// ============================================================================
// MASTER DATA — employees, vendors, cost centres, ledgers, vehicles
// ============================================================================
// Unchanged from v8.2 except getAdminVendorList, added at the bottom for the
// new admin role's read-only vendor/TDS view (today's minimal admin page —
// the write side, adding a vendor, is tomorrow's work).

function getEmployees_() {
  var vals = getSheet_(MASTER_DATA_SHEET).getRange('A2:A').getValues();
  var list = [];
  for (var i = 0; i < vals.length; i++) { if (!vals[i][0]) break; list.push(String(vals[i][0]).trim()); }
  return list.sort();
}

function getVendorsWithTDS_() {
  var sheet = getSheet_(MASTER_DATA_SHEET);
  // Single read across the whole vendor block now (D:I — name through
  // ledger balance) rather than two separate range reads; simpler now
  // that ledger balance is a first-class field every caller may need.
  var vals = sheet.getRange('D2:I').getValues();
  var map = {};
  for (var i = 0; i < vals.length; i++) {
    if (!vals[i][0]) break;
    var name = String(vals[i][0]).trim();
    var declarationOnFile = String(vals[i][4] || '').trim() === 'Yes'; // H
    // A 194C(6) declaration on file is a categorical statutory exemption
    // from TDS for that vendor — not something the TDS Applicable/Rate
    // columns can independently override. Enforced HERE, at the read
    // boundary, rather than only at addVendor's write time, so this
    // stays true no matter how the sheet got into this state — the
    // admin UI, a manually-edited cell, or legacy data from before this
    // rule existed all resolve to the same answer. If E currently says
    // "Applicable" for a declared vendor, that's stale/contradictory
    // data in the sheet; this always sides with the declaration.
    map[name] = {
      tdsApplicable: declarationOnFile ? false : (String(vals[i][1]).trim() === 'Applicable'), // E
      tdsRate: declarationOnFile ? 0 : (vals[i][2] ? parseFloat(String(vals[i][2]).replace('%', '')) / 100 : 0), // F — fallback rate only, see resolveVendorTdsForAmount
      pan: String(vals[i][3] || '').trim().toUpperCase(), // G
      declarationOnFile: declarationOnFile, // H
      ledgerBalance: parseFloat(vals[i][5]) || 0 // I
    };
  }
  return map;
}

// ----------------------------------------------------------------------------
// UNIFIED TDS DECISION (per explicit instruction) — the single canonical
// place that decides whether a bill against a Transport vendor gets TDS,
// and at what rate. Every place in the codebase that used to compute TDS
// off raw Master Data fields (submission, the query-scoped line-edit
// path, and the export-time threshold safety net) now goes through this
// instead, so the rule can never drift between call sites.
//
// Precedence, exactly as specified:
//   1. 194C declaration on file  -> TDS NOT applicable. Full stop. This
//      overrides EVERYTHING below — an applicable flag, a crossed
//      threshold, none of it matters once a declaration is on file.
//   2. Otherwise, TDS IS applicable if EITHER the Master Data "TDS
//      Applicable" flag says so, OR this bill pushes the vendor's
//      Ledger Balance (column I, the running total BEFORE this bill)
//      past the Rs. 30,000 single-bill / Rs. 1,00,000 cumulative 194C
//      threshold — even if the sheet says "Not Applicable" / rate 0.
//   3. Whenever TDS IS applicable, the RATE always comes from the 4th
//      character of the vendor's PAN (C = 2%, anything else = 1%) —
//      this OVERRIDES whatever is sitting in the TDS Rate % column.
//      The Rate % column is used only as a FALLBACK when the PAN is
//      missing or doesn't match the standard PAN shape; if neither a
//      valid PAN nor a fallback rate is available, this returns a
//      warning instead of guessing.
//
// FIXED (per explicit instruction, Option B): the threshold check below
// now reads from the Vendor FY Ledger sheet (VENDOR_FY_LEDGER_SHEET,
// getVendorFyLedgerBalance/updateVendorFyLedgerBalance, this file) — a
// per-vendor, per-financial-year running total — instead of Master
// Data's lifetime "Ledger Balance" column I. This closes the old gap
// where a vendor who crossed Rs. 1,00,000 lifetime years ago showed as
// threshold-triggered forever, even in a FY where actual YTD billing was
// nowhere near the threshold. Submission-time and export-time
// (computeTdsThresholdOverridesForFy, Tally Export.gs) now agree by
// construction: both key off the same getFinancialYearBounds() and both
// reset every April 1. Master Data column I is left untouched and is no
// longer read here — it remains available as an admin-editable lifetime
// reference figure, but no longer drives any TDS decision.
//
// billDateForFy: the voucher's own bill date (a Date, or a formatted
// date STRING as stored in AV.DATE — parsed via parseRdsDateString if
// not already a Date). This MUST be the voucher's true, immutable
// AV.DATE — never "today" for a resubmit/query-edit — so a voucher's FY
// assignment can never drift between its original submission and any
// later edit. Defaults to now() if omitted, so an old caller that
// doesn't pass this still works, just without FY precision.
//
// baseAmount should be the amount BEFORE GST when known (GST review
// time); at submission GST isn't known yet so the full bill amount is
// used, matching how it always worked pre-PAN-rate.
//
// extraPriorAmountThisTransaction (optional, default 0): amount from
// OTHER vendor lines for this SAME vendor already counted within the
// current submission/edit, but not yet persisted to the FY ledger (that
// only happens after the whole voucher is written — see
// updateVendorFyLedgerBalance, this file). Only ever added to the
// CUMULATIVE check, never the single-bill check — a voucher with two
// separate Rs. 20,000 bills for the same vendor is still two Rs. 20,000
// bills, neither of which crosses the single-bill threshold on its own,
// but their COMBINED Rs. 40,000 should still count toward the annual
// cumulative check.
function resolveVendorTdsForAmount_(vendorName, baseAmount, extraPriorAmountThisTransaction, billDateForFy) {
  extraPriorAmountThisTransaction = extraPriorAmountThisTransaction || 0;
  var vendorTDS = getVendorsWithTDS_();
  var info = vendorTDS[String(vendorName || '').trim()];
  if (!info) {
    return { applicable: false, rate: 0, tdsAmount: 0, thresholdTriggered: false, error: 'Vendor "' + vendorName + '" not found in Master Data.' };
  }

  if (info.declarationOnFile) {
    return { applicable: false, rate: 0, tdsAmount: 0, thresholdTriggered: false, reason: '194C declaration on file' };
  }

  var fyKey = getFyKeyForDateValue_(billDateForFy);
  var effectiveBalance = getVendorFyLedgerBalance_(vendorName, fyKey) + extraPriorAmountThisTransaction;
  var thresholdTriggered = baseAmount >= TDS_SINGLE_BILL_THRESHOLD || (effectiveBalance + baseAmount) >= TDS_ANNUAL_THRESHOLD;
  var applicable = info.tdsApplicable || thresholdTriggered;

  if (!applicable) {
    return { applicable: false, rate: 0, tdsAmount: 0, thresholdTriggered: false };
  }

  var rate = getPanHolderRate_(info.pan);
  var usedFallbackRate = false;
  if (rate === null) {
    if (info.tdsRate > 0) {
      rate = info.tdsRate;
      usedFallbackRate = true;
    } else {
      return {
        applicable: true, rate: 0, tdsAmount: 0, thresholdTriggered: thresholdTriggered,
        warning: 'TDS applies to vendor "' + vendorName + '" but no valid PAN and no fallback TDS Rate % is configured in Master Data \u2014 TDS was NOT calculated for this bill. Add a valid PAN or a fallback rate.'
      };
    }
  }

  return {
    applicable: true, rate: rate, tdsAmount: Math.round(baseAmount * rate),
    thresholdTriggered: thresholdTriggered, usedFallbackRate: usedFallbackRate
  };
}

