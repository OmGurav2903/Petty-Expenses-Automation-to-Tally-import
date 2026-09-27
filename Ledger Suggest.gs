// ============================================================================
// LEDGER SUGGEST — suggests which Ledger / Expense Category fits the Description
// a submitter has typed. SUGGEST-AND-CONFIRM ONLY: nothing here ever sets, changes
// or validates a voucher's ledger. The submitter still picks the ledger; the
// server-side ledger and vehicle checks (validateVoucherCore) are untouched.
//
// How it works (no external calls, no new OAuth scope, everything stays in Google):
//   1. Every past description becomes a small "fingerprint" (words, word pairs and
//      letter triples, so typos like "brithday" still match).
//   2. A new description is compared with all examples; the closest ones vote for
//      their ledger (nearest-neighbour). Closer examples count for more.
//   3. Three narrow, explainable rules add weight where the business rules are
//      hard: a vehicle number, "fastag", "toll" - the ledgers that need a vehicle.
//   4. The example pool = LS_SEED (Ledger Seed.gs) + LS_HINTS (below) + the
//      descriptions of APPROVED vouchers from the All Vouchers sheet. So it learns
//      from what Accounts finally accepted, with no retraining step: a new approved
//      voucher is simply one more example (cache refreshes every 6 hours, or run
//      refreshLedgerLearning()).
//   5. Only ledgers currently in Master Data column M can ever be suggested, so a
//      retired ledger can never appear.
// Every suggestion outcome is written to the Audit Log (LEDGER_SUGGESTION) so accuracy
// can be measured from real use: run ledgerSuggestReport() from the Apps Script editor.
// ============================================================================

var LS_LIVE_CACHE_KEY   = 'ls_live_v1';
var LS_LIVE_TTL_SECONDS = 6 * 60 * 60;
var LS_LIVE_MAX_ROWS    = 5000;   // newest approved rows scanned
var LS_LIVE_MAX_UNIQUE  = 1200;   // distinct examples kept (repeats are merged and weigh a little more)
var LS_LIVE_WEIGHT      = 1.4;     // approved live vouchers reflect current practice
var LS_K                = 15;      // neighbours that vote
var LS_MIN_SIM          = 0.14;    // ignore neighbours less similar than this
var LS_RULE_BOOST       = 1.6;     // weight a rule adds (about 2-3 very close neighbours)
var LS_HIGH_SHARE       = 0.65;    // tier thresholds - tuned on a time-split test (see CHANGES.md)
var LS_HIGH_SIM         = 0.30;
var LS_MED_SHARE        = 0.40;
var LS_MIN_CHARS        = 6;
var LS_MAX_SUGGESTIONS  = 3;

// Never offered as a suggestion (still selectable by hand, exactly as before).
var LS_NEVER_SUGGEST = {
  'Repairs & Maintenance': 1, 'Repairs & Maintainance': 1,
  'Repairs & Maintenance - MH43 AD 7803': 1, 'Travelling Expenses': 1
};

// Vehicle number -> its repair ledger (exact ledger names as in Master Data).
var LS_PLATE_LEDGER = {
  'MH03EG0225': 'Repairs & Maintainance-MH03EG0225',
  'MH04LQ4014': 'Repairs & Maintenance -MH04LQ4014',
  'MH04MH4896': 'Repairs & Maintenance - MH04MH4896',
  'MH43BX0252': 'Repairs & Maintenance - MH 43 BX 0252',
  'MH43BX7803': 'Repairs & Maintenance - MH43 Bx 7803',
  'MH43BX7821': 'Repairs & Maintenance - MH43 BX 7821',
  'MH04NB5087': 'Repairs & Maintenance - MH 04 NB 5087'
};

