// ============================================================================
// SHEET UTILITIES — spreadsheet access, single-sheet voucher lookup,
// Rabale Daily Sync ledger mapping
// ============================================================================

function getSpreadsheet_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function getSheet_(sheetName) {
  return getSpreadsheet_().getSheetByName(sheetName);
}

// ============================================================================
// COLUMN WIDTH / READABILITY (per explicit instruction) — a shared helper
// so every sheet in the app gets the same treatment: short, structured
// columns (IDs, dates, amounts, statuses) are auto-sized to fit their
// content exactly; long free-text columns (Notes, Description, Query
// Details, Decision Notes, Voucher Narration) are capped at a readable
// max width and wrapped, rather than left to either truncate visually or
// blow the column out to the width of the single longest note anyone has
// ever typed. wideTextCols0Based lists which 0-based column indexes on
// this sheet get the cap+wrap treatment; every other column just gets a
// plain autoResizeColumn.
// ============================================================================
var WIDE_TEXT_COLUMN_MAX_WIDTH_PX = 340;

function autoFitSheetColumns_(sheet, wideTextCols0Based) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  var wideSet = {};
  (wideTextCols0Based || []).forEach(function (c) { wideSet[c] = true; });
  for (var c = 1; c <= lastCol; c++) {
    sheet.autoResizeColumn(c);
    if (wideSet[c - 1]) {
      if (sheet.getColumnWidth(c) > WIDE_TEXT_COLUMN_MAX_WIDTH_PX) {
        sheet.setColumnWidth(c, WIDE_TEXT_COLUMN_MAX_WIDTH_PX);
      }
      var lastRow = Math.max(sheet.getLastRow(), 1);
      sheet.getRange(1, c, lastRow, 1).setWrap(true);
    }
  }
}

// One-time migration — run manually from the Apps Script editor. Sweeps
// every sheet this app writes to, in both spreadsheets (the main app
// spreadsheet and the separate RDS spreadsheet, including every existing
// month tab in each), and applies autoFitSheetColumns to it. Safe to
// re-run: it only ever changes column width/wrap, never a cell's value,
// and picks up any sheet created since the last run automatically (RDS
// and Tally Export month tabs are matched by prefix, not by a fixed
// list, since new ones appear every month).
function migrateNeatenAllSheetColumns() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var touched = [];

  var mainWideTextBySheet = {};
  mainWideTextBySheet[ALL_VOUCHERS_SHEET] = [AV.NOTES];
  mainWideTextBySheet[QUERY_THREAD_SHEET] = [QT.QUERY_DETAILS, QT.RESPONSE];
  mainWideTextBySheet[AUDIT_LOG_SHEET] = [AL.NOTES];
  mainWideTextBySheet[CASH_ADVANCES_SHEET] = [CA.PURPOSE, CA.NOTES];
  mainWideTextBySheet[CASH_WITHDRAWAL_BATCHES_SHEET] = [WB.BATCH_IDS, WB.DECISION_NOTES];

  var mainSs = getSpreadsheet_();
  mainSs.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (mainWideTextBySheet.hasOwnProperty(name)) {
      autoFitSheetColumns_(sheet, mainWideTextBySheet[name]);
      touched.push(name);
    } else if (name.indexOf(TALLY_EXPORT_SHEET_PREFIX) === 0) {
      autoFitSheetColumns_(sheet, [TE.VOUCHER_NARRATION]);
      touched.push(name);
    } else {
      // Every other main-spreadsheet sheet (Master Data, Users, Transport
      // Breakdown, Settings, Vendor FY Ledger, Regular Expense Vendors,
      // Vendor Expense Details) has no genuinely long free-text column —
      // plain auto-fit, no cap needed.
      autoFitSheetColumns_(sheet, []);
      touched.push(name);
    }
  });

  var rdsSs = SpreadsheetApp.openById(getRdsSpreadsheetId_());
  rdsSs.getSheets().forEach(function (sheet) {
    autoFitSheetColumns_(sheet, []);
    touched.push('[RDS] ' + sheet.getName());
  });

  Logger.log('migrateNeatenAllSheetColumns: resized ' + touched.length + ' sheet(s): ' + touched.join(', '));
  return { touched: touched };
}

// Parses a client-submitted date string into a real Date, safely.
// The ONLY format accepted from the client is unambiguous ISO
// (yyyy-mm-dd, what a native <input type="date"> always produces).
// This is deliberate: `new Date(someString)` for any non-ISO,
// slash-separated string (e.g. "1/8/2026") is parsed by V8 as
// US-style M/d/yyyy regardless of what locale produced the string —
// which is exactly the bug that turned a submitted 1 Aug 2026 into
// 8 Jan 2026 (client formatted the date via toLocaleDateString('en-IN')
// before sending it, server re-parsed it as if it were US-formatted).
// Building the Date from the y/m/d components directly (rather than
// handing any string to `new Date()`) also avoids any UTC/local
// timezone shift risk on the day boundary, independent of what
// Session.getScriptTimeZone() happens to be set to.
function parseClientDateString_(s) {
  var str = String(s || '').trim();
  var m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    var d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    if (!isNaN(d.getTime())) return d;
  }
  // Fallback for any legacy/non-ISO caller: let JS attempt it, but this
  // path should not be hit from the voucher submission form anymore.
  var fallback = new Date(str);
  return isNaN(fallback.getTime()) ? null : fallback;
}

function formatDate_(val) {
  if (val === null || val === undefined || val === '') return '';
  if (val instanceof Date) {
    try { return Utilities.formatDate(val, Session.getScriptTimeZone(), 'dd-MM-yyyy'); }
    catch (e) { return val.toLocaleDateString('en-IN').replace(/\//g, '-'); }
  }
  return String(val).trim();
}

// Inverse of formatDate's dd/MM/yyyy output — needed wherever RDS logic
// has only the formatted string (as stored on AV.DATE / RS.DATE) but needs
// a real Date to resolve a month-tab name. Falls back to "now" rather than
// throwing if the string is somehow malformed, since a wrong-but-valid
// fallback keeps the sync running (logged) rather than blocking a voucher
// submission over a formatting edge case.
function parseRdsDateString_(s) {
  var parts = String(s || '').trim().split(/[\/\-]/);
  if (parts.length === 3) {
    var d = parseInt(parts[0], 10), m = parseInt(parts[1], 10), y = parseInt(parts[2], 10);
    if (!isNaN(d) && !isNaN(m) && !isNaN(y)) return new Date(y, m - 1, d);
  }
  Logger.log('WARNING: parseRdsDateString could not parse "' + s + '" — using current date instead.');
  return new Date();
}

// Compares two values by actual calendar day (year/month/date), not by
// string equality. Used for RDS day-boundary detection — string
// comparison is exactly what let Sheets' own date-string auto-parsing
// (see the Day 6 rewrite below) produce a false "new day" and a
// duplicate Opening Balance row; comparing real Date fields is immune to
// that regardless of the cell's display format or the spreadsheet's
// locale. Returns false for anything that isn't a genuine, valid Date —
// e.g. a blank cell, or a legacy string-formatted row from before this
// fix, which deliberately reads as "not the same day" so a self-healing
// Opening Balance row gets inserted rather than silently trusting an
// ambiguous old value.
function isSameCalendarDay_(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date) || isNaN(a.getTime()) || isNaN(b.getTime())) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function safe_(val) {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return formatDate_(val);
  return String(val).trim();
}

function getOrCreateDriveFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// ============================================================================
// VOUCHER DRIVE FOLDER STATUS SUFFIX (per explicit instruction) — a
// voucher's own Drive folder (Rabale Expense System/<batchId>/<voucherId>)
// gets an "(Approved)"/"(Rejected)"/"(Query)"/"(Deleted)" suffix appended
// to its name so its state is visible directly in Drive, without opening
// the sheet. Deliberately keyed on the VOUCHER's own folder, not the
// batch folder one level up — a batch folder holds every voucher
// submitted that day, each independently at its own stage, so it has no
// single status to carry; the voucher folder is the smallest unit that
// genuinely has one.
//
// findVoucherDriveFolder tolerates the folder currently carrying ANY of
// the suffixes above (or none) — callers elsewhere in this codebase
// (saveVoucherSubmission, resubmitVoucherCoreWriteOnly, etc.) still look
// the folder up by the PLAIN voucherId via getOrCreateDriveFolder, so
// setVoucherDriveFolderStatusSuffix('') is called at the start of every
// resubmit path (see resubmitVoucherCoreWriteOnly, Vouchers.gs) to strip
// any suffix BEFORE those plain-name lookups run — otherwise a suffixed
// folder would be invisible to them and a second, empty "<voucherId>"
// folder would get silently created alongside it, orphaning the original
// bill files. Both functions are best-effort: Drive folder cosmetics
// never block or fail a real business operation, matching the existing
// pattern in adminChangeVoucherId/adminDeleteVoucherCompletely.
function findVoucherDriveFolder_(batchId, voucherId) {
  if (!batchId || !voucherId) return null;
  var root = DriveApp.getRootFolder();
  var expIt = root.getFoldersByName('Rabale Expense System');
  if (!expIt.hasNext()) return null;
  var batchIt = expIt.next().getFoldersByName(batchId);
  if (!batchIt.hasNext()) return null;
  var batchFolder = batchIt.next();

  var exact = batchFolder.getFoldersByName(voucherId);
  if (exact.hasNext()) return exact.next();

  var all = batchFolder.getFolders();
  while (all.hasNext()) {
    var f = all.next();
    var name = f.getName();
    for (var i = 0; i < VOUCHER_FOLDER_STATUS_SUFFIXES.length; i++) {
      if (name === voucherId + ' (' + VOUCHER_FOLDER_STATUS_SUFFIXES[i] + ')') return f;
    }
  }
  return null;
}

// suffix: one of VOUCHER_FOLDER_STATUS_SUFFIXES, or '' to clear back to
// the plain voucherId. Silently does nothing if the folder can't be
// found (e.g. a voucher with no bill files yet never had a folder
// created) or on any Drive error — logged, never thrown.
function setVoucherDriveFolderStatusSuffix_(batchId, voucherId, suffix) {
  try {
    var folder = findVoucherDriveFolder_(batchId, voucherId);
    if (!folder) return;
    var newName = suffix ? (voucherId + ' (' + suffix + ')') : voucherId;
    if (folder.getName() !== newName) folder.setName(newName);
  } catch (err) {
    Logger.log('setVoucherDriveFolderStatusSuffix failed for ' + voucherId + ' (' + suffix + '): ' + err);
  }
}

// Generic key-value lookup on the Settings sheet, by header text rather
// than a hardcoded column position — so someone reordering Settings'
// columns doesn't silently break every reader of it. Returns null (not an
// error) if the sheet, headers, or the key itself aren't found; callers
// decide their own fallback.
function getSettingValue_(settingName) {
  var sheet = getSheet_(SETTINGS_SHEET);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return null;
  var header = data[0];
  var nameCol = -1, valueCol = -1;
  for (var c = 0; c < header.length; c++) {
    var h = String(header[c]).trim().toLowerCase();
    if (h === 'setting name') nameCol = c;
    if (h === 'setting value') valueCol = c;
  }
  if (nameCol === -1 || valueCol === -1) return null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][nameCol]).trim() === settingName) return String(data[i][valueCol]).trim();
  }
  return null;
}

