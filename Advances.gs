// ============================================================================
// CASH ADVANCES — REVISED AGAIN (correction #2, per explicit instruction).
// See the CA object's comment in Config.gs for full context. Summary of
// what changed from the previous version:
//   - Entry moved from Accounts (Approval Dashboard) to Submission
//     (Submission Dashboard) — recordCashAdvance is now gated to
//     'submission' + 'admin'.
//   - GIVEN_TO is now a DROPDOWN sourced from getEmployees() — the exact
//     same list, same order, same stripIouPrefix display treatment as a
//     voucher's Submitted By field — instead of free text.
//   - No more per-advance Status/Settled Amount/Linked Voucher IDs. There
//     is no reliable way to link one voucher to one specific advance, so
//     this stopped trying to. A balance is purely SUM(advances given to
//     a person) minus SUM(their non-Rejected vouchers) — see
//     getCashAdvanceBalances/getCashAdvanceLedger below.
// ============================================================================

function getOrCreateCashAdvancesSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(CASH_ADVANCES_SHEET);
  if (sheet) return sheet;
  sheet = ss.insertSheet(CASH_ADVANCES_SHEET);
  sheet.getRange(1, 1, 1, EXPECTED_CASH_ADVANCES_HEADERS.length).setValues([EXPECTED_CASH_ADVANCES_HEADERS]);
  sheet.setFrozenRows(1);
  // FIX (per explicit instruction) — Date Given / Last Updated are written
  // as raw Date objects (recordCashAdvance/adminEditCashAdvance below),
  // same as RS.DATE on the RDS sheet. Without an explicit column number
  // format, Sheets falls back to its own default for an unformatted Date
  // cell, which renders the full JS Date.toString() — "Sun Aug 09 2026
  // 05:30:00 GMT+0530 (India Standard Time)" — instead of a clean date.
  // This is the exact same fix already applied to RS.DATE in
  // getOrCreateRdsMonthSheet (Sheet Utils.gs); this was the one place in
  // the codebase missing it — every other date-bearing sheet (Users,
  // Audit Log, Query Thread) stores a pre-formatted STRING instead of a
  // raw Date, so this gap doesn't apply to them.
  sheet.getRange(2, CA.DATE_GIVEN + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('dd-mm-yyyy');
  sheet.getRange(2, CA.LAST_UPDATED + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('dd-mm-yyyy');
  // READABILITY (per explicit instruction) — Purpose/Notes are free
  // text; cap+wrap those, plain auto-fit everything else.
  autoFitSheetColumns_(sheet, [CA.PURPOSE, CA.NOTES]);
  return sheet;
}

function cashAdvanceViewRoleAllowed_(role) {
  return ['submission', 'accounts', 'admin', 'L1', 'L2', 'auditor'].indexOf(role) !== -1;
}

// One-time migration — run manually from the Apps Script editor if the
// Cash Advances sheet already existed before the getOrCreateCashAdvancesSheet
// fix above (i.e. it was created before Date Given/Last Updated had a
// column number format). Idempotent, safe to re-run: just re-applies the
// same format, doesn't touch any cell's actual value.
function migrateFixCashAdvancesDateFormat() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var sheet = getOrCreateCashAdvancesSheet_();
  sheet.getRange(2, CA.DATE_GIVEN + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('dd-mm-yyyy');
  sheet.getRange(2, CA.LAST_UPDATED + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('dd-mm-yyyy');
  Logger.log('migrateFixCashAdvancesDateFormat: Date Given / Last Updated columns reformatted on "' + CASH_ADVANCES_SHEET + '".');
}
// value/display convention as a voucher's Submitted By field) for the
// entry form's Given To select, and 'recordedPersons' (distinct GIVEN_TO
// values that already have at least one advance) for the ledger view's
// person picker, so that list doesn't show hundreds of employees who've
// never actually received an advance.
// Internal helper (no token \u2014 not an RPC, called only from closeRdsDay,
// Triggers.gs) — sums every Cash Advance given on exactly one calendar
// date, plus a per-person breakdown for the Advance cell's note. Used by
// the RDS Advance/Closing-Balance feature (25 Aug 2026, Option A,
// confirmed design): consolidated once per day, written onto that day's
// last RDS row rather than a new synthetic row.
function getCashAdvancesGivenOnDate_(dateObj) {
  var result = { total: 0, byPerson: [] };
  var d = (dateObj instanceof Date) ? dateObj : new Date(dateObj);
  if (isNaN(d.getTime())) return result;
  var y = d.getFullYear(), m = d.getMonth(), day = d.getDate();

  var sheet = getOrCreateCashAdvancesSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return result;

  var data = sheet.getRange(2, 1, lastRow - 1, EXPECTED_CASH_ADVANCES_HEADERS.length).getValues();
  var byName = {};
  for (var i = 0; i < data.length; i++) {
    var name = safe_(data[i][CA.GIVEN_TO]);
    if (!name) continue;
    var given = new Date(data[i][CA.DATE_GIVEN]);
    if (isNaN(given.getTime())) continue;
    if (given.getFullYear() !== y || given.getMonth() !== m || given.getDate() !== day) continue;
    var amount = parseFloat(data[i][CA.AMOUNT]) || 0;
    result.total += amount;
    byName[name] = (byName[name] || 0) + amount;
  }
  result.byPerson = Object.keys(byName).sort().map(function (n) { return { name: stripIouPrefix_(n), amount: byName[n] }; });
  return result;
}

function getCashAdvancePersons(token) {
  var session = validateSession_(token);
  if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
  if (!cashAdvanceViewRoleAllowed_(session.role)) return { success: false, error: 'You do not have permission to view this.' };

  var sheet = getOrCreateCashAdvancesSheet_();
  var lastRow = sheet.getLastRow();
  var recorded = {};
  if (lastRow >= 2) {
    var data = sheet.getRange(2, 1, lastRow - 1, EXPECTED_CASH_ADVANCES_HEADERS.length).getValues();
    for (var i = 0; i < data.length; i++) {
      var name = safe_(data[i][CA.GIVEN_TO]);
      if (name) recorded[name] = true;
    }
  }
  return { success: true, employees: getEmployees_(), recordedPersons: Object.keys(recorded).sort() };
}

// Record a new advance — Submission/Warehouse staff (the people who
// actually hand out the cash), plus Admin as an override. Given To must
// be one of getEmployees() — the same canonical list Submitted By draws
// from, which is what makes the balance/ledger calculations below able
// to match the two ledgers on name alone.
function recordCashAdvance(givenTo, amount, purpose, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'submission' && session.role !== 'admin') {
      return { success: false, error: 'You do not have permission to do this.' };
    }

    givenTo = String(givenTo || '').trim();
    purpose = String(purpose || '').trim();
    amount = parseFloat(amount);

    if (!givenTo) return { success: false, error: 'Select who the advance was given to.' };
    if (getEmployees_().indexOf(givenTo) === -1) {
      return { success: false, error: 'Unknown employee: ' + givenTo + '. Add them to Master Data first.' };
    }
    if (isNaN(amount) || amount <= 0) return { success: false, error: 'Enter a valid amount greater than 0.' };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var sheet = getOrCreateCashAdvancesSheet_();
      var now = new Date();
      var advanceId = 'ADV-' + Date.now();
      var newRow = new Array(EXPECTED_CASH_ADVANCES_HEADERS.length).fill('');
      newRow[CA.ADVANCE_ID] = advanceId;
      newRow[CA.DATE_GIVEN] = now;
      newRow[CA.GIVEN_TO] = givenTo;
      newRow[CA.AMOUNT] = amount;
      newRow[CA.PURPOSE] = purpose;
      newRow[CA.GIVEN_BY] = session.displayName || session.role;
      newRow[CA.NOTES] = '';
      newRow[CA.LAST_UPDATED] = now;
      sheet.appendRow(newRow);

      logAction_('ADVANCE_GIVEN', advanceId, session.displayName || session.role, session.role,
        givenTo + ': Rs. ' + amount);

      return { success: true, message: 'Advance of Rs. ' + amount.toLocaleString('en-IN') + ' recorded for ' + stripIouPrefix_(givenTo) + '.' };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('recordCashAdvance error: ' + err);
    return { success: false, error: 'Failed to record advance: ' + err.toString() };
  }
}