// Plain-language phrases per ledger (from the Ledger Guide). They make sparse or
// brand-new ledgers usable from day one. To support a new ledger, add a line here.
var LS_HINTS = {
  'Lodging & Boarding Exp': ['hotel room rent for outstation trip', 'lodging charges hotel stay', 'night stay boarding lodging'],
  'Parking Charges': ['car parking charges', 'parking fee paid', 'vehicle parking'],
  'Postage & Courier Charges': ['courier charges for sending documents', 'speed post charges', 'courier sent to office parcel'],
  'House Keeping Material: Thane & Rabale': ['housekeeping material acid phenyl', 'broom mop cleaning supplies', 'floor cleaner washroom cleaning material'],
  'Repairs & Maintenance - Squaring Machine': ['squaring machine servicing', 'squaring machine repair patti change', 'hydraulic squaring machine parts'],
  'Repairs & Maintenance - Single Clamp Machine ( Bindwell Bluechip)': ['bindwell bluechip single clamp machine repair', 'new single clamp machine bluechip service'],
  'Repairs & Maintenance - Single Clamp Binding Mach.': ['single clamp binding machine repair', 'single clamp binding machine motor belt'],
  'Repairs & Maintenance- Cutting Machine': ['spy cutting machine repair', 'seypa cutting machine gear box oil', 'cutting machine blade belt hydraulic'],
  'Vehicle Fastag': ['fastag recharge', 'fastag recharge for vehicle', 'fastag balance top up'],
  'Vehicle Operating - Jakat/Toll': ['toll charges paid at toll plaza', 'airoli toll', 'vashi toll dahisar toll', 'jakat charges'],
  'Vehicle Operating - Petrol': ['petrol filled in vehicle', 'diesel charges for vehicle', 'cng charges for vehicle'],
  'Conveyance - Others': ['auto charges to thane office', 'train and auto travelling charges for book delivery', 'rapido charges travelling', 'petrol for own bike going to school'],
  'Transportation Non - GST': ['porter charges rabale to thane', 'tempo hired to carry parcel', 'hamali loading unloading charges', 'porter charges for book delivery'],
  'Tea & Coffee': ['tea charges for mechanic', 'tea for visitors', 'tea and coffee for guests'],
  'Pantry Material': ['sugar 10 kg', 'pantry items sugar tea powder', 'vim bar scotch brite for pantry'],
  'Food Exp': ['lunch charges for staff going for delivery', 'lunch for labours working late', 'breakfast and lunch on outstation trip'],
  'Staff Welfare': ['drinking water 20 ltr jar', 'water jar charges', 'gift hamper for staff fun friday', 'women day celebration gifts'],
  'Birthday Cake & Chocolates': ['birthday cake for employees monthly', 'birthday celebration cake and chocolates'],
  'Packing Material': ['thread bundle 25 kg', 'packing paper rubber band', 'cotton chindi for packing', 'courier bags for packing'],
  'Printing & Stationery': ['a4 paper register pen stationery', 'xerox and colour print out', 'cello tape stapler pins files'],
  'Office Expenses': ['pooja material and flowers', 'first aid bandage', 'monthly dustbin cleaning', 'lock and gloves for office'],
  'Repairs & Maintenance - Others': ['electrician charges', 'ac repair', 'lift servicing', 'printer service', 'grease and oil for all machines', 'drainage cleaning']
};