// Logs (and records to Audit Log) if All Vouchers' header row doesn't match
// EXPECTED_VOUCHER_HEADERS, instead of letting a shifted/renamed column
// silently read the wrong field into the wrong place. Doesn't block the
// operation — an app that hard-stops on a header mismatch is worse than one
// that logs loudly and keeps going, since staff still need to submit
// vouchers while someone fixes the sheet.
function validateVoucherSheetHeaders_(sheet) {
  var headers = sheet.getRange(1, 1, 1, EXPECTED_VOUCHER_HEADERS.length).getValues()[0];
  for (var i = 0; i < EXPECTED_VOUCHER_HEADERS.length; i++) {
    if (String(headers[i]).trim() !== EXPECTED_VOUCHER_HEADERS[i]) {
      var msg = 'Header mismatch in "' + sheet.getName() + '" at column ' + (i + 1) +
                ': expected "' + EXPECTED_VOUCHER_HEADERS[i] + '", found "' + headers[i] + '"';
      Logger.log('WARNING: ' + msg);
      logAction_('SCHEMA_WARNING', '', 'system', 'system', msg);
      return false;
    }
  }
  return true;
}

// Finds a voucher by ID in the (single, ongoing) All Vouchers sheet.
// Returns { sheet, rowIndex (1-based, ready for getRange), rowValues } or null.
function findVoucherRow_(voucherId) {
  var sheet = getSheet_(ALL_VOUCHERS_SHEET);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][AV.VOUCHER_ID]) === voucherId) {
      return { sheet: sheet, rowIndex: i + 1, rowValues: data[i] };
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Rabale Daily Sync — restored. This sheet is what accounts currently
// maintains by hand-copying each paper voucher; the point of this function
// is to remove that manual step, not replace the sheet itself.
// ----------------------------------------------------------------------------

// RDS ledger column schema v2 (per explicit instruction,
// mapping_new_RDS.xlsx) — maps real Tally ledger names directly to their
// RDS column, replacing the old synthetic-category grouping. The 19
// "Repairs & Maintenance - <asset>" ledgers still share one column (per
// the mapping file); every other ledger gets its own. Ledgers retired
// per explicit instruction (no longer selectable once removed from
// Master Data column M — see the RS object's comment in Config.gs for
// the full retired list) are deliberately absent here.
//
// ASSUMPTION (flagged, not in the mapping file): plain 'Repairs &
// Maintenance' / 'Repairs & Maintainance' (no asset suffix) is folded
// into the same shared column as its suffixed siblings — it wasn't one
// of the ledgers called out as retired, and every one of its suffixed
// variants belongs to this same family, so treating it identically is
// the closest reading of the mapping file's intent. Confirm if this
// ledger should instead be retired like the other unlisted ones.
//
// ASSUMPTION (flagged, genuine gap in the mapping file): the mapping file
// only covers REGULAR (ledger-based) voucher types. It's silent on where
// genuine TRANSPORT-type vouchers (isTransport=true — GST, multi-vendor)
// should sync to now that the old shared RS.TRANSPORTATION column no
// longer exists. Continuing to route them into TRANSPORTATION_NON_GST
// below preserves the exact column they shared before (both used to fall
// into the same old RS.TRANSPORTATION column) — but a GST-bearing
// Transport voucher landing in a column literally named "Non - GST" is
// self-contradictory on its face, so this needs your confirmation before
// going live; see updateRabaleDailySync/updateRabaleDailySyncRow below
// for the single line that would change if you'd rather it go elsewhere
// (or get its own new column).
var LEDGER_SYNC_COLUMN_MAP = {
  'Birthday Cake & Chocolates': RS.BIRTHDAY_CAKE_CHOCOLATES,
  'Conveyance - Others': RS.CONVEYANCE_OTHERS,
  'Food Exp': RS.FOOD_EXP,
  'House Keeping Material: Thane & Rabale': RS.HOUSE_KEEPING_MATERIAL,
  'Lodging & Boarding Exp': RS.LODGING_BOARDING,
  'Office Expenses': RS.OFFICE_EXPENSES,
  'Packing Material': RS.PACKING_MATERIAL,
  'Pantry Material': RS.PANTRY_MATERIAL,
  'Parking Charges': RS.PARKING_CHARGES,
  'Postage & Courier Charges': RS.POSTAGE_COURIER,
  'Printing & Stationery': RS.PRINTING_STATIONERY,
  'Repairs & Maintenance': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintainance': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintainance-MH03EG0225': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - MH 04 NB 5087': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - MH 43 BX 0252': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - MH04MH4896': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - MH43 AD 7803': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - MH43 Bx 7803': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - MH43 BX 7821': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - Others': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - Pinning Machine': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - Shrink Machine': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - Single Clamp Binding Mach.': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - Single Clamp Machine ( Bindwell Bluechip)': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - Single Knife Cutting Mach.': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - Squaring Machine': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance - Three Knife Cutting Mach.': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance- Cutting Machine': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance -MH04LQ4014': RS.REPAIRS_MAINTENANCE,
  'Repairs & Maintenance- Strapping Machine': RS.REPAIRS_MAINTENANCE,
  'Repairs and Maintenance- Six Clamp Book Binding Mac': RS.REPAIRS_MAINTENANCE,
  'Staff Welfare': RS.STAFF_WELFARE,
  'Tea & Coffee': RS.TEA_COFFEE,
  'Transportation Non - GST': RS.TRANSPORTATION_NON_GST,
  'Travelling Expenses': RS.TRAVELLING_EXPENSES,
  'Vehicle Fastag': RS.VEHICLE_FASTAG,
  'Vehicle Operating - Jakat/Toll': RS.VEHICLE_JAKAT_TOLL,
  'Vehicle Operating - Petrol': RS.VEHICLE_PETROL
};

// CHANGED FROM THE ORIGINAL: previously returned null and the caller
// silently skipped writing the amount when a ledger had no mapped column —
// real money would vanish from Rabale Daily Sync with no error anywhere.
// Verified against the current Master Data: all 46 real ledgers today have
// a mapping above, so this isn't live right now — but ledgers get added
// over time (docx items #7/#8), and the next one added without a matching
// entry here would hit exactly that silent-drop bug. Logging loudly instead
// costs nothing today and prevents a real future reconciliation gap.
function getLedgerSyncColumn_(ledgerName) {
  var col = LEDGER_SYNC_COLUMN_MAP[ledgerName];
  if (col === undefined) {
    var msg = 'No Rabale Daily Sync column mapped for ledger "' + ledgerName + '" — ' +
      'amount was NOT synced. Add it to LEDGER_SYNC_COLUMN_MAP in SheetUtils.gs.';
    Logger.log('WARNING: ' + msg);
    logAction_('SYNC_WARNING', '', 'system', 'system', msg);
    return null;
  }
  return col;
}

// ----------------------------------------------------------------------------
// RDS month-tab resolution and the running Cash in Hand engine (Day 6).
// ----------------------------------------------------------------------------

function getRdsMonthSheetName_(dateObj) {
  return Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'MMMM yyyy');
}

function getPreviousRdsMonthSheetName_(dateObj) {
  var d = new Date(dateObj.getFullYear(), dateObj.getMonth() - 1, 1);
  return getRdsMonthSheetName_(d);
}

// Scans bottom-up for the last row with a real (non-blank, numeric) Cash in
// Hand value, skipping blank spacer rows. Returns null if the sheet has no
// data rows at all yet.
function getLastCashInHandFromSheet_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var values = sheet.getRange(2, RS.CASH_IN_HAND + 1, lastRow - 1, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var v = values[i][0];
    if (v !== '' && v !== null && !isNaN(parseFloat(v))) return parseFloat(v);
  }
  return null;
}

// Resolves what to seed a NEW day (or new month tab) with:
//   1. If this tab already has an earlier day this month, its own last close.
//   2. Else, the PREVIOUS month's tab's last close, if that tab exists.
//   3. Else (the very first entry this system has ever logged) the flat
//      trial-run seed, RDS_INITIAL_OPENING_BALANCE.
function resolveRdsOpeningBalance_(ss, forDate, sameTabLastBalance) {
  if (sameTabLastBalance !== null && sameTabLastBalance !== undefined) return sameTabLastBalance;
  var prevSheet = ss.getSheetByName(getPreviousRdsMonthSheetName_(forDate));
  if (prevSheet) {
    var bal = getLastCashInHandFromSheet_(prevSheet);
    if (bal !== null) return bal;
  }
  return RDS_INITIAL_OPENING_BALANCE;
}