// Daily breakdown (per explicit instruction) — powers the combined
// Reconciliation/Breakdown view (Main.gs, loadCashAdvanceDailyLog). Groups
// BOTH ledgers by calendar day: CA.DATE_GIVEN for advances, AV.DATE (the
// submission date, same field that drives RDS/batch placement) for
// vouchers — a voucher filed late still lands on the day it was actually
// typed in, which is the whole point of the "given vs. filed" comparison
// this view exists to surface (see the filing-lag discussion this was
// designed around). Each person listed on a day carries their CURRENT
// overall balance status (open/settled/flagged), not a day-scoped one —
// the balance itself has never been day-scoped (see getCashAdvanceBalances
// above), only the display grouping is new here.
function getCashAdvanceDailyBreakdown(daysBack, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (!cashAdvanceViewRoleAllowed_(session.role)) return { success: false, error: 'You do not have permission to view this.' };

    daysBack = parseInt(daysBack, 10);
    if (isNaN(daysBack) || daysBack <= 0) daysBack = 14;
    daysBack = Math.min(daysBack, 90); // hard ceiling — this is a review window, not a full-history export

    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    cutoff.setHours(0, 0, 0, 0);

    // Per-person CURRENT balance status, reused for every day this person
    // appears on — same computation as getCashAdvanceBalances, factored
    // out here rather than calling that RPC internally so this stays one
    // sheet-read pass per ledger, not two.
    var given = getCashAdvanceGivenTotals_();
    var submitted = getVoucherSubmittedTotals_();
    var now = new Date();
    var statusByName = {};
    Object.keys(given).forEach(function (name) {
      var g = given[name];
      var totalSubmitted = (submitted[name] && submitted[name].total) || 0;
      var openBalance = g.total - totalSubmitted;
      var ageDays = Math.floor((now - new Date(g.oldestDate)) / 86400000);
      var flagged = openBalance > 0.004 && ageDays > CASH_ADVANCE_AGE_FLAG_DAYS;
      statusByName[name] = {
        status: openBalance <= 0.004 ? 'settled' : (flagged ? 'flagged' : 'open'),
        label: openBalance <= 0.004 ? 'Settled' : (flagged ? 'Flagged \u00b7 ' + ageDays + 'd' : 'Open Rs. ' + Math.round(openBalance).toLocaleString('en-IN'))
      };
    });

    // dayKey -> { date (Date, for sorting/display), advanceTotal,
    // voucherTotal, people: [{name, amount, purpose}] }
    var days = {};
    function dayKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
    function ensureDay(d) {
      var k = dayKey(d);
      if (!days[k]) days[k] = { sortDate: new Date(d.getFullYear(), d.getMonth(), d.getDate()), advanceTotal: 0, voucherTotal: 0, people: [] };
      return days[k];
    }

    var caSheet = getOrCreateCashAdvancesSheet_();
    var caLastRow = caSheet.getLastRow();
    if (caLastRow >= 2) {
      var caData = caSheet.getRange(2, 1, caLastRow - 1, EXPECTED_CASH_ADVANCES_HEADERS.length).getValues();
      for (var i = 0; i < caData.length; i++) {
        var name = safe_(caData[i][CA.GIVEN_TO]);
        if (!name) continue;
        var d = new Date(caData[i][CA.DATE_GIVEN]);
        if (isNaN(d.getTime()) || d < cutoff) continue;
        var amount = parseFloat(caData[i][CA.AMOUNT]) || 0;
        var bucket = ensureDay(d);
        bucket.advanceTotal += amount;
        bucket.people.push({
          name: stripIouPrefix_(name), initials: initialsOf_(name), amount: amount,
          purpose: safe_(caData[i][CA.PURPOSE]) || 'Cash advance',
          status: (statusByName[name] && statusByName[name].status) || 'open',
          statusLabel: (statusByName[name] && statusByName[name].label) || ''
        });
      }
    }

    var avSheet = getSheet_(ALL_VOUCHERS_SHEET);
    var avData = avSheet.getDataRange().getValues();
    for (var j = 1; j < avData.length; j++) {
      if (!safe_(avData[j][AV.VOUCHER_ID])) continue;
      if (safe_(avData[j][AV.STATUS]) === 'Rejected') continue;
      var vd = parseRdsDateString_(safe_(avData[j][AV.DATE]));
      if (isNaN(vd.getTime()) || vd < cutoff) continue;
      var vAmount = parseFloat(avData[j][AV.AMOUNT]) || 0;
      ensureDay(vd).voucherTotal += vAmount;
    }

    var result = Object.keys(days).map(function (k) {
      var d = days[k];
      var lag = (d.advanceTotal > 0.004 && d.voucherTotal <= 0.004) || (d.advanceTotal <= 0.004 && d.voucherTotal > 0.004);
      return {
        date: formatDate_(d.sortDate), sortDate: d.sortDate.getTime(),
        advanceTotal: d.advanceTotal, voucherTotal: d.voucherTotal,
        people: d.people, lag: lag
      };
    });
    result.sort(function (a, b) { return b.sortDate - a.sortDate; });
    result.forEach(function (r) { delete r.sortDate; });

    return { success: true, days: result, daysBack: daysBack };
  } catch (err) {
    Logger.log('getCashAdvanceDailyBreakdown error: ' + err);
    return { success: false, error: 'Failed to load daily breakdown: ' + err.toString() };
  }
}