// REVISED — Cost Centres / Ledgers / Vehicles each shifted one column
// right (J->K, L->M, N->O) to make room for the new Ledger Balance column
// at I (see updateVendorLedgerBalance below). Column layout is now:
// D:F vendor/TDS-applicable/TDS-rate, G:H PAN/declaration, I ledger
// balance, J spacer, K cost centres, L spacer, M ledgers, N spacer,
// O vehicles.
function getCostCentres_() {
  var vals = getSheet_(MASTER_DATA_SHEET).getRange('K2:K').getValues();
  var list = [];
  for (var i = 0; i < vals.length; i++) { if (!vals[i][0]) break; list.push(String(vals[i][0]).trim()); }
  return list.sort();
}

function getLedgers_() {
  var vals = getSheet_(MASTER_DATA_SHEET).getRange('M2:M').getValues();
  var list = [];
  for (var i = 0; i < vals.length; i++) { if (!vals[i][0]) break; list.push(String(vals[i][0]).trim()); }
  return list.sort();
}

function getVehicles_() {
  var vals = getSheet_(MASTER_DATA_SHEET).getRange('O2:O').getValues();
  var list = [];
  for (var i = 0; i < vals.length; i++) { if (!vals[i][0]) break; list.push(String(vals[i][0]).trim()); }
  return list.sort();
}