// ---- input normaliser: spelling variants, Hinglish and Marathi/Hindi words ------
// Maps common alternative words onto the English words the examples use. Extend freely.
var LS_ALIAS = {
  'fasttag':'fastag','fasttags':'fastag','फास्टैग':'fastag','फास्टॅग':'fastag',
  'bday':'birthday','birtdhay':'birthday','brithday':'birthday','bithday':'birthday','बर्थडे':'birthday',
  'puja':'pooja','पूजा':'pooja',
  'chai':'tea','चाय':'tea','चहा':'tea','कॉफी':'coffee','कॉफ़ी':'coffee',
  'khana':'lunch','jevan':'lunch','jevn':'lunch','खाना':'lunch','जेवण':'lunch','लंच':'lunch','नाश्ता':'breakfast',
  'rickshaw':'auto','riksha':'auto','rikshaw':'auto','रिक्षा':'auto','रिक्शा':'auto','ऑटो':'auto',
  'travelling':'travel','traveling':'travel','travell':'travel','traval':'travel',
  'repaire':'repair','repairing':'repair','repairs':'repair','marammat':'repair','durusti':'repair','मरम्मत':'repair','दुरुस्ती':'repair',
  'servicing':'service','सर्विस':'service','सर्व्हिस':'service',
  'tyres':'tyre','tire':'tyre','tires':'tyre','टायर':'tyre','puncher':'puncture','punchture':'puncture','पंक्चर':'puncture',
  'tolls':'toll','jakat':'toll','jakaat':'toll','जकात':'toll','टोल':'toll',
  'portar':'porter','potar':'porter','पोर्टर':'porter','tampo':'tempo','टेम्पो':'tempo',
  'hammali':'hamali','हमाली':'hamali','loading':'hamali','unloading':'hamali',
  'petrol':'petrol','pertol':'petrol','पेट्रोल':'petrol','deisel':'diesel','डिझेल':'diesel','डीजल':'diesel','डीज़ल':'diesel','सीएनजी':'cng',
  'parking':'parking','पार्किंग':'parking',
  'cheeni':'sugar','chini':'sugar','sakhar':'sugar','चीनी':'sugar','साखर':'sugar',
  'paani':'water','pani':'water','पानी':'water','जार':'jar',
  'dhaga':'thread','sutli':'thread','suttli':'thread','sutali':'thread','धागा':'thread','सुतळी':'thread','सुतली':'thread',
  'stationary':'stationery','स्टेशनरी':'stationery','register':'register','रजिस्टर':'register',
  'courier':'courier','कूरियर':'courier','कुरिअर':'courier',
  'straping':'strapping','pining':'pinning','pinnig':'pinning','squarity':'squaring',
  'mechanic':'mechanic','machanic':'mechanic','mechanice':'mechanic','machanice':'mechanic','मेकॅनिक':'mechanic','मैकेनिक':'mechanic',
  'pattee':'bandage','patti':'bandage','पट्टी':'bandage','केक':'cake'
};
var LS_STOP = {};
'being amount paid to for of on dt dtd dated date rs charges charge exps exp expenses expense and the a an at in by from is was with no nos pc pcs payment done'
  .split(' ').forEach(function (w) { LS_STOP[w] = 1; });
// People's names and forms of address say nothing about the ledger ("tea for Sandeep sir").
'sir madam maam ma sandeep dheb kapil dev akash dhawale dhwale siddhesh nagavkar anish kumar umesh kanthe eknath sunil mhatre sanil ravikiran ravi suryavanshi shivshankar shiv shankar yadav balkrushna shinde riya devi eshwar ishwar kalingade deepak sane dilip sagar tushar mahatab atmaram hande mithun dhuri kisan pandey pandurang khanit'
  .split(' ').forEach(function (w) { LS_STOP[w] = 1; });

var LS_TEA_FOOD_CUE   = /\b(tea|coffee|chai|lunch|breakfast|dinner|snacks|food)\b/;
var LS_FUEL_CUE       = /\b(petrol|diesel|cng|fuel)\b/;
var LS_PLATE_RE       = /\bmh\s*-?\s*(\d{2})\s*-?\s*([a-z]{1,2})\s*-?\s*(\d{3,4})\b/g;
var LS_TRANSPORT_HINT = /return parcel|lr no|lorry receipt|transporter|consignment|lr number/;
var LS_REPAIR_CUE     = /\b(repair|service|servicing|tyre|puncture|battery|brake|brakes|clutch|oil|puc|rto|fitness|wheel|bulb|filter|coolant|radiator|starter|paint|painting|key|spare|labour|alignment|def|adblue|pad|pads|horn|wiper|fitting|denting|engine|gear|suspension)\b/;
var LS_GOODS_CUE      = /\b(hamali|parcel|lr|porter|tempo|transport|transportation|delivery|freight|consignment|loading|unloading)\b/;

// ---------------------------------------------------------------------------
// Text -> features
// ---------------------------------------------------------------------------
function lsPlates_(text) {
  var out = [], m, s = String(text || '').toLowerCase();
  LS_PLATE_RE.lastIndex = 0;
  while ((m = LS_PLATE_RE.exec(s)) !== null) out.push(('mh' + m[1] + m[2] + m[3]).toUpperCase());
  return out;
}