// Two-letter initials for the compact avatar chip in the daily breakdown —
// display-only, no relation to any identifier elsewhere in the system.
function initialsOf_(name) {
  var clean = stripIouPrefix_(name).trim();
  if (!clean) return '?';
  var parts = clean.split(/\s+/);
  return parts.length === 1 ? parts[0].substring(0, 2).toUpperCase() : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}


// person with any advance on record, comparing SUM(every advance ever
// given to them) against SUM(every non-Rejected voucher they've ever
// submitted). The name is the only link between the two ledgers, and
// that's by design now — see the CA comment in Config.gs. ageDays counts
// from their OLDEST advance and only while a positive balance remains;
// flagged true once that crosses CASH_ADVANCE_AGE_FLAG_DAYS (30), which
// is the "check in on it regularly" signal this was built to support.
function getCashAdvanceBalances(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (!cashAdvanceViewRoleAllowed_(session.role)) return { success: false, error: 'You do not have permission to view this.' };

    var given = getCashAdvanceGivenTotals_();
    var submitted = getVoucherSubmittedTotals_();

    var now = new Date();
    var balances = Object.keys(given).map(function (name) {
      var g = given[name];
      var totalSubmitted = (submitted[name] && submitted[name].total) || 0;
      var openBalance = g.total - totalSubmitted;
      var ageDays = Math.floor((now - new Date(g.oldestDate)) / 86400000);
      return {
        givenTo: name, totalGiven: g.total, totalSubmitted: totalSubmitted,
        openBalance: openBalance, oldestAdvanceDate: formatDate_(g.oldestDate),
        ageDays: openBalance > 0.004 ? ageDays : 0,
        flagged: openBalance > 0.004 && ageDays > CASH_ADVANCE_AGE_FLAG_DAYS
      };
    });

    balances.sort(function (a, b) { return b.openBalance - a.openBalance; });

    return { success: true, balances: balances, ageFlagDays: CASH_ADVANCE_AGE_FLAG_DAYS };
  } catch (err) {
    Logger.log('getCashAdvanceBalances error: ' + err);
    return { success: false, error: 'Failed to load Cash Advance balances: ' + err.toString() };
  }
}