// Header row for a brand-new month tab. REVISED (RDS ledger schema v2,
// per explicit instruction) — previously this copied whatever an
// existing tab already had, specifically so a hand-corrected typo in a
// live header would propagate forward automatically. That's exactly the
// wrong behavior now: every tab that exists at the time of this deploy
// still has the OLD 22-column category schema, so blindly copying it
// forward would keep re-creating the old layout on every future month
// forever, silently undoing this whole migration. EXPECTED_RDS_HEADERS_
// FALLBACK (Config.gs) is now the authoritative source for every NEW
// tab going forward — it already is one column-for-column with the RS
// object, which is exactly the invariant a copied-but-possibly-stale
// header row could never guarantee. Copying an existing tab is kept only
// as a defensive fallback for the (should-never-happen) case where the
// constant is missing/empty.
function getRdsHeaderRow_(ss) {
  if (EXPECTED_RDS_HEADERS_FALLBACK && EXPECTED_RDS_HEADERS_FALLBACK.length > 0) {
    return EXPECTED_RDS_HEADERS_FALLBACK;
  }
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getLastRow() >= 1 && sheets[i].getLastColumn() >= RS.ACTUAL_CASH_IN_HAND + 1) {
      return sheets[i].getRange(1, 1, 1, sheets[i].getLastColumn()).getValues()[0];
    }
  }
  var oldSheet = getSheet_(RABALE_DAILY_SYNC_SHEET);
  if (oldSheet && oldSheet.getLastRow() >= 1) {
    return oldSheet.getRange(1, 1, 1, oldSheet.getLastColumn()).getValues()[0];
  }
  return EXPECTED_RDS_HEADERS_FALLBACK;
}

// Locks Voucher No. through Cash in Hand on a freshly created month tab
// so nobody hand-edits the script-owned section and silently desyncs the
// running balance — PLUS the Cash Given by Accounts column, protected as
// a SEPARATE range since it sits after Advance/Actual Cash in Hand on the
// real header, not adjacent to Cash in Hand. Advance/Actual Cash in Hand
// (the two columns in between) are deliberately left OUTSIDE both ranges —
// manual entry only, per explicit instruction. Script execution ("Execute
// as: Me") runs as the deployment owner, so this protection does not
// block the script's own writes — only manual edits by anyone else.
function protectRdsScriptOwnedRange_(sheet) {
  try {
    var leadRange = sheet.getRange(1, 1, sheet.getMaxRows(), RDS_SCRIPT_OWNED_LAST_COL);
    var leadProtection = leadRange.protect().setDescription(
      'Script-managed (Voucher No. through Cash in Hand) \u2014 do not hand-edit. Advance and Actual Cash in Hand remain open for manual entry.');
    leadProtection.removeEditors(leadProtection.getEditors());
    if (leadProtection.canDomainEdit()) leadProtection.setDomainEdit(false);
    leadProtection.addEditor(Session.getEffectiveUser());

    var cashGivenRange = sheet.getRange(1, RS.CASH_GIVEN_BY_ACCOUNTS + 1, sheet.getMaxRows(), 1);
    var cashGivenProtection = cashGivenRange.protect().setDescription(
      'Script-managed (Cash Given by Accounts) \u2014 do not hand-edit.');
    cashGivenProtection.removeEditors(cashGivenProtection.getEditors());
    if (cashGivenProtection.canDomainEdit()) cashGivenProtection.setDomainEdit(false);
    cashGivenProtection.addEditor(Session.getEffectiveUser());
  } catch (e) {
    Logger.log('WARNING: Could not protect script-owned range on new RDS tab "' + sheet.getName() + '": ' + e);
    logAction_('SYNC_WARNING', '', 'system', 'system', 'RDS protection setup failed on "' + sheet.getName() + '": ' + e);
  }
}

// Finds or creates the month tab for dateObj in the RDS spreadsheet.
// Creating a tab sets up its header row (copied, never guessed — see
// getRdsHeaderRow) and locks the script-owned column range immediately,
// before any data is ever written to it.
function getOrCreateRdsMonthSheet_(ss, dateObj) {
  var name = getRdsMonthSheetName_(dateObj);
  var sheet = ss.getSheetByName(name);
  if (sheet) return { sheet: sheet, isNewSheet: false };
  sheet = ss.insertSheet(name);
  var headers = getRdsHeaderRow_(ss);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, RS.DATE + 1, sheet.getMaxRows(), 1).setNumberFormat('dd-mm-yyyy');
  protectRdsScriptOwnedRange_(sheet);
  // ADDED — see RDS_SCRATCH_COLUMNS_COUNT (Config.gs). Explicitly extends
  // the grid past the last data column (Actual Cash in Hand) with open,
  // never-protected columns for Warehouse's own free-form use. This is
  // what fixes "can't go beyond column AF" — the grid previously never
  // had columns past the last header, not a permissions issue.
  var lastDataCol = headers.length;
  sheet.insertColumnsAfter(lastDataCol, RDS_SCRATCH_COLUMNS_COUNT);
  // READABILITY (per explicit instruction) — size the header row's
  // columns to fit on creation, same treatment migrateNeatenAllSheetColumns
  // applies retroactively to existing tabs. No column here carries
  // genuinely long free text, so a plain auto-fit (no cap/wrap) is enough.
  autoFitSheetColumns_(sheet, []);
  return { sheet: sheet, isNewSheet: true };
}

// One-time repair for month tabs created BEFORE this change — adds the
// same open scratch columns to every existing tab that doesn't have them
// yet. Idempotent: skips a tab that's already at or past the target
// width. Run once from the Apps Script editor against the RDS
// spreadsheet, same manual-run convention as the other RDS migrations
// in this file (migrateRdsInsertCashGivenColumn, etc.).
function migrateAddRdsScratchColumns() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
  var sheets = ss.getSheets();
  var targetMinCols = EXPECTED_RDS_HEADERS_FALLBACK.length + RDS_SCRATCH_COLUMNS_COUNT;
  var touched = [];
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    var currentCols = sh.getMaxColumns();
    if (currentCols < targetMinCols) {
      sh.insertColumnsAfter(currentCols, targetMinCols - currentCols);
      touched.push(sh.getName());
    }
  }
  Logger.log('migrateAddRdsScratchColumns: extended ' + touched.length + ' tab(s): ' + touched.join(', '));
  return touched;
}

// Rebuilds the Cash in Hand column (RS.CASH_IN_HAND) for an entire tab in
// one pass, top to bottom: an "Opening Balance" row resets the running
// figure to its own stored value; a real voucher row subtracts its own
// Total from whatever the running figure currently is; a "Cash Given by
// Accounts" row (Day 7 — see appendRdsCashGivenRow) ADDS its own amount
// to the running figure instead of subtracting one; a blank spacer row is
// left untouched. This is a full recompute, not an incremental patch
// forward from wherever the triggering write happened \u2014 deliberately.
// A mid-day amount correction (Amount Mismatch query response) changes
// that row's Total, which means every later row's Cash in Hand in this
// tab is now stale; redoing the whole column from scratch is the only way
// to fix that which can't drift out of sync, and at this data volume (at
// most a few hundred rows a month) the extra computation is negligible.
// Never touches Advance/Actual Cash in Hand — the range this reads and
// writes stops at RS.CASH_IN_HAND. REVERTED (correction, per explicit
// instruction) — a prior version of this function briefly recognized a
// dedicated Advance row and subtracted it here; that was wrong. Advance
// is a periodic MANUAL reconciliation split of Cash in Hand (Advance +
// Actual Cash in Hand = Cash in Hand on the rows it's filled in), never a
// per-transaction figure this function should compute or touch — see the
// Cash Advances comment in Config.gs for where that tracking actually
// lives now (its own sheet, entirely outside RDS).
function recomputeRdsCashInHand_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var numRows = lastRow - 1;
  var colCount = Math.max(sheet.getLastColumn(), RS.ACTUAL_CASH_IN_HAND + 1);
  // Read-only — these are never modified here, only Cash in Hand is.
  var voucherNos = sheet.getRange(2, RS.VOUCHER_NO + 1, numRows, 1).getValues();
  var employeeNames = sheet.getRange(2, RS.EMPLOYEE_NAME + 1, numRows, 1).getValues();
  var totals = sheet.getRange(2, RS.TOTAL + 1, numRows, 1).getValues();
  var cashGivenAmounts = sheet.getRange(2, RS.CASH_GIVEN_BY_ACCOUNTS + 1, numRows, 1).getValues();
  var advanceValues = sheet.getRange(2, RS.ADVANCE + 1, numRows, 1).getValues();
  var cashRange = sheet.getRange(2, RS.CASH_IN_HAND + 1, numRows, 1);
  var cashValues = cashRange.getValues();

  var running = null;
  var isOpeningRowFlags = [];
  var isCashGivenRowFlags = [];
  var isClosingRowFlags = [];
  var isBlankSpacerFlags = [];
  // FIXED (per explicit instruction) — previously every 'Cash Given by
  // Accounts' row in the day was bolded, which reads as "highlighted in
  // the middle of the day" when Accounts releases cash more than once
  // before day-close. Only the LAST cash-given row within each day's
  // block should read as the day's cash-given figure at a glance; the
  // simplest correct way to know which one is "last" is a first pass
  // that just classifies every row (day boundaries = Opening Balance
  // rows) and remembers the highest cash-given row index seen since the
  // most recent Opening Balance row. A second pass then builds the
  // actual running-balance/font-weight arrays using that lookup instead
  // of blanket-bolding every isCashGivenRow.
  var lastCashGivenIndexForBlock = {}; // openingRowIndex -> last cash-given row index in that block
  var currentBlockOpeningIndex = -1;
  for (var i = 0; i < numRows; i++) {
    var isOpeningRow = safe_(employeeNames[i][0]) === 'Opening Balance';
    var isCashGivenRow = safe_(employeeNames[i][0]) === RDS_CASH_GIVEN_ROW_LABEL;
    var isClosingRow = safe_(advanceValues[i][0]) !== '';
    var isBlankSpacer = !safe_(voucherNos[i][0]) && !isOpeningRow && !isCashGivenRow;
    isOpeningRowFlags.push(isOpeningRow);
    isCashGivenRowFlags.push(isCashGivenRow);
    isClosingRowFlags.push(isClosingRow);
    isBlankSpacerFlags.push(isBlankSpacer);
    if (isOpeningRow) { currentBlockOpeningIndex = i; continue; }
    if (isCashGivenRow && currentBlockOpeningIndex !== -1) lastCashGivenIndexForBlock[currentBlockOpeningIndex] = i;
  }
  // Flatten to a simple "is this row the last cash-given row of its day"
  // lookup for the second pass below.
  var isLastCashGivenOfDay = {};
  Object.keys(lastCashGivenIndexForBlock).forEach(function (openingIdx) {
    isLastCashGivenOfDay[lastCashGivenIndexForBlock[openingIdx]] = true;
  });

  var fontWeights = [];
  for (var i = 0; i < numRows; i++) {
    var isOpeningRow = isOpeningRowFlags[i];
    var isCashGivenRow = isCashGivenRowFlags[i];
    // ADDED (25 Aug 2026, Advance/Closing Balance feature) — a row with a
    // populated RS.ADVANCE cell is that day's closing snapshot (written
    // once by closeRdsDay, Triggers.gs, onto the day's actual last row —
    // never its own separate row). safe(0) is '0', not '', so a
    // genuinely-zero-advance day still counts and stays bold; only a
    // never-touched blank cell doesn't. Classified here, in the same pass
    // as Opening Balance/Cash Given, so this bolding self-heals on every
    // future recompute exactly the same way theirs already does — the
    // one-time setFontWeight('bold') closeRdsDay applies at write time
    // would otherwise be silently wiped the next time ANY voucher
    // elsewhere in this month tab triggers a recompute, since this
    // function always rewrites the whole range's font weights.
    var isClosingRow = isClosingRowFlags[i];
    // A Cash Given row deliberately has a blank Voucher No. (it isn't a
    // voucher) — without excluding it here too, it would be misread as a
    // blank spacer and silently skipped, losing the top-up entirely.
    var isBlankSpacer = isBlankSpacerFlags[i];
    // Only the day's LAST cash-given row is bolded now — see the first
    // pass above. Opening Balance and the day-close row are unaffected.
    var boldThisRow = isOpeningRow || isClosingRow || (isCashGivenRow && isLastCashGivenOfDay[i]);
    fontWeights.push(new Array(colCount).fill(boldThisRow ? 'bold' : 'normal'));
    if (isBlankSpacer) continue;
    if (isOpeningRow) { running = parseFloat(cashValues[i][0]) || 0; continue; }
    if (running === null) running = 0; // defensive only — a tab should never have a voucher/cash-given row before its first Opening Balance row
    if (isCashGivenRow) {
      running += (parseFloat(cashGivenAmounts[i][0]) || 0);
    } else {
      running -= (parseFloat(totals[i][0]) || 0);
    }
    cashValues[i][0] = running;
  }
  cashRange.setValues(cashValues);
  sheet.getRange(2, 1, numRows, colCount).setFontWeights(fontWeights);
}