// A plate typed one character off, or with two neighbouring characters swapped (MH04LQ4041 for
// MH04LQ4014), still points at the one known vehicle it is closest to - only when exactly one is.
function lsClosestPlate_(plate) {
  if (LS_PLATE_LEDGER[plate]) return plate;
  var hit = null, k, i, d;
  for (k in LS_PLATE_LEDGER) {
    if (k.length !== plate.length) continue;
    var diffs = []; for (i = 0; i < k.length; i++) if (k.charAt(i) !== plate.charAt(i)) diffs.push(i);
    d = diffs.length;
    var swapped = d === 2 && diffs[1] === diffs[0] + 1 && k.charAt(diffs[0]) === plate.charAt(diffs[1]) && k.charAt(diffs[1]) === plate.charAt(diffs[0]);
    if (d === 1 || swapped) { if (hit) return null; hit = k; }
  }
  return hit;
}

function lsTokens_(text) {
  var s = String(text || '').toLowerCase();
  s = s.replace(/fast\s*-?\s*tag/g, 'fastag').replace(/b'day/g, 'birthday');
  s = s.replace(LS_PLATE_RE, function (all, a, b, c) { return ' plate' + a + b + c + ' '; });
  s = s.replace(/\d{1,2}[\.\-\/]\d{1,2}[\.\-\/]\d{2,4}/g, ' ');
  var raw = s.split(/[^a-z0-9\u0900-\u097F]+/), out = [];
  for (var i = 0; i < raw.length; i++) {
    var w = raw[i];
    if (!w || /^\d+$/.test(w)) continue;
    if (LS_ALIAS[w]) w = LS_ALIAS[w];
    if (w.length < 2 || LS_STOP[w]) continue;
    out.push(w);
  }
  return out;
}

// feature -> weight (term frequency, sub-linear). w: word, b: word pair, c: letter triple.
function lsFeatures_(text) {
  var toks = lsTokens_(text), f = {}, i, j;
  function add(k, v) { f[k] = (f[k] || 0) + v; }
  for (i = 0; i < toks.length; i++) {
    add('w:' + toks[i], 1);
    if (i + 1 < toks.length) add('b:' + toks[i] + '_' + toks[i + 1], 0.8);
    var w = toks[i];
    if (w.length >= 5 && /^[a-z]+$/.test(w)) {
      for (j = 0; j + 3 <= w.length; j++) add('c:' + w.substr(j, 3), 0.25);
    }
  }
  return f;
}

// ---------------------------------------------------------------------------
// Model (nearest-neighbour index over the example pool)
// ---------------------------------------------------------------------------
function lsBuildModel_(examples) {
  var n = examples.length, df = {}, feats = [], i, k;
  for (i = 0; i < n; i++) {
    var f = lsFeatures_(examples[i].t);
    feats.push(f);
    for (k in f) df[k] = (df[k] || 0) + 1;
  }
  var idf = {};
  for (k in df) idf[k] = Math.log((n + 1) / (df[k] + 0.5)) + 1;
  var post = {}, texts = [], ledgers = [], weights = [];
  for (i = 0; i < n; i++) {
    var f2 = feats[i], vec = {}, norm = 0;
    for (k in f2) { var w = (1 + Math.log(f2[k])) * idf[k]; vec[k] = w; norm += w * w; }
    norm = Math.sqrt(norm) || 1;
    for (k in vec) { (post[k] = post[k] || []).push([i, vec[k] / norm]); }
    texts.push(examples[i].t); ledgers.push(examples[i].l); weights.push(examples[i].w || 1);
  }
  return { n: n, idf: idf, post: post, texts: texts, ledgers: ledgers, weights: weights };
}

function lsSuggestCore_(model, text, allowedList) {
  var res = { tier: 'none', suggestions: [], hint: '' };
  var clean = String(text || '').trim();
  if (clean.length < LS_MIN_CHARS) return res;
  var lower = clean.toLowerCase();
  if (LS_TRANSPORT_HINT.test(lower)) res.hint = 'transport';

  var allowed = {}, ai;
  for (ai = 0; ai < allowedList.length; ai++) allowed[allowedList[ai]] = 1;

  // --- nearest neighbours ---
  var qf = lsFeatures_(clean), qv = {}, qn = 0, k;
  for (k in qf) { var idf = model.idf[k]; if (idf === undefined) idf = Math.log(model.n + 1) + 1; var w = (1 + Math.log(qf[k])) * idf; qv[k] = w; qn += w * w; }
  qn = Math.sqrt(qn) || 1;
  var sims = {}, p, pi;
  for (k in qv) {
    p = model.post[k]; if (!p) continue;
    for (pi = 0; pi < p.length; pi++) sims[p[pi][0]] = (sims[p[pi][0]] || 0) + (qv[k] / qn) * p[pi][1];
  }
  var cand = [], id;
  for (id in sims) if (sims[id] >= LS_MIN_SIM && allowed[model.ledgers[id]] && !LS_NEVER_SUGGEST[model.ledgers[id]]) cand.push([+id, sims[id]]);
  cand.sort(function (a, b) { return b[1] - a[1]; });
  cand = cand.slice(0, LS_K);

  var score = {}, best = {}, topSim = 0, ci;
  for (ci = 0; ci < cand.length; ci++) {
    var l = model.ledgers[cand[ci][0]], s = cand[ci][1];
    score[l] = (score[l] || 0) + s * s * model.weights[cand[ci][0]];
    if (!best[l] || s > best[l][1]) best[l] = [cand[ci][0], s];
    if (s > topSim) topSim = s;
  }

  // --- three narrow rules: only for ledgers where a vehicle number is involved ---
  var why = {};
  function boost(ledger, reason) {
    if (!allowed[ledger] || LS_NEVER_SUGGEST[ledger]) return;
    score[ledger] = (score[ledger] || 0) + LS_RULE_BOOST;
    if (!why[ledger]) why[ledger] = reason;
  }
  var plates = lsPlates_(clean), toks = lsTokens_(clean), tset = {}, ti;
  for (ti = 0; ti < toks.length; ti++) tset[toks[ti]] = 1;
  var teaFood = LS_TEA_FOOD_CUE.test(lower) || tset.tea || tset.lunch;
  if (tset.fastag) boost('Vehicle Fastag', 'mentions Fastag');
  if (tset.toll) boost('Vehicle Operating - Jakat/Toll', 'mentions toll');
  if (plates.length && !tset.fastag && !tset.toll && !teaFood) {
    if (LS_FUEL_CUE.test(lower) || tset.petrol || tset.diesel || tset.cng) boost('Vehicle Operating - Petrol', 'fuel for a vehicle');
    else if (LS_REPAIR_CUE.test(lower) && !LS_GOODS_CUE.test(lower)) {
      var known = lsClosestPlate_(plates[0]);
      if (known) boost(LS_PLATE_LEDGER[known], (known === plates[0] ? 'repair of vehicle ' : 'looks like vehicle ') + known);
    }
  }

  var total = 0, l2, list = [];
  for (l2 in score) total += score[l2];
  if (total <= 0) return res;
  for (l2 in score) list.push({ ledger: l2, share: score[l2] / total });
  list.sort(function (a, b) { return b.share - a.share; });

  var top = list[0], sim = topSim;
  if (why[top.ledger]) sim = Math.max(sim, 0.6); // a rule hit counts as strong evidence
  res.topShare = top.share; res.topSim = sim;
  if (top.share >= LS_HIGH_SHARE && sim >= LS_HIGH_SIM) res.tier = 'high';
  else if (top.share >= LS_MED_SHARE) res.tier = 'medium';
  else res.tier = 'low';

  var need = LS_VEHICLE_LEDGERS_();
  for (var i = 0; i < list.length && res.suggestions.length < LS_MAX_SUGGESTIONS; i++) {
    var L = list[i].ledger;
    if (i > 0 && list[i].share < 0.08) break;
    var reason = why[L] || (best[L] ? ('like: ' + model.texts[best[L][0]]) : '');
    res.suggestions.push({ ledger: L, pct: Math.round(list[i].share * 100), why: String(reason).substr(0, 70), needsVehicle: need.indexOf(L) !== -1 });
  }
  return res;
}

function LS_VEHICLE_LEDGERS_() {
  return (typeof VEHICLE_REQUIRED_LEDGERS !== 'undefined') ? VEHICLE_REQUIRED_LEDGERS : [];
}

// ---------------------------------------------------------------------------
// Example pool: seed + hints + live approved vouchers
// ---------------------------------------------------------------------------
function lsSeedExamples_() {
  var out = [], i, l;
  for (i = 0; i < LS_SEED.length; i++) out.push({ t: LS_SEED[i][1], l: LS_SEED_LEDGERS[LS_SEED[i][0]], w: 1 });
  for (l in LS_HINTS) for (i = 0; i < LS_HINTS[l].length; i++) out.push({ t: LS_HINTS[l][i], l: l, w: 1.2 });
  return out;
}

function lsLoadLive_() {
  var cache = CacheService.getScriptCache();
  try {
    var meta = cache.get(LS_LIVE_CACHE_KEY + '_n');
    if (meta) {
      var n = parseInt(meta, 10), keys = [], i;
      for (i = 0; i < n; i++) keys.push(LS_LIVE_CACHE_KEY + '_' + i);
      var got = cache.getAll(keys), json = '';
      for (i = 0; i < n; i++) { if (got[keys[i]] === undefined) { json = null; break; } json += got[keys[i]]; }
      if (json !== null) return JSON.parse(json);
    }
  } catch (e) { /* fall through to a fresh read */ }

  var live = [];
  try {
    var sheet = getSheet_(ALL_VOUCHERS_SHEET), last = sheet ? sheet.getLastRow() : 0;
    if (last >= 2) {
      var vals = sheet.getRange(2, 1, last - 1, AV.NOTES + 1).getValues();
      var byKey = {}, order = [], scanned = 0;
      for (var r = vals.length - 1; r >= 0 && scanned < LS_LIVE_MAX_ROWS && order.length < LS_LIVE_MAX_UNIQUE; r--) {
        var row = vals[r], type = String(row[AV.EXPENSE_TYPE] || '').trim(), notes = String(row[AV.NOTES] || '').trim();
        if (String(row[AV.STATUS]) !== 'Approved' || !type || type === 'Transport' || notes.length < 5) continue;
        scanned++;
        var seen = {}, kt = lsTokens_(notes).filter(function (w) { if (seen[w]) return false; seen[w] = 1; return true; }).sort().join(' ');
        var key = type + '|' + kt;
        if (byKey[key]) { byKey[key].c++; continue; }   // same words, same ledger: one example that weighs a little more
        byKey[key] = { t: notes.substr(0, 200), l: type, c: 1 };
        order.push(key);
      }
      for (var oi = 0; oi < order.length; oi++) {
        var e = byKey[order[oi]];
        live.push({ t: e.t, l: e.l, w: LS_LIVE_WEIGHT * (1 + 0.25 * Math.min(e.c - 1, 4)) });
      }
    }
  } catch (e) { Logger.log('lsLoadLive_ read failed: ' + e); }
  try {
    // The cache limit is 100 KB per value in BYTES; Devanagari is 3 bytes a character, so 30,000 characters is the safe size.
    var s = JSON.stringify(live), CH = 30000, parts = [], off = 0, obj = {};
    while (off < s.length) { parts.push(s.substr(off, CH)); off += CH; }
    if (!parts.length) parts.push('[]');
    for (var j = 0; j < parts.length; j++) obj[LS_LIVE_CACHE_KEY + '_' + j] = parts[j];
    obj[LS_LIVE_CACHE_KEY + '_n'] = String(parts.length);
    cache.putAll(obj, LS_LIVE_TTL_SECONDS);
  } catch (e2) { Logger.log('lsLoadLive_ cache write failed: ' + e2); }
  return live;
}

var _lsModelMemo = null; // reused within one execution only
function lsGetModel_() {
  var live = lsLoadLive_();
  var sig = live.length + ':' + (live.length ? live[0].t.substr(0, 20) : '');
  if (_lsModelMemo && _lsModelMemo.sig === sig) return _lsModelMemo.model;
  var model = lsBuildModel_(lsSeedExamples_().concat(live));
  _lsModelMemo = { sig: sig, model: model };
  return model;
}

// Admin/editor helper: forget the cached live examples so the next suggestion re-reads
// the sheet (normally they refresh by themselves every 6 hours).
function refreshLedgerLearning() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var cache = CacheService.getScriptCache(), n = parseInt(cache.get(LS_LIVE_CACHE_KEY + '_n') || '0', 10), keys = [LS_LIVE_CACHE_KEY + '_n'];
  for (var i = 0; i < n; i++) keys.push(LS_LIVE_CACHE_KEY + '_' + i);
  cache.removeAll(keys);
  _lsModelMemo = null;
  return { success: true };
}

