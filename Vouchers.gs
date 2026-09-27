// ============================================================================
// VOUCHERS — submission, listing
// ============================================================================
//
// CHANGED FROM v8.2:
//   - saveVoucherSubmission now takes the files payload too and uploads them
//     in the SAME call, inside the SAME lock, as the row write. This is the
//     fix for the reported bug: bill files existed on Drive but the sheet
//     column and every dashboard's "view bill" link stayed empty. The old
//     design wrote the row, returned success, THEN made a second separate
//     call to upload files and patch the row — and that second call's
//     sheet-write was wrapped in a try/catch that deliberately swallowed
//     failures ("don't fail the whole upload, just the metadata"). Whatever
//     the exact failure was on any given submission, the user was never told
//     and the row was never fixed. One call, one lock, one place a failure
//     is visible, removes the entire class of bug rather than one instance
//     of it.
//   - Writes to the single ongoing "All Vouchers" sheet, same as always —
//     NOT split by month. (An earlier version of this file mistakenly split
//     it; rolled back.)
//   - Calls updateRabaleDailySync again, same as v8.2 — that sheet was never
//     meant to be retired. The goal is removing the manual step of
//     hand-copying a paper voucher into it, not replacing it.
//
// uploadBillFiles is kept as a standalone, still-callable function for the
// one legitimate remaining use case: retrying files that failed on first
// submission. It is no longer part of the primary submit flow.
// ============================================================================

// Shared file-batch validation for both the primary submission upload
// (saveVoucherSubmission) and the supplementary retry path (uploadBillFiles)
// — count, per-file size, AND aggregate payload size, all checked up front
// before any Drive write starts, so a bad batch fails fast with one clear
// message rather than partway through a loop of Drive calls. Returns an
// error string, or null if the batch is valid.
function validateFileUploadBatch_(files) {
  if (files.length > MAX_FILES_PER_UPLOAD) {
    return 'Maximum ' + MAX_FILES_PER_UPLOAD + ' files allowed per upload.';
  }
  var maxMb = Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024));
  var totalEstSize = 0;
  for (var i = 0; i < files.length; i++) {
    var estSize = (files[i].data || '').length * 0.75; // rough estimate from base64 length
    if (estSize > MAX_FILE_SIZE_BYTES) {
      return 'File "' + (files[i].name || 'unknown') + '" exceeds ' + maxMb + 'MB limit.';
    }
    if (!billTypeOfBase64_(files[i].data)) {
      return 'File "' + String(files[i].name || 'unknown').replace(/[\r\n<>]/g, ' ').substr(0, 80) + '" is not an allowed type. Bills can only be ' + BILL_TYPES_LABEL + ' files.';
    }
    totalEstSize += estSize;
  }
  if (totalEstSize > MAX_TOTAL_UPLOAD_BYTES) {
    var totalMb = Math.round(totalEstSize / (1024 * 1024));
    var maxTotalMb = Math.round(MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024));
    return 'Total upload size (' + totalMb + 'MB) exceeds the ' + maxTotalMb + 'MB limit for one voucher \u2014 try removing a file or compressing images further.';
  }
  return null;
}

// ============================================================================
// BILL FILE TYPE (v5). Bills may only be PDF, JPG, PNG, HEIC or WebP. The type is decided from the file's own
// first bytes, never from the file name or the type the browser claims (the sender chooses both). Whatever is
// stored or emailed gets the DETECTED type and a matching extension, so a program renamed "bill.pdf" is refused and
// a real PDF called "bill.exe" is stored as "bill.pdf". Used by every path that turns an upload into a file:
// validateFileUploadBatch (all voucher paths), uploadBillFilesToFolder, the query-response upload (Approval.gs)
// and the new-vendor request (Master.gs).
// ============================================================================
var BILL_TYPES_LABEL = 'PDF, JPG, PNG, HEIC or WebP';
var BILL_HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif'];