// ----------------------------------------------------------------------------
// LEDGER BALANCE (per explicit instruction) — column I, row-aligned with
// the vendor block in D:H. A running total of what's been billed against
// a Transport vendor, in Rupees, at face value: it accumulates the raw
// per-vendor amount entered on a transport voucher's vendor line, never
// TDS-adjusted, never GST-adjusted. This function (updateVendorLedgerBalance)
// applies the initial increment at SUBMISSION time only. The balance IS
// adjusted again afterwards, though — via applyVendorLedgerBalanceDelta()
// (Vouchers.gs), which nets the delta between a voucher's old and new
// per-vendor totals: on edit/resubmit (Vouchers.gs, resubmitVoucherCore),
// on a query-scoped vendor-line edit (Vouchers.gs, the query-response
// path), and on admin delete (Approval.gs, adminDeleteVoucherCompletely,
// which reverses the vendor lines entirely). See
// applyVendorLedgerBalanceDelta()'s own comment for the netting mechanism.
//
// Uses its own short-lived lock scoped to just this read-modify-write —
// the caller (saveVoucherSubmission) has already released the main
// script lock by the time this runs, and multiple submissions can post
// against the same vendor concurrently, so the increment itself must
// still be serialized or one write can clobber another.
function updateVendorLedgerBalance_(vendorName, amountToAdd) {
  vendorName = String(vendorName || '').trim();
  amountToAdd = parseFloat(amountToAdd) || 0;
  if (!vendorName || !amountToAdd) return;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    Logger.log('updateVendorLedgerBalance: lock timeout for vendor "' + vendorName + '" — Rs.' + amountToAdd + ' NOT recorded.');
    logAction_('LEDGER_BALANCE_WARNING', '', 'system', 'system',
      'Ledger balance update skipped for vendor "' + vendorName + '" (lock timeout) — Rs.' + amountToAdd + ' not recorded. Needs manual correction in Master Data column I.');
    return;
  }
  try {
    var sheet = getSheet_(MASTER_DATA_SHEET);
    var names = sheet.getRange('D2:D').getValues();
    var rowIndex = -1;
    for (var i = 0; i < names.length; i++) {
      if (!names[i][0]) break;
      if (String(names[i][0]).trim() === vendorName) { rowIndex = i + 2; break; }
    }
    if (rowIndex === -1) {
      // Shouldn't happen — buildVendorLineItems already rejects any
      // vendor name not present in Master Data before this is ever
      // called — but if the vendor block layout changes underneath this
      // some day, fail loudly in the log rather than silently losing the
      // amount.
      Logger.log('updateVendorLedgerBalance: vendor "' + vendorName + '" not found in Master Data D:D — Rs.' + amountToAdd + ' NOT recorded.');
      logAction_('LEDGER_BALANCE_WARNING', '', 'system', 'system',
        'Vendor "' + vendorName + '" not found in Master Data — Rs.' + amountToAdd + ' not recorded in Ledger Balance.');
      return;
    }
    var cell = sheet.getRange(rowIndex, 9); // column I
    var current = parseFloat(cell.getValue()) || 0;
    cell.setValue(round2_(current + amountToAdd));
  } catch (err) {
    Logger.log('updateVendorLedgerBalance error for vendor "' + vendorName + '": ' + err);
    logAction_('LEDGER_BALANCE_WARNING', '', 'system', 'system', 'Ledger balance update failed for vendor "' + vendorName + '": ' + err);
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------
// VENDOR FY LEDGER (Option B — per explicit instruction) — a per-vendor,
// per-financial-year running total, replacing Master Data's lifetime
// Ledger Balance (column I) as the input to resolveVendorTdsForAmount's
// threshold check. Lives in its own sheet (VENDOR_FY_LEDGER_SHEET,
// Config.gs): one row per Vendor + Financial Year, auto-created on first
// write. Same semantics as the old column I otherwise — raw per-vendor
// amount from a transport voucher's vendor line, never TDS-adjusted,
// never GST-adjusted — just now scoped to the FY the bill actually falls
// in (per its immutable AV.DATE), matching computeTdsThresholdOverridesForFy
// (Tally Export.gs) exactly, so submission-time and export-time can never
// disagree again.
// ----------------------------------------------------------------------------

// Resolves any accepted date shape (Date object, or a formatted date
// string as stored in AV.DATE) to a financial-year key ("2025-2026"
// style, see getFinancialYearBounds, Tally Export.gs). Falls back to
// now() for anything unparseable, rather than throwing — same
// fail-soft convention as parseRdsDateString itself.
function getFyKeyForDateValue_(dateValue) {
  var d = (dateValue instanceof Date) ? dateValue : parseRdsDateString_(dateValue);
  if (!(d instanceof Date) || isNaN(d.getTime())) d = new Date();
  return getFinancialYearBounds_(d).key;
}

// Finds or creates the Vendor FY Ledger sheet, same
// auto-create-with-headers convention as getOrCreateRdsMonthSheet
// (Sheet Utils.gs). Lives in the main spreadsheet (SHEET_ID) — this is a
// TDS/vendor concept, not an RDS one.
function getOrCreateVendorFyLedgerSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(VENDOR_FY_LEDGER_SHEET);
  if (sheet) return sheet;
  sheet = ss.insertSheet(VENDOR_FY_LEDGER_SHEET);
  sheet.getRange(1, 1, 1, EXPECTED_VENDOR_FY_LEDGER_HEADERS.length).setValues([EXPECTED_VENDOR_FY_LEDGER_HEADERS]);
  sheet.setFrozenRows(1);
  autoFitSheetColumns_(sheet, []); // READABILITY (per explicit instruction)
  return sheet;
}

// Read-only lookup — no row is created just to read a balance. A vendor
// with no row yet for this FY (first bill of the year, or a vendor
// registered after this feature shipped) is correctly 0.
function getVendorFyLedgerBalance_(vendorName, fyKey) {
  vendorName = String(vendorName || '').trim();
  var sheet = getOrCreateVendorFyLedgerSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][VFL.VENDOR_NAME]).trim() === vendorName && String(data[i][VFL.FINANCIAL_YEAR]).trim() === fyKey) {
      return parseFloat(data[i][VFL.BALANCE]) || 0;
    }
  }
  return 0;
}

// Read-modify-write, find-or-create the Vendor+FY row. Locked the same
// way updateVendorLedgerBalance is — multiple submissions can post
// against the same vendor/FY concurrently, so the increment itself must
// be serialized. amountToAdd may be negative (used by
// applyVendorFyLedgerBalanceDelta below for reversals/corrections).
function updateVendorFyLedgerBalance_(vendorName, fyKey, amountToAdd) {
  vendorName = String(vendorName || '').trim();
  fyKey = String(fyKey || '').trim();
  amountToAdd = parseFloat(amountToAdd) || 0;
  if (!vendorName || !fyKey || !amountToAdd) return;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    Logger.log('updateVendorFyLedgerBalance: lock timeout for vendor "' + vendorName + '" FY ' + fyKey + ' — Rs.' + amountToAdd + ' NOT recorded.');
    logAction_('LEDGER_BALANCE_WARNING', '', 'system', 'system',
      'FY ledger update skipped for vendor "' + vendorName + '" FY ' + fyKey + ' (lock timeout) — Rs.' + amountToAdd + ' not recorded. Needs manual correction in the Vendor FY Ledger sheet.');
    return;
  }
  try {
    var sheet = getOrCreateVendorFyLedgerSheet_();
    var lastRow = sheet.getLastRow();
    var rowIndex = -1;
    if (lastRow >= 2) {
      var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
      for (var i = 0; i < data.length; i++) {
        if (String(data[i][VFL.VENDOR_NAME]).trim() === vendorName && String(data[i][VFL.FINANCIAL_YEAR]).trim() === fyKey) {
          rowIndex = i + 2;
          break;
        }
      }
    }
    if (rowIndex === -1) {
      sheet.appendRow([vendorName, fyKey, round2_(amountToAdd)]);
    } else {
      var cell = sheet.getRange(rowIndex, VFL.BALANCE + 1);
      var current = parseFloat(cell.getValue()) || 0;
      cell.setValue(round2_(current + amountToAdd));
    }
  } catch (err) {
    Logger.log('updateVendorFyLedgerBalance error for vendor "' + vendorName + '" FY ' + fyKey + ': ' + err);
    logAction_('LEDGER_BALANCE_WARNING', '', 'system', 'system', 'FY ledger update failed for vendor "' + vendorName + '" FY ' + fyKey + ': ' + err);
  } finally {
    lock.releaseLock();
  }
}