// { personName: { total, oldestDate } } across every Cash Advances row.
function getCashAdvanceGivenTotals_() {
  var sheet = getOrCreateCashAdvancesSheet_();
  var lastRow = sheet.getLastRow();
  var result = {};
  if (lastRow < 2) return result;
  var data = sheet.getRange(2, 1, lastRow - 1, EXPECTED_CASH_ADVANCES_HEADERS.length).getValues();
  for (var i = 0; i < data.length; i++) {
    var name = safe_(data[i][CA.GIVEN_TO]);
    if (!name) continue;
    var amount = parseFloat(data[i][CA.AMOUNT]) || 0;
    var d = data[i][CA.DATE_GIVEN];
    if (!result[name]) result[name] = { total: 0, oldestDate: d };
    result[name].total += amount;
    if (new Date(d) < new Date(result[name].oldestDate)) result[name].oldestDate = d;
  }
  return result;
}

// { personName: { total } } across every non-Rejected All Vouchers row —
// "non-Rejected" because a rejected voucher was never a valid expense
// that actually consumed the advance; if it's later resubmitted, its
// status moves off Rejected and it counts again at that point.
function getVoucherSubmittedTotals_() {
  var sheet = getSheet_(ALL_VOUCHERS_SHEET);
  var data = sheet.getDataRange().getValues();
  var result = {};
  for (var i = 1; i < data.length; i++) {
    if (!safe_(data[i][AV.VOUCHER_ID])) continue;
    if (safe_(data[i][AV.STATUS]) === 'Rejected') continue;
    var name = safe_(data[i][AV.SUBMITTED_BY]);
    if (!name) continue;
    var amount = parseFloat(data[i][AV.AMOUNT]) || 0;
    if (!result[name]) result[name] = { total: 0 };
    result[name].total += amount;
  }
  return result;
}