// Appends one "Cash Given by Accounts" row to TODAY's RDS tab and
// recomputes the running balance — the counterpart to updateRabaleDailySync
// for voucher rows, but additive instead of subtractive (see
// recomputeRdsCashInHand above). Caller (addRdsCashGiven, Approval.gs) is
// responsible for validating the amount and the "today's batch is fully
// Approved" business gate BEFORE calling this — this function only knows
// how to write the row safely, not whether it SHOULD be written.
//
// Always targets TODAY (mirrors how Batch ID/voucher submission always
// resolves against "now") — there is deliberately no path here to
// backdate a Cash Given entry to a past day; that would require inserting
// a row into the middle of an already-closed day's block rather than a
// simple append, a materially different (and materially riskier)
// operation this function does not attempt.
//
// Multiple calls on the same day are expected and supported (per explicit
// instruction) — each is its own independent row/event; nothing here
// assumes or enforces a single entry per day.
function appendRdsCashGivenRow_(amount) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    Logger.log('appendRdsCashGivenRow lock timeout: ' + lockErr);
    return { success: false, error: 'System is busy. Please try again in a few seconds.' };
  }
  try {
    var now = new Date();
    var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
    var monthInfo = getOrCreateRdsMonthSheet_(ss, now);
    var sheet = monthInfo.sheet;
    var colCount = Math.max(sheet.getLastColumn(), RS.ACTUAL_CASH_IN_HAND + 1);

    // Today's Opening Balance row must already exist — it's created the
    // moment the first voucher of the day is submitted (updateRabaleDailySync),
    // and addRdsCashGiven's own gate (Approval.gs) already requires at
    // least one voucher to exist today before this is ever reachable. If
    // it's somehow missing anyway, fail loudly rather than silently
    // appending an addition with nothing to add on top of.
    var lastRow = sheet.getLastRow();
    var lastDateVal = lastRow >= 2 ? sheet.getRange(lastRow, RS.DATE + 1).getValue() : null;
    if (monthInfo.isNewSheet || lastRow < 2 || !isSameCalendarDay_(lastDateVal, now)) {
      return { success: false, error: 'No Rabale Daily Sync entry found for today yet \u2014 at least one voucher must be synced before Cash Given can be recorded.' };
    }

    var newRow = new Array(colCount).fill('');
    newRow[RS.VOUCHER_NO] = 'CASH-' + Date.now();
    newRow[RS.DATE] = now;
    newRow[RS.EMPLOYEE_NAME] = RDS_CASH_GIVEN_ROW_LABEL;
    newRow[RS.CASH_GIVEN_BY_ACCOUNTS] = amount;
    sheet.appendRow(newRow);

    recomputeRdsCashInHand_(sheet);
    return { success: true, voucherNo: newRow[RS.VOUCHER_NO] };
  } catch (err) {
    Logger.log('appendRdsCashGivenRow error: ' + err);
    return { success: false, error: 'Failed to record Cash Given: ' + err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------
// Admin Cash Given override (per explicit instruction) — correcting a
// mistaken "Cash Given by Accounts" entry. CHANGED (cash-release
// redesign): no longer locked to TODAY's tab — release now spans
// whatever the unreleased backlog is at the moment Add Cash Given is
// clicked, which can legitimately span multiple days, so a mistake might
// not be noticed until after the day it was made. Looks across the
// current month tab AND the previous one (covers the one realistic edge
// case: an entry made in the last day or two of a month, noticed just
// after the new month tab was created) rather than being day-locked.
// Every entry is still uniquely addressable by its RS.VOUCHER_NO value
// ("CASH-<timestamp>", assigned at creation), so admin always operates on
// one specific entry, never "the last one" or "all of them".
// ----------------------------------------------------------------------------

// Read-only listing for the Admin UI: Cash Given entries from the current
// and previous month tabs, with their editable identifiers and dates so
// admin can tell entries apart when more than one exists.
function listRecentRdsCashGivenEntries_() {
  var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
  var now = new Date();
  var prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var sheets = [ss.getSheetByName(getRdsMonthSheetName_(now)), ss.getSheetByName(getRdsMonthSheetName_(prevMonth))];
  var entries = [];
  sheets.forEach(function (sheet) {
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var data = sheet.getRange(2, 1, lastRow - 1, RS.CASH_GIVEN_BY_ACCOUNTS + 1).getValues();
    for (var i = 0; i < data.length; i++) {
      if (safe_(data[i][RS.EMPLOYEE_NAME]) !== RDS_CASH_GIVEN_ROW_LABEL) continue;
      entries.push({
        voucherNo: safe_(data[i][RS.VOUCHER_NO]),
        amount: parseFloat(data[i][RS.CASH_GIVEN_BY_ACCOUNTS]) || 0,
        date: formatDate_(data[i][RS.DATE])
      });
    }
  });
  // Most recent first — admin is almost always looking for something
  // they just noticed, not something from weeks ago.
  entries.reverse();
  return entries;
}

// Finds a Cash Given entry's sheet row (1-based) by voucher number,
// searching the current month tab then the previous one. Returns
// {sheet, rowIndex} or null — callers must treat null as "refuse".
function findRdsCashGivenRowByVoucherNo_(voucherNo) {
  var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
  var now = new Date();
  var prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var sheets = [ss.getSheetByName(getRdsMonthSheetName_(now)), ss.getSheetByName(getRdsMonthSheetName_(prevMonth))];
  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    if (!sheet) continue;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) continue;
    var data = sheet.getRange(2, 1, lastRow - 1, RS.CASH_GIVEN_BY_ACCOUNTS + 1).getValues();
    for (var i = 0; i < data.length; i++) {
      if (safe_(data[i][RS.EMPLOYEE_NAME]) !== RDS_CASH_GIVEN_ROW_LABEL) continue;
      if (safe_(data[i][RS.VOUCHER_NO]) !== voucherNo) continue;
      return { sheet: sheet, rowIndex: i + 2 }; // +1 for header, +1 for 0-based -> 1-based
    }
  }
  return null;
}