// bytes: array of (signed) bytes from Utilities.base64Decode. Returns {mime, ext} or null.
function detectBillFileType_(bytes) {
  var n = bytes ? bytes.length : 0;
  function at(i) { return i < n ? (bytes[i] & 0xFF) : -1; }
  function ascii(i, len) { var s = '', k, c; for (k = 0; k < len; k++) { c = at(i + k); if (c < 0) return ''; s += String.fromCharCode(c); } return s; }
  var limit = Math.min(n, 1024) - 5, p;
  for (p = 0; p <= limit; p++) { if (at(p) === 0x25 && ascii(p, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' }; }
  if (at(0) === 0xFF && at(1) === 0xD8 && at(2) === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (at(0) === 0x89 && ascii(1, 3) === 'PNG' && at(4) === 0x0D && at(5) === 0x0A && at(6) === 0x1A && at(7) === 0x0A) return { mime: 'image/png', ext: 'png' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (ascii(4, 4) === 'ftyp' && BILL_HEIC_BRANDS.indexOf(ascii(8, 4)) !== -1) return { mime: 'image/heic', ext: 'heic' };
  return null;
}

// Cheap check on the first ~1 KB of a base64 string (used for the up-front validation of a whole batch).
function billTypeOfBase64_(b64) {
  var head = String(b64 || '').substr(0, 1400).replace(/\s/g, '');
  head = head.substr(0, head.length - (head.length % 4));
  if (!head) return null;
  var bytes;
  try { bytes = Utilities.base64Decode(head); } catch (e) { return null; }
  return detectBillFileType_(bytes);
}

function safeBillFileName_(name, ext) {
  var base = String(name || '').split(/[\\\/]/).pop();
  base = base.replace(/\.[A-Za-z0-9]{1,5}$/, '');                       // drop the claimed extension
  base = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').replace(/[ .]+$/, '');
  if (!base) base = 'bill';
  return base.substr(0, 80) + '.' + ext;
}

// f: {data (base64), name, mimeType}. Returns {blob} or {error}. Never trusts f.name / f.mimeType.
function billBlobFromClientFile_(f, fallbackBaseName) {
  if (!f || !f.data) return { error: 'The file is empty.' };
  var bytes;
  try { bytes = Utilities.base64Decode(f.data); } catch (e) { return { error: 'The file data is not valid.' }; }
  if (bytes.length > MAX_FILE_SIZE_BYTES) return { error: 'The file is too large.' };
  var kind = detectBillFileType_(bytes);
  if (!kind) return { error: 'Only ' + BILL_TYPES_LABEL + ' files are allowed.' };
  return { blob: Utilities.newBlob(bytes, kind.mime, safeBillFileName_(f.name || fallbackBaseName, kind.ext)), kind: kind };
}

function generateBatchId_() {
  return batchIdForDate_(new Date());
}

// Extracted (Day 7) so getRdsCashGivenStatus/addRdsCashGiven (Approval.gs)
// can compute today's Batch ID to look up "every voucher submitted today"
// without duplicating this format — Batch ID has always been purely
// date-derived (every voucher submitted on the same calendar day shares
// one Batch ID), never random, so this is a safe, lossless extraction.
function batchIdForDate_(d) {
  return 'B-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Suggests the next Voucher ID as (highest existing numeric Voucher ID) + 1,
// pre-filled on the submission form but always editable — staff can override
// it, and the existing duplicate check (checkVoucherIdExists / the live blur
// check) still enforces uniqueness regardless of what they enter. Ignores
// any non-numeric legacy IDs still sitting in the sheet from before Voucher
// IDs were restricted to numbers-only.
function getNextSuggestedVoucherNumber_() {
  try {
    var sheet = getSheet_(ALL_VOUCHERS_SHEET);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return '1';
    var ids = sheet.getRange(2, AV.VOUCHER_ID + 1, lastRow - 1, 1).getValues();
    var max = 0;
    for (var i = 0; i < ids.length; i++) {
      var v = String(ids[i][0]).trim();
      if (/^[0-9]+$/.test(v)) {
        var n = parseInt(v, 10);
        if (n > max) max = n;
      }
    }
    return String(max + 1);
  } catch (err) {
    Logger.log('getNextSuggestedVoucherNumber error: ' + err);
    return '';
  }
}

// Lightweight RPC for resetForm() to refresh the suggested next number after
// a submission, without re-fetching the whole form (employees/vendors/etc).
function fetchNextVoucherNumber(token) {
  var session = validateSession_(token);
  if (!session.valid || !session.role) return { success: false, error: 'Session expired.' };
  return { success: true, voucherNo: getNextSuggestedVoucherNumber_() };
}

function checkVoucherIdExists(voucherId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired.' };
    var validation = validateVoucherId_(voucherId);
    // An invalid-format ID isn't "existing" — the format error surfaces at
    // submit time from validateVoucherId itself. This endpoint only answers
    // the duplicate question.
    if (!validation.valid) return { success: true, exists: false };
    var found = findVoucherRow_(validation.id);
    return { success: true, exists: !!found };
  } catch (err) {
    Logger.log('checkVoucherIdExists error: ' + err);
    return { success: false, error: err.toString() };
  }
}

// Shared by saveVoucherSubmission and resubmitVoucher — validates and
// normalizes the core voucher fields common to both a new submission and
// an edit (everything except the voucher ID itself, which a resubmit never
// changes, and files, which each caller handles differently). Returns
// {valid:false, error} or {valid:true, ...normalized fields...}.
// Calendar-day-only comparison (ignores time-of-day) — a date is "future"
// only if its actual calendar day is after today's, not merely later in
// the same day due to a timestamp component. Shared by the Actual Expense
// Date block below and anywhere else future-dating needs checking.
function isFutureCalendarDate_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return false;
  var today = new Date();
  var dOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return dOnly.getTime() > todayOnly.getTime();
}

function validateVoucherCoreFields_(data) {
  var submittedBy = String(data.submittedBy || '').trim();
  var costCentre  = String(data.costCentre  || '').trim();
  var amount      = parseFloat(data.amount) || 0;
  var description = String(data.description || '').trim();

  var empValidation = validateEmployee_(submittedBy);
  if (!empValidation.valid) return { valid: false, error: empValidation.error };

  var ccValidation = validateCostCentre_(costCentre);
  if (!ccValidation.valid) return { valid: false, error: ccValidation.error };

  if (amount <= 0) return { valid: false, error: 'Amount must be greater than 0.' };

  var isTransport = (String(data.expenseType || '').toLowerCase() === 'transport');
  var expenseType = isTransport ? 'Transport' : String(data.ledger || '').trim();
  var vehicleNo   = String(data.vehicleNo || '').trim();
  // Voucher/Submission Date is NEVER taken from the client — it is always
  // "today" for a new voucher, and stays fixed at the original submission
  // moment for every subsequent edit (callers that are editing an existing
  // row overwrite this back to the original AV.DATE right after calling
  // this function — see resubmitVoucherCoreWriteOnly below). This closes
  // off future/backdating on the voucher date itself entirely, rather
  // than validating a client-sent value that could be tampered with.
  var voucherDateRaw = new Date();

  // Actual Expense Date — the date on the vendor's bill. Free-form
  // backdating IS allowed here (that's the whole point of this field),
  // but it can never be in the future. Falls back to voucherDateRaw
  // (today) if the client didn't send one, which keeps this backward
  // compatible with any not-yet-updated caller/cache.
  var actualExpenseDateRaw = data.actualExpenseDate
    ? parseClientDateString_(data.actualExpenseDate)
    : voucherDateRaw;
  if (!actualExpenseDateRaw || isNaN(actualExpenseDateRaw.getTime())) actualExpenseDateRaw = voucherDateRaw;
  if (isFutureCalendarDate_(actualExpenseDateRaw)) {
    return { valid: false, error: 'Actual Expense Date cannot be in the future.' };
  }

  if (!isTransport) {
    var ledgerValidation = validateLedgerName_(expenseType);
    if (!ledgerValidation.valid) return { valid: false, error: ledgerValidation.error };
    // Description is required for regular (ledger-based) expenses — Tally
    // export's narration for these needs it ("...paid to X for
    // DESCRIPTION on dt: ..."), and there's no other field to fall back
    // on that describes what the expense was actually for.
    if (!description) return { valid: false, error: 'Description is required.' };
    if (description.length > 300) return { valid: false, error: 'Description is too long (max 300 characters).' };

    // Vehicle-linked Regular ledgers (per explicit instruction, revised):
    // Vehicle No. selection is compulsory for exactly these three ledgers
    // (VEHICLE_REQUIRED_LEDGERS, Config.gs) and blocked for every other
    // Regular ledger — a vehicle has no meaning against, say, "Office
    // Expenses", and allowing one through silently would make the
    // narration's "Vehicle no. ..." clause appear on ledgers it was never
    // meant for. Description is no longer required to restate the vehicle
    // number — narration states it directly instead (buildRegularNarration,
    // Tally Export.gs) — so Description just needs to describe the expense,
    // same as any other Regular ledger. This is the authoritative check;
    // submitVoucher (Main.gs) mirrors it client-side only for fast
    // feedback (compulsory-select alert + hiding/disabling the field for
    // every other ledger).
    if (VEHICLE_REQUIRED_LEDGERS.indexOf(expenseType) !== -1) {
      if (!vehicleNo) return { valid: false, error: 'Select a vehicle for the "' + expenseType + '" ledger.' };
    } else if (vehicleNo) {
      return { valid: false, error: 'Vehicle No. is not applicable for the "' + expenseType + '" ledger.' };
    }
  } else {
    if (!vehicleNo) return { valid: false, error: 'Vehicle No. is required for Transport vouchers.' };
  }

  // Return Parcel is a whole-voucher flag, not per-vendor — the same
  // shipment run is either a return-parcel trip or it isn't, it doesn't
  // vary line by line within one voucher.
  var voucherReturnParcel = isTransport && !!data.returnParcel;

  return {
    valid: true, submittedBy: submittedBy, costCentre: costCentre, amount: amount,
    description: description, isTransport: isTransport, expenseType: expenseType,
    vehicleNo: vehicleNo, voucherDateRaw: voucherDateRaw, actualExpenseDateRaw: actualExpenseDateRaw,
    voucherReturnParcel: voucherReturnParcel
  };
}

// Shared by saveVoucherSubmission and resubmitVoucher — validates each
// transport vendor line and looks up its real TDS status from Master Data
// (not from whatever the client sent — TDS applicability/rate is
// server-authoritative). A vendor name that doesn't match Master Data is
// rejected outright rather than silently treated as "no TDS", since a typo
// on a real contractor's name would otherwise mean a real 194C deduction
// quietly never happens. Returns {valid:false, error} or
// {valid:true, items:[...]}.
//
// REVISED (Day 5): Option B (each bill its own line item with its own
// required file) is ROLLED BACK, per explicit instruction — the file
// requirement/upload lived here and is gone. A transport voucher's bills
// now live in ONE combined upload at the whole-voucher level, exactly like
// a Regular voucher always worked (see saveVoucherSubmission/
// resubmitVoucherCore, which no longer branch on isTransport for files at
// all). The vendor LINE ITEMS themselves are unchanged and still matter —
// each line is still its own row in Transport Breakdown, still gets its
// own CGST/SGST/LR review from Accounts (updateVendorLineItemGst,
// Approval.gs) — that per-line GST workflow was never part of Option B and
// isn't touched by this rollback. The same vendor can still legitimately
// appear on 2+ separate lines (2 separate bills, 2 separate amounts) —
// Tally export now clubs those back together when generating entries (see
// buildTransportEntries, Tally export.gs) rather than requiring them to be
// pre-combined here.
// Shared by every buildVendorLineItems call site — logs any TDS
// warnings it returned (e.g. "threshold crossed but no valid PAN and no
// fallback rate") to the Audit Log so they're not silently lost, and
// returns a short suffix to tack onto the caller's success message so
// the person submitting/editing sees it immediately rather than having
// to go looking in the Audit Log.
function logAndFormatTdsWarnings_(voucherId, actorName, actorRole, warnings) {
  if (!warnings || warnings.length === 0) return '';
  logAction_('TDS_WARNING', voucherId, actorName || 'system', actorRole || 'system', warnings.join(' | '));
  return ' \u26a0\ufe0f ' + warnings.join(' ');
}

// billDateForFy: the voucher's true bill date for FY-ledger purposes —
// a live Date at fresh submission, or the voucher's original immutable
// AV.DATE (string or Date) at any resubmit/query-edit. Passed straight
// through to resolveVendorTdsForAmount; see that function's comment for
// why this must never be "today" on an edit. Optional (defaults to
// now() inside resolveVendorTdsForAmount) so this stays backward
// compatible if a future caller forgets to pass it — but every call site
// in this codebase does pass it.
function buildVendorLineItems_(vendorsInput, voucherReturnParcel, billDateForFy) {
  if (!vendorsInput || vendorsInput.length === 0) {
    return { valid: false, error: 'At least one vendor is required for a transport voucher.' };
  }
  var vendorTDS = getVendorsWithTDS_(); // used here only for the "unknown vendor" existence check
  var pendingWithinVoucher = {}; // vendor name -> amount already counted from earlier lines in THIS submission, not yet in the FY ledger
  var items = [];
  var warnings = [];
  for (var vi = 0; vi < vendorsInput.length; vi++) {
    var v = vendorsInput[vi];
    var vName = String(v.name || '').trim();
    var vAmount = parseFloat(v.amount) || 0;
    if (!vName || vAmount <= 0) {
      return { valid: false, error: 'Each vendor needs a name and an amount greater than 0.' };
    }
    if (!vendorTDS.hasOwnProperty(vName)) {
      return { valid: false, error: 'Unknown vendor "' + vName + '". Ask admin to register it first.' };
    }

    // GST is not captured here — Accounts fills in CGST/SGST later, at
    // approval time, via updateVendorLineItemGst, which recomputes TDS
    // net of GST but reuses the applicability/rate decided here.
    //
    // resolveVendorTdsForAmount (Master data.gs) is the single canonical
    // TDS decision: declaration exemption, FY-scoped ledger threshold
    // check, and PAN-derived rate, all in one place — see that function
    // for the full precedence rule and its documented caveats.
    var tdsResult = resolveVendorTdsForAmount_(vName, vAmount, pendingWithinVoucher[vName] || 0, billDateForFy);
    if (tdsResult.warning) warnings.push(tdsResult.warning);
    pendingWithinVoucher[vName] = (pendingWithinVoucher[vName] || 0) + vAmount;

    items.push({
      name: vName, amount: vAmount, returnParcel: voucherReturnParcel,
      tdsApplicable: tdsResult.applicable, tdsRate: tdsResult.rate, tdsAmount: tdsResult.tdsAmount
    });
  }
  return { valid: true, items: items, warnings: warnings };
}

// Shared by saveVoucherSubmission and resubmitVoucher.
function buildVoucherNotes_(isTransport, description, voucherReturnParcel, vendorLineItems) {
  if (isTransport) {
    return (voucherReturnParcel ? '[Return Parcel] ' : '') + 'Vendors: ' + vendorLineItems.map(function (v) {
      return v.name + ': Rs.' + v.amount;
    }).join(' | ');
  }
  return description;
}

function saveVoucherSubmission(formDataJson, filesJson, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'submission') return { success: false, error: 'You do not have permission to submit vouchers.' };

    var data;
    try { data = JSON.parse(formDataJson); } catch (e) { return { success: false, error: 'Invalid form data.' }; }

    var voucherValidation = validateVoucherId_(data.voucherNo);
    if (!voucherValidation.valid) return { success: false, error: voucherValidation.error };
    var voucherId = voucherValidation.id;

    var core = validateVoucherCoreFields_(data);
    if (!core.valid) return { success: false, error: core.error };
    var submittedBy = core.submittedBy, costCentre = core.costCentre, amount = core.amount,
        description = core.description, isTransport = core.isTransport, expenseType = core.expenseType,
        vehicleNo = core.vehicleNo, voucherDateRaw = core.voucherDateRaw, voucherReturnParcel = core.voucherReturnParcel;
    var batchId = generateBatchId_();

    // REVISED (Day 5): Option B rolled back — Regular and Transport now
    // share ONE whole-voucher file upload, same validation either way.
    // Vendor line items (Transport only) no longer carry files.
    var files = [];
    if (filesJson) {
      try { files = JSON.parse(filesJson) || []; } catch (e) { files = []; }
    }
    if (files.length === 0) {
      return { success: false, error: 'At least one bill file is required.' };
    }
    var fileBatchError = validateFileUploadBatch_(files);
    if (fileBatchError) return { success: false, error: fileBatchError };

    var vendorLineItems = [];
    if (isTransport) {
      var vliResult = buildVendorLineItems_(data.vendors, voucherReturnParcel, voucherDateRaw);
      if (!vliResult.valid) return { success: false, error: vliResult.error };
      vendorLineItems = vliResult.items;
      // Server-side money-integrity fix: amount for a transport voucher is
      // ALWAYS the sum of the validated vendor line items, never the
      // client-sent total. The client happens to compute and send the same
      // sum today (submitVoucher() in Main.gs), but nothing previously
      // stopped a mismatched value from being trusted and stored as
      // AV.AMOUNT — which feeds Rabale Daily Sync and every dashboard
      // total directly. (Tally export's own Petty Cash/Journal figures
      // were already safe, since buildTransportEntries independently
      // re-sums from Transport Breakdown line items — this fix is about
      // AV.AMOUNT and RDS, not the exported accounting.)
      amount = vendorLineItems.reduce(function (s, it) { return s + it.amount; }, 0);
    }

    var notes = buildVoucherNotes_(isTransport, description, voucherReturnParcel, vendorLineItems);

    // ------------------------------------------------------------------
    // PERFORMANCE FIX (Day 5): the global script lock previously wrapped
    // this entire function, INCLUDING every Drive folder lookup and file
    // upload — up to 25 slow, synchronous, network-bound calls. Since
    // LockService.getScriptLock() is script-wide (serializes the WHOLE
    // app, not just submissions), that meant one person uploading bill
    // photos froze every other submission AND every L1/Accounts/L2
    // approval action for the entire duration of their upload. The lock
    // now covers ONLY the part that genuinely needs cross-request
    // serialization: the duplicate-voucher-ID check and the row append.
    // Everything after (Drive I/O, Rabale Daily Sync, Transport
    // Breakdown) operates on a row this request now uniquely owns, so it
    // doesn't need to block anyone else.
    // ------------------------------------------------------------------
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      Logger.log('saveVoucherSubmission lock timeout: ' + lockErr);
      return { success: false, error: 'System is busy processing another submission. Please try again in a few seconds.' };
    }

    var sheet, newRowIndex;
    try {
      sheet = getSheet_(ALL_VOUCHERS_SHEET);
      validateVoucherSheetHeaders_(sheet);
      var existing = sheet.getDataRange().getValues();

      for (var i = 1; i < existing.length; i++) {
        if (String(existing[i][AV.VOUCHER_ID]).trim() === voucherId) {
          logAction_('SUBMIT_DUPLICATE', voucherId, submittedBy, 'submission', 'Attempted duplicate submission');
          return { success: false, error: 'Voucher number ' + voucherId + ' already exists. Please use a unique voucher number.' };
        }
      }

      var newRow = new Array(EXPECTED_VOUCHER_HEADERS.length).fill('');
      newRow[AV.VOUCHER_ID]     = voucherId;
      newRow[AV.DATE]           = formatDate_(voucherDateRaw);
      newRow[AV.EXPENSE_TYPE]   = expenseType;
      newRow[AV.SUBMITTED_BY]   = submittedBy;
      newRow[AV.VEHICLE_NO]     = vehicleNo;
      newRow[AV.COST_CENTRE]    = costCentre;
      newRow[AV.AMOUNT]         = amount;
      newRow[AV.STATUS]         = getPendingStatusForRole_(APPROVAL_SEQUENCE[0]); // 'Pending L1'
      newRow[AV.BATCH_ID]       = batchId;
      newRow[AV.QUERY_STATUS]   = 'No Query';
      newRow[AV.TALLY_EXPORTED] = 'No';
      newRow[AV.NOTES]          = notes;
      newRow[AV.SUBMITTED_BY_OPERATOR] = session.displayName || '';
      newRow[AV.ACTUAL_EXPENSE_DATE] = formatDate_(core.actualExpenseDateRaw);
      newRow[AV.CASH_RELEASED]  = 'No';
      sheet.appendRow(newRow);
      newRowIndex = sheet.getLastRow();
      // Lock this cell to plain text so Sheets' own locale-based
      // auto-parsing can never reinterpret the "dd/MM/yyyy" string we
      // just wrote (e.g. as US MM/dd/yyyy on a US-locale spreadsheet,
      // silently turning 01/08/2026 into 8 Jan). Same class of bug the
      // RDS sheet was already hardened against — AV.DATE was still open.
      sheet.getRange(newRowIndex, AV.DATE + 1).setNumberFormat('@');
      sheet.getRange(newRowIndex, AV.ACTUAL_EXPENSE_DATE + 1).setNumberFormat('@');
    } finally {
      lock.releaseLock();
    }

    // From here down, this voucherId's row is uniquely owned by this
    // request — no concurrent request can be touching it, so none of this
    // needs the global lock.
    try {
      updateRabaleDailySync_(voucherId, voucherDateRaw, submittedBy, vehicleNo, costCentre, amount, isTransport, data.ledger || '');
    } catch (syncErr) {
      Logger.log('saveVoucherSubmission: Rabale Daily Sync update failed for ' + voucherId + ': ' + syncErr);
      logAction_('SYNC_WARNING', voucherId, submittedBy, 'submission', 'Rabale Daily Sync update failed: ' + syncErr);
    }

    // Cash Advances (per explicit instruction, correction #2) — no
    // per-voucher hook needed anymore. A person's balance is now computed
    // live by summing their advances and their non-Rejected vouchers on
    // demand (getCashAdvanceBalances/getCashAdvanceLedger, Advances.gs),
    // not by linking a specific voucher to a specific advance row at
    // submission time — this voucher is already counted the moment it's
    // read from All Vouchers, nothing to write here.

    var fileUrls = [];
    var failedFiles = [];
    var root          = DriveApp.getRootFolder();
    var expFolder     = getOrCreateDriveFolder_(root, 'Rabale Expense System');
    var batchFolder   = getOrCreateDriveFolder_(expFolder, batchId);
    var voucherFolder = getOrCreateDriveFolder_(batchFolder, voucherId);

    var uploadResult = uploadBillFilesToFolder_(files, voucherFolder);
    fileUrls = uploadResult.fileUrls;
    failedFiles = uploadResult.failedFiles;

    if (fileUrls.length > 0) {
      try {
        sheet.getRange(newRowIndex, AV.BILL_FILES + 1).setValue(fileUrls.join('\n'));
      } catch (writeErr) {
        Logger.log('saveVoucherSubmission: failed to write bill file URLs for ' + voucherId + ': ' + writeErr);
      }
    }

    if (isTransport && vendorLineItems.length > 0) {
      writeTransportBreakdown_(voucherId, vendorLineItems);
      // Ledger Balance (Master Data column I, legacy/lifetime) AND the
      // Vendor FY Ledger (current source of truth for the TDS threshold
      // decision) both accumulate at initial submission, raw
      // pre-TDS/pre-GST amount. See updateVendorLedgerBalance and
      // updateVendorFyLedgerBalance (Master data.gs) for exactly what
      // each does and doesn't track.
      var fyKeyForSubmission = getFyKeyForDateValue_(voucherDateRaw);
      vendorLineItems.forEach(function (it) {
        try { updateVendorLedgerBalance_(it.name, it.amount); }
        catch (ledgerErr) { Logger.log('Ledger balance update failed for ' + it.name + ' on ' + voucherId + ': ' + ledgerErr); }
        try { updateVendorFyLedgerBalance_(it.name, fyKeyForSubmission, it.amount); }
        catch (fyLedgerErr) { Logger.log('FY ledger update failed for ' + it.name + ' on ' + voucherId + ': ' + fyLedgerErr); }
      });
    }

    logAction_('SUBMIT', voucherId, submittedBy, 'submission',
      'Amount: ' + amount + ', Operator: ' + (session.displayName || 'submission') +
      (fileUrls.length || failedFiles.length ? ', ' + fileUrls.length + '/' + (fileUrls.length + failedFiles.length) + ' file(s) uploaded' : ''));

    var tdsWarningSuffix = isTransport ? logAndFormatTdsWarnings_(voucherId, session.displayName, 'submission', vliResult && vliResult.warnings) : '';

    return {
      success: true,
      voucherId: voucherId,
      batchId: batchId,
      fileCount: fileUrls.length,
      failedCount: failedFiles.length,
      failedFiles: failedFiles,
      message: 'Voucher ' + voucherId + ' submitted. Batch: ' + batchId + tdsWarningSuffix
    };
  } catch (err) {
    Logger.log('saveVoucherSubmission error: ' + err);
    return { success: false, error: 'Failed to save voucher: ' + err.toString() };
  }
}

// ============================================================================
// EDIT / RESUBMIT (Day 3) — submission can edit and resubmit a voucher it
// already created, but only before anything has approved it (Pending L1)
// or after it's been rejected. Once any stage has approved it, a plain
// edit here would silently invalidate an approval already on record — that
// has to go through admin's revert function first.
// ============================================================================

// CHANGED (bugfix round): was ['Pending L1', 'Rejected'] — a freshly
// submitted, unqueried voucher was fully editable by submission for as
// long as it sat waiting for L1 to act on it, with no query required at
// all. Per explicit instruction, submission should only be able to touch
// a voucher once it's Rejected (this, full edit) or has an open query at
// any stage (see QUERY_EDIT_STATUSES/QUERY_CATEGORIES, Config.gs — a
// SEPARATE, category-scoped edit path, not this one). A plain Pending L1
// voucher with no query is now fully locked from the submission side.
var EDITABLE_STATUSES = ['Rejected'];

// Explicit release for the Cancel button (cancelEdit/goToNewVoucher,
// Main.gs) — a save already releases the lock as part of its own write
// (see resubmitVoucherCoreWriteOnly), this covers the "changed my mind"
// path where no write happens at all. Silently no-ops if the voucher
// isn't found or the lock isn't ours to release (see
// releaseVoucherEditLock's own force=false semantics) — a Cancel click
// should never surface an error to the user over lock bookkeeping.
function releaseVoucherEditLockRpc(voucherId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role || session.role !== 'submission') return { success: true };
    var found = findVoucherRow_(voucherId);
    if (!found) return { success: true };
    releaseVoucherEditLock_(found, session.displayName || 'submission', false);
    return { success: true };
  } catch (err) {
    Logger.log('releaseVoucherEditLockRpc error: ' + err);
    return { success: true }; // never block the client's cancel flow over this
  }
}