// FY-scoped counterpart to applyVendorLedgerBalanceDelta (Vouchers.gs) —
// same old-vs-new per-vendor delta netting, applied to a single FY's
// ledger row per vendor. All of a given voucher's vendor lines share one
// FY (the voucher's own immutable AV.DATE never changes across an edit),
// so a single fyKey covers the whole call.
function applyVendorFyLedgerBalanceDelta_(oldSummary, newSummary, fyKey) {
  var allNames = {};
  Object.keys(oldSummary || {}).forEach(function (n) { allNames[n] = true; });
  Object.keys(newSummary || {}).forEach(function (n) { allNames[n] = true; });
  Object.keys(allNames).forEach(function (name) {
    var oldTotal = (oldSummary && oldSummary[name]) ? oldSummary[name].totalAmount : 0;
    var newTotal = (newSummary && newSummary[name]) ? newSummary[name].totalAmount : 0;
    var delta = round2_(newTotal - oldTotal);
    if (delta !== 0) updateVendorFyLedgerBalance_(name, fyKey, delta);
  });
}

// Voucher IDs are plain numbers only (per the real sheet's existing
// convention) — no letters/hyphens/underscores. The duplicate check
// (checkVoucherIdExists / the live check on blur) stays exactly as before;
// this only tightens the FORMAT, not the uniqueness rule.
function validateVoucherId_(id) {
  if (!id || typeof id !== 'string') return { valid: false, error: 'Voucher ID must be a string.' };
  var trimmed = id.trim();
  if (trimmed.length === 0) return { valid: false, error: 'Voucher ID cannot be empty.' };
  if (trimmed.length > 15) return { valid: false, error: 'Voucher ID is too long.' };
  if (!/^[0-9]+$/.test(trimmed)) {
    return { valid: false, error: 'Voucher ID must be numbers only.' };
  }
  return { valid: true, id: trimmed };
}

function validateLedgerName_(ledgerName) {
  var validLedgers = getLedgers_();
  if (validLedgers.indexOf(ledgerName) === -1) {
    return { valid: false, error: 'Invalid ledger: ' + ledgerName };
  }
  return { valid: true };
}

function validateCostCentre_(costCentre) {
  var validCentres = getCostCentres_();
  if (validCentres.indexOf(costCentre) === -1) {
    return { valid: false, error: 'Invalid cost centre: ' + costCentre };
  }
  return { valid: true };
}

function validateEmployee_(employee) {
  var validEmployees = getEmployees_();
  if (validEmployees.indexOf(employee) === -1) {
    return { valid: false, error: 'Invalid employee: ' + employee };
  }
  return { valid: true };
}

function getFormData(token) {
  var session = validateSession_(token);
  if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
  var vendors = getVendorsWithTDS_();
  return {
    success: true, employees: getEmployees_(), vendors: Object.keys(vendors).sort(), vendorTDS: vendors,
    costCentres: getCostCentres_(), ledgers: getLedgers_(), vehicles: getVehicles_(),
    suggestedVoucherNo: getNextSuggestedVoucherNumber_(),
    maxFiles: MAX_FILES_PER_UPLOAD
  };
}

// Read-only vendor + TDS view for the admin role. Sorted for a stable,
// scannable list rather than Master Data's raw sheet order.
function getAdminVendorList(token) {
  var session = validateSession_(token);
  if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
  if (session.role !== 'admin') return { success: false, error: 'You do not have permission to view vendor management.' };

  var vendors = getVendorsWithTDS_();
  var list = Object.keys(vendors).sort().map(function (name) {
    return {
      name: name,
      tdsApplicable: vendors[name].tdsApplicable,
      tdsRate: vendors[name].tdsRate,
      pan: vendors[name].pan,
      declarationOnFile: vendors[name].declarationOnFile,
      ledgerBalance: vendors[name].ledgerBalance
    };
  });
  return { success: true, vendors: list };
}

// Standard PAN structure: 5 letters, 4 digits, 1 letter (e.g.
// ABCDE1234F) — the 4th letter is a holder-type code (P=Individual,
// H=HUF, C=Company, F=Firm, A=AOP, B=BOI, G=Government, J=Artificial
// Judicial Person, L=Local Authority, T=Trust) and the 5th a
// surname/name initial. Case-insensitive on input, always
// stored/compared uppercase (PAN convention).
var PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
function validatePAN_(pan) {
  var p = String(pan || '').trim().toUpperCase();
  if (!p) return { valid: true, pan: '' }; // optional field — blank is fine
  if (!PAN_REGEX.test(p)) {
    return { valid: false, error: 'PAN must be in the format ABCDE1234F (5 letters, 4 digits, 1 letter).' };
  }
  return { valid: true, pan: p };
}