// Ledger view (per explicit instruction) — one person's full history:
// every advance given to them (Dr) and every non-Rejected voucher they've
// submitted (Cr), merged in date order with a running balance. The name
// is the only link, per the CA comment in Config.gs — this deliberately
// does NOT try to match a specific voucher to a specific advance.
function getCashAdvanceLedger(personName, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (!cashAdvanceViewRoleAllowed_(session.role)) return { success: false, error: 'You do not have permission to view this.' };

    personName = String(personName || '').trim();
    if (!personName) return { success: false, error: 'Select a person.' };

    var entries = [];

    var caSheet = getOrCreateCashAdvancesSheet_();
    var caLastRow = caSheet.getLastRow();
    if (caLastRow >= 2) {
      var caData = caSheet.getRange(2, 1, caLastRow - 1, EXPECTED_CASH_ADVANCES_HEADERS.length).getValues();
      for (var i = 0; i < caData.length; i++) {
        if (safe_(caData[i][CA.GIVEN_TO]) !== personName) continue;
        entries.push({
          date: caData[i][CA.DATE_GIVEN], sortDate: new Date(caData[i][CA.DATE_GIVEN]).getTime(),
          type: 'Advance', ref: safe_(caData[i][CA.ADVANCE_ID]),
          description: safe_(caData[i][CA.PURPOSE]) || 'Cash advance',
          dr: parseFloat(caData[i][CA.AMOUNT]) || 0, cr: 0
        });
      }
    }

    var avSheet = getSheet_(ALL_VOUCHERS_SHEET);
    var avData = avSheet.getDataRange().getValues();
    for (var j = 1; j < avData.length; j++) {
      var vid = safe_(avData[j][AV.VOUCHER_ID]);
      if (!vid) continue;
      if (safe_(avData[j][AV.STATUS]) === 'Rejected') continue;
      if (safe_(avData[j][AV.SUBMITTED_BY]) !== personName) continue;
      var d = parseRdsDateString_(safe_(avData[j][AV.DATE]));
      entries.push({
        date: safe_(avData[j][AV.DATE]), sortDate: d.getTime(),
        type: 'Voucher', ref: vid,
        description: safe_(avData[j][AV.EXPENSE_TYPE]) || 'Voucher submitted',
        dr: 0, cr: parseFloat(avData[j][AV.AMOUNT]) || 0
      });
    }

    entries.sort(function (a, b) { return a.sortDate - b.sortDate; });
    var running = 0;
    entries.forEach(function (e) {
      running += e.dr - e.cr;
      e.balance = running;
      e.date = (typeof e.date === 'string') ? e.date : formatDate_(e.date);
      delete e.sortDate;
    });

    // Status header info (per explicit instruction) — same open/settled/
    // flagged computation as getCashAdvanceBalances, scoped to just this
    // person, so the ledger view can show it without a second round trip.
    var given = getCashAdvanceGivenTotals_();
    var status = 'settled', statusLabel = 'Settled', ageDays = 0;
    if (running > 0.004 && given[personName]) {
      ageDays = Math.floor((new Date() - new Date(given[personName].oldestDate)) / 86400000);
      var flagged = ageDays > CASH_ADVANCE_AGE_FLAG_DAYS;
      status = flagged ? 'flagged' : 'open';
      statusLabel = flagged ? 'Flagged \u00b7 ' + ageDays + 'd open' : 'Open';
    }

    return {
      success: true, personName: stripIouPrefix_(personName), entries: entries, closingBalance: running,
      initials: initialsOf_(personName), status: status, statusLabel: statusLabel
    };
  } catch (err) {
    Logger.log('getCashAdvanceLedger error: ' + err);
    return { success: false, error: 'Failed to load ledger: ' + err.toString() };
  }
}