// Loads an existing voucher's data for the submission-side edit form.
// Role-gated to 'submission' specifically — this is the edit-your-own-
// voucher flow, not GST entry (getVendorLineItems, Approval.gs) or admin's
// god-mode revert, which are differently scoped and already exist. Returns
// vendor line items as name/amount only, not the GST/CGST/SGST/LR fields
// getVendorLineItems returns for Accounts — those aren't submission's
// business here.
function getVoucherForEdit(voucherId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'submission') return { success: false, error: 'You do not have permission to edit vouchers.' };

    var found = findVoucherRow_(voucherId);
    if (!found) return { success: false, error: 'Voucher not found: ' + voucherId };

    var status = safe_(found.rowValues[AV.STATUS]);
    var hasOpenQueryForScopedEdit = false;
    if (EDITABLE_STATUSES.indexOf(status) === -1) {
      if (QUERY_EDIT_STATUSES.indexOf(status) !== -1 && findOpenQueryRow_(voucherId)) {
        hasOpenQueryForScopedEdit = true;
      } else {
        return { success: false, error: 'This voucher is at "' + status + '" and has already progressed past L1 \u2014 ask admin to revert it before editing.' };
      }
    }

    // Edit lock (Day N) — acquired here, the moment the edit form actually
    // opens, not merely when Save is clicked. This is what makes the lock
    // meaningful: it covers the whole multi-minute editing session, not
    // just the instant of the write. Client releases it via
    // releaseVoucherEditLockRpc on Cancel; a successful save releases it
    // as part of the write itself (resubmitVoucherCoreWriteOnly /
    // resubmitVoucherForQueryScope); an abandoned tab self-expires after
    // EDIT_LOCK_TIMEOUT_SECONDS.
    var lockResult = acquireVoucherEditLock_(found, session.displayName || 'submission');
    if (!lockResult.success) return { success: false, error: lockResult.error };

    var expenseType = safe_(found.rowValues[AV.EXPENSE_TYPE]);
    var isTransport = (expenseType === 'Transport');
    var billFilesRaw = safe_(found.rowValues[AV.BILL_FILES]);
    var billFiles = billFilesRaw ? billFilesRaw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : [];

    var vendors = [];
    var returnParcel = false;
    if (isTransport) {
      var tbSheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
      if (tbSheet) {
        var tbData = tbSheet.getDataRange().getValues();
        for (var i = 1; i < tbData.length; i++) {
          if (safe_(tbData[i][TB.VOUCHER_ID]) === voucherId) {
            // REVISED (Day 5): billFiles dropped here — Option B rolled
            // back, a transport voucher's bills live on AV.BILL_FILES
            // (whole voucher, returned separately below) same as Regular.
            vendors.push({
              name: safe_(tbData[i][TB.VENDOR_NAME]),
              amount: parseFloat(tbData[i][TB.AMOUNT]) || 0
            });
            if (safe_(tbData[i][TB.RETURN_PARCEL]) === 'Yes') returnParcel = true;
          }
        }
      }
    }

    return {
      success: true,
      voucherId: voucherId,
      status: status,
      date: formatDate_(found.rowValues[AV.DATE]),
      actualExpenseDate: safe_(found.rowValues[AV.ACTUAL_EXPENSE_DATE]) || formatDate_(found.rowValues[AV.DATE]),
      expenseType: expenseType,
      isTransport: isTransport,
      submittedBy: safe_(found.rowValues[AV.SUBMITTED_BY]),
      vehicleNo: safe_(found.rowValues[AV.VEHICLE_NO]),
      costCentre: safe_(found.rowValues[AV.COST_CENTRE]),
      amount: parseFloat(found.rowValues[AV.AMOUNT]) || 0,
      description: isTransport ? '' : safe_(found.rowValues[AV.NOTES]), // Notes IS the description for regular vouchers (see buildVoucherNotes)
      billFiles: billFiles,
      vendors: vendors,
      returnParcel: returnParcel
    };
  } catch (err) {
    Logger.log('getVoucherForEdit error: ' + err);
    return { success: false, error: 'Failed to load voucher: ' + err.toString() };
  }
}