// 194C TDS rate purely from PAN holder-type, per explicit instruction:
// 4th character 'C' (Company) => 2%, anything else => 1%. Returns null
// if the PAN doesn't match the standard shape at all (missing/malformed
// — resolveVendorTdsForAmount falls back to the Master Data Rate %
// column in that case).
//
// FLAGGED, not silently implemented: this is a simplification of the
// real 194C split (Individual/HUF = 1%, every OTHER payee type = 2%).
// Under the real rule, Firms (F), AOPs (A), BOIs (B), Trusts (T),
// Government (G), Local Authorities (L), and Artificial Judicial
// Persons (J) are all 2%, same as Companies — only P (Individual) and H
// (HUF) are genuinely 1%.
//
// FIXED (per explicit instruction): this previously treated PAN holder
// type 'C' as 2% and everything else — including F/A/B/T/G/L/J — as 1%,
// which under-withheld TDS for Firms, Trusts, AOPs, BOIs, Government
// bodies, Local Authorities, and Artificial Judicial Persons. Corrected
// to the actual 194C split: only Individual (P) and HUF (H) get 1%;
// every other holder type gets 2%.
//
// NOT retroactive, by construction: this function is only ever called
// live, at submission time (resolveVendorTdsForAmount, via
// buildVendorLineItems) and at query-response line-edit time (via
// updateTransportBreakdownLines) — it never re-runs against historical
// Transport Breakdown rows. A bill already GST-reviewed or already
// Tally-exported keeps whatever rate was stored on it at that time.
// Operational note: any vendor with a non-P/H/C-type PAN who has a bill
// still sitting anywhere in the approval pipeline will get the higher
// (correct) 2% rate the next time that line is touched (GST review or a
// query-response amount/vendor correction) — worth a heads-up to
// Accounts rather than a surprise mid-review.
function getPanHolderRate_(pan) {
  var p = String(pan || '').trim().toUpperCase();
  if (!PAN_REGEX.test(p)) return null;
  var holderType = p.charAt(3);
  return (holderType === 'P' || holderType === 'H') ? 0.01 : 0.02;
}

// Shared by addVendor and updateVendorMasterData — every field-level
// validation (name shape, PAN format, declaration/TDS coercion,
// non-negative ledger balance) lives here exactly once so add and edit
// can never quietly diverge on what "valid" means.
function validateVendorMasterFields_(name, tdsApplicable, tdsRate, pan, declarationOnFile, ledgerBalance) {
  name = String(name || '').trim();
  if (!name) return { valid: false, error: 'Vendor name is required.' };
  if (name.length > 100) return { valid: false, error: 'Vendor name is too long.' };

  declarationOnFile = !!declarationOnFile;
  tdsApplicable = !!tdsApplicable;
  var rate = 0;
  // A 194C(6) declaration on file is a categorical TDS exemption — it
  // overrides whatever the TDS Applicable/Rate fields were set to,
  // rather than being validated as a conflicting combination. Matches
  // the same rule enforced at read time in getVendorsWithTDS, and in
  // the actual TDS decision in resolveVendorTdsForAmount.
  if (declarationOnFile) {
    tdsApplicable = false;
    rate = 0;
  } else if (tdsApplicable) {
    rate = parseFloat(tdsRate);
    if (ALLOWED_TDS_RATES.indexOf(rate) === -1) {
      return { valid: false, error: 'TDS rate must be 1% or 2%.' };
    }
  }

  var panResult = validatePAN_(pan);
  if (!panResult.valid) return { valid: false, error: panResult.error };

  var balance = (ledgerBalance === '' || ledgerBalance === null || ledgerBalance === undefined) ? 0 : parseFloat(ledgerBalance);
  if (isNaN(balance) || balance < 0) {
    return { valid: false, error: 'Ledger Balance must be a number of 0 or more.' };
  }

  return {
    valid: true, name: name, tdsApplicable: tdsApplicable, rate: rate,
    pan: panResult.pan, declarationOnFile: declarationOnFile, ledgerBalance: round2_(balance)
  };
}

// Admin-only: register a new vendor. Per your instruction, this is
// deliberately admin-only (not accounts, not L1/L2) — vendor registration
// needs the actual registration/TDS-formality checks done before a vendor
// can be paid through the system, and admin is the role reserved for that
// kind of system-configuration control.
//
// Writes into Master Data's D:I range (Vendor Name / TDS Applicability /
// TDS Rate % / PAN / 194C Declaration / Ledger Balance — one contiguous
// vendor block), appending after whatever vendor rows already exist
// there — NOT sheet.appendRow(), which would append at the sheet's
// overall last row and land far below column D since Employees (column
// A) runs to row 60+. Master Data is several independent column-siloed
// lists sharing one sheet, each with its own row count.
//
// ledgerBalance lets admin set a real STARTING balance for a vendor that
// already has billing history predating this system (the one-time setup
// this whole feature exists for) — it's added to, never silently reset,
// by every submission after that (updateVendorLedgerBalance, Vouchers.gs).
function addVendor(name, tdsApplicable, tdsRate, pan, declarationOnFile, ledgerBalance, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin') return { success: false, error: 'You do not have permission to add vendors.' };

    var v = validateVendorMasterFields_(name, tdsApplicable, tdsRate, pan, declarationOnFile, ledgerBalance);
    if (!v.valid) return { success: false, error: v.error };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var sheet = getSheet_(MASTER_DATA_SHEET);
      var existing = getVendorsWithTDS_();
      if (existing.hasOwnProperty(v.name)) {
        return { success: false, error: 'Vendor "' + v.name + '" is already registered.' };
      }
      // PAN uniqueness (24 Aug 2026, flagged) — a blank PAN is exempt
      // (PAN is optional, and every blank PAN would otherwise "duplicate"
      // every other blank one). A duplicate PAN under a different name is
      // exactly the case this exists to catch — same taxpayer registered
      // twice, which would double-count against the same PAN's real 194C
      // threshold and TDS obligations without anyone noticing.
      if (v.pan) {
        var panOwner = Object.keys(existing).find(function (n) { return existing[n].pan === v.pan; });
        if (panOwner) {
          return { success: false, error: 'PAN ' + v.pan + ' is already registered to vendor "' + panOwner + '".' };
        }
      }

      // Find the first empty row in column D specifically, not the sheet's
      // overall last row.
      var colD = sheet.getRange('D2:D').getValues();
      var targetRow = colD.length + 2; // default: one past the last value found
      for (var i = 0; i < colD.length; i++) {
        if (!colD[i][0]) { targetRow = i + 2; break; }
      }

      sheet.getRange(targetRow, 4).setValue(v.name);                                                    // D
      sheet.getRange(targetRow, 5).setValue(v.tdsApplicable ? 'Applicable' : 'Not Applicable');          // E
      sheet.getRange(targetRow, 6).setValue(v.tdsApplicable ? v.rate : 0);                               // F
      sheet.getRange(targetRow, 7).setValue(v.pan);                                                       // G
      sheet.getRange(targetRow, 8).setValue(v.declarationOnFile ? 'Yes' : 'No');                         // H
      sheet.getRange(targetRow, 9).setValue(v.ledgerBalance);                                            // I

      logAction_('ADD_VENDOR', '', session.displayName || session.role, session.role,
        v.name + (v.tdsApplicable ? ' (TDS ' + v.rate + '%)' : ' (no TDS' + (v.declarationOnFile ? ', 194C declaration on file' : '') + ')') +
        (v.pan ? ', PAN ' + v.pan : '') + (v.ledgerBalance ? ', starting Ledger Balance Rs.' + v.ledgerBalance : ''));

      return { success: true, message: 'Vendor "' + v.name + '" added.' + (v.declarationOnFile ? ' (TDS set to Not Applicable — 194C declaration on file.)' : '') };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('addVendor error: ' + err);
    return { success: false, error: 'Failed to add vendor: ' + err.toString() };
  }
}