// Overwrites the amount on an existing Cash Given entry and recomputes
// the running Cash in Hand for that tab (full recompute, not incremental
// — same principle used everywhere else in this file).
function adminEditRdsCashGivenAmount_(voucherNo, newAmount) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    return { success: false, error: 'System is busy. Please try again in a few seconds.' };
  }
  try {
    var found = findRdsCashGivenRowByVoucherNo_(voucherNo);
    if (!found) return { success: false, error: 'That Cash Given entry was not found \u2014 it may already be edited/removed.' };
    found.sheet.getRange(found.rowIndex, RS.CASH_GIVEN_BY_ACCOUNTS + 1).setValue(newAmount);
    recomputeRdsCashInHand_(found.sheet);
    return { success: true };
  } catch (err) {
    Logger.log('adminEditRdsCashGivenAmount error: ' + err);
    return { success: false, error: 'Failed to edit Cash Given entry: ' + err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// Removes a Cash Given entry entirely and recomputes the running Cash in
// Hand — "taking it down completely", per explicit instruction, so
// Accounts can add a corrected entry fresh via the normal Add Cash Given
// flow. The caller (adminRemoveRdsCashGiven, Approval.gs) is responsible
// for reverting every voucher this entry released back to unreleased.
function adminDeleteRdsCashGivenEntry_(voucherNo) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    return { success: false, error: 'System is busy. Please try again in a few seconds.' };
  }
  try {
    var found = findRdsCashGivenRowByVoucherNo_(voucherNo);
    if (!found) return { success: false, error: 'That Cash Given entry was not found \u2014 it may already be removed.' };
    found.sheet.deleteRow(found.rowIndex);
    recomputeRdsCashInHand_(found.sheet);
    return { success: true };
  } catch (err) {
    Logger.log('adminDeleteRdsCashGivenEntry error: ' + err);
    return { success: false, error: 'Failed to remove Cash Given entry: ' + err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------
// One-time repair: re-applies protectRdsScriptOwnedRange with the
// CURRENT (correct) A:AD range on every existing RDS month tab, after
// removing whatever "Script-managed" protection object is currently
// there. Use this if a live tab was protected under an older/wider
// range at some point (before RDS_SCRIPT_OWNED_LAST_COL was set to its
// current value, or via a manual Sheets-UI protection) and columns
// beyond AD ended up locked when they shouldn't be. Safe to re-run.
function fixRdsProtections() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
  var sheets = ss.getSheets();
  var fixed = [];
  sheets.forEach(function (sheet) {
    try {
      var existing = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
      existing.forEach(function (p) {
        if (p.getDescription() && p.getDescription().indexOf('Script-managed') === 0) p.remove();
      });
      protectRdsScriptOwnedRange_(sheet);
      fixed.push(sheet.getName());
    } catch (e) {
      Logger.log('fixRdsProtections: failed on "' + sheet.getName() + '": ' + e);
    }
  });
  var summary = 'fixRdsProtections: re-applied A:AD protection on ' + fixed.length + ' tab(s): ' + fixed.join(', ');
  Logger.log(summary);
  return summary;
}


// editor (select this function in the dropdown, click Run), BEFORE
// deploying the version of this code that adds RS.CASH_GIVEN_BY_ACCOUNTS.
// Safe to re-run: skips any tab that already has the new header in the
// expected position.
//
// What it does, per existing RDS month tab:
//   1. Inserts one new blank column immediately before the current
//      Advance column (physically shifting Advance and Actual Cash in
//      Hand one column to the right — Google Sheets shifts any existing
//      Protection range that starts at/after the insertion point
//      automatically, but this function does not rely on that; it
//      re-creates the protection explicitly in step 3 regardless).
//   2. Writes the new column's header text into row 1.
//   3. Removes the tab's existing script-owned protection (if any) and
//      re-adds it via protectRdsScriptOwnedRange with the NEW,
//      one-column-wider range — an old protection object left at the OLD
//      (narrower) range would leave the new Cash Given column open to
//      manual editing by anyone with sheet access, defeating the point.
//
// Does NOT touch any voucher data, Cash in Hand values, or existing
// Advance/Actual Cash in Hand entries — those cells simply move one
// column right along with the column insert; their VALUES are untouched.
//
// A brand-new month tab created AFTER this migration (and after the
// matching code deploy) needs none of this — getOrCreateRdsMonthSheet
// already builds it with the new layout from row 1.
function migrateRdsInsertCashGivenColumn() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
  var sheets = ss.getSheets();
  var migrated = [], skipped = [];

  sheets.forEach(function (sheet) {
    var lastCol = sheet.getLastColumn();
    if (lastCol < 1) { skipped.push(sheet.getName() + ' (empty sheet)'); return; }

    var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    // Already migrated if the header at the NEW Cash Given position
    // already reads the expected label — safe to re-run without
    // double-inserting a column.
    if (String(headerRow[RS.CASH_GIVEN_BY_ACCOUNTS] || '').trim() === RDS_CASH_GIVEN_ROW_LABEL) {
      skipped.push(sheet.getName() + ' (already migrated)');
      return;
    }

    // Old layout: Advance was one column to the left of where it is now.
    // Insert a new blank column at that OLD Advance position — everything
    // from there rightward (old Advance, old Actual Cash in Hand) shifts
    // right by one, landing exactly on the new layout's positions.
    var oldAdvanceCol = RS.CASH_GIVEN_BY_ACCOUNTS + 1; // 1-based sheet column of the old Advance header
    sheet.insertColumnBefore(oldAdvanceCol);
    sheet.getRange(1, RS.CASH_GIVEN_BY_ACCOUNTS + 1).setValue(RDS_CASH_GIVEN_ROW_LABEL);

    // Re-protect with the new, wider script-owned range — remove any
    // stale protection object first so this tab never ends up with two
    // overlapping ones.
    try {
      var existingProtections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
      existingProtections.forEach(function (p) {
        if (p.getDescription() && p.getDescription().indexOf('Script-managed') === 0) p.remove();
      });
    } catch (protErr) {
      Logger.log('migrateRdsInsertCashGivenColumn: could not clear old protection on "' + sheet.getName() + '": ' + protErr);
    }
    protectRdsScriptOwnedRange_(sheet);

    migrated.push(sheet.getName());
  });

  var summary = 'migrateRdsInsertCashGivenColumn: migrated ' + migrated.length + ' tab(s): ' + migrated.join(', ') +
    '. Skipped ' + skipped.length + ': ' + skipped.join(', ');
  Logger.log(summary);
  logAction_('SYSTEM_MIGRATION', '', 'system', 'system', summary);
  return { migrated: migrated, skipped: skipped };
}

// ============================================================================
// ALL VOUCHERS — two additive migrations, run once each from the Apps
// Script editor before deploying the backdating/cash-release/locking
// build. Both are idempotent (safe to re-run) and, unlike
// migrateRdsInsertCashGivenColumn above, neither shifts any existing
// column — the 5 new AV fields are appended after the current last
// column, so there is no protection-range or column-position fallout to
// manage.
// ============================================================================

// 1. Appends the 5 new headers (Actual Expense Date, Cash Released, Cash
//    Released Voucher No., Edit Locked By, Edit Locked At) if they're not
//    already present. Existing rows are left with those cells blank —
//    blank Actual Expense Date is handled everywhere it's read as
//    "fall back to Date" (getVoucherForEdit, Tally export), blank Cash
//    Released is treated as "not yet released" (correct for pre-existing
//    Approved vouchers — see adminBackfillCashReleased below for how to
//    reconcile those against reality rather than guessing).
function migrateAddVoucherColumns() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var sheet = getSheet_(ALL_VOUCHERS_SHEET);
  var lastCol = sheet.getLastColumn();
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var existingHeaders = headerRow.map(function (h) { return String(h || '').trim(); });

  var newHeaders = EXPECTED_VOUCHER_HEADERS.slice(AV.ACTUAL_EXPENSE_DATE); // the 5 appended ones
  var alreadyPresent = newHeaders.every(function (h) { return existingHeaders.indexOf(h) !== -1; });
  if (alreadyPresent) {
    Logger.log('migrateAddVoucherColumns: already migrated, nothing to do.');
    return { migrated: false };
  }

  sheet.getRange(1, AV.ACTUAL_EXPENSE_DATE + 1, 1, newHeaders.length).setValues([newHeaders]);
  var summary = 'migrateAddVoucherColumns: appended ' + newHeaders.length + ' new headers to "' + ALL_VOUCHERS_SHEET + '".';
  Logger.log(summary);
  logAction_('SYSTEM_MIGRATION', '', 'system', 'system', summary);
  return { migrated: true };
}

// Companion migration for USR.EMAIL (bugfix round) — appends the 'Email'
// header to the live Users sheet if it's not already there. Idempotent
// and additive-only, same convention as migrateAddVoucherColumns above:
// existing user rows simply read as blank email (safe(), never undefined)
// until an admin sets one via setUserEmail / the Add User form. Run once
// from the Apps Script editor before deploying this version.
function migrateAddUserEmailColumn() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var sheet = getOrCreateUsersSheet_();
  var lastCol = sheet.getLastColumn();
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var existingHeaders = headerRow.map(function (h) { return String(h || '').trim(); });

  if (existingHeaders.indexOf('Email') !== -1) {
    Logger.log('migrateAddUserEmailColumn: already migrated, nothing to do.');
    return { migrated: false };
  }

  sheet.getRange(1, USR.EMAIL + 1).setValue('Email');
  var summary = 'migrateAddUserEmailColumn: appended "Email" header to "' + USERS_SHEET + '".';
  Logger.log(summary);
  logAction_('SYSTEM_MIGRATION', '', 'system', 'system', summary);
  return { migrated: true };
}

// Companion migration for AV.WITHDRAWAL_BATCH_ID (Cash Withdrawal Batches
// feature, per explicit instruction) — appends the 'Withdrawal Batch ID'
// header to the live "All Vouchers" sheet if it's not already there.
// Idempotent and additive-only, identical convention to
// migrateAddUserEmailColumn above. Run once from the Apps Script editor
// before deploying this version. Existing voucher rows simply read as
// blank (safe(), never undefined) — i.e. "not yet requested for
// withdrawal" — until they're bundled into a request.
function migrateAddWithdrawalBatchColumn() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var sheet = getSheet_(ALL_VOUCHERS_SHEET);
  var lastCol = sheet.getLastColumn();
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var existingHeaders = headerRow.map(function (h) { return String(h || '').trim(); });

  if (existingHeaders.indexOf('Withdrawal Batch ID') !== -1) {
    Logger.log('migrateAddWithdrawalBatchColumn: already migrated, nothing to do.');
    return { migrated: false };
  }

  sheet.getRange(1, AV.WITHDRAWAL_BATCH_ID + 1).setValue('Withdrawal Batch ID');
  var summary = 'migrateAddWithdrawalBatchColumn: appended "Withdrawal Batch ID" header to "' + ALL_VOUCHERS_SHEET + '".';
  Logger.log(summary);
  logAction_('SYSTEM_MIGRATION', '', 'system', 'system', summary);
  return { migrated: true };
}