// Submission edits and resubmits a voucher. Reuses the exact same
// validation as saveVoucherSubmission (validateVoucherCoreFields,
// buildVendorLineItems, buildVoucherNotes, validateFileUploadBatch) rather
// than duplicating it.
//
// The voucher ID itself is immutable — voucherId identifies WHICH row to
// update; nothing in formDataJson can change it (any voucherNo field the
// client sends along, since the edit form reuses the submission form's
// markup, is simply never read).
//
// Bill files: filesJson carries NEW files to add (same base64 shape as
// saveVoucherSubmission); removedFileUrlsJson carries existing bill file
// URLs the submitter chose to remove. Per explicit instruction, a removed
// file is only UNLINKED from BILL_FILES, never deleted from Drive — a
// human might want to recover it later, and silently deleting is
// higher-risk for zero real benefit. At least one file (existing remaining
// + new) must remain, matching the same "bill upload compulsory" rule as
// original submission.
//
// Transport Breakdown is fully replaced (old rows deleted, new ones
// written), per explicit instruction — this clears any GST/CGST/SGST/LR
// Accounts may have already entered before rejecting the voucher; Accounts
// re-reviews GST on the resubmitted voucher same as any other transport
// voucher, no attempt is made to preserve it line-by-line.
//
// Stage routing (Task 3): if the voucher was 'Rejected', reads
// AV.REJECTED_AT_STAGE and routes back to exactly that stage via the
// shared moveVoucherToStage() helper (Approval.gs) — NOT restarting at L1.
// Falls back to L1 (and logs the fallback) if that column is blank or
// unrecognized, e.g. a legacy rejected voucher that predates this column.
// A voucher that was already 'Pending L1' needs no stage change.
// Shared by resubmitVoucher — used both to fetch the OLD vendor lines
// (before Transport Breakdown gets cleared) and to summarize the NEW ones,
// so a resubmit's audit log entry can describe exactly what changed on the
// vendor side (added/removed/changed), not just "voucher resubmitted".
// Summarized by vendor NAME (count + total amount), not per exact line —
// an exact line-level diff is ambiguous when a vendor legitimately
// appears twice with different amounts; a name-level count+total change is
// still a meaningful, honest "this got added/removed" signal without
// pretending to know which specific physical bill was removed.
function summarizeVendorLines_(items) {
  var summary = {};
  (items || []).forEach(function (it) {
    var name = it.name || it.vendorName;
    if (!summary[name]) summary[name] = { count: 0, totalAmount: 0 };
    summary[name].count++;
    summary[name].totalAmount += it.amount;
  });
  return summary;
}

function getOldVendorLineSummary_(voucherId) {
  var tbSheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
  if (!tbSheet) return {};
  var tbData = tbSheet.getDataRange().getValues();
  var oldItems = [];
  for (var i = 1; i < tbData.length; i++) {
    if (safe_(tbData[i][TB.VOUCHER_ID]) === voucherId) {
      oldItems.push({ name: safe_(tbData[i][TB.VENDOR_NAME]), amount: parseFloat(tbData[i][TB.AMOUNT]) || 0 });
    }
  }
  return summarizeVendorLines_(oldItems);
}

function diffVendorSummaries_(oldSummary, newSummary) {
  var changes = [];
  var allNames = {};
  Object.keys(oldSummary).forEach(function (n) { allNames[n] = true; });
  Object.keys(newSummary).forEach(function (n) { allNames[n] = true; });
  Object.keys(allNames).sort().forEach(function (name) {
    var o = oldSummary[name], n = newSummary[name];
    if (o && !n) {
      changes.push('DELETED ' + name + ' (' + o.count + ' bill(s), Rs.' + o.totalAmount + ')');
    } else if (!o && n) {
      changes.push('ADDED ' + name + ' (' + n.count + ' bill(s), Rs.' + n.totalAmount + ')');
    } else if (o && n && (o.count !== n.count || o.totalAmount !== n.totalAmount)) {
      changes.push('CHANGED ' + name + ' (' + o.count + ' bill(s)/Rs.' + o.totalAmount + ' \u2192 ' + n.count + ' bill(s)/Rs.' + n.totalAmount + ')');
    }
  });
  return changes;
}

// Ledger Balance (Master Data column I) keeps up with any vendor-side
// change after original submission, not just the initial add — a full
// edit/resubmit, a query-scoped amount/vendor correction, or an admin
// delete all move real Rupees on or off a vendor's running total, so each
// of those call sites applies the delta between old and new per-vendor
// summaries here rather than leaving the balance to drift. Zero-delta
// vendors (unchanged lines) and vendors that don't move at all are
// skipped — no pointless writes.
function applyVendorLedgerBalanceDelta_(oldSummary, newSummary) {
  var allNames = {};
  Object.keys(oldSummary || {}).forEach(function (n) { allNames[n] = true; });
  Object.keys(newSummary || {}).forEach(function (n) { allNames[n] = true; });
  Object.keys(allNames).forEach(function (name) {
    var oldTotal = (oldSummary && oldSummary[name]) ? oldSummary[name].totalAmount : 0;
    var newTotal = (newSummary && newSummary[name]) ? newSummary[name].totalAmount : 0;
    var delta = round2_(newTotal - oldTotal);
    if (delta !== 0) updateVendorLedgerBalance_(name, delta);
  });
}

// Shared write logic for resubmitVoucher and resubmitVoucherAndRespondToQuery
// — assumes the CALLER already holds the script lock and has already
// validated/parsed the form data via validateVoucherCoreFields /
// buildVendorLineItems. Re-fetches the voucher fresh here (eligibility
// checked against CURRENT state, not whatever was true when the edit form
// loaded — mirrors updateVoucherStatus's own re-check pattern) and does
// all the writes. On success, the result includes `found` (the live Sheet
// row reference) and `previousStatus` so a combined caller can continue
// working with the same row without a second sheet scan — callers that
// return straight to the client MUST delete these two fields first, since
// a Sheet object can't cross the google.script.run serialization boundary.
//
// REVISED (Day 5): Option B rolled back — Transport and Regular now share
// ONE whole-voucher file add/remove path (newFiles/removedFileUrls),
// exactly the same either way; there's no more per-vendor-line file
// branch. `operatorName` (the logged-in submission user doing the
// resubmit) stamps AV.SUBMITTED_BY_OPERATOR, same as a fresh submission.
function resubmitVoucherCore_(voucherId, submittedBy, costCentre, amount, isTransport, expenseType, vehicleNo, voucherDateRaw, notes, vendorLineItems, newFiles, removedFileUrls, ledgerName, operatorName, actualExpenseDateRaw) {
  var found = findVoucherRow_(voucherId);
  if (!found) return { success: false, error: 'Voucher not found: ' + voucherId };

  var previousStatus = safe_(found.rowValues[AV.STATUS]);
  if (EDITABLE_STATUSES.indexOf(previousStatus) === -1) {
    return { success: false, error: 'This voucher is at "' + previousStatus + '" and has already progressed past L1 \u2014 ask admin to revert it before editing.' };
  }

  return resubmitVoucherCoreWriteOnly_(found, submittedBy, costCentre, amount, isTransport, expenseType, vehicleNo,
    voucherDateRaw, notes, vendorLineItems, newFiles, removedFileUrls, ledgerName, operatorName, actualExpenseDateRaw);
}