// Admin-only: edit an EXISTING vendor's full Master Data record in one
// pass — this is the "master control" replacement for hand-editing the
// sheet. Vendor Name is the lookup key and is NOT renameable here
// (Transport Breakdown, past vouchers, and Ledger Balance are all keyed
// on the name as plain text, not a stable ID — renaming would silently
// orphan every historical reference; register a new vendor instead if a
// name genuinely needs to change).
function updateVendorMasterData(name, tdsApplicable, tdsRate, pan, declarationOnFile, ledgerBalance, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin') return { success: false, error: 'You do not have permission to edit vendors.' };

    var v = validateVendorMasterFields_(name, tdsApplicable, tdsRate, pan, declarationOnFile, ledgerBalance);
    if (!v.valid) return { success: false, error: v.error };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var sheet = getSheet_(MASTER_DATA_SHEET);
      var colD = sheet.getRange('D2:D').getValues();
      var targetRow = -1;
      for (var i = 0; i < colD.length; i++) {
        if (!colD[i][0]) break;
        if (String(colD[i][0]).trim() === v.name) { targetRow = i + 2; break; }
      }
      if (targetRow === -1) return { success: false, error: 'Vendor "' + v.name + '" not found.' };

      // PAN uniqueness on edit too (24 Aug 2026, flagged) — excludes this
      // vendor's own existing row (re-saving the same PAN unchanged is
      // not a duplicate), same blank-PAN exemption as addVendor.
      if (v.pan) {
        var existingForEdit = getVendorsWithTDS_();
        var panOwnerEdit = Object.keys(existingForEdit).find(function (n) { return n !== v.name && existingForEdit[n].pan === v.pan; });
        if (panOwnerEdit) {
          return { success: false, error: 'PAN ' + v.pan + ' is already registered to vendor "' + panOwnerEdit + '".' };
        }
      }

      var before = sheet.getRange(targetRow, 5, 1, 5).getValues()[0]; // E:I, for the audit diff below

      sheet.getRange(targetRow, 5).setValue(v.tdsApplicable ? 'Applicable' : 'Not Applicable');          // E
      sheet.getRange(targetRow, 6).setValue(v.tdsApplicable ? v.rate : 0);                               // F
      sheet.getRange(targetRow, 7).setValue(v.pan);                                                       // G
      sheet.getRange(targetRow, 8).setValue(v.declarationOnFile ? 'Yes' : 'No');                         // H
      sheet.getRange(targetRow, 9).setValue(v.ledgerBalance);                                            // I

      logAction_('EDIT_VENDOR', '', session.displayName || session.role, session.role,
        v.name + ': TDS ' + before[0] + '/' + before[1] + '% \u2192 ' + (v.tdsApplicable ? 'Applicable/' + v.rate : 'Not Applicable/0') + '%' +
        ', PAN ' + (before[2] || '\u2014') + ' \u2192 ' + (v.pan || '\u2014') +
        ', Declaration ' + before[3] + ' \u2192 ' + (v.declarationOnFile ? 'Yes' : 'No') +
        ', Ledger Balance Rs.' + (parseFloat(before[4]) || 0) + ' \u2192 Rs.' + v.ledgerBalance);

      return { success: true, message: 'Vendor "' + v.name + '" updated.' };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('updateVendorMasterData error: ' + err);
    return { success: false, error: 'Failed to update vendor: ' + err.toString() };
  }
}