// Cash Withdrawal Batches sheet — auto-created on first use (same pattern
// as getOrCreateTallyExportSheet, Tally Export.gs) rather than requiring
// a manual one-time sheet creation, since unlike the AV column migration
// above there's no existing data to reconcile: a brand-new sheet with
// just its header row is always correct the first time anything writes
// to it.
function getOrCreateCashWithdrawalBatchesSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(CASH_WITHDRAWAL_BATCHES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CASH_WITHDRAWAL_BATCHES_SHEET);
    sheet.getRange(1, 1, 1, EXPECTED_CASH_WITHDRAWAL_BATCHES_HEADERS.length).setValues([EXPECTED_CASH_WITHDRAWAL_BATCHES_HEADERS]);
    sheet.setFrozenRows(1);
    // READABILITY (per explicit instruction) — Batch IDs/Decision Notes
    // can run long; cap+wrap those, plain auto-fit everything else.
    autoFitSheetColumns_(sheet, [WB.BATCH_IDS, WB.DECISION_NOTES]);
    return sheet;
  }
  // Header back-fill for a sheet created before a column was appended to
  // EXPECTED_CASH_WITHDRAWAL_BATCHES_HEADERS (WB.EMAIL_SUBJECT and
  // WB.DECIDED_VIA, 16 Sep 2026). Strictly append-only and idempotent: it
  // only ever writes header cells PAST the current last column, so an
  // existing header is never renamed and no data cell is touched. Without
  // this, appendRow would keep writing values into unlabelled columns —
  // exactly the silent-misalignment failure the corrupted August RDS
  // header caused.
  var lastCol = sheet.getLastColumn();
  var expected = EXPECTED_CASH_WITHDRAWAL_BATCHES_HEADERS.length;
  if (lastCol < expected) {
    var missing = EXPECTED_CASH_WITHDRAWAL_BATCHES_HEADERS.slice(lastCol);
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    Logger.log('getOrCreateCashWithdrawalBatchesSheet: back-filled header(s) ' + missing.join(', '));
  }
  return sheet;
}

// 2. Reformats every existing AV.DATE text cell from the old dd/MM/yyyy
//    to the new dd-MM-yyyy so the column is visually consistent — without
//    this, old rows would keep showing slashes forever while every new
//    submission shows hyphens. Text-only string replace (AV.DATE is
//    stored as plain text, not a real Date — see saveVoucherSubmission),
//    so this never touches cell values' underlying type, only their
//    displayed characters. Idempotent: a cell with no slash is left as-is.
//    Batched into a single setValues call rather than per-cell writes.
function migrateReformatVoucherDates() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var sheet = getSheet_(ALL_VOUCHERS_SHEET);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { changed: 0 };
  var range = sheet.getRange(2, AV.DATE + 1, lastRow - 1, 1);
  var values = range.getValues();
  var changed = 0;
  var out = values.map(function (row) {
    var v = String(row[0] || '');
    if (v.indexOf('/') === -1) return [v];
    changed++;
    return [v.replace(/\//g, '-')];
  });
  if (changed > 0) range.setValues(out);
  var summary = 'migrateReformatVoucherDates: reformatted ' + changed + ' of ' + values.length + ' row(s) from dd/MM/yyyy to dd-MM-yyyy.';
  Logger.log(summary);
  logAction_('SYSTEM_MIGRATION', '', 'system', 'system', summary);
  return { changed: changed };
}

// REWRITTEN (Day 6) — now targets the separate RDS spreadsheet
// (RDS_SHEET_ID), resolves the correct month tab, detects a day boundary
// against that tab's own last row, inserts a blank spacer + Opening
// Balance row when one is crossed (seeded via resolveRdsOpeningBalance),
// appends this voucher's row with its Total, then recomputes the whole
// tab's Cash in Hand column. Wrapped in its own lock: the OLD version was
// a blind append with no cross-row dependency, safe to run outside any
// lock (which is why the caller in Vouchers.gs runs it after releasing
// the voucher-row lock) — the running balance changes that, since two
// concurrent submissions on the same day would otherwise both read the
// same "last row" state and either double-insert an Opening Balance row
// or compute against the same stale prior balance instead of chaining
// correctly. This lock is separate from and does not conflict with the
// caller's already-released voucher-row lock.
// REWRITTEN (Day 6, then fixed again same day) — takes a real Date object
// (dateObj) rather than a formatted string. The original version passed
// formatDate(voucherDateRaw) — a "dd/MM/yyyy" STRING — and wrote that
// string into the sheet. Google Sheets auto-detects date-like strings and
// parses them using the SPREADSHEET'S OWN LOCALE, not whatever format the
// string was actually in — on a US-locale spreadsheet, "12/08/2026"
// (meant 12th August) gets silently read as December 8th. Passing a real
// Date object here sidesteps that entirely: Sheets stores exactly the
// Date instance it's given via the API, no string parsing involved. The
// column's number format ('dd-mm-yyyy', set in getOrCreateRdsMonthSheet)
// then controls DISPLAY only, independent of the spreadsheet's locale.
//
// Also fixes the duplicate-Opening-Balance-row bug: day-boundary
// detection now compares actual Date fields (isSameCalendarDay) instead
// of comparing formatted strings, which is what let a locale-driven
// re-interpretation of the previous row's date produce a false "this is
// a new day" on a same-day second voucher.
function updateRabaleDailySync_(voucherId, dateObj, employee, vehicleNo, costCentre, amount, isTransport, ledgerName) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    Logger.log('updateRabaleDailySync lock timeout for ' + voucherId + ': ' + lockErr);
    logAction_('SYNC_WARNING', voucherId, 'system', 'system', 'Rabale Daily Sync busy \u2014 sync skipped for ' + voucherId + '.');
    return;
  }
  try {
    var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
    var monthInfo = getOrCreateRdsMonthSheet_(ss, dateObj);
    var sheet = monthInfo.sheet;
    var colCount = Math.max(sheet.getLastColumn(), RS.ACTUAL_CASH_IN_HAND + 1);

    var lastRow = sheet.getLastRow();
    var lastDateVal = lastRow >= 2 ? sheet.getRange(lastRow, RS.DATE + 1).getValue() : null;
    var isNewDay = monthInfo.isNewSheet || lastRow < 2 || !isSameCalendarDay_(lastDateVal, dateObj);

    if (isNewDay) {
      var sameTabLastBalance = (!monthInfo.isNewSheet && lastRow >= 2) ? getLastCashInHandFromSheet_(sheet) : null;
      var opening = resolveRdsOpeningBalance_(ss, dateObj, sameTabLastBalance);
      if (lastRow >= 2) sheet.appendRow(new Array(colCount).fill('')); // blank spacer row between the two days' blocks
      var openRow = new Array(colCount).fill('');
      openRow[RS.DATE] = dateObj;
      openRow[RS.EMPLOYEE_NAME] = 'Opening Balance';
      openRow[RS.CASH_IN_HAND] = opening;
      sheet.appendRow(openRow);
    }

    var newRow = new Array(colCount).fill('');
    newRow[RS.VOUCHER_NO]    = voucherId;
    newRow[RS.DATE]          = dateObj;
    newRow[RS.EMPLOYEE_NAME] = employee;
    newRow[RS.VEHICLE_NO]    = vehicleNo;
    newRow[RS.COST_CENTRE]   = costCentre;
    // NEEDS CONFIRMATION — see LEDGER_SYNC_COLUMN_MAP's comment above:
    // genuine Transport-type (isTransport) vouchers reuse the
    // TRANSPORTATION_NON_GST column, matching where they landed before
    // (both used to share the old RS.TRANSPORTATION column) — but that's
    // this file's own assumption, not something the new mapping file
    // actually specifies.
    var syncCol = isTransport ? RS.TRANSPORTATION_NON_GST : getLedgerSyncColumn_(ledgerName);
    if (syncCol !== null && syncCol !== undefined) newRow[syncCol] = amount;
    newRow[RS.TOTAL] = amount;
    sheet.appendRow(newRow);

    recomputeRdsCashInHand_(sheet);
  } catch (err) {
    Logger.log('updateRabaleDailySync error for ' + voucherId + ': ' + err);
    logAction_('SYNC_WARNING', voucherId, 'system', 'system', 'Rabale Daily Sync update failed: ' + err);
  } finally {
    lock.releaseLock();
  }
}

// Finds the existing Rabale Daily Sync row for voucherId WITHIN a given
// month tab (a voucher's date is locked on every edit path in this system,
// so its month tab can never change between original submission and any
// later resubmit — no cross-tab search needed).
// One-time migration — run manually from the Apps Script editor. Backfills
// the blank spacer row between day blocks (per explicit instruction) onto
// any RDS month tab that predates it — updateRabaleDailySync (this file)
// and closeRdsDay (Triggers.gs) have both inserted this spacer on every
// day boundary for a while now, so this only matters for OLDER data
// written before either of those existed. Detects a day boundary the same
// way recomputeRdsCashInHand does (an "Opening Balance" row not already
// preceded by a blank row) and inserts one spacer directly above it.
// Inserts bottom-to-top within each sheet so earlier row numbers already
// queued stay valid as later ones shift the sheet down. Never touches an
// existing cell's value — purely adds blank rows — and a full
// recomputeRdsCashInHand afterwards re-derives Cash in Hand and the
// Opening/Closing/Cash-Given bolding against the new row layout.
function migrateInsertMissingRdsDaySpacers() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
  var sheets = ss.getSheets();
  var totalInserted = 0;
  var touchedSheets = [];
  sheets.forEach(function (sheet) {
    var lastRow = sheet.getLastRow();
    if (lastRow < 3) return; // header + at most one data row — no boundary possible
    var colCount = Math.max(sheet.getLastColumn(), RS.CASH_GIVEN_BY_ACCOUNTS + 1);
    var numRows = lastRow - 1;
    var employeeNames = sheet.getRange(2, RS.EMPLOYEE_NAME + 1, numRows, 1).getValues();
    var voucherNos = sheet.getRange(2, RS.VOUCHER_NO + 1, numRows, 1).getValues();
    var insertBeforeRows = [];
    // i starts at 1 (never the sheet's very first data row) — that row is
    // already the top of the tab's first day block and needs no spacer
    // above it.
    for (var i = 1; i < numRows; i++) {
      if (safe_(employeeNames[i][0]) !== 'Opening Balance') continue;
      var prevIsBlank = !safe_(employeeNames[i - 1][0]) && !safe_(voucherNos[i - 1][0]);
      if (!prevIsBlank) insertBeforeRows.push(i + 2); // sheet row number of this Opening Balance row
    }
    if (insertBeforeRows.length === 0) return;
    insertBeforeRows.sort(function (a, b) { return b - a; }); // bottom-to-top
    insertBeforeRows.forEach(function (rowNum) { sheet.insertRowBefore(rowNum); });
    totalInserted += insertBeforeRows.length;
    touchedSheets.push(sheet.getName() + ' (' + insertBeforeRows.length + ')');
    recomputeRdsCashInHand_(sheet);
  });
  Logger.log('migrateInsertMissingRdsDaySpacers: inserted ' + totalInserted + ' spacer row(s) across: ' + touchedSheets.join(', '));
  return { totalInserted: totalInserted, touchedSheets: touchedSheets };
}