// The actual write logic, factored out of resubmitVoucherCore so the Day 6
// scoped query-edit path (resubmitVoucherForQueryScope, 'full'/Other
// category) can reuse it against a voucher at Pending Accounts/Pending L2
// — statuses EDITABLE_STATUSES deliberately excludes — without going
// through resubmitVoucherCore's own gate, which would incorrectly reject
// it. Callers other than resubmitVoucherCore are responsible for their own
// status validation before calling this; it does none itself.
//
// CHANGED (backdating build): AV.DATE (Voucher/Submission Date) is now
// permanently fixed at original creation and is NEVER rewritten here —
// the `voucherDateRaw` parameter is accepted for backward call-site
// compatibility but deliberately ignored for both the AV.DATE write and
// Rabale Daily Sync placement; the TRUE original date is re-derived from
// `found` itself instead, so it's correct regardless of what any caller
// passes. `actualExpenseDateRaw` is the new, genuinely editable field —
// callers pass a real value when it's actually meant to change (Other
// category, or the older Pending-L1/Rejected full edit), or omit it to
// leave the stored Actual Expense Date untouched.
function resubmitVoucherCoreWriteOnly_(found, submittedBy, costCentre, amount, isTransport, expenseType, vehicleNo, voucherDateRaw, notes, vendorLineItems, newFiles, removedFileUrls, ledgerName, operatorName, actualExpenseDateRaw) {
  var voucherId = safe_(found.rowValues[AV.VOUCHER_ID]);
  var previousStatus = safe_(found.rowValues[AV.STATUS]);
  var trueVoucherDateRaw = parseRdsDateString_(safe_(found.rowValues[AV.DATE]));
  // Captured BEFORE any write below — found.rowValues is the in-memory
  // snapshot from the original findVoucherRow read and is never mutated
  // by the .setValue() calls that follow, so this stays accurate as the
  // true "before" state for the audit diff logged at the end.
  var beforeSnapshot = snapshotVoucherCoreForAudit_(found.rowValues);

  var existingBillFilesRaw = safe_(found.rowValues[AV.BILL_FILES]);
  var existingBillFiles = existingBillFilesRaw ? existingBillFilesRaw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : [];
  // CHANGED (bugfix round 2, #2): bill files are append-only now, per
  // explicit instruction — a submitter may add supporting documents but
  // must never be able to remove one that's already attached, since a
  // removed bill on an in-flight or already-actioned voucher would erase
  // part of the record an approver may have already reviewed. removedFileUrls
  // is still accepted as a parameter (every caller still passes it) so
  // this signature doesn't need to change across all three resubmit
  // paths, but it's intentionally ignored here rather than threaded
  // through — existingBillFiles is never filtered against it. The client
  // no longer offers a remove control at all (renderExistingFileChips,
  // Main.gs), so this is enforcement of that rule on the server, not
  // just a UI restriction.
  var remainingExisting = existingBillFiles;

  if (remainingExisting.length + newFiles.length === 0) {
    return { success: false, error: 'At least one bill file is required.' };
  }
  if (remainingExisting.length + newFiles.length > MAX_FILES_PER_UPLOAD) {
    return { success: false, error: 'Maximum ' + MAX_FILES_PER_UPLOAD + ' files allowed \u2014 remove some existing files before adding more.' };
  }

  var batchId = safe_(found.rowValues[AV.BATCH_ID]) || generateBatchId_();

  // Drive folder status suffix (per explicit instruction) — clear it back
  // to the plain voucherId BEFORE any Drive access below. This voucher is
  // resubmitting (re-entering the pipeline, whether from Rejected or in
  // response to a query), so any Approved/Rejected/Query suffix from
  // before no longer applies — and critically, the new-file upload code
  // further down looks the folder up via getOrCreateDriveFolder(batchFolder,
  // voucherId), an EXACT match on the plain voucherId. Leaving a suffix in
  // place would make that lookup miss the real (suffixed) folder entirely
  // and silently create a second, empty one, orphaning every existing
  // bill file. Best effort — never blocks the resubmission itself.
  setVoucherDriveFolderStatusSuffix_(batchId, voucherId, '');

  // AV.DATE deliberately NOT rewritten — see function comment above.
  found.sheet.getRange(found.rowIndex, AV.EXPENSE_TYPE + 1).setValue(expenseType);
  found.sheet.getRange(found.rowIndex, AV.SUBMITTED_BY + 1).setValue(submittedBy);
  found.sheet.getRange(found.rowIndex, AV.VEHICLE_NO + 1).setValue(vehicleNo);
  found.sheet.getRange(found.rowIndex, AV.COST_CENTRE + 1).setValue(costCentre);
  found.sheet.getRange(found.rowIndex, AV.AMOUNT + 1).setValue(amount);
  found.sheet.getRange(found.rowIndex, AV.NOTES + 1).setValue(notes);
  if (operatorName) found.sheet.getRange(found.rowIndex, AV.SUBMITTED_BY_OPERATOR + 1).setValue(operatorName);
  if (actualExpenseDateRaw instanceof Date && !isNaN(actualExpenseDateRaw.getTime())) {
    found.sheet.getRange(found.rowIndex, AV.ACTUAL_EXPENSE_DATE + 1).setNumberFormat('@').setValue(formatDate_(actualExpenseDateRaw));
  }

  // Transport Breakdown: always clear first (cheap no-op if the voucher
  // was never transport), then rewrite only if the RESUBMITTED version is
  // transport — correctly handles all four transitions
  // (transport<->transport, transport<->regular). Old vendor lines are
  // captured BEFORE clearing so the audit log below can describe exactly
  // what was added/deleted/changed on the vendor side, not just "voucher
  // resubmitted" — a deleted vendor line is logged just as explicitly as
  // a name or amount change.
  var oldVendorSummary = getOldVendorLineSummary_(voucherId);
  clearTransportBreakdownRows_(voucherId);

  if (isTransport && vendorLineItems.length > 0) {
    writeTransportBreakdown_(voucherId, vendorLineItems);
  }
  var newVendorSummary = summarizeVendorLines_(vendorLineItems);
  // The audit-log diff always narrates against the REAL previous Transport
  // Breakdown content — vendorChanges must stay accurate regardless of
  // what happened to the ledger below.
  var vendorChanges = diffVendorSummaries_(oldVendorSummary, newVendorSummary);

  // BUG FIX (ledger balance): if this voucher was Rejected, its vendor
  // lines were already fully reversed out of the ledger at the moment of
  // rejection (see updateVoucherStatus, Approval.gs) — but the Transport
  // Breakdown rows themselves were deliberately left in place so the
  // submitter could see/edit them here. Feeding the real oldVendorSummary
  // (still showing the pre-reversal amounts) into the ledger delta below
  // would compute delta=0 for an unchanged amount and silently fail to
  // re-add money that's genuinely being resubmitted. Treating "old" as
  // zero here for the ledger math ONLY (never for the audit diff above)
  // correctly re-adds the full resubmitted amount with no double-count,
  // since the reversal at reject-time already zeroed it out.
  var oldVendorSummaryForLedger = (previousStatus === 'Rejected') ? {} : oldVendorSummary;
  applyVendorLedgerBalanceDelta_(oldVendorSummaryForLedger, newVendorSummary);
  applyVendorFyLedgerBalanceDelta_(oldVendorSummaryForLedger, newVendorSummary, getFinancialYearBounds_(trueVoucherDateRaw).key);

  // Rabale Daily Sync — update the existing row in place rather than
  // append a duplicate. Uses trueVoucherDateRaw (the ORIGINAL submission
  // date), never the passed-in voucherDateRaw param — RDS placement must
  // never move as a side effect of an edit, per explicit instruction.
  updateRabaleDailySyncRow_(voucherId, trueVoucherDateRaw, submittedBy, vehicleNo, costCentre, amount, isTransport, ledgerName);

  // New files upload into the SAME Drive folder as the original (same
  // batchId, same voucherId), then merge with the remaining (non-removed)
  // existing URLs — one path for both Regular and Transport now.
  var newFileUrls = [];
  var failedFiles = [];
  if (newFiles.length > 0) {
    var root          = DriveApp.getRootFolder();
    var expFolder     = getOrCreateDriveFolder_(root, 'Rabale Expense System');
    var batchFolder   = getOrCreateDriveFolder_(expFolder, batchId);
    var voucherFolder = getOrCreateDriveFolder_(batchFolder, voucherId);
    var uploadResult = uploadBillFilesToFolder_(newFiles, voucherFolder);
    newFileUrls = uploadResult.fileUrls;
    failedFiles = uploadResult.failedFiles;
  }
  var finalFileList = remainingExisting.concat(newFileUrls);
  found.sheet.getRange(found.rowIndex, AV.BILL_FILES + 1).setValue(finalFileList.join('\n'));

  // A successful save always releases the lock, regardless of who
  // acquired it (force=true) — the edit session is over either way.
  releaseVoucherEditLock_(found, operatorName || '', true);

  // Stage routing (Task 3) — only a Rejected voucher needs to move;
  // Pending L1 is already exactly where it should be.
  if (previousStatus === 'Rejected') {
    var rejectedAtRole = safe_(found.rowValues[AV.REJECTED_AT_STAGE]);
    var targetStage = APPROVAL_SEQUENCE.indexOf(rejectedAtRole) !== -1 ? rejectedAtRole : APPROVAL_SEQUENCE[0];
    if (targetStage !== rejectedAtRole) {
      var fallbackMsg = 'resubmitVoucherCore fell back to ' + APPROVAL_SEQUENCE[0] + ' for ' + voucherId + ' \u2014 Rejected At Stage was blank or unrecognized ("' + rejectedAtRole + '").';
      Logger.log('WARNING: ' + fallbackMsg);
      logAction_('SYNC_WARNING', voucherId, 'system', 'system', fallbackMsg);
    }
    moveVoucherToStage_(found, targetStage);
  }

  logAction_('RESUBMIT', voucherId, operatorName || submittedBy, 'submission',
    'Resubmitted from "' + previousStatus + '"' +
    (newFileUrls.length ? ', ' + newFileUrls.length + ' file(s) in final set' : '') +
    (vendorChanges.length ? '; ' + vendorChanges.join('; ') : ''));

  // Structured before/after pair for the Auditor Dashboard's diff view
  // (see snapshotVoucherCoreForAudit) — separate from the human-readable
  // RESUBMIT entry above so existing log readers/exports are unaffected;
  // the Auditor UI looks specifically for VOUCHER_EDIT_SNAPSHOT entries.
  var afterSnapshot = snapshotVoucherCoreForAudit_(found.rowValues);
  // found.rowValues itself is stale (unwritten in-memory), so read back
  // the fields this function actually changed from the local variables
  // it just wrote, rather than re-fetching the whole row for one call.
  afterSnapshot.expenseType = expenseType;
  afterSnapshot.submittedBy = submittedBy;
  afterSnapshot.vehicleNo = vehicleNo;
  afterSnapshot.costCentre = costCentre;
  afterSnapshot.amount = amount;
  afterSnapshot.notes = notes;
  afterSnapshot.billFiles = finalFileList.join('\n');
  if (actualExpenseDateRaw instanceof Date && !isNaN(actualExpenseDateRaw.getTime())) {
    afterSnapshot.actualExpenseDate = formatDate_(actualExpenseDateRaw);
  }
  logAction_('VOUCHER_EDIT_SNAPSHOT', voucherId, operatorName || submittedBy, 'submission',
    JSON.stringify({ before: beforeSnapshot, after: afterSnapshot }));

  return {
    success: true,
    voucherId: voucherId,
    newFileCount: newFileUrls.length,
    failedCount: failedFiles.length,
    failedFiles: failedFiles,
    message: 'Voucher ' + voucherId + ' resubmitted.',
    found: found,
    previousStatus: previousStatus
  };
}

function resubmitVoucher(voucherId, formDataJson, filesJson, removedFileUrlsJson, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'submission') return { success: false, error: 'You do not have permission to edit vouchers.' };

    var voucherIdValidation = validateVoucherId_(voucherId);
    if (!voucherIdValidation.valid) return { success: false, error: 'Invalid voucher ID.' };
    voucherId = voucherIdValidation.id;

    var data;
    try { data = JSON.parse(formDataJson); } catch (e) { return { success: false, error: 'Invalid form data.' }; }

    var core = validateVoucherCoreFields_(data);
    if (!core.valid) return { success: false, error: core.error };

    // Lightweight, lock-free read purely to get this voucher's true,
    // immutable AV.DATE for FY-ledger purposes before the TDS decision
    // in buildVendorLineItems below — the real, lock-protected row read
    // for the actual write happens later inside resubmitVoucherCore /
    // resubmitVoucherCoreWriteOnly. AV.DATE never changes across an
    // edit, so this early read can never go stale relative to the later
    // one; a second, cheap read here is preferable to restructuring the
    // call order just to share one read.
    var earlyFoundForDate = findVoucherRow_(voucherId);
    if (!earlyFoundForDate) return { success: false, error: 'Voucher not found: ' + voucherId };
    var billDateForFy = earlyFoundForDate.rowValues[AV.DATE];

    var vendorLineItems = [];
    var amount = core.amount;
    if (core.isTransport) {
      var vliResult = buildVendorLineItems_(data.vendors, core.voucherReturnParcel, billDateForFy);
      if (!vliResult.valid) return { success: false, error: vliResult.error };
      vendorLineItems = vliResult.items;
      amount = vendorLineItems.reduce(function (s, it) { return s + it.amount; }, 0);
    }

    var notes = buildVoucherNotes_(core.isTransport, core.description, core.voucherReturnParcel, vendorLineItems);

    var newFiles = [];
    if (filesJson) {
      try { newFiles = JSON.parse(filesJson) || []; } catch (e) { newFiles = []; }
    }
    var fileBatchError = validateFileUploadBatch_(newFiles);
    if (fileBatchError) return { success: false, error: fileBatchError };

    var removedFileUrls = [];
    if (removedFileUrlsJson) {
      try { removedFileUrls = JSON.parse(removedFileUrlsJson) || []; } catch (e) { removedFileUrls = []; }
    }

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      Logger.log('resubmitVoucher lock timeout: ' + lockErr);
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      // NOTE: resubmitVoucherCore's Drive I/O stays INSIDE this lock,
      // unlike saveVoucherSubmission's — a resubmit's critical section
      // (status re-check + Transport Breakdown rewrite + stage routing)
      // is a read-check-write sequence on a row that could otherwise be
      // concurrently approved/rejected mid-resubmit, which is a real
      // race, not just a slow-request annoyance. Resubmits are also far
      // less frequent than fresh submissions, so this isn't the hot path
      // the lock-scope fix was aimed at.
      var result = resubmitVoucherCore_(voucherId, core.submittedBy, core.costCentre, amount, core.isTransport,
        core.expenseType, core.vehicleNo, core.voucherDateRaw, notes, vendorLineItems, newFiles, removedFileUrls, data.ledger || '', session.displayName, core.actualExpenseDateRaw);
      // `found`/`previousStatus` are internal-only (a Sheet object can't
      // cross the RPC boundary) — only resubmitVoucherAndRespondToQuery,
      // which calls resubmitVoucherCore directly server-side, needs them.
      delete result.found;
      delete result.previousStatus;
      if (result.success && core.isTransport) {
        result.message = (result.message || '') + logAndFormatTdsWarnings_(voucherId, session.displayName, 'submission', vliResult && vliResult.warnings);
      }
      return result;
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('resubmitVoucher error: ' + err);
    return { success: false, error: 'Failed to resubmit voucher: ' + err.toString() };
  }
}