// Admin-only: register a new Regular-expense vendor (handoff 2.C —
// separate list from Transport's Master Data vendor block, no TDS
// fields since TDS is not applicable to this flow). Same validation
// rigor as addVendor above: PAN format (optional field, same
// ABCDE1234F shape via validatePAN) and name uniqueness — deliberately
// admin-gated for the same reason addVendor is: a vendor becomes
// payable through the system the moment it's selectable here.
function addRegularVendor_(name, pan, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin') return { success: false, error: 'You do not have permission to add vendors.' };

    name = String(name || '').trim();
    if (!name) return { success: false, error: 'Vendor name is required.' };
    if (name.length > 100) return { success: false, error: 'Vendor name is too long.' };

    var panResult = validatePAN_(pan);
    if (!panResult.valid) return { success: false, error: panResult.error };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var sheet = getOrCreateRegularVendorMasterSheet_();
      var existing = getRegularVendorsList_();
      if (existing.hasOwnProperty(name)) {
        return { success: false, error: 'Vendor "' + name + '" is already registered.' };
      }
      // PAN uniqueness (24 Aug 2026, flagged) — same rule as addVendor
      // (Transport vendors); blank PAN is exempt since it's an optional
      // field and every blank would otherwise "duplicate" every other one.
      if (panResult.pan) {
        var panOwner = Object.keys(existing).find(function (n) { return existing[n].pan === panResult.pan; });
        if (panOwner) {
          return { success: false, error: 'PAN ' + panResult.pan + ' is already registered to vendor "' + panOwner + '".' };
        }
      }
      sheet.appendRow([name, panResult.pan]);

      logAction_('ADD_REGULAR_VENDOR', '', session.displayName || session.role, session.role,
        name + (panResult.pan ? ', PAN ' + panResult.pan : ''));

      return { success: true, message: 'Vendor "' + name + '" added.' };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('addRegularVendor error: ' + err);
    return { success: false, error: 'Failed to add vendor: ' + err.toString() };
  }
}

// Read-only list for the Accounts-side Regular voucher review dropdown
// and the Admin > Vendors panel. No session role restriction beyond a
// valid session — same posture as other plain read RPCs in this file.
function getRegularVendorsForClient_(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    var list = getRegularVendorsList_();
    return { success: true, vendors: Object.keys(list).sort() };
  } catch (err) {
    Logger.log('getRegularVendorsForClient error: ' + err);
    return { success: false, error: 'Failed to load vendors: ' + err.toString() };
  }
}

// Makes a string safe to use as a Drive file/folder name: no path or
// wildcard characters, control characters removed, whitespace collapsed,
// length capped.
function safeDriveName_(s, maxLen) {
  return String(s === null || s === undefined ? '' : s).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').substring(0, maxLen || 80);
}

// Keeps a copy of the bill sent with a new-vendor request:
//   Rabale Expense System / Vendor Requests / <vendor> (<dd-MM-yyyy>) / <file>
// Same top-level folder and the same domain-only sharing as voucher bills
// (bills can carry GST numbers and bank details). NEVER throws \u2014 returns
// {success:false, error} so the caller can carry on with the email. Sharing
// failure is non-fatal (the file simply stays private to the owner).
function saveVendorRequestBillToDrive_(vendorName, blob, when) {
  try {
    var root = DriveApp.getRootFolder();
    var expFolder = getOrCreateDriveFolder_(root, 'Rabale Expense System');
    var requestsFolder = getOrCreateDriveFolder_(expFolder, VENDOR_REQUEST_DRIVE_FOLDER);
    var folder = getOrCreateDriveFolder_(requestsFolder, (safeDriveName_(vendorName, 80) || 'Vendor') + ' (' + formatDate_(when) + ')');
    try {
      folder.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (shareErr) {
      Logger.log('saveVendorRequestBillToDrive_: could not set domain sharing, left private: ' + shareErr);
    }
    var file = folder.createFile(blob);
    return { success: true, file: file, url: file.getUrl(), folderUrl: folder.getUrl() };
  } catch (err) {
    Logger.log('saveVendorRequestBillToDrive_ error: ' + err);
    return { success: false, error: String(err && err.message ? err.message : err) };
  }
}

// ============================================================================
// NEW VENDOR REQUEST (per explicit instruction) — submission can't add a
// vendor directly (addVendor above stays admin-only, since it writes
// straight into Master Data with no review step), but a transport voucher
// can't be submitted against a vendor that isn't registered yet
// (buildVendorLineItems, Vouchers.gs, rejects unknown vendor names
// outright). This gives submission a way to ask for one to be added,
// with the vendor's bill attached as proof, emailed to whoever's
// configured to actually add it — no direct write to Master Data happens
// here at all, it's purely a notification.
// ============================================================================
function requestNewVendor(vendorName, fileJson, notes, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'submission') return { success: false, error: 'You do not have permission to do this.' };

    vendorName = String(vendorName || '').trim();
    if (!vendorName) return { success: false, error: 'Vendor name is required.' };
    if (vendorName.length > 100) return { success: false, error: 'Vendor name is too long.' };

    var existing = getVendorsWithTDS_();
    if (existing.hasOwnProperty(vendorName)) {
      return { success: false, error: 'Vendor "' + vendorName + '" is already registered \u2014 no need to request it.' };
    }

    var recipient = getVendorRequestEmail_();
    if (!recipient) {
      return { success: false, error: 'Vendor request email is not configured yet \u2014 ask admin to set the VENDOR_REQUEST_EMAIL Script Property.' };
    }

    var file = null;
    if (fileJson) {
      try { file = JSON.parse(fileJson); } catch (e) { file = null; }
    }
    if (!file || !file.data) {
      return { success: false, error: 'Please attach the vendor\u2019s bill.' };
    }
    var estSize = (file.data || '').length * 0.75;
    if (estSize > MAX_FILE_SIZE_BYTES) {
      return { success: false, error: 'File exceeds ' + Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024)) + 'MB limit.' };
    }
    var madeBill = billBlobFromClientFile_(file, vendorName + '_bill'); // v5: type decided from the file's own bytes
    if (madeBill.error) return { success: false, error: 'The bill must be a ' + BILL_TYPES_LABEL + ' file.' };

    notes = String(notes || '').trim();
    if (notes.length > 500) notes = notes.substring(0, 500);

    var subject = 'New Vendor Request: ' + vendorName;
    // Content is built in Notifications.gs (plain text here; HTML inside sendNotification_).
    var vendorMail = { vendorName: vendorName, requestedBy: nameWithPosition_(session.displayName || 'submission', session.designation), dateText: new Date().toLocaleString('en-IN'), notes: notes, driveUrl: '' };

    // The bill is emailed AND kept in Drive. Order: save the Drive copy first
    // (best effort \u2014 its link goes into the email), then send. If the SEND
    // fails the Drive copy is trashed again, so a failed attempt leaves no
    // orphan file and a retry cannot create a duplicate. If the Drive save
    // itself fails the email still goes (the bill is attached to it) and the
    // gap is reported to the submitter and written to the Audit Log.
    var saved = null;
    try {
      var blob = madeBill.blob;
      saved = saveVendorRequestBillToDrive_(vendorName, blob, new Date());
      if (saved.success) vendorMail.driveUrl = saved.url;
      var body = vendorRequestText_(vendorMail);
      sendNotification_({ to: recipient, subject: subject, body: body, attachments: [blob] }, function (hasLogo) { return vendorRequestHtml_(vendorMail, getAppUrl_(), hasLogo); });
    } catch (mailErr) {
      Logger.log('requestNewVendor: email send failed: ' + mailErr);
      if (saved && saved.success) {
        try { saved.file.setTrashed(true); } catch (trashErr) { Logger.log('requestNewVendor: could not trash the Drive copy after a failed send: ' + trashErr); }
      }
      return { success: false, error: 'Failed to send the vendor request email: ' + mailErr.toString() };
    }

    var driveNote = saved.success ? ', bill saved to Drive: ' + saved.url : ', bill could NOT be saved to Drive (' + saved.error + ') \u2014 it is attached to the email only';
    if (!saved.success) {
      logAction_('VENDOR_REQUEST_DRIVE_SAVE_FAILED', '', session.displayName || session.role, session.role, 'Drive copy of the bill for "' + vendorName + '" failed: ' + saved.error);
    }
    logAction_('VENDOR_REQUEST', '', session.displayName || session.role, session.role,
      'Requested new vendor "' + vendorName + '"' + (notes ? ' \u2014 ' + notes : '') + ', emailed to ' + recipient + driveNote);

    return { success: true, message: 'Request for "' + vendorName + '" sent.' + (saved.success ? '' : ' Note: the bill could not be saved to Drive, but it is attached to the email.') };
  } catch (err) {
    Logger.log('requestNewVendor error: ' + err);
    return { success: false, error: 'Failed to send vendor request: ' + err.toString() };
  }
}