// Full entry list, most recent first — powers the Admin correction table.
function getCashAdvanceEntries(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };

    var sheet = getOrCreateCashAdvancesSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, entries: [] };

    var data = sheet.getRange(2, 1, lastRow - 1, EXPECTED_CASH_ADVANCES_HEADERS.length).getValues();
    var entries = [];
    for (var i = 0; i < data.length; i++) {
      if (!safe_(data[i][CA.ADVANCE_ID])) continue;
      entries.push({
        advanceId: safe_(data[i][CA.ADVANCE_ID]), dateGiven: formatDate_(data[i][CA.DATE_GIVEN]),
        givenTo: safe_(data[i][CA.GIVEN_TO]),
        amount: parseFloat(data[i][CA.AMOUNT]) || 0, purpose: safe_(data[i][CA.PURPOSE]),
        givenBy: safe_(data[i][CA.GIVEN_BY])
      });
    }
    entries.reverse();
    return { success: true, entries: entries };
  } catch (err) {
    Logger.log('getCashAdvanceEntries error: ' + err);
    return { success: false, error: 'Failed to load Cash Advance entries: ' + err.toString() };
  }
}

// Admin correction — amount only.
function adminEditCashAdvance(advanceId, newAmount, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };

    newAmount = parseFloat(newAmount);
    if (isNaN(newAmount) || newAmount <= 0) return { success: false, error: 'Enter a valid amount greater than 0.' };

    var sheet = getOrCreateCashAdvancesSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Entry not found.' };

    var data = sheet.getRange(2, 1, lastRow - 1, EXPECTED_CASH_ADVANCES_HEADERS.length).getValues();
    for (var i = 0; i < data.length; i++) {
      if (safe_(data[i][CA.ADVANCE_ID]) !== advanceId) continue;
      var rowIndex = i + 2;
      sheet.getRange(rowIndex, CA.AMOUNT + 1).setValue(newAmount);
      sheet.getRange(rowIndex, CA.LAST_UPDATED + 1).setValue(new Date());
      logAction_('ADVANCE_EDIT', advanceId, session.displayName || session.role, session.role, 'Amount corrected to Rs. ' + newAmount);
      return { success: true, message: 'Advance amount updated.' };
    }
    return { success: false, error: 'Entry not found.' };
  } catch (err) {
    Logger.log('adminEditCashAdvance error: ' + err);
    return { success: false, error: 'Failed to update: ' + err.toString() };
  }
}

// Admin removal.
function adminRemoveCashAdvance(advanceId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };

    var sheet = getOrCreateCashAdvancesSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Entry not found.' };

    var data = sheet.getRange(2, 1, lastRow - 1, EXPECTED_CASH_ADVANCES_HEADERS.length).getValues();
    for (var i = 0; i < data.length; i++) {
      if (safe_(data[i][CA.ADVANCE_ID]) !== advanceId) continue;
      sheet.deleteRow(i + 2);
      logAction_('ADVANCE_DELETE', advanceId, session.displayName || session.role, session.role, 'Entry removed');
      return { success: true, message: 'Advance entry removed.' };
    }
    return { success: false, error: 'Entry not found.' };
  } catch (err) {
    Logger.log('adminRemoveCashAdvance error: ' + err);
    return { success: false, error: 'Failed to remove: ' + err.toString() };
  }
}