// Combined submission-side operation: edits/resubmits a voucher AND
// responds to its open query in the SAME lock, so both effects land
// together rather than as two separate sequential calls that could
// partially succeed — the project's own established lesson from the
// original submit+upload bug ("one call, one lock, one place a failure is
// visible"). Only offered when the voucher is in EDITABLE_STATUSES
// (Pending L1 or Rejected), same restriction as plain resubmit and for the
// same reason: a voucher a prior stage has already approved (Pending
// Accounts / Pending L2) must not have its numbers silently changed
// through a query response either — for that case, the plain
// respondToQuery (text + optional file attachment, no field edits) is
// still the right tool; Main.gs\'s routing logic picks between the two.
// ============================================================================
// SCOPED QUERY EDIT (Day 6) — for a query raised while a voucher is at
// Pending Accounts or Pending L2 (i.e. L1, and possibly Accounts too, has
// already approved). Plain resubmitVoucherAndRespondToQuery above is NOT
// used here: it assumes EDITABLE_STATUSES (Rejected only), where
// nothing has been approved yet and a fully open edit is safe. Past that
// point, an open edit could silently undermine a prior stage's approval —
// see the field-scope table in QUERY_CATEGORIES (Config.gs) — so every
// field this function touches is validated against the category's
// declared scope BEFORE anything is written. A change outside scope
// REJECTS THE WHOLE RESUBMIT with a clear error; it never silently drops
// the disallowed field, since that would lose the submitter's other edits
// without telling them why.
//
// Date and Voucher Number are locked for every category here, including
// 'full' (Other) — this is the one respect in which even Other is less
// permissive than the older Pending-L1/Rejected edit, which still allows
// date changes. Voucher Number was never editable via this API at all
// (voucherId is a separate parameter, never read from formData).
// ============================================================================
function resubmitVoucherForQueryScope(voucherId, formDataJson, filesJson, removedFileUrlsJson, response, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'submission') return { success: false, error: 'You do not have permission to do this.' };
    if (!response || !response.trim()) return { success: false, error: 'A response is required.' };

    var voucherIdValidation = validateVoucherId_(voucherId);
    if (!voucherIdValidation.valid) return { success: false, error: 'Invalid voucher ID.' };
    voucherId = voucherIdValidation.id;

    var data;
    try { data = JSON.parse(formDataJson); } catch (e) { return { success: false, error: 'Invalid form data.' }; }

    var core = validateVoucherCoreFields_(data);
    if (!core.valid) return { success: false, error: core.error };

    var newFiles = [];
    if (filesJson) { try { newFiles = JSON.parse(filesJson) || []; } catch (e) { newFiles = []; } }
    var fileBatchError = validateFileUploadBatch_(newFiles);
    if (fileBatchError) return { success: false, error: fileBatchError };

    var removedFileUrls = [];
    if (removedFileUrlsJson) { try { removedFileUrls = JSON.parse(removedFileUrlsJson) || []; } catch (e) { removedFileUrls = []; } }

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var found = findVoucherRow_(voucherId);
      if (!found) return { success: false, error: 'Voucher not found: ' + voucherId };

      var currentStatus = safe_(found.rowValues[AV.STATUS]);
      if (QUERY_EDIT_STATUSES.indexOf(currentStatus) === -1) {
        return { success: false, error: 'This voucher is at "' + currentStatus + '" and is not eligible for a scoped query edit.' };
      }

      // Captured before any of the fieldScope branches below write
      // anything — see snapshotVoucherCoreForAudit's own comment for why
      // this stays accurate as the "before" half of the audit diff.
      var beforeSnapshot = snapshotVoucherCoreForAudit_(found.rowValues);

      var queryRow = findOpenQueryRow_(voucherId);
      if (!queryRow) return { success: false, error: 'No open query found for this voucher.' };
      var qid       = safe_(queryRow.rowValues[QT.QUERY_ID]);
      var queryType = safe_(queryRow.rowValues[QT.QUERY_TYPE]);
      var category  = QUERY_CATEGORIES[queryType];
      if (!category) return { success: false, error: 'Unrecognized query category on this voucher: ' + queryType };

      var isTransport = safe_(found.rowValues[AV.EXPENSE_TYPE]) === 'Transport';
      // Original submission date, used for RDS placement in every branch
      // below — never core.voucherDateRaw, which is always "today" now
      // that AV.DATE is permanently immutable. (The old explicit
      // "date cannot be changed" rejection that lived here is gone too —
      // it's structurally impossible to change it now, there's nothing
      // left to reject.)
      var trueVoucherDateRaw = parseRdsDateString_(safe_(found.rowValues[AV.DATE]));

      // Fields outside a given category's scope, checked once up front so
      // each branch below just asks "did anything I don't own change?"
      // instead of re-deriving these.
      var submittedByChanged        = core.submittedBy !== safe_(found.rowValues[AV.SUBMITTED_BY]);
      var vehicleNoChanged          = core.vehicleNo !== safe_(found.rowValues[AV.VEHICLE_NO]);
      var actualExpenseDateChanged  = formatDate_(core.actualExpenseDateRaw) !== safe_(found.rowValues[AV.ACTUAL_EXPENSE_DATE]);
      var descriptionChanged        = !isTransport && core.description !== safe_(found.rowValues[AV.NOTES]);
      var amountFlatChanged         = !isTransport && core.amount !== (parseFloat(found.rowValues[AV.AMOUNT]) || 0);
      var ledgerChanged             = !isTransport && core.expenseType !== safe_(found.rowValues[AV.EXPENSE_TYPE]);

      var touchedLineIndexes = [];
      var demote = false;
      var tdsWarnings = [];
      var resultFileInfo = { newFileCount: 0, failedCount: 0, failedFiles: [] };

      function applyFiles() {
        var existingBillFilesRaw = safe_(found.rowValues[AV.BILL_FILES]);
        var existingBillFiles = existingBillFilesRaw ? existingBillFilesRaw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : [];
        // CHANGED (bugfix round 2, #2): append-only, same as
        // resubmitVoucherCoreWriteOnly above — removedFileUrls is accepted
        // but never applied. See that function's comment for the full
        // rationale.
        var remainingExisting = existingBillFiles;
        if (remainingExisting.length + newFiles.length === 0) return 'At least one bill file is required.';
        if (remainingExisting.length + newFiles.length > MAX_FILES_PER_UPLOAD) return 'Maximum ' + MAX_FILES_PER_UPLOAD + ' files allowed.';

        var newFileUrls = [];
        if (newFiles.length > 0) {
          var batchId = safe_(found.rowValues[AV.BATCH_ID]) || 'unbatched';
          var root = DriveApp.getRootFolder();
          var expFolder = getOrCreateDriveFolder_(root, 'Rabale Expense System');
          var batchFolder = getOrCreateDriveFolder_(expFolder, batchId);
          var voucherFolder = getOrCreateDriveFolder_(batchFolder, voucherId);
          var uploadResult = uploadBillFilesToFolder_(newFiles, voucherFolder);
          newFileUrls = uploadResult.fileUrls;
          resultFileInfo.failedFiles = resultFileInfo.failedFiles.concat(uploadResult.failedFiles);
        }
        resultFileInfo.newFileCount = newFileUrls.length;
        resultFileInfo.failedCount = resultFileInfo.failedFiles.length;
        found.sheet.getRange(found.rowIndex, AV.BILL_FILES + 1).setValue(remainingExisting.concat(newFileUrls).join('\n'));
        return null;
      }

      if (category.fieldScope === 'billFiles') {
        if (submittedByChanged || vehicleNoChanged || actualExpenseDateChanged || descriptionChanged || amountFlatChanged || ledgerChanged) {
          return { success: false, error: 'Only Bill Files can be changed for this query.' };
        }
        var fileErr = applyFiles();
        if (fileErr) return { success: false, error: fileErr };

      } else if (category.fieldScope === 'description') {
        if (submittedByChanged || vehicleNoChanged || actualExpenseDateChanged || amountFlatChanged || ledgerChanged) {
          return { success: false, error: 'Only Description can be changed for this query.' };
        }
        if (isTransport) return { success: false, error: 'This query category does not apply to a Transport voucher.' };
        found.sheet.getRange(found.rowIndex, AV.NOTES + 1).setValue(core.description);

      } else if (category.fieldScope === 'actualExpenseDate') {
        if (submittedByChanged || vehicleNoChanged || descriptionChanged || amountFlatChanged || ledgerChanged) {
          return { success: false, error: 'Only Actual Expense Date can be changed for this query.' };
        }
        found.sheet.getRange(found.rowIndex, AV.ACTUAL_EXPENSE_DATE + 1).setNumberFormat('@').setValue(formatDate_(core.actualExpenseDateRaw));

      } else if (category.fieldScope === 'submittedBy') {
        if (vehicleNoChanged || actualExpenseDateChanged || descriptionChanged || amountFlatChanged || ledgerChanged) {
          return { success: false, error: 'Only Submitted By can be changed for this query.' };
        }
        found.sheet.getRange(found.rowIndex, AV.SUBMITTED_BY + 1).setValue(core.submittedBy);
        updateRabaleDailySyncRow_(voucherId, trueVoucherDateRaw, core.submittedBy, safe_(found.rowValues[AV.VEHICLE_NO]), safe_(found.rowValues[AV.COST_CENTRE]),
          parseFloat(found.rowValues[AV.AMOUNT]) || 0, isTransport, safe_(found.rowValues[AV.EXPENSE_TYPE]));

      } else if (category.fieldScope === 'vehicleNo') {
        if (submittedByChanged || actualExpenseDateChanged || descriptionChanged || amountFlatChanged || ledgerChanged) {
          return { success: false, error: 'Only Vehicle No. can be changed for this query.' };
        }
        found.sheet.getRange(found.rowIndex, AV.VEHICLE_NO + 1).setValue(core.vehicleNo);
        updateRabaleDailySyncRow_(voucherId, trueVoucherDateRaw, safe_(found.rowValues[AV.SUBMITTED_BY]), core.vehicleNo, safe_(found.rowValues[AV.COST_CENTRE]),
          parseFloat(found.rowValues[AV.AMOUNT]) || 0, isTransport, safe_(found.rowValues[AV.EXPENSE_TYPE]));

      } else if (category.fieldScope === 'costCentre') {
        if (submittedByChanged || vehicleNoChanged || actualExpenseDateChanged || descriptionChanged || amountFlatChanged || ledgerChanged) {
          return { success: false, error: 'Only Cost Centre can be changed for this query.' };
        }
        found.sheet.getRange(found.rowIndex, AV.COST_CENTRE + 1).setValue(core.costCentre);
        updateRabaleDailySyncRow_(voucherId, trueVoucherDateRaw, safe_(found.rowValues[AV.SUBMITTED_BY]), safe_(found.rowValues[AV.VEHICLE_NO]), core.costCentre,
          parseFloat(found.rowValues[AV.AMOUNT]) || 0, isTransport, safe_(found.rowValues[AV.EXPENSE_TYPE]));

      } else if (category.fieldScope === 'ledgerOrVendor') {
        // BUG FIX (per report \u2014 "Only Ledger / Expense Category can be
        // changed for this query" firing even when nothing else was
        // touched): Vehicle No. is NOT an independently-editable field on a
        // Regular voucher \u2014 it is entirely DETERMINED by which ledger is
        // selected (VEHICLE_REQUIRED_LEDGERS, Config.gs; enforced above in
        // validateVoucherCoreFields, which already refused to reach this
        // point unless vehicleNo correctly matches the NEW ledger's
        // requirement \u2014 blank for a non-vehicle ledger, populated for one
        // of the three vehicle ledgers). So when this query's scope is
        // Ledger/Expense Category and the submitter changes TO or FROM a
        // vehicle-required ledger (e.g. "Office Expenses" -> "Vehicle
        // Operating - Jakat/Toll"), the resulting vehicleNo change is not a
        // scope violation \u2014 it is an unavoidable, already-validated side
        // effect of a legitimate ledger change. The old blanket
        // "vehicleNoChanged blocks everything" check made that combination
        // impossible to save at all: the client correctly enabled and
        // required the Vehicle No. field the moment a vehicle ledger was
        // picked (isVehicleLedgerSelected/updateVehicleRequirement,
        // Main.gs), the client-side validation and validateVoucherCoreFields
        // both accepted it, and only THIS scope check then rejected the
        // whole resubmit. A vehicleNo change is now only out-of-scope when
        // the ledger did NOT also change \u2014 i.e. someone editing the
        // vehicle on an unchanged ledger, which is still exactly what this
        // query category does not cover.
        if (submittedByChanged || actualExpenseDateChanged || descriptionChanged || (vehicleNoChanged && !ledgerChanged)) {
          return { success: false, error: 'Only ' + (isTransport ? 'Vendor' : 'Ledger / Expense Category') + ' can be changed for this query.' };
        }
        if (!isTransport) {
          if (amountFlatChanged) return { success: false, error: 'Only Ledger / Expense Category can be changed for this query.' };
          found.sheet.getRange(found.rowIndex, AV.EXPENSE_TYPE + 1).setValue(core.expenseType);
          found.sheet.getRange(found.rowIndex, AV.VEHICLE_NO + 1).setValue(core.vehicleNo);
          updateRabaleDailySyncRow_(voucherId, trueVoucherDateRaw, safe_(found.rowValues[AV.SUBMITTED_BY]), core.vehicleNo, safe_(found.rowValues[AV.COST_CENTRE]),
            parseFloat(found.rowValues[AV.AMOUNT]) || 0, false, core.expenseType);
        } else {
          var vliResultLv = buildVendorLineItems_(data.vendors, core.voucherReturnParcel, trueVoucherDateRaw);
          if (!vliResultLv.valid) return { success: false, error: vliResultLv.error };
          var newItemsLv = vliResultLv.items;
          var currentItemsLv = getVendorLineItemsInternal_(voucherId);
          if (newItemsLv.length !== currentItemsLv.length) {
            return { success: false, error: 'Vendor lines cannot be added or removed in response to this query \u2014 raise a new query, or ask admin to revert the voucher for a full edit.' };
          }
          var allowedLineSetLv = {};
          (getOpenQueryForVoucher(voucherId, token).targetLines || []).forEach(function (tl) { allowedLineSetLv[tl.lineIndex] = true; });

          var lineUpdatesLv = [];
          for (var liLv = 0; liLv < newItemsLv.length; liLv++) {
            var curLv = currentItemsLv[liLv], neuLv = newItemsLv[liLv];
            var nameChangedLv = curLv.vendorName !== neuLv.name;
            var amountChangedLv = curLv.amount !== neuLv.amount;
            if (!nameChangedLv && !amountChangedLv) continue;
            if (!allowedLineSetLv[liLv]) return { success: false, error: 'Vendor line ' + (liLv + 1) + ' was not part of this query and cannot be changed.' };
            if (amountChangedLv) return { success: false, error: 'Only the vendor can be changed for this query \u2014 amount is locked.' };
            lineUpdatesLv.push({ lineIndex: liLv, vendorName: neuLv.name, amount: neuLv.amount });
          }
          if (lineUpdatesLv.length === 0) return { success: false, error: 'No change detected on the targeted vendor line(s).' };

          var updateResultLv = updateTransportBreakdownLines_(voucherId, lineUpdatesLv, trueVoucherDateRaw);
          if (updateResultLv.error) return { success: false, error: updateResultLv.error };
          touchedLineIndexes = updateResultLv.touchedLineIndexes;
          tdsWarnings = updateResultLv.warnings || [];

          var touchedVendorNamesLv = {};
          lineUpdatesLv.forEach(function (u) { touchedVendorNamesLv[u.vendorName] = true; });
          var relevantVliWarningsLv = (vliResultLv.warnings || []).filter(function (w) {
            return Object.keys(touchedVendorNamesLv).some(function (vn) { return w.indexOf('vendor "' + vn + '"') !== -1; });
          });
          tdsWarnings = tdsWarnings.concat(relevantVliWarningsLv);

          applyVendorLedgerBalanceDelta_(summarizeVendorLines_(currentItemsLv), summarizeVendorLines_(newItemsLv));
          applyVendorFyLedgerBalanceDelta_(summarizeVendorLines_(currentItemsLv), summarizeVendorLines_(newItemsLv), getFinancialYearBounds_(trueVoucherDateRaw).key);

          var newTotalLv = newItemsLv.reduce(function (s, it) { return s + it.amount; }, 0);
          found.sheet.getRange(found.rowIndex, AV.AMOUNT + 1).setValue(newTotalLv);
          var newNotesLv = buildVoucherNotes_(true, '', core.voucherReturnParcel, newItemsLv);
          found.sheet.getRange(found.rowIndex, AV.NOTES + 1).setValue(newNotesLv);
          updateRabaleDailySyncRow_(voucherId, trueVoucherDateRaw, safe_(found.rowValues[AV.SUBMITTED_BY]), safe_(found.rowValues[AV.VEHICLE_NO]), safe_(found.rowValues[AV.COST_CENTRE]), newTotalLv, true, '');

          if (touchedLineIndexes.length > 0) demote = true;
        }

      } else if (category.fieldScope === 'amount') {
        if (submittedByChanged || vehicleNoChanged || actualExpenseDateChanged || descriptionChanged || ledgerChanged) {
          return { success: false, error: 'Only Amount can be changed for this query.' };
        }
        if (!isTransport) {
          found.sheet.getRange(found.rowIndex, AV.AMOUNT + 1).setValue(core.amount);
          updateRabaleDailySyncRow_(voucherId, trueVoucherDateRaw, safe_(found.rowValues[AV.SUBMITTED_BY]), safe_(found.rowValues[AV.VEHICLE_NO]), safe_(found.rowValues[AV.COST_CENTRE]),
            core.amount, false, safe_(found.rowValues[AV.EXPENSE_TYPE]));
        } else {
          var vliResult = buildVendorLineItems_(data.vendors, core.voucherReturnParcel, trueVoucherDateRaw);
          if (!vliResult.valid) return { success: false, error: vliResult.error };
          var newItems = vliResult.items;

          var currentItems = getVendorLineItemsInternal_(voucherId);
          if (newItems.length !== currentItems.length) {
            return { success: false, error: 'Vendor lines cannot be added or removed in response to this query \u2014 raise a new query, or ask admin to revert the voucher for a full edit.' };
          }

          // Which lines is this query actually allowed to touch?
          var allowedLineSet = {};
          (getOpenQueryForVoucher(voucherId, token).targetLines || []).forEach(function (tl) { allowedLineSet[tl.lineIndex] = true; });

          var lineUpdates = [];
          for (var li = 0; li < newItems.length; li++) {
            var cur = currentItems[li], neu = newItems[li];
            var nameChanged = cur.vendorName !== neu.name;
            var amountChanged = cur.amount !== neu.amount;
            if (!nameChanged && !amountChanged) continue;

            if (!allowedLineSet[li]) {
              return { success: false, error: 'Vendor line ' + (li + 1) + ' was not part of this query and cannot be changed.' };
            }
            if (nameChanged) {
              return { success: false, error: 'Only the amount can be changed for this query \u2014 vendor name is locked.' };
            }
            lineUpdates.push({ lineIndex: li, vendorName: neu.name, amount: neu.amount });
          }

          if (lineUpdates.length === 0) return { success: false, error: 'No change detected on the targeted vendor line(s).' };

          var updateResult = updateTransportBreakdownLines_(voucherId, lineUpdates, trueVoucherDateRaw);
          if (updateResult.error) return { success: false, error: updateResult.error };
          touchedLineIndexes = updateResult.touchedLineIndexes;
          tdsWarnings = updateResult.warnings || [];

          // vliResult above was built against the FULL vendor line list
          // (every line on the voucher, not just the one(s) this query
          // targeted), so it may carry a TDS warning for an untouched
          // line — those were only used above for shape/vendor-existence
          // validation and diffing, not shown to anyone. Surface only the
          // warnings that name a vendor actually present in lineUpdates
          // (the genuinely changed lines); an unrelated vendor's warning
          // stays out of scope for this response.
          var touchedVendorNames = {};
          lineUpdates.forEach(function (u) { touchedVendorNames[u.vendorName] = true; });
          var relevantVliWarnings = (vliResult.warnings || []).filter(function (w) {
            return Object.keys(touchedVendorNames).some(function (vn) {
              return w.indexOf('vendor "' + vn + '"') !== -1;
            });
          });
          tdsWarnings = tdsWarnings.concat(relevantVliWarnings);

          applyVendorLedgerBalanceDelta_(summarizeVendorLines_(currentItems), summarizeVendorLines_(newItems));
          applyVendorFyLedgerBalanceDelta_(summarizeVendorLines_(currentItems), summarizeVendorLines_(newItems), getFinancialYearBounds_(trueVoucherDateRaw).key);

          var newTotal = newItems.reduce(function (s, it) { return s + it.amount; }, 0);
          found.sheet.getRange(found.rowIndex, AV.AMOUNT + 1).setValue(newTotal);
          var newNotes = buildVoucherNotes_(true, '', core.voucherReturnParcel, newItems);
          found.sheet.getRange(found.rowIndex, AV.NOTES + 1).setValue(newNotes);
          updateRabaleDailySyncRow_(voucherId, trueVoucherDateRaw, safe_(found.rowValues[AV.SUBMITTED_BY]), safe_(found.rowValues[AV.VEHICLE_NO]), safe_(found.rowValues[AV.COST_CENTRE]),
            newTotal, true, '');

          if (touchedLineIndexes.length > 0) demote = true;
        }

      } else if (category.fieldScope === 'full') {
        var vendorLineItemsFull = [];
        var amountFull = core.amount;
        var oldVendorSummaryFull = {};
        if (core.isTransport) {
          var vliFull = buildVendorLineItems_(data.vendors, core.voucherReturnParcel, trueVoucherDateRaw);
          if (!vliFull.valid) return { success: false, error: vliFull.error };
          vendorLineItemsFull = vliFull.items;
          amountFull = vendorLineItemsFull.reduce(function (s, it) { return s + it.amount; }, 0);
          oldVendorSummaryFull = getOldVendorLineSummary_(voucherId);
        }
        var notesFull = buildVoucherNotes_(core.isTransport, core.description, core.voucherReturnParcel, vendorLineItemsFull);

        // resubmitVoucherCore does its own status re-check against
        // EDITABLE_STATUSES (Rejected only) — irrelevant here, so
        // call the shared write logic directly rather than through that
        // gate. Re-fetch happens inside resubmitVoucherCore itself.
        var coreResult = resubmitVoucherCoreWriteOnly_(found, core.submittedBy, core.costCentre, amountFull, core.isTransport,
          core.expenseType, core.vehicleNo, core.voucherDateRaw, notesFull, vendorLineItemsFull, newFiles, removedFileUrls, data.ledger || '', session.displayName, core.actualExpenseDateRaw);
        if (!coreResult.success) return coreResult;
        resultFileInfo.newFileCount = coreResult.newFileCount;
        resultFileInfo.failedCount = coreResult.failedCount;
        resultFileInfo.failedFiles = coreResult.failedFiles;

        if (core.isTransport) {
          var changes = diffVendorSummaries_(oldVendorSummaryFull, summarizeVendorLines_(vendorLineItemsFull));
          if (changes.length > 0) demote = true;
          tdsWarnings = vliFull.warnings || [];
        }
      }

      // Demotion: a Transport voucher currently at Pending L2 whose vendor
      // lines were actually touched must go back to Accounts for GST
      // re-review — L2 approving never re-checks GST review status (see
      // the Day 6 fix in Approval.gs), so this is the only thing standing
      // between a scoped edit and a silent GST bypass. No-op if the
      // voucher is already at Pending Accounts (nothing downstream to
      // clear) or if this category never touches vendor lines at all.
      if (demote && currentStatus === 'Pending L2') {
        moveVoucherToStage_(found, 'accounts');
      }

      // DATE FORMAT FIX (per explicit instruction) — QT.RESPONSE_DATE's
      // header is "Response Date"; matches dd-MM-yyyy like every other
      // date column instead of a full date+time string.
      var now = formatDate_(new Date());
      queryRow.sheet.getRange(queryRow.rowIndex, QT.RESPONSE + 1).setValue(response.trim());
      queryRow.sheet.getRange(queryRow.rowIndex, QT.RESPONSE_DATE + 1).setValue(now);
      queryRow.sheet.getRange(queryRow.rowIndex, QT.STATUS + 1).setValue('Resolved');
      clearQueryLineStamps_(voucherId, qid);
      found.sheet.getRange(found.rowIndex, AV.QUERY_STATUS + 1).setValue('No Query');

      // Release the lock regardless of which fieldScope branch ran above
      // — the 'full' branch already released it inside
      // resubmitVoucherCoreWriteOnly (harmless no-op here); for the
      // narrower scopes this is the only release point.
      releaseVoucherEditLock_(found, session.displayName || '', true);

      logAction_('QUERY_RESPONSE', voucherId, session.displayName || session.role, session.role,
        queryType + ' \u2014 ' + response.trim().substring(0, 80) + (demote ? ' (sent back to Accounts for GST re-review)' : ''));

      // Structured before/after diff for the Auditor Dashboard — re-fetch
      // rather than trust found.rowValues, since it wasn't updated by the
      // .setValue() calls in whichever fieldScope branch ran above (the
      // 'full' branch already logged its own via resubmitVoucherCoreWriteOnly,
      // but re-logging here from a fresh read is harmless and keeps this
      // path correct regardless of which branch fired).
      var refetched = findVoucherRow_(voucherId);
      if (refetched) {
        logAction_('VOUCHER_EDIT_SNAPSHOT', voucherId, session.displayName || session.role, session.role,
          JSON.stringify({ before: beforeSnapshot, after: snapshotVoucherCoreForAudit_(refetched.rowValues) }));
      }


      return {
        success: true,
        voucherId: voucherId,
        newFileCount: resultFileInfo.newFileCount,
        failedCount: resultFileInfo.failedCount,
        failedFiles: resultFileInfo.failedFiles,
        message: 'Voucher ' + voucherId + ' updated and response sent.' + (demote ? ' Sent back to Accounts for GST re-review.' : '') +
          logAndFormatTdsWarnings_(voucherId, session.displayName || session.role, session.role, tdsWarnings)
      };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('resubmitVoucherForQueryScope error: ' + err);
    return { success: false, error: 'Failed to respond to query: ' + err.toString() };
  }
}