// Link straight to the Master Data tab for the employee-request email, so the
// person adding the name lands on the right sheet. Best effort: returns ''
// (and the email simply has no button) if the sheet cannot be resolved. The
// link only opens for people who already have access to the spreadsheet.
function getMasterDataSheetUrl_() {
  try {
    var sh = getSheet_(MASTER_DATA_SHEET);
    return sh.getParent().getUrl() + '#gid=' + sh.getSheetId();
  } catch (err) {
    Logger.log('getMasterDataSheetUrl_: ' + err);
    return '';
  }
}

// Mirrors requestNewVendor above (same modal-and-email pattern, same
// role gate, same "never writes Master Data directly, only emails the
// request" posture) but for adding a new employee to the Submitted By
// list — per explicit instruction, with no bill or supporting document
// required, since a new employee is a name to add, not a transaction to
// verify. Kept as its own function rather than a shared one with
// requestNewVendor: the two differ enough in validation (no file, no PAN/
// TDS considerations, a different existence check) that a shared
// function would need almost as many branches as just having two.
function requestNewEmployee(employeeName, notes, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'submission') return { success: false, error: 'You do not have permission to do this.' };

    employeeName = String(employeeName || '').trim();
    if (!employeeName) return { success: false, error: 'Employee name is required.' };
    if (employeeName.length > 100) return { success: false, error: 'Employee name is too long.' };

    var existing = getEmployees_();
    if (existing.indexOf(employeeName) !== -1) {
      return { success: false, error: '"' + employeeName + '" is already on the list \u2014 no need to request it.' };
    }

    var recipient = getEmployeeRequestEmail_();
    if (!recipient) {
      return { success: false, error: 'Employee request email is not configured yet \u2014 ask admin to set the EMPLOYEE_REQUEST_EMAIL Script Property.' };
    }

    notes = String(notes || '').trim();
    if (notes.length > 500) notes = notes.substring(0, 500);

    var subject = 'New Employee Request: ' + employeeName;
    // Content is built in Notifications.gs (plain text here; HTML inside sendNotification_).
    var employeeMail = { employeeName: employeeName, requestedBy: nameWithPosition_(session.displayName || 'submission', session.designation), dateText: formatDate_(new Date()), notes: notes, sheetName: MASTER_DATA_SHEET };
    var body = employeeRequestText_(employeeMail);

    try {
      sendNotification_({ to: recipient, subject: subject, body: body }, function (hasLogo) { return employeeRequestHtml_(employeeMail, getMasterDataSheetUrl_(), hasLogo); });
    } catch (mailErr) {
      Logger.log('requestNewEmployee: email send failed: ' + mailErr);
      return { success: false, error: 'Failed to send the employee request email: ' + mailErr.toString() };
    }

    logAction_('EMPLOYEE_REQUEST', '', session.displayName || session.role, session.role,
      'Requested new employee "' + employeeName + '"' + (notes ? ' \u2014 ' + notes : '') + ', emailed to ' + recipient);

    return { success: true, message: 'Request for "' + employeeName + '" sent.' };
  } catch (err) {
    Logger.log('requestNewEmployee error: ' + err);
    return { success: false, error: 'Failed to send employee request: ' + err.toString() };
  }
}