// ---------------------------------------------------------------------------
// Endpoints (called from the Submit Voucher screen)
// ---------------------------------------------------------------------------
function suggestLedger(token, description) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'submission') return { success: false, error: 'Not available for this role.' };
    var text = String(description || '').substr(0, 300);
    var r = lsSuggestCore_(lsGetModel_(), text, getLedgers_());
    return { success: true, tier: r.tier, suggestions: r.suggestions, hint: r.hint };
  } catch (err) {
    Logger.log('suggestLedger error: ' + err); // a suggestion failure must never affect submitting
    return { success: false, error: 'Suggestion unavailable.' };
  }
}

// Fire-and-forget from the client after a NEW voucher is saved: records what was
// suggested and what the submitter chose. Never blocks or fails the submission.
function logLedgerSuggestion(voucherId, outcomeJson, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false };
    var o = JSON.parse(String(outcomeJson || '{}'));
    var note = 'top=' + String(o.top || '') + ' | tier=' + String(o.tier || '') + ' | chosen=' + String(o.chosen || '') +
      ' | match=' + (o.top && o.top === o.chosen ? 'Y' : 'N') + ' | clicked=' + (o.clicked ? 'Y' : 'N') +
      ' | shown=' + (o.shown || []).join(' ; ');
    logAction_('LEDGER_SUGGESTION', voucherId, session.displayName || session.role, session.role, note.substr(0, 480));
    return { success: true };
  } catch (err) {
    Logger.log('logLedgerSuggestion error: ' + err);
    return { success: false };
  }
}