function resubmitVoucherAndRespondToQuery(voucherId, formDataJson, filesJson, removedFileUrlsJson, response, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'submission') return { success: false, error: 'You do not have permission to do this.' };
    if (!response || !response.trim()) return { success: false, error: 'A response is required.' };

    var voucherIdValidation = validateVoucherId_(voucherId);
    if (!voucherIdValidation.valid) return { success: false, error: 'Invalid voucher ID.' };
    voucherId = voucherIdValidation.id;

    var data;
    try { data = JSON.parse(formDataJson); } catch (e) { return { success: false, error: 'Invalid form data.' }; }

    var core = validateVoucherCoreFields_(data);
    if (!core.valid) return { success: false, error: core.error };

    // Same early, lock-free date read as resubmitVoucher — see that
    // function's comment for why.
    var earlyFoundForDateQ = findVoucherRow_(voucherId);
    if (!earlyFoundForDateQ) return { success: false, error: 'Voucher not found: ' + voucherId };
    var billDateForFyQ = earlyFoundForDateQ.rowValues[AV.DATE];

    var vendorLineItems = [];
    var amount = core.amount;
    if (core.isTransport) {
      var vliResult = buildVendorLineItems_(data.vendors, core.voucherReturnParcel, billDateForFyQ);
      if (!vliResult.valid) return { success: false, error: vliResult.error };
      vendorLineItems = vliResult.items;
      amount = vendorLineItems.reduce(function (s, it) { return s + it.amount; }, 0);
    }

    var notes = buildVoucherNotes_(core.isTransport, core.description, core.voucherReturnParcel, vendorLineItems);

    var newFiles = [];
    if (filesJson) {
      try { newFiles = JSON.parse(filesJson) || []; } catch (e) { newFiles = []; }
    }
    var fileBatchError = validateFileUploadBatch_(newFiles);
    if (fileBatchError) return { success: false, error: fileBatchError };

    var removedFileUrls = [];
    if (removedFileUrlsJson) {
      try { removedFileUrls = JSON.parse(removedFileUrlsJson) || []; } catch (e) { removedFileUrls = []; }
    }

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var queryRow = findOpenQueryRow_(voucherId);
      if (!queryRow) return { success: false, error: 'No open query found for this voucher.' };

      var result = resubmitVoucherCore_(voucherId, core.submittedBy, core.costCentre, amount, core.isTransport,
        core.expenseType, core.vehicleNo, core.voucherDateRaw, notes, vendorLineItems, newFiles, removedFileUrls, data.ledger || '', session.displayName, core.actualExpenseDateRaw);
      if (!result.success) return result;

      var found = result.found;
      // DATE FORMAT FIX (per explicit instruction) — QT.RESPONSE_DATE's
      // header is "Response Date"; matches dd-MM-yyyy like every other
      // date column instead of a full date+time string.
      var now = formatDate_(new Date());
      queryRow.sheet.getRange(queryRow.rowIndex, QT.RESPONSE + 1).setValue(response.trim());
      queryRow.sheet.getRange(queryRow.rowIndex, QT.RESPONSE_DATE + 1).setValue(now);
      queryRow.sheet.getRange(queryRow.rowIndex, QT.STATUS + 1).setValue('Resolved');
      clearQueryLineStamps_(voucherId, safe_(queryRow.rowValues[QT.QUERY_ID]));
      found.sheet.getRange(found.rowIndex, AV.QUERY_STATUS + 1).setValue('No Query');

      logAction_('QUERY_RESPONSE', voucherId, session.displayName || session.role, session.role, response.trim().substring(0, 80) + ' (with voucher edit)');

      return {
        success: true,
        voucherId: voucherId,
        newFileCount: result.newFileCount,
        failedCount: result.failedCount,
        failedFiles: result.failedFiles,
        message: 'Voucher ' + voucherId + ' updated and response sent.' +
          logAndFormatTdsWarnings_(voucherId, session.displayName || session.role, session.role, core.isTransport ? vliResult.warnings : [])
      };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('resubmitVoucherAndRespondToQuery error: ' + err);
    return { success: false, error: 'Failed to update voucher and respond: ' + err.toString() };
  }
}