// Finds the existing Rabale Daily Sync row for voucherId WITHIN a given
// month tab (a voucher's date is locked on every edit path in this system,
// so its month tab can never change between original submission and any
// later resubmit — no cross-tab search needed).
function findRabaleDailySyncRow_(sheet, voucherId) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][RS.VOUCHER_NO]) === voucherId) return { sheet: sheet, rowIndex: i + 1, rowValues: data[i] };
  }
  return null;
}

// Updates an EXISTING Rabale Daily Sync row in place for a resubmitted
// voucher — NOT an append (that's updateRabaleDailySync above, used only
// at original submission). Clears the whole ledger-category column block
// before writing the new amount (a voucher's ledger can change on edit,
// including Regular<->Transport), then recomputes the tab's whole Cash in
// Hand column, same reasoning as updateRabaleDailySync: an amount change
// here invalidates every later row's running balance in this tab, and a
// full recompute is the only way to fix that without cascade-tracking
// bugs. If no matching row is found, logs a warning and does nothing
// further — the resubmit itself still succeeds even if this sync step
// can't find a row to update.
function updateRabaleDailySyncRow_(voucherId, dateObj, employee, vehicleNo, costCentre, amount, isTransport, ledgerName) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    Logger.log('updateRabaleDailySyncRow lock timeout for ' + voucherId + ': ' + lockErr);
    logAction_('SYNC_WARNING', voucherId, 'system', 'system', 'Rabale Daily Sync busy \u2014 edit sync skipped for ' + voucherId + '.');
    return;
  }
  try {
    var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
    var sheetName = getRdsMonthSheetName_(dateObj);
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      var msg = 'No Rabale Daily Sync tab "' + sheetName + '" found for ' + voucherId + ' during resubmit \u2014 sync NOT updated.';
      Logger.log('WARNING: ' + msg);
      logAction_('SYNC_WARNING', voucherId, 'system', 'system', msg);
      return;
    }

    var found = findRabaleDailySyncRow_(sheet, voucherId);
    if (!found) {
      var msg2 = 'No Rabale Daily Sync row found for ' + voucherId + ' in "' + sheetName + '" during resubmit \u2014 sync NOT updated.';
      Logger.log('WARNING: ' + msg2);
      logAction_('SYNC_WARNING', voucherId, 'system', 'system', msg2);
      return;
    }

    var rowIndex = found.rowIndex;
    sheet.getRange(rowIndex, RS.EMPLOYEE_NAME + 1).setValue(employee);
    sheet.getRange(rowIndex, RS.VEHICLE_NO + 1).setValue(vehicleNo);
    sheet.getRange(rowIndex, RS.COST_CENTRE + 1).setValue(costCentre);
    // Clears the whole ledger-column block (RDS schema v2 — the 19
    // per-ledger columns, Birthday Cake & Chocolates through Vehicle
    // Operating - Petrol) before writing the new amount, since a
    // voucher's ledger can change on edit (including Regular<->Transport)
    // and the old amount may be sitting in a different column than the
    // new one.
    var ledgerColCount = RS.VEHICLE_PETROL - RS.BIRTHDAY_CAKE_CHOCOLATES + 1;
    sheet.getRange(rowIndex, RS.BIRTHDAY_CAKE_CHOCOLATES + 1, 1, ledgerColCount).setValue('');
    var syncCol = isTransport ? RS.TRANSPORTATION_NON_GST : getLedgerSyncColumn_(ledgerName);
    if (syncCol !== null && syncCol !== undefined) sheet.getRange(rowIndex, syncCol + 1).setValue(amount);
    sheet.getRange(rowIndex, RS.TOTAL + 1).setValue(amount);

    recomputeRdsCashInHand_(sheet);
  } catch (err) {
    Logger.log('updateRabaleDailySyncRow error for ' + voucherId + ': ' + err);
    logAction_('SYNC_WARNING', voucherId, 'system', 'system', 'Rabale Daily Sync edit sync failed: ' + err);
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------
// Regular Vendor (Dual-GST) support sheets — handoff 2.C. Both created
// on-demand, same lazy getOrCreate pattern as getOrCreateCashAdvancesSheet
// (Advances.gs). Kept entirely separate from Transport's Master Data
// vendor block and Transport Breakdown sheet.
// ----------------------------------------------------------------------------
function getOrCreateRegularVendorMasterSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(REGULAR_VENDOR_MASTER_SHEET);
  if (sheet) return sheet;
  sheet = ss.insertSheet(REGULAR_VENDOR_MASTER_SHEET);
  sheet.getRange(1, 1, 1, EXPECTED_REGULAR_VENDOR_MASTER_HEADERS.length).setValues([EXPECTED_REGULAR_VENDOR_MASTER_HEADERS]);
  sheet.setFrozenRows(1);
  autoFitSheetColumns_(sheet, []); // READABILITY (per explicit instruction)
  return sheet;
}

function getOrCreateRegularVendorDetailsSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(REGULAR_VENDOR_DETAILS_SHEET);
  if (sheet) return sheet;
  sheet = ss.insertSheet(REGULAR_VENDOR_DETAILS_SHEET);
  sheet.getRange(1, 1, 1, EXPECTED_REGULAR_VENDOR_DETAILS_HEADERS.length).setValues([EXPECTED_REGULAR_VENDOR_DETAILS_HEADERS]);
  sheet.setFrozenRows(1);
  autoFitSheetColumns_(sheet, []); // READABILITY (per explicit instruction)
  return sheet;
}

// Plain name -> PAN map, mirroring getVendorsWithTDS' shape closely enough
// to reuse the same calling conventions elsewhere (existence checks via
// hasOwnProperty).
function getRegularVendorsList_() {
  var sheet = getOrCreateRegularVendorMasterSheet_();
  var data = sheet.getDataRange().getValues();
  var out = {};
  for (var i = 1; i < data.length; i++) {
    var name = safe_(data[i][RVM.VENDOR_NAME]);
    if (name) out[name] = { pan: safe_(data[i][RVM.PAN]) };
  }
  return out;
}