// Run from the Apps Script editor. Reads the Audit Log's LEDGER_SUGGESTION rows and, for
// vouchers that have since been approved, compares the suggestion with the ledger that
// finally stood. Logs a summary and returns it.
function ledgerSuggestReport() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var out = { rows: 0, top1MatchesChosen: 0, chipUsed: 0, noSuggestion: 0, approved: 0, top1MatchesFinal: 0, chosenMatchesFinal: 0, byTier: {} };
  var log = getSheet_(AUDIT_LOG_SHEET), av = getSheet_(ALL_VOUCHERS_SHEET);
  if (!log || !av) return out;
  var finals = {}, avVals = av.getLastRow() >= 2 ? av.getRange(2, 1, av.getLastRow() - 1, AV.STATUS + 1).getValues() : [];
  avVals.forEach(function (r) { if (String(r[AV.STATUS]) === 'Approved') finals[String(r[AV.VOUCHER_ID])] = String(r[AV.EXPENSE_TYPE]); });
  var lv = log.getLastRow() >= 2 ? log.getRange(2, 1, log.getLastRow() - 1, 6).getValues() : [];
  lv.forEach(function (r) {
    if (String(r[1]) !== 'LEDGER_SUGGESTION') return;
    var note = String(r[5]), get = function (k) { var m = note.match(new RegExp(k + '=([^|]*)')); return m ? m[1].trim() : ''; };
    var top = get('top'), tier = get('tier'), chosen = get('chosen'), vid = String(r[2]);
    out.rows++;
    out.byTier[tier || 'none'] = out.byTier[tier || 'none'] || { n: 0, top1MatchesFinal: 0, approved: 0 };
    out.byTier[tier || 'none'].n++;
    if (!top) out.noSuggestion++;
    if (top && top === chosen) out.top1MatchesChosen++;
    if (get('clicked') === 'Y') out.chipUsed++;
    if (finals[vid] !== undefined) {
      out.approved++; out.byTier[tier || 'none'].approved++;
      if (chosen === finals[vid]) out.chosenMatchesFinal++;
      if (top && top === finals[vid]) { out.top1MatchesFinal++; out.byTier[tier || 'none'].top1MatchesFinal++; }
    }
  });
  Logger.log('ledgerSuggestReport: ' + JSON.stringify(out));
  return out;
}