// Supplementary upload for files that failed on first submission. Not part
// of the primary flow — see the file header comment.
// ============================================================================
// BILL UPLOAD PERFORMANCE FIX (per explicit instruction — "bill uploading
// takes a while") — extracted from what were two near-identical copies of
// this loop (one here, one inline in saveVoucherSubmission above) so a
// future fix to one can't silently miss the other.
//
// Root cause: Apps Script has no true parallelism within one execution —
// every DriveApp call is a synchronous network round-trip, done one at a
// time. The old code made TWO such round-trips per file (createFile,
// then setSharing) — for N bill photos that's 2N sequential Drive API
// calls the person is sitting there waiting on, on top of the base64
// upload itself over whatever connection a warehouse floor has.
//
// The fix: setSharing is now called ONCE on voucherFolder, not once per
// file — cutting the loop from 2N round-trips to N. This is safe:
// - Every file created inside voucherFolder was already being shared
//   DOMAIN_WITH_LINK/VIEW individually before, to the exact same
//   audience this folder-level call grants — the set of people who CAN
//   view any given bill doesn't change.
// - The one real difference is that the folder itself becomes browsable
//   at that same permission level (previously only the folder's owner
//   could browse it; only individual files were link-shared). The app
//   never surfaces or links to a folder URL anywhere — bill viewing
//   always opens a direct file URL (openBillFile, Main.gs) — so this
//   isn't a materially bigger exposure in practice.
// - Idempotent either way: called on every upload regardless of whether
//   voucherFolder is brand new or already existed from an earlier
//   upload to the same voucher, so there's no "did I already share
//   this?" state to track.
//
// If this trade-off isn't acceptable, the alternative is to keep
// per-file setSharing (reverting just that one line back into the loop
// below) and accept the slower N-round-trip floor that comes with it —
// everything else in this fix (removing the duplicate loop, batching
// client-side compression already in place) still stands either way.
// ============================================================================
function uploadBillFilesToFolder_(files, voucherFolder) {
  // SECURITY (Day 5, preserved from the original per-file setSharing this
  // replaced): DOMAIN_WITH_LINK restricts viewing to the Google Workspace
  // domain — bill files can carry GST numbers and vendor bank/contact
  // details. If this deployment is NOT on a Google Workspace domain,
  // DOMAIN_WITH_LINK will fail — use DriveApp.Access.ANYONE_WITH_LINK
  // instead in that case (the old, less restrictive default).
  voucherFolder.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);

  var fileUrls = [];
  var failedFiles = [];
  for (var j = 0; j < files.length; j++) {
    try {
      var f = files[j];
      var made = billBlobFromClientFile_(f);
      if (made.error) throw new Error(made.error);   // handled below like any failed file: reported, never stored
      var created = voucherFolder.createFile(made.blob);
      fileUrls.push(created.getUrl());
    } catch (fileErr) {
      Logger.log('Failed to upload file "' + (files[j].name || 'unknown') + '": ' + fileErr);
      failedFiles.push(files[j].name || 'unknown');
    }
  }
  return { fileUrls: fileUrls, failedFiles: failedFiles };
}

function uploadBillFiles_(filesJson, batchId, voucherId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };

    var files;
    try { files = JSON.parse(filesJson); } catch (e) { return { success: false, error: 'Invalid file data.' }; }
    if (!files || files.length === 0) return { success: true, count: 0, fileUrls: [] };

    var fileBatchError = validateFileUploadBatch_(files);
    if (fileBatchError) return { success: false, error: fileBatchError };

    var root          = DriveApp.getRootFolder();
    var expFolder     = getOrCreateDriveFolder_(root, 'Rabale Expense System');
    var batchFolder   = getOrCreateDriveFolder_(expFolder, batchId);
    var voucherFolder = getOrCreateDriveFolder_(batchFolder, voucherId);

    var fileUrls = [];
    var failedFiles = [];
    var uploadResult = uploadBillFilesToFolder_(files, voucherFolder);
    fileUrls = uploadResult.fileUrls;
    failedFiles = uploadResult.failedFiles;

    if (fileUrls.length > 0) {
      var found = findVoucherRow_(voucherId);
      if (found) {
        var existingUrls = safe_(found.rowValues[AV.BILL_FILES]);
        var merged = existingUrls ? existingUrls + '\n' + fileUrls.join('\n') : fileUrls.join('\n');
        found.sheet.getRange(found.rowIndex, AV.BILL_FILES + 1).setValue(merged);
      } else {
        Logger.log('uploadBillFiles: voucher ' + voucherId + ' not found for supplementary upload metadata write.');
      }
    }

    logAction_('UPLOAD', voucherId, session.displayName || session.role, session.role,
      fileUrls.length + ' file(s) to Drive (supplementary)' + (failedFiles.length > 0 ? ', ' + failedFiles.length + ' failed' : ''));
    return { success: true, count: fileUrls.length, fileUrls: fileUrls, failedCount: failedFiles.length, failedFiles: failedFiles };
  } catch (err) {
    Logger.log('uploadBillFiles error: ' + err);
    return { success: false, error: 'File upload failed: ' + err.toString() };
  }
}

function getAllVouchers(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.', vouchers: [] };

    var sheet = getSheet_(ALL_VOUCHERS_SHEET);
    var data = sheet.getDataRange().getValues();
    var vouchers = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var vid = safe_(row[AV.VOUCHER_ID]);
      if (!vid) continue;
      vouchers.push({
        voucherId:        vid,
        date:              formatDate_(row[AV.DATE]),
        expenseType:       safe_(row[AV.EXPENSE_TYPE]),
        submittedBy:       safe_(row[AV.SUBMITTED_BY]),
        vehicleNo:         safe_(row[AV.VEHICLE_NO]),
        costCentre:        safe_(row[AV.COST_CENTRE]),
        amount:            parseFloat(row[AV.AMOUNT]) || 0,
        status:            safe_(row[AV.STATUS]),
        batchId:           safe_(row[AV.BATCH_ID]),
        approvedL1:        safe_(row[AV.APPROVED_BY_L1]),
        approvedAccounts:  safe_(row[AV.APPROVED_BY_ACCOUNTS]),
        approvedL2:        safe_(row[AV.APPROVED_BY_L2]),
        queryStatus:       safe_(row[AV.QUERY_STATUS]) || 'No Query',
        tallyCoded:        safe_(row[AV.TALLY_EXPORTED]),
        billFiles:         safe_(row[AV.BILL_FILES]),
        notes:             safe_(row[AV.NOTES]),
        rejectedAtStage:   safe_(row[AV.REJECTED_AT_STAGE]),
        submittedByOperator: safe_(row[AV.SUBMITTED_BY_OPERATOR]), // NEW (Day 5) — which logged-in submission user actually keyed this in, for the My Vouchers "Mine" filter
        actualExpenseDate: safe_(row[AV.ACTUAL_EXPENSE_DATE]) || formatDate_(row[AV.DATE]),
        cashReleased:      safe_(row[AV.CASH_RELEASED]) === 'Yes',
        editLockedBy:      safe_(row[AV.EDIT_LOCKED_BY])
      });
    }
    return { success: true, vouchers: vouchers, role: session.role };
  } catch (err) {
    Logger.log('getAllVouchers error: ' + err);
    return { success: false, error: 'Failed to load vouchers: ' + err.toString(), vouchers: [] };
  }
}