// ----------------------------------------------------------------------------
// Transport Breakdown — one row per vendor line item on a transport
// voucher. `items` is the array built in Vouchers.gs, already validated and
// already carrying server-computed TDS (never trust client-sent TDS math).
// Bill Files / Query Status columns are left blank at submission time —
// nothing currently populates them at the line-item level, only at the
// whole-voucher level in All Vouchers.
// ----------------------------------------------------------------------------
function writeTransportBreakdown_(voucherId, items) {
  try {
    var sheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
    if (!sheet) {
      Logger.log('WARNING: Transport Breakdown sheet not found. Line items skipped for ' + voucherId);
      return;
    }
    var rows = items.map(function (it) {
      var row = new Array(14).fill('');
      row[TB.VOUCHER_ID]     = voucherId;
      row[TB.VENDOR_NAME]    = it.name;
      row[TB.AMOUNT]         = it.amount;
      row[TB.TDS_APPLICABLE] = it.tdsApplicable ? 'Yes' : 'No';
      row[TB.TDS_RATE]       = it.tdsApplicable ? it.tdsRate : 0; // fraction (0.02 = 2%), matching the real sheet's existing convention - NOT Master Data's percent-number convention (2.0)
      row[TB.TDS_AMOUNT]     = it.tdsAmount;
      row[TB.BILL_FILES]     = ''; // REVISED (Day 5): per-line bill files rolled back — a transport voucher's
                                    // bill(s) now live on AV.BILL_FILES (whole voucher), same as Regular
                                    // vouchers always worked. This column stays in the sheet layout (never
                                    // deleting a column) but is intentionally left blank going forward.
      row[TB.CGST]           = 0;    // Accounts fills this in at approval time, not submission.
      row[TB.SGST]           = 0;
      row[TB.GST_REVIEWED]   = 'No'; // flips to 'Yes' only when Accounts explicitly saves GST for this line.
      row[TB.RETURN_PARCEL]  = it.returnParcel ? 'Yes' : 'No'; // set at submission, unlike GST/LR
      row[TB.LR_NO]          = '';   // set by Accounts alongside GST, not at submission.
      row[TB.HAMALI]         = 0;    // Accounts fills this in at approval time, same as CGST/SGST.
      return row;
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 14).setValues(rows);
  } catch (err) {
    Logger.log('writeTransportBreakdown error: ' + err);
  }
}

// Line-aware counterpart to clearTransportBreakdownRows/writeTransportBreakdown,
// used ONLY by the scoped query-edit path (resubmitVoucherForQueryScope in
// Vouchers.gs) for the Amount Mismatch / Wrong Vendor categories — where the
// whole point is that ONLY the specific line(s) a query targeted may change,
// and every other line's GST review must survive untouched. This is
// deliberately the opposite of clearTransportBreakdownRows' documented
// behavior above: that full wipe is still correct and unchanged for a plain
// full edit (Pending L1/Rejected) or the "Other" catch-all category, where
// arbitrary structural changes (add/remove a vendor entirely) are allowed
// and a full re-review is the safer default.
//
// lineUpdates: [{lineIndex, vendorName, amount}], lineIndex 0-based in the
// same sheet-scan order getVendorLineItems/getOpenQueryForVoucher use. Only
// lines actually present in lineUpdates are touched. For each: if the
// vendor name or amount actually differs from what's currently in the
// sheet, TDS is recomputed server-side against Master Data (never trust
// client TDS math, matching buildVendorLineItems' own rule) for the new
// vendor/amount, and GST_REVIEWED/CGST/SGST/LR_NO are reset — a vendor or
// amount correction invalidates whatever GST figures Accounts entered
// against the OLD values. If neither field actually changed for a given
// line (e.g. the raiser targeted a line but the submitter's response ended
// up matching the existing value), that line is left completely alone,
// GST data included.
//
// Returns {touchedLineIndexes: [...], error: null} or {error: 'message'}.
// Caller MUST hold the script lock — this does direct range writes with no
// locking of its own, same convention as writeTransportBreakdown.
function updateTransportBreakdownLines_(voucherId, lineUpdates, billDateForFy) {
  var sheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
  if (!sheet) return { error: 'Transport Breakdown sheet not found.' };

  var data = sheet.getDataRange().getValues();
  var matchingRows = [];
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][TB.VOUCHER_ID]) === voucherId) matchingRows.push({ sheetRow: i + 1, values: data[i] });
  }
  if (matchingRows.length === 0) return { error: 'No vendor line items found for ' + voucherId + '.' };

  var vendorTDS = getVendorsWithTDS_(); // used here only for the "unknown vendor" existence check
  var touchedLineIndexes = [];
  var warnings = [];
  var pendingWithinCall = {}; // same-vendor-multi-line guard, see buildVendorLineItems (Vouchers.gs)

  for (var u = 0; u < lineUpdates.length; u++) {
    var upd = lineUpdates[u];
    if (upd.lineIndex < 0 || upd.lineIndex >= matchingRows.length) {
      return { error: 'Invalid vendor line selected.' };
    }
    var target = matchingRows[upd.lineIndex];
    var currentName   = safe_(target.values[TB.VENDOR_NAME]);
    var currentAmount = parseFloat(target.values[TB.AMOUNT]) || 0;
    var newName   = String(upd.vendorName || currentName).trim();
    var newAmount = (upd.amount === undefined || upd.amount === null) ? currentAmount : parseFloat(upd.amount) || 0;

    if (newName === currentName && newAmount === currentAmount) continue; // no real change — leave GST data alone

    if (!vendorTDS.hasOwnProperty(newName)) {
      return { error: 'Unknown vendor "' + newName + '". Ask admin to register it first.' };
    }
    if (newAmount <= 0) return { error: 'Amount must be greater than 0.' };

    // Same canonical TDS decision as submission (resolveVendorTdsForAmount,
    // Master data.gs) — declaration exemption, FY-scoped ledger threshold,
    // PAN-derived rate. A query-response correction to a vendor line gets
    // exactly the same rule as the original submission, not a separate
    // simplified calculation. billDateForFy is the voucher's own
    // immutable AV.DATE (passed in by the caller), never "today".
    var tdsResult = resolveVendorTdsForAmount_(newName, newAmount, pendingWithinCall[newName] || 0, billDateForFy);
    if (tdsResult.warning) warnings.push(tdsResult.warning);
    pendingWithinCall[newName] = (pendingWithinCall[newName] || 0) + newAmount;

    sheet.getRange(target.sheetRow, TB.VENDOR_NAME + 1).setValue(newName);
    sheet.getRange(target.sheetRow, TB.AMOUNT + 1).setValue(newAmount);
    sheet.getRange(target.sheetRow, TB.TDS_APPLICABLE + 1).setValue(tdsResult.applicable ? 'Yes' : 'No');
    sheet.getRange(target.sheetRow, TB.TDS_RATE + 1).setValue(tdsResult.applicable ? tdsResult.rate : 0);
    sheet.getRange(target.sheetRow, TB.TDS_AMOUNT + 1).setValue(tdsResult.tdsAmount);
    // Stale now that the line itself changed — Accounts must re-review.
    sheet.getRange(target.sheetRow, TB.CGST + 1).setValue(0);
    sheet.getRange(target.sheetRow, TB.SGST + 1).setValue(0);
    sheet.getRange(target.sheetRow, TB.HAMALI + 1).setValue(0);
    sheet.getRange(target.sheetRow, TB.GST_REVIEWED + 1).setValue('No');
    sheet.getRange(target.sheetRow, TB.LR_NO + 1).setValue('');

    touchedLineIndexes.push(upd.lineIndex);
  }

  return { touchedLineIndexes: touchedLineIndexes, error: null, warnings: warnings };
}

// Removes ALL existing Transport Breakdown rows for voucherId — used by
// resubmitVoucher (Day 3) before writing fresh line items on an edit, since
// an edit can change vendor names/amounts/count entirely; leaving the old
// rows in place would double-count TDS and stale GST review state
// alongside the new lines. By explicit instruction, GST/CGST/SGST/LR data
// Accounts may have already entered is NOT preserved across an edit — it's
// simply cleared along with everything else, and Accounts re-reviews GST
// on the resubmitted voucher same as any other transport voucher. Deletes
// in reverse row order so earlier deletions don't shift the index of rows
// still queued for removal.
function clearTransportBreakdownRows_(voucherId) {
  var sheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
  if (!sheet) return;
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (safe_(data[i][TB.VOUCHER_ID]) === voucherId) {
      sheet.deleteRow(i + 1);
    }
  }
}

// ============================================================================
// VOUCHER EDIT LOCK (AV.EDIT_LOCKED_BY / EDIT_LOCKED_AT) — see
// EDIT_LOCK_TIMEOUT_SECONDS (Config.gs) for the design rationale. All three
// functions operate on an already-resolved `found` (from findVoucherRow) so
// callers that already have it (getVoucherForEdit, updateVoucherStatus,
// raiseVoucherQuery) don't re-scan the sheet just to check the lock.
// ============================================================================

// Returns {locked:false} if unlocked or the existing lock has expired
// (expiry treated as unlocked — a crashed tab must never permanently
// strand a voucher). Returns {locked:true, lockedBy, ageSeconds} otherwise.
function getVoucherEditLockInfo_(found) {
  var lockedBy = safe_(found.rowValues[AV.EDIT_LOCKED_BY]);
  var lockedAtRaw = found.rowValues[AV.EDIT_LOCKED_AT];
  if (!lockedBy || !(lockedAtRaw instanceof Date) || isNaN(lockedAtRaw.getTime())) {
    return { locked: false };
  }
  var ageSeconds = (new Date().getTime() - lockedAtRaw.getTime()) / 1000;
  if (ageSeconds > EDIT_LOCK_TIMEOUT_SECONDS) {
    return { locked: false, expired: true };
  }
  return { locked: true, lockedBy: lockedBy, ageSeconds: ageSeconds };
}

// Called by an approver action (approve/reject/query) right after
// findVoucherRow, before any write. Blocks only if the lock is held by
// someone OTHER than the acting session — an approver re-clicking their
// own in-flight action isn't a conflict. Returns null (no conflict) or an
// error string ready to hand straight back to the client.
function checkVoucherNotLockedForActor_(found, actorDisplayName) {
  var info = getVoucherEditLockInfo_(found);
  if (!info.locked) return null;
  if (info.lockedBy === actorDisplayName) return null;
  var minutesLeft = Math.max(1, Math.ceil((EDIT_LOCK_TIMEOUT_SECONDS - info.ageSeconds) / 60));
  return 'This voucher is currently being edited by ' + info.lockedBy + '. Try again in a few minutes (lock clears automatically within ' + minutesLeft + ' more minute(s) if they don\u2019t finish).';
}

// Called when submission opens a voucher for edit/query-response
// (getVoucherForEdit). Acquires the lock for `actorDisplayName` unless
// someone else already holds a non-expired one, in which case it refuses
// with the same message shape checkVoucherNotLockedForActor produces, so
// the client's error handling doesn't need to know which side raised it.
// Re-opening while you already hold your own lock just refreshes the
// timestamp (extends the timeout) rather than erroring.
function acquireVoucherEditLock_(found, actorDisplayName) {
  var conflict = checkVoucherNotLockedForActor_(found, actorDisplayName);
  if (conflict) return { success: false, error: conflict };
  found.sheet.getRange(found.rowIndex, AV.EDIT_LOCKED_BY + 1).setValue(actorDisplayName);
  found.sheet.getRange(found.rowIndex, AV.EDIT_LOCKED_AT + 1).setValue(new Date());
  return { success: true };
}

// Releases the lock — on save (write path already has `found` fresh),
// on explicit Cancel (releaseVoucherEditLockRpc, Vouchers.gs), or via
// admin override (adminForceReleaseVoucherLock). Only clears it if it's
// currently held by `actorDisplayName`, UNLESS force is true (admin) —
// otherwise a delayed release from an already-superseded session could
// wipe out someone else's legitimately newer lock.
function releaseVoucherEditLock_(found, actorDisplayName, force) {
  var currentlyHeldBy = safe_(found.rowValues[AV.EDIT_LOCKED_BY]);
  if (!force && currentlyHeldBy && currentlyHeldBy !== actorDisplayName) return; // not ours to release
  found.sheet.getRange(found.rowIndex, AV.EDIT_LOCKED_BY + 1).setValue('');
  found.sheet.getRange(found.rowIndex, AV.EDIT_LOCKED_AT + 1).setValue('');
}

// ============================================================================
// AUDIT VERSION SNAPSHOTS — Auditor Dashboard "what changed" diff view.
// Extracts the human-meaningful fields from a voucher row (skips internal
// bookkeeping like the edit lock or Tally-exported flag) into a plain
// object, for two callers: adminDeleteVoucherCompletely's full-record
// audit entry (Approval.gs), and every voucher-edit path's before/after
// pair below. Both sides always compare the SAME shape, which is what
// makes a generic field-by-field diff possible in the Auditor UI without
// per-field-type special-casing there.
// ============================================================================
function snapshotVoucherCoreForAudit_(rowValues) {
  return {
    status: safe_(rowValues[AV.STATUS]),
    expenseType: safe_(rowValues[AV.EXPENSE_TYPE]),
    submittedBy: safe_(rowValues[AV.SUBMITTED_BY]),
    vehicleNo: safe_(rowValues[AV.VEHICLE_NO]),
    costCentre: safe_(rowValues[AV.COST_CENTRE]),
    amount: parseFloat(rowValues[AV.AMOUNT]) || 0,
    notes: safe_(rowValues[AV.NOTES]),
    actualExpenseDate: safe_(rowValues[AV.ACTUAL_EXPENSE_DATE]),
    billFiles: safe_(rowValues[AV.BILL_FILES])
  };
}