// ============================================================================
// TALLY EXPORT — Day 2, revised
// ============================================================================
//
// Reverse-engineered from the user's working prototype (generateTallyExcel())
// and cross-verified against a real sample export, per the Day 2 brief, with
// adjustments made across two rounds of explicit follow-up instruction:
//
//   1. A transport voucher's vendor lines are partitioned into a GST group
//      (cgst>0 or sgst>0) and a non-GST group. Each non-empty group becomes
//      its OWN "Rabale Petty Expenses" entry — not one combined entry for
//      the whole voucher. A voucher with only one group in practice stays
//      as a single entry with the plain voucher number; the A/B suffix is
//      only added when 2+ groups genuinely exist needing disambiguation.
//   2. CGST/SGST are components OF the vendor's submitted amount, not
//      additions on top — base = amount - cgst - sgst.
//   3. "Bill Type of Ref" / "Bill Amount - Dr/Cr" columns REMOVED entirely
//      — Tally sheet is now 8 columns, not 10.
//   4. Voucher Narration follows exact templates (see buildXxxNarration
//      functions below) instead of a generic "Voucher X - Type - detail"
//      string.
//   5. TDS rounds to the nearest whole rupee (see Voucher.gs), not 2dp.
//   6. Journal and Rabale - Petty Cash entries get a running serial number
//      in the Voucher Number column — NOT the real Tally voucher number
//      (Tally still auto-assigns that on import), purely so the exported
//      file is readable/scannable — see assignSerialNumbers().
//
// REVISED (Day 4): transport narration ("...paid to X...") now references
// the EMPLOYEE the petty cash was paid to, not the vendor — matching how
// Regular narration already worked. Vendor name was removed from both
// transport narration templates entirely; it still appears ONLY in
// buildTdsNarration, since that entry specifically records tax withheld
// from the vendor. This also resolves the previous multi-vendor-narration
// open item below, since without a vendor list to join, a multi-vendor
// group now uses the exact same template as a single-vendor one. All four
// narration builders are capped at NARRATION_MAX_LEN via capNarration().
//
// Petty Cash stays ONE aggregate entry per original voucher (not split by
// GST group) — cash physically leaves as one lump regardless of how the
// bookkeeping splits it on the expense side.
//
// REVISED (Day 5), fixing two real bugs — see buildTransportEntries for
// the full explanation:
//   7. Rule 1 above (GST group / non-GST group split) is now MORE
//      GRANULAR: every individual GST-bearing VENDOR gets its own
//      separate "Rabale Petty Expenses" entry (previously all GST-bearing
//      lines from every vendor were summed into one combined entry,
//      regardless of vendor). Non-GST vendors still combine into one
//      aggregate entry, unchanged. Suffixes are now A, B, C, ... as
//      needed, not a fixed A/B pair.
//   8. Same-vendor, same-GST-status lines (2+ bills from one vendor) now
//      CLUB into one entry, on both the Rabale Petty Expenses credit side
//      and the Journal side — previously each bill produced its own
//      separate row/entry even when the vendor was identical. A vendor
//      with both a GST bill and a non-GST bill still keeps those as two
//      separate clubbed groups (not blended together), per explicit
//      instruction.

// ============================================================================

function round2_(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Tally narration fields are conventionally length-limited for import
// reliability; truncate defensively rather than letting a long multi-vendor
// LR list or free-text description silently overflow. Applied at the point
// every narration string is finalized, across all four narration builders.
var NARRATION_MAX_LEN = 250;
function capNarration_(s) {
  if (s.length <= NARRATION_MAX_LEN) return s;
  return s.slice(0, NARRATION_MAX_LEN - 1) + '\u2026';
}

// Whole-number display when there's no fractional paise, otherwise 2dp —
// matches how the narration templates read ("Rs. 500/-" not "Rs. 500.00/-").
function fmtAmt_(n) {
  var r = round2_(n);
  return (r % 1 === 0) ? String(r) : r.toFixed(2);
}

// submittedBy is stored as the literal ledger string, e.g. "IOU - Umesh
// Kanthe" — narration needs just the employee's name.
function stripIouPrefix_(name) {
  return String(name || '').replace(/^IOU\s*-\s*/i, '').trim();
}

// Voucher dates are stored/displayed as dd-MM-yyyy (see formatDate in
// SheetUtils.gs). Narration text uses dots (dd.mm.yyyy) per the given
// templates; the Tally sheet's own Date column also uses hyphens
// (dd-mm-yyyy) as of the global date-format change — both builders below
// are separator-agnostic (match '/' OR '-') rather than assuming
// formatDate's exact character, so neither silently breaks if the
// underlying separator ever changes again, and both tolerate reading a
// still-unmigrated legacy row (slash-formatted) during the transition
// window before migrateReformatVoucherDates() has been run.
function toDotDate_(anyDate) {
  return String(anyDate || '').replace(/[\/\-]/g, '.');
}
function toHyphenDate_(anyDate) {
  return String(anyDate || '').replace(/\//g, '-');
}

// Ledger names for Petty Cash / TDS On Contractor / Transportation are read
// from Settings at export time. Falls back to the brief's stated default
// names (and logs a warning) if Settings doesn't have a value, rather than
// failing the whole export over a missing configuration row.
function getTallyLedgerNames_() {
  var defaults = {
    tdsOnContractor: 'TDS On Contractor',
    pettyCash: 'Petty Cash - Rabale',
    transportation: 'Transportation - GST'
  };
  var result = {
    tdsOnContractor: getSettingValue_('TDS On Contractor Ledger'),
    pettyCash: getSettingValue_('Petty Cash Ledger'),
    transportation: getSettingValue_('Transportation Ledger')
  };
  var usedFallback = [];
  ['tdsOnContractor', 'pettyCash', 'transportation'].forEach(function (key) {
    if (!result[key]) { result[key] = defaults[key]; usedFallback.push(key); }
  });
  if (usedFallback.length > 0) {
    Logger.log('WARNING: Tally export using fallback ledger name(s) — Settings sheet missing: ' + usedFallback.join(', '));
    logAction_('SETTINGS_WARNING', '', 'system', 'system', 'Tally export fell back to default ledger name(s) for: ' + usedFallback.join(', '));
  }
  result.ineligibleCgst = INELIGIBLE_CGST_LEDGER;
  result.ineligibleSgst = INELIGIBLE_SGST_LEDGER;
  result.transportationNonGst = TRANSPORTATION_NON_GST_LEDGER;
  return result;
}

function getMonthKeyFromDMY_(dateStr) {
  var parts = String(dateStr || '').split(/[\/\-]/);
  if (parts.length !== 3) return null;
  var m = parts[1], y = parts[2];
  return y + '-' + String(m).padStart(2, '0');
}

// Given a voucher ID and its (already-deleted) Voucher Date, finds and
// highlights every matching row in that month's Tally Export sheet —
// used by adminDeleteVoucherCompletely (Approval.gs) so a deleted-but-
// already-exported voucher is visibly flagged wherever the accounting
// export lives, not just in the Audit Log. Returns the number of rows
// highlighted (0 if the month's export sheet doesn't exist or has no
// matching rows — logged as a warning by the caller if that's
// unexpected, not treated as fatal here).
function highlightDeletedVoucherInTallyExportSheet_(voucherId, voucherDateStr) {
  var monthKey = getMonthKeyFromDMY_(voucherDateStr);
  if (!monthKey) return 0;
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(TALLY_EXPORT_SHEET_PREFIX + monthKey);
  if (!sheet) return 0;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var data = sheet.getRange(2, 1, lastRow - 1, EXPECTED_TALLY_EXPORT_HEADERS.length).getValues();
  var count = 0;
  for (var i = 0; i < data.length; i++) {
    if (safe_(data[i][TE.VOUCHER_NUMBER]) !== voucherId) continue;
    var range = sheet.getRange(i + 2, 1, 1, EXPECTED_TALLY_EXPORT_HEADERS.length);
    range.setBackground(TALLY_EXPORT_DELETED_VOUCHER_HIGHLIGHT);
    count++;
  }
  if (count > 0) {
    // A single note on the first matched row is enough context for
    // someone scanning the sheet — repeating it on every Dr/Cr line of
    // the same voucher would be noise.
    for (var j = 0; j < data.length; j++) {
      if (safe_(data[j][TE.VOUCHER_NUMBER]) === voucherId) {
        sheet.getRange(j + 2, TE.VOUCHER_NUMBER + 1).setNote('Voucher deleted from All Vouchers after export \u2014 see Audit Log for full detail.');
        break;
      }
    }
  }
  return count;
}

// Creates the month's Tally Export sheet directly with the header row if it
// doesn't exist yet — no dependency on a pre-existing hidden template tab.
function getOrCreateTallyExportSheet_(monthKey) {
  var name = TALLY_EXPORT_SHEET_PREFIX + monthKey;
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, EXPECTED_TALLY_EXPORT_HEADERS.length).setValues([EXPECTED_TALLY_EXPORT_HEADERS]);
    sheet.setFrozenRows(1);
    // DATE FORMAT FIX (per explicit instruction) — TE.VOUCHER_DATE is
    // written as a pre-formatted dd-MM-yyyy STRING (makeTeEntry's
    // voucherDate param, ultimately formatDate(AV.DATE)), never a real
    // Date object. Without an explicit text number format, Sheets'
    // auto-detection can still reinterpret a hyphenated date-shaped
    // string and redisplay it using the spreadsheet's own locale default
    // — the same class of bug the Day 6 RDS rewrite already fixed for
    // RS.DATE (see updateRabaleDailySync's comment, Sheet Utils.gs) and
    // that AV.DATE guards against with its own '@' format (Vouchers.gs).
    // This sheet was the one place still missing it. See
    // migrateFixTallyExportDateFormat below for sheets created before
    // this fix.
    sheet.getRange(2, TE.VOUCHER_DATE + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
    // READABILITY (per explicit instruction) — Voucher Narration is
    // genuinely long free text; cap+wrap it, plain auto-fit everything
    // else.
    autoFitSheetColumns_(sheet, [TE.VOUCHER_NARRATION]);
  }
  return sheet;
}

// One-time migration — run manually from the Apps Script editor if any
// "Tally Export <month>" sheet was created before the fix above (i.e.
// every month tab that already existed prior to 17 Sep 2026). Idempotent
// and value-safe: it only sets the column's number format, never
// touches a cell's actual content, and re-running it is a harmless no-op.
function migrateFixTallyExportDateFormat() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var ss = getSpreadsheet_();
  var sheets = ss.getSheets();
  var touched = [];
  sheets.forEach(function (sheet) {
    if (sheet.getName().indexOf(TALLY_EXPORT_SHEET_PREFIX) !== 0) return;
    sheet.getRange(2, TE.VOUCHER_DATE + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
    touched.push(sheet.getName());
  });
  Logger.log('migrateFixTallyExportDateFormat: reformatted Voucher Date column on ' + touched.length + ' sheet(s): ' + touched.join(', '));
  return { touched: touched };
}

// ----------------------------------------------------------------------------
// Voucher Narration — exact templates as specified:
//   1. Transportation:          Being transportation charges Rs. XXX/- paid to EMPLOYEE on dt: dd.mm.yyyy
//   2. Transportation with GST: Being transportation charges Rs. XXX/- paid to EMPLOYEE on dt: dd.mm.yyyy (LR no.: XXXXXX)
//   3. Transportation (Return): Being transportation charges Rs. XXX/- paid to EMPLOYEE for return parcel on dt: dd.mm.yyyy
//   4. Regular:                 Being Rs. XXX/- paid to EMPLOYEE for DESCRIPTION on dt: dd.mm.yyyy
// Revised per explicit instruction: transport narration references the
// EMPLOYEE (who the petty cash was actually paid to via the IOU ledger),
// not the vendor — this also brings it in line with Regular's narration,
// which was already employee-based. Vendor name is deliberately NOT in
// either transport narration template; it still appears in the TDS
// narration (buildTdsNarration below), since that entry is specifically
// about tax withheld from the vendor's payment, a genuinely different fact.
// Return Parcel and GST are independent flags on a vendor line, so both can
// apply at once — combined naturally (return-parcel clause before "on dt:",
// LR clause after it, matching where each appears in the individual
// templates above). Every narration is capped at NARRATION_MAX_LEN via
// capNarration().
// ----------------------------------------------------------------------------

// REVISED (Day 5): buildTransportVendorNarration (the old per-single-line
// narration builder) is removed — buildTransportGroupNarration below is
// now used for every grouping granularity (whole voucher, RPE group, or a
// single clubbed vendor group), since it already sums amount and joins
// distinct LR numbers over whatever item list it's given; a single-vendor
// "group" of one clubbed line item collapses to the exact same output the
// old single-line builder produced.

// Amount shown is always the TOTAL for this logical entry (sum across
// every vendor in it) — never a per-vendor breakdown. Since vendor names no
// longer appear in this narration, a multi-vendor group now collapses to
// exactly the same template as a single-vendor one (this also removes the
// previously-flagged "multi-vendor narration is my own extension" ambiguity
// — there's no vendor list to join anymore). Return Parcel is a
// whole-voucher flag (uniform across every item passed in here), so it's
// read once, not per vendor. LR numbers are still per-vendor (Accounts can
// enter a different LR per vendor line), so distinct non-blank values are
// listed together when there's more than one.
function buildTransportGroupNarration_(v, items, dateDot) {
  var total = items.reduce(function (s, it) { return s + it.amount; }, 0);
  var hasGst = items.some(function (it) { return it.cgst > 0 || it.sgst > 0; });
  var returnParcel = items.length > 0 && items[0].returnParcel;
  var employee = stripIouPrefix_(v.submittedBy);
  var s = 'Being transportation charges Rs. ' + fmtAmt_(total) + '/- paid to ' + employee;
  if (returnParcel) s += ' for return parcel';
  s += ' on dt: ' + dateDot;
  if (hasGst) {
    var lrNos = [];
    items.forEach(function (it) { if (it.lrNo && lrNos.indexOf(it.lrNo) === -1) lrNos.push(it.lrNo); });
    if (lrNos.length > 0) s += ' (LR no.: ' + lrNos.join(', ') + ')';
  }
  // Vehicle no. — COMPULSORY (24 Aug 2026, per explicit instruction).
  // generateTallyExport now gates on v.vehicleNo being present for every
  // Transport voucher BEFORE this function is ever called, so this is a
  // straight append, not a conditional — a blank vehicle number means
  // the voucher was skipped from export entirely, never a narration
  // silently missing it. (This also fixes a real prior bug where
  // v.vehicleNo was never populated at all, so this line was always a
  // no-op regardless of the guard.)
  s += '. Vehicle no. ' + v.vehicleNo;
  return capNarration_(s);
}

function buildRegularNarration_(v) {
  var employee = stripIouPrefix_(v.submittedBy);
  var s = 'Being Rs. ' + fmtAmt_(v.amount) + '/- paid to ' + employee;
  if (v.description) s += ' for ' + v.description;
  // Narration date is the ACTUAL EXPENSE DATE — see buildTransportEntries
  // comment above for why this differs from v.dateForSheet.
  s += ' on dt: ' + toDotDate_(v.actualExpenseDate || v.date);
  // Vehicle no. — COMPULSORY for the three vehicle-linked Regular ledgers
  // (24 Aug 2026, per explicit instruction; see the export-time gate in
  // generateTallyExport). Straight append for those ledgers, same
  // reasoning as buildTransportGroupNarration above.
  if (VEHICLE_REQUIRED_LEDGERS.indexOf(v.expenseType) !== -1) {
    s += '. Vehicle no. ' + v.vehicleNo;
  }
  return capNarration_(s);
}

// TDS-withholding lines within a Journal entry get their OWN narration,
// entirely separate from the payment lines' narration — per explicit
// instruction. This is the ONE narration that keeps vendor name (per
// explicit instruction) — TDS is withheld from the vendor's payment, so the
// vendor identity is the actual fact being recorded here, unlike the
// payment narration above which is about what the employee was reimbursed.
// peVoucherNumber is the REAL Rabale Petty Expenses voucher number (with
// A/B suffix if applicable) this vendor's payment belongs to — NOT the
// Journal entry's own throwaway serial — since that's the identifier a
// human actually wants when reading this later. TDS is calculated on the
// amount EXCLUDING GST, matching the recomputation done in
// updateVendorLineItemGst (Approval.gs) when GST is saved.
function buildTdsNarration_(it, peVoucherNumber, dateDot) {
  var ratePercent = round2_(it.tdsRate * 100);
  var tdsBase = it.amount - it.cgst - it.sgst - (it.hamali || 0);
  return capNarration_('Being TDS deducted @' + ratePercent + '% on Rs. ' + fmtAmt_(tdsBase) + '/- on dt: ' + dateDot + ' (' + it.vendorName + ' - ' + peVoucherNumber + ')');
}


// Wraps a Tally Export row (8 real columns) with an internal-only group id
// used for the Dr=Cr balance check and serial-number assignment before
// writing. `group` never reaches the sheet.
function makeTeEntry_(group, drCr, amount, voucherDate, voucherType, voucherNumber, ledgerName, costCenter, narration) {
  return {
    group: group,
    drCr: drCr,
    amount: amount,
    row: [voucherDate, voucherType, voucherNumber, ledgerName, amount, drCr, costCenter, narration]
  };
}

// Regular (ledger-based) expense — 2 voucher types normally (no TDS, no
// GST split). Branches to a 3-voucher-type flow when v.regularVendor is
// set (handoff 2.C, Dual-GST vendor flow, confirmed 24 Aug 2026) — a
// recombination of two patterns that already exist elsewhere in this
// file, not new architecture: the Rabale Petty Expenses group mirrors
// buildTransportEntries' GST group shape (credited to the vendor instead
// of the employee), and the new Journal group is identical in shape to
// buildTransportEntries' own payment Journal (vendor Dr / employee Cr).
// The Rabale - Petty Cash group (g2) is completely unchanged either way —
// TDS is not applicable to this flow, so there's no TDS Journal entry.
function buildRegularEntries_(v, ledgers) {
  var entries = [];
  var narration = buildRegularNarration_(v);

  var g1 = v.voucherId + '|PE';
  if (v.regularVendor) {
    var cgst = round2_(v.regularVendor.cgst || 0);
    var sgst = round2_(v.regularVendor.sgst || 0);
    var base = round2_(v.amount - cgst - sgst);
    entries.push(makeTeEntry_(g1, 'Dr', base, v.dateForSheet, 'Rabale Petty Expenses', v.voucherId, v.expenseType, v.costCentre, narration));
    if (cgst > 0) entries.push(makeTeEntry_(g1, 'Dr', cgst, v.dateForSheet, 'Rabale Petty Expenses', v.voucherId, ledgers.ineligibleCgst, v.costCentre, narration));
    if (sgst > 0) entries.push(makeTeEntry_(g1, 'Dr', sgst, v.dateForSheet, 'Rabale Petty Expenses', v.voucherId, ledgers.ineligibleSgst, v.costCentre, narration));
    entries.push(makeTeEntry_(g1, 'Cr', v.amount, v.dateForSheet, 'Rabale Petty Expenses', v.voucherId, v.regularVendor.vendorName, v.costCentre, narration));

    var gj = v.voucherId + '|J';
    entries.push(makeTeEntry_(gj, 'Dr', v.amount, v.dateForSheet, 'Journal', '', v.regularVendor.vendorName, v.costCentre, narration));
    entries.push(makeTeEntry_(gj, 'Cr', v.amount, v.dateForSheet, 'Journal', '', v.submittedBy, v.costCentre, narration));
  } else {
    entries.push(makeTeEntry_(g1, 'Dr', v.amount, v.dateForSheet, 'Rabale Petty Expenses', v.voucherId, v.expenseType, v.costCentre, narration));
    entries.push(makeTeEntry_(g1, 'Cr', v.amount, v.dateForSheet, 'Rabale Petty Expenses', v.voucherId, v.submittedBy, v.costCentre, narration));
  }

  var g2 = v.voucherId + '|PC';
  entries.push(makeTeEntry_(g2, 'Dr', v.amount, v.dateForSheet, 'Rabale - Petty Cash', '', v.submittedBy, v.costCentre, narration));
  entries.push(makeTeEntry_(g2, 'Cr', v.amount, v.dateForSheet, 'Rabale - Petty Cash', '', ledgers.pettyCash, v.costCentre, narration));
  return entries;
}

// Clubs vendor line items by (vendor name + GST status) — used ONLY for
// the Journal TDS-withholding entry, which stays ONE entry per vendor
// (summed across however many bills that vendor has) regardless of how
// many separate bills/LRs they were split across on the payment side —
// per explicit instruction ("this doesn't affect the TDS entries - only
// one TDS entry per vendor"). A vendor with both a GST bill and a
// non-GST bill still produces TWO groups for that vendor, kept
// deliberately separate (per earlier explicit instruction — GST and
// non-GST bills from the same vendor are NOT blended together even
// though same-status bills are, for TDS purposes).
function clubVendorLinesByVendorAndGst_(items) {
  var groups = {};
  var order = [];
  items.forEach(function (it) {
    var hasGst = (it.cgst > 0 || it.sgst > 0);
    var key = it.vendorName + '|' + (hasGst ? 'G' : 'N');
    if (!groups[key]) {
      groups[key] = {
        key: key, vendorName: it.vendorName, hasGst: hasGst,
        amount: 0, cgst: 0, sgst: 0, hamali: 0, tdsAmount: 0,
        tdsApplicable: it.tdsApplicable, tdsRate: it.tdsRate,
        lineIndexes: []
      };
      order.push(key);
    }
    var g = groups[key];
    g.amount += it.amount;
    g.cgst += it.cgst;
    g.sgst += it.sgst;
    g.hamali += (it.hamali || 0);
    g.tdsAmount += it.tdsAmount;
    g.lineIndexes.push(it.lineIndex);
  });
  return order.map(function (k) { return groups[k]; });
}

// REVISED per explicit instruction: same-vendor bills are NO LONGER
// clubbed together on the payment side (Rabale Petty Expenses credit
// rows / Journal payment rows) — two bills from the same vendor now
// produce two separate entries/rows, exactly like two different
// vendors always have. LR number is the differentiator: the group key
// includes it, so genuinely distinct bills (distinct LR, or no LR at
// all — see fallback below) never collapse into one row. TDS is
// UNAFFECTED by this — see clubVendorLinesByVendorAndGst above, which
// still groups by vendor+GST only and is used exclusively for the
// Journal TDS entry.
//
// Fallback when LR is blank: falls back to the line's own lineIndex
// (guaranteed unique) rather than an empty string, so two blank-LR
// bills from the same vendor still don't accidentally club together —
// clubbing should only happen when the LR values GENUINELY match, not
// when both happen to be missing.
function splitVendorLinesByVendorGstAndLr_(items) {
  var groups = {};
  var order = [];
  items.forEach(function (it) {
    var hasGst = (it.cgst > 0 || it.sgst > 0);
    var lrKey = it.lrNo ? ('LR:' + it.lrNo) : ('#' + it.lineIndex);
    var key = it.vendorName + '|' + (hasGst ? 'G' : 'N') + '|' + lrKey;
    if (!groups[key]) {
      groups[key] = {
        key: key, vendorName: it.vendorName, hasGst: hasGst,
        amount: 0, cgst: 0, sgst: 0, hamali: 0, tdsAmount: 0,
        tdsApplicable: it.tdsApplicable, tdsRate: it.tdsRate,
        lineIndexes: []
      };
      order.push(key);
    }
    var g = groups[key];
    g.amount += it.amount;
    g.cgst += it.cgst;
    g.sgst += it.sgst;
    g.hamali += (it.hamali || 0);
    g.tdsAmount += it.tdsAmount;
    g.lineIndexes.push(it.lineIndex);
  });
  return order.map(function (k) { return groups[k]; });
}

// Original (un-clubbed) items belonging to a set of vendor groups — used
// only to feed narration builders (buildTransportGroupNarration), which
// need the raw per-bill amount/LR/returnParcel fields, not the clubbed
// totals.
function flattenVendorGroupItems_(items, vendorGroups) {
  var wanted = {};
  vendorGroups.forEach(function (vg) { vg.lineIndexes.forEach(function (li) { wanted[li] = true; }); });
  return items.filter(function (it) { return wanted.hasOwnProperty(it.lineIndex); });
}

// Transport (vendor-based) expense — 3 voucher types: split Rabale Petty
// Expenses (per vendor, per GST group), per-vendor Journal, aggregate
// Petty Cash.
//
// REVISED (Day 5), per explicit instruction, fixing two real bugs:
//   1. GST vendors were previously all summed into ONE combined "GST
//      group" entry regardless of which vendor they came from (5 vendors,
//      2 with GST, produced ONE combined GST entry + ONE non-GST entry =
//      2 total). Now each GST vendor gets its OWN separate entry; only
//      non-GST vendors still combine into one aggregate entry (5 vendors,
//      2 with GST -> 2 separate GST entries + 1 combined non-GST entry =
//      3 total).
//   2. The same vendor appearing on 2+ lines (2+ bills) previously
//      produced 2+ separate credit rows / Journal entries under the same
//      vendor name. Same-vendor-same-GST-status lines now club into ONE
//      entry, on both the Rabale Petty Expenses side and the Journal
//      side. A vendor with both a GST and a non-GST bill keeps those two
//      as separate clubbed groups (see clubVendorLinesByVendorAndGst).
function buildTransportEntries_(v, items, ledgers) {
  var entries = [];
  // Narration date is the ACTUAL EXPENSE DATE (the bill's real date), not
  // the Voucher Date column (v.dateForSheet, always the submission date) —
  // per explicit instruction: the Voucher Date field stays fixed to
  // submission/batch date for Tally's own records, while the backdated
  // bill date is surfaced in the narration text instead, mirroring how
  // the old handwritten-voucher process handled it.
  var dateDot = toDotDate_(v.actualExpenseDate || v.date);

  // Fine-grained grouping (vendor + GST status + LR) drives everything on
  // the PAYMENT side — Rabale Petty Expenses credit rows and Journal
  // payment rows. Two bills from the same vendor are no longer clubbed
  // here; LR number (or line index, if LR is blank) keeps them distinct.
  var fineGroups = splitVendorLinesByVendorGstAndLr_(items);
  var nonGstGroups = fineGroups.filter(function (g) { return !g.hasGst; });
  var gstGroups = fineGroups.filter(function (g) { return g.hasGst; });

  // Rabale Petty Expenses entries: all non-GST bills still combine into
  // ONE aggregate entry (unchanged, deliberate — see file header); each
  // GST-applicable BILL now gets its own entry (previously each GST
  // VENDOR got its own entry, clubbing that vendor's multiple bills — no
  // longer). A voucher that nets out to only one entry overall stays a
  // plain voucher number; A/B/C... suffixes only appear once 2+ entries
  // genuinely need disambiguating.
  var rpeGroups = [];
  if (nonGstGroups.length > 0) rpeGroups.push({ vendorGroups: nonGstGroups, isGst: false });
  gstGroups.forEach(function (g) { rpeGroups.push({ vendorGroups: [g], isGst: true }); });

  var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (rpeGroups.length > 1) {
    rpeGroups.forEach(function (rg, idx) { rg.suffix = idx < letters.length ? letters[idx] : ('X' + (idx + 1)); });
  } else {
    rpeGroups.forEach(function (rg) { rg.suffix = ''; });
  }

  // Which real Rabale Petty Expenses voucher number(s) (with suffix) each
  // fine-grained bill belongs to, rolled up to the COARSE (vendor+GST)
  // key — since TDS stays one entry per vendor even when that vendor's
  // bills now span multiple suffixed RPE entries, the TDS narration lists
  // all of them.
  var peVoucherNumbersByCoarseKey = {};

  rpeGroups.forEach(function (rg) {
    var voucherNumber = v.voucherId + rg.suffix;
    rg.vendorGroups.forEach(function (vg) {
      var coarseKey = vg.vendorName + '|' + (vg.hasGst ? 'G' : 'N');
      if (!peVoucherNumbersByCoarseKey[coarseKey]) peVoucherNumbersByCoarseKey[coarseKey] = [];
      if (peVoucherNumbersByCoarseKey[coarseKey].indexOf(voucherNumber) === -1) {
        peVoucherNumbersByCoarseKey[coarseKey].push(voucherNumber);
      }
    });

    var sumBase = 0, sumCgst = 0, sumSgst = 0, sumHamali = 0;
    rg.vendorGroups.forEach(function (vg) {
      sumBase += (vg.amount - vg.cgst - vg.sgst - vg.hamali);
      sumCgst += vg.cgst;
      sumSgst += vg.sgst;
      sumHamali += vg.hamali;
    });

    var narration = buildTransportGroupNarration_(v, flattenVendorGroupItems_(items, rg.vendorGroups), dateDot);
    var groupId = voucherNumber + '|PE';
    // GST-applicable group uses the "Non - GST" ledger, non-GST group uses
    // the Settings-configured Transportation ledger — per explicit
    // instruction (TRANSPORTATION_NON_GST_LEDGER in Config.gs). Reads
    // inverted at a glance; implemented literally as instructed.
    var transportLedger = rg.isGst ? ledgers.transportationNonGst : ledgers.transportation;

    entries.push(makeTeEntry_(groupId, 'Dr', round2_(sumBase), v.dateForSheet, 'Rabale Petty Expenses', voucherNumber, transportLedger, v.costCentre, narration));
    if (sumCgst > 0) entries.push(makeTeEntry_(groupId, 'Dr', round2_(sumCgst), v.dateForSheet, 'Rabale Petty Expenses', voucherNumber, ledgers.ineligibleCgst, v.costCentre, narration));
    if (sumSgst > 0) entries.push(makeTeEntry_(groupId, 'Dr', round2_(sumSgst), v.dateForSheet, 'Rabale Petty Expenses', voucherNumber, ledgers.ineligibleSgst, v.costCentre, narration));
    // Hamali (loading/unloading) charges — per explicit instruction, a
    // SECOND, separate debit line to the same Transportation Non GST
    // ledger, right after CGST/SGST, never netted into sumBase above.
    // Fires for both GST and non-GST groups alike (hamali is independent
    // of a bill's GST status) — always ledgers.transportationNonGst
    // specifically, not the group's own `transportLedger` variable.
    if (sumHamali > 0) entries.push(makeTeEntry_(groupId, 'Dr', round2_(sumHamali), v.dateForSheet, 'Rabale Petty Expenses', voucherNumber, ledgers.transportationNonGst, v.costCentre, narration));
    // ONE credit row per fine-grained (vendor+GST+LR) group — two bills
    // from the same vendor now produce two separate credit rows, same as
    // two different vendors always have.
    rg.vendorGroups.forEach(function (vg) {
      entries.push(makeTeEntry_(groupId, 'Cr', round2_(vg.amount), v.dateForSheet, 'Rabale Petty Expenses', voucherNumber, vg.vendorName, v.costCentre, narration));
    });
  });

  // Journal — payment entry PER FINE-GRAINED (vendor+GST+LR) group, i.e.
  // per bill — matching the RPE side above. TDS is DIFFERENT: it stays
  // grouped by the COARSE key (vendor+GST only, see
  // clubVendorLinesByVendorAndGst) — one TDS entry per vendor, summed
  // across however many separate bills/LRs that vendor has this voucher,
  // per explicit instruction. The TDS narration lists every RPE voucher
  // number (with suffix) that vendor's bills ended up split across.
  fineGroups.forEach(function (vg) {
    var narrationPay = buildTransportGroupNarration_(v, flattenVendorGroupItems_(items, [vg]), dateDot);
    var groupPay = v.voucherId + '|J|' + vg.key + '|pay';
    entries.push(makeTeEntry_(groupPay, 'Dr', round2_(vg.amount), v.dateForSheet, 'Journal', '', vg.vendorName, v.costCentre, narrationPay));
    entries.push(makeTeEntry_(groupPay, 'Cr', round2_(vg.amount), v.dateForSheet, 'Journal', '', v.submittedBy, v.costCentre, narrationPay));
  });

  var tdsGroups = clubVendorLinesByVendorAndGst_(items);
  tdsGroups.forEach(function (vg) {
    if (!vg.tdsApplicable || vg.tdsAmount <= 0) return;
    var coarseKey = vg.vendorName + '|' + (vg.hasGst ? 'G' : 'N');
    var peVoucherNumbers = peVoucherNumbersByCoarseKey[coarseKey] || [v.voucherId];
    var narrationTds = buildTdsNarration_({ tdsRate: vg.tdsRate, amount: vg.amount, cgst: vg.cgst, sgst: vg.sgst, vendorName: vg.vendorName }, peVoucherNumbers.join(', '), dateDot);
    var groupTds = v.voucherId + '|J|' + vg.key + '|tds';
    entries.push(makeTeEntry_(groupTds, 'Dr', round2_(vg.tdsAmount), v.dateForSheet, 'Journal', '', vg.vendorName, v.costCentre, narrationTds));
    entries.push(makeTeEntry_(groupTds, 'Cr', round2_(vg.tdsAmount), v.dateForSheet, 'Journal', '', ledgers.tdsOnContractor, v.costCentre, narrationTds));
  });

  // Petty Cash — ONE aggregate entry for the whole voucher (see file
  // header). REAL BUG FIXED (Day 4): this used to net out totalTds here
  // (totalPaid - totalTds), which double-counted the TDS withholding —
  // the vendor-facing Journal entry above already carries the TDS effect
  // entirely on its own (Dr vendor / Cr TDS On Contractor, a
  // self-balancing pair that never touches the employee's IOU ledger).
  // TDS is a fact about the COMPANY-TO-VENDOR relationship, not about how
  // much cash physically left the petty cash box to reimburse the
  // employee — the employee paid the vendor the FULL bill amount out of
  // pocket and must be reimbursed the FULL amount. Petty Cash always uses
  // totalPaid, never net of TDS.
  var totalPaid = items.reduce(function (s, it) { return s + it.amount; }, 0);
  var narrationPc = buildTransportGroupNarration_(v, items, dateDot);
  var groupPc = v.voucherId + '|PC';
  entries.push(makeTeEntry_(groupPc, 'Dr', round2_(totalPaid), v.dateForSheet, 'Rabale - Petty Cash', '', v.submittedBy, v.costCentre, narrationPc));
  entries.push(makeTeEntry_(groupPc, 'Cr', round2_(totalPaid), v.dateForSheet, 'Rabale - Petty Cash', '', ledgers.pettyCash, v.costCentre, narrationPc));

  return entries;
}

// Groups entries by their internal group id and confirms Dr total = Cr
// total for every group, within float rounding tolerance. Returns a list
// of group ids that DON'T balance — empty list means everything's fine.
function findUnbalancedGroups_(entries) {
  var totals = {};
  entries.forEach(function (e) {
    if (!totals[e.group]) totals[e.group] = { dr: 0, cr: 0 };
    if (e.drCr === 'Dr') totals[e.group].dr += e.amount; else totals[e.group].cr += e.amount;
  });
  var bad = [];
  Object.keys(totals).forEach(function (g) {
    if (Math.abs(totals[g].dr - totals[g].cr) > 0.02) bad.push(g);
  });
  return bad;
}

// Highest existing numeric Voucher Number already used for `typeName` in
// this sheet, so a running serial continues cleanly across export runs
// instead of restarting at 1 and colliding with entries from an earlier run.
function getNextSerialForType_(sheet, typeName) {
  var data = sheet.getDataRange().getValues();
  var max = 0;
  for (var i = 1; i < data.length; i++) {
    if (data[i][TE.VOUCHER_TYPE_NAME] === typeName) {
      var n = parseInt(data[i][TE.VOUCHER_NUMBER], 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return max + 1;
}

// Assigns a running serial number (plain text, in the Voucher Number
// column) to every Journal and Rabale - Petty Cash entry in this batch.
// These two types leave Voucher Number for Tally to auto-assign on
// import — but with literally nothing in that column, there's no way to
// visually tell where one whole Dr/Cr entry ends and the next begins when
// scanning the raw exported rows. This serial is a readability aid for the
// file only; it is NOT the real Tally voucher number, and does not affect
// what Tally assigns on import.
//
// Every row belonging to one logical entry (same internal group id) gets
// the SAME serial, not one number per row.
function assignSerialNumbers_(sheet, entries) {
  var nextSerial = {
    'Journal': getNextSerialForType_(sheet, 'Journal'),
    'Rabale - Petty Cash': getNextSerialForType_(sheet, 'Rabale - Petty Cash')
  };
  var seenGroups = {};
  entries.forEach(function (e) {
    var voucherType = e.row[TE.VOUCHER_TYPE_NAME];
    if (voucherType !== 'Journal' && voucherType !== 'Rabale - Petty Cash') return;
    if (!seenGroups.hasOwnProperty(e.group)) {
      seenGroups[e.group] = nextSerial[voucherType]++;
    }
    e.row[TE.VOUCHER_NUMBER] = String(seenGroups[e.group]);
  });
}

// Transport Breakdown line items for one voucher, server-internal (no
// session gating — this is called from within an already-authorized export
// run, not exposed as its own RPC). Includes lineIndex for the same reason
// GST entry needs it: duplicate vendor names on one voucher are legal.
function getVendorLineItemsForExport_(voucherId) {
  var sheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var items = [];
  var lineIndex = 0;
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][TB.VOUCHER_ID]) !== voucherId) continue;
    items.push({
      lineIndex: lineIndex++,
      tbRow: i + 1,
      vendorName: safe_(data[i][TB.VENDOR_NAME]),
      amount: parseFloat(data[i][TB.AMOUNT]) || 0,
      tdsApplicable: safe_(data[i][TB.TDS_APPLICABLE]) === 'Yes',
      tdsRate: parseFloat(data[i][TB.TDS_RATE]) || 0,
      tdsAmount: parseFloat(data[i][TB.TDS_AMOUNT]) || 0,
      cgst: parseFloat(data[i][TB.CGST]) || 0,
      sgst: parseFloat(data[i][TB.SGST]) || 0,
      hamali: parseFloat(data[i][TB.HAMALI]) || 0,
      gstReviewed: safe_(data[i][TB.GST_REVIEWED]) === 'Yes',
      returnParcel: safe_(data[i][TB.RETURN_PARCEL]) === 'Yes',
      lrNo: safe_(data[i][TB.LR_NO])
    });
  }
  return items;
}

// Returns Approved vouchers for the Tally Export selection screen.
// mode='pending' (default) — never-exported candidates, unchanged
// behavior. mode='exported' — already-exported vouchers, added so
// accounts has a read-only reference view ("just in case of file
// corruption or missing something") and admin can select from it to
// re-export. Both roles can VIEW either mode; only admin can actually
// TRIGGER a re-export of an already-exported voucher (enforced in
// generateTallyExport below, not here — this function is read-only).
function getTallyExportCandidates(token, mode) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'accounts' && session.role !== 'admin') {
      return { success: false, error: 'You do not have permission to view Tally export candidates.' };
    }
    var wantExported = (mode === 'exported');
    var sheet = getSheet_(ALL_VOUCHERS_SHEET);
    var data = sheet.getDataRange().getValues();
    var list = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (safe_(row[AV.STATUS]) !== 'Approved') continue;
      // Approved-but-requeried vouchers are excluded — same rule cash
      // release already enforces (getUnreleasedApprovedVouchersStatus).
      // A query can be raised against an Approved voucher (Query Thread
      // is independent of approval stage), and Tally export on a voucher
      // whose amount/vendor/GST is actively disputed would lock in
      // figures that might still change once the submitter responds.
      var queryStatusCand = safe_(row[AV.QUERY_STATUS]);
      if (queryStatusCand && queryStatusCand !== 'No Query') continue;
      var alreadyExported = (safe_(row[AV.TALLY_EXPORTED]) === 'Yes');
      if (alreadyExported !== wantExported) continue;
      list.push({
        voucherId: safe_(row[AV.VOUCHER_ID]),
        date: formatDate_(row[AV.DATE]),
        expenseType: safe_(row[AV.EXPENSE_TYPE]),
        submittedBy: safe_(row[AV.SUBMITTED_BY]),
        vehicleNo: safe_(row[AV.VEHICLE_NO]),
        costCentre: safe_(row[AV.COST_CENTRE]),
        amount: parseFloat(row[AV.AMOUNT]) || 0,
        status: safe_(row[AV.STATUS]),
        batchId: safe_(row[AV.BATCH_ID]),
        alreadyExported: alreadyExported
      });
    }
    return { success: true, vouchers: list };
  } catch (err) {
    Logger.log('getTallyExportCandidates error: ' + err);
    return { success: false, error: 'Failed to load export candidates: ' + err.toString(), vouchers: [] };
  }
}

// Generates Tally Export rows for the given voucher IDs. Role-gated to
// accounts/admin. Everything runs under one lock so a second concurrent
// export can't double-export the same voucher. Each voucher is
// re-validated (still Approved) at write time, not just trusted from what
// the client had selected.
//
// Already-exported vouchers: accounts is still blocked from re-exporting
// (skipped with the existing "Already exported" reason, same as before) —
// admin CAN re-export an already-exported voucher, per explicit
// instruction ("admin should be able to export any amount of times").
// Logged under a distinct TALLY_REEXPORT audit action so a re-export is
// trivially distinguishable from a first-time export later. This is a
// genuine operational risk worth restating: re-exporting produces another
// real .xlsx file with fresh serial numbers: if that file is imported into
// Tally a second time (rather than just used to recover from a lost/
// corrupted original), the expense would be double-booked on Tally's side.
// This code has no way to know what the human does with the file
// afterward — the guard here is "who can trigger it," not "what happens
// after."
// ----------------------------------------------------------------------------
// Section 194C TDS threshold auto-detection (deferred at launch, now
// implemented per explicit instruction). A vendor's bill becomes
// TDS-applicable once EITHER threshold is crossed within a financial
// year (1 Apr - 31 Mar): a single bill of >= Rs. 30,000, or the vendor's
// running cumulative total for the FY reaching >= Rs. 1,00,000.
// Deliberately NON-retroactive: only the bill that crosses the
// threshold, and every bill after it that FY, is affected — bills
// already processed before the crossing point are never touched. This
// changes ONLY the TDS Journal entry at Tally-export time; it never
// touches cash reimbursed to the employee (Petty Cash always pays the
// full submitted amount, per the existing TDS/Petty Cash principle) and
// never rewrites the stored per-line TDS fields on the Transport
// Breakdown sheet — those remain exactly what Accounts set at GST
// review time. This is computed fresh on every export, from ALL
// Approved vouchers' vendor line items company-wide, not persisted
// as separate running-balance state, so there's no separate ledger to
// keep in sync or get out of date. EXCEPTION: a vendor with a 194C(6)
// declaration on file is never threshold-triggered, no matter the bill
// size or cumulative total — that's a categorical statutory exemption,
// not a rate the threshold can turn on (see the declarationOnFile check
// in computeTdsThresholdOverridesForFy below).
// ----------------------------------------------------------------------------

var TDS_SINGLE_BILL_THRESHOLD = 30000;
var TDS_ANNUAL_THRESHOLD = 100000;

function getFinancialYearBounds_(dateObj) {
  var y = dateObj.getFullYear();
  var fyStartYear = (dateObj.getMonth() >= 3) ? y : y - 1; // FY starts April (month index 3)
  return {
    key: fyStartYear + '-' + (fyStartYear + 1),
    start: new Date(fyStartYear, 3, 1),
    end: new Date(fyStartYear + 1, 2, 31, 23, 59, 59)
  };
}

// One full pass over the Transport Breakdown + All Vouchers sheets for a
// given financial year, joined by Voucher ID. Returns a map of
// TB-sheet-row-number (1-based) -> true, for every bill that is
// threshold-triggered — either on its own, or because it pushed (or
// followed) its vendor's FY-cumulative base amount (excl. GST and hamali,
// matching how TDS itself is always computed) past Rs. 1,00,000. Only Approved
// vouchers count; a voucher stuck in the approval chain doesn't yet
// count toward the running total.
function computeTdsThresholdOverridesForFy_(fyBounds) {
  var result = {};
  var tbSheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
  var avSheet = getSheet_(ALL_VOUCHERS_SHEET);
  if (!tbSheet || !avSheet) return result;

  // A vendor with a 194C(6) declaration on file is categorically exempt
  // from TDS regardless of bill size or cumulative total — that's a
  // statutory carve-out, not something the Rs. 30,000/Rs. 1,00,000
  // threshold can override. These vendors are excluded from threshold
  // detection entirely below, matching the same rule enforced in
  // getVendorsWithTDS (Master data.gs).
  var vendorMaster = getVendorsWithTDS_();

  var avData = avSheet.getDataRange().getValues();
  var voucherMeta = {};
  for (var a = 1; a < avData.length; a++) {
    var vid = safe_(avData[a][AV.VOUCHER_ID]);
    if (!vid) continue;
    voucherMeta[vid] = {
      status: safe_(avData[a][AV.STATUS]),
      dateObj: parseRdsDateString_(safe_(avData[a][AV.DATE]))
    };
  }

  var tbData = tbSheet.getDataRange().getValues();
  var byVendor = {};
  for (var i = 1; i < tbData.length; i++) {
    var voucherId = safe_(tbData[i][TB.VOUCHER_ID]);
    var meta = voucherMeta[voucherId];
    if (!meta || meta.status !== 'Approved') continue;
    var dObj = meta.dateObj;
    if (!(dObj instanceof Date) || isNaN(dObj.getTime())) continue;
    if (dObj < fyBounds.start || dObj > fyBounds.end) continue;

    var vendorName = safe_(tbData[i][TB.VENDOR_NAME]);
    if (!vendorName) continue;
    if (vendorMaster[vendorName] && vendorMaster[vendorName].declarationOnFile) continue; // 194C(6) — never threshold-triggered
    var cgst = parseFloat(tbData[i][TB.CGST]) || 0;
    var sgst = parseFloat(tbData[i][TB.SGST]) || 0;
    var hamali = parseFloat(tbData[i][TB.HAMALI]) || 0;
    var baseAmount = (parseFloat(tbData[i][TB.AMOUNT]) || 0) - cgst - sgst - hamali;

    if (!byVendor[vendorName]) byVendor[vendorName] = [];
    byVendor[vendorName].push({ row: i + 1, amount: baseAmount, dateObj: dObj });
  }

  Object.keys(byVendor).forEach(function (vendorName) {
    var bills = byVendor[vendorName];
    bills.sort(function (x, y) { return (x.dateObj - y.dateObj) || (x.row - y.row); });
    var cumulative = 0;
    bills.forEach(function (b) {
      cumulative += b.amount;
      if (b.amount >= TDS_SINGLE_BILL_THRESHOLD || cumulative >= TDS_ANNUAL_THRESHOLD) {
        result[b.row] = true;
      }
    });
  });

  return result;
}

// Applies threshold overrides to one voucher's fetched vendor line
// items, ahead of buildTransportEntries. A vendor newly triggered by the
// threshold at export time, AND a vendor already flagged TDS-applicable,
// both get their rate RE-DERIVED here from the SAME rule as everywhere
// else — PAN 4th-letter first (see getPanHolderRate, Master data.gs),
// falling back to the vendor's Master Data Rate % only if the PAN is
// missing/invalid, and only warning (never guessing) if neither is
// available. Re-deriving already-applicable lines too (not just newly
// triggered ones) closes a gap where a PAN corrected between submission
// and export would otherwise never reach an already-applicable line's
// Tally figure. A line whose re-derived rate matches its stored rate is
// left byte-for-byte unchanged (same object), so no spurious warning or
// no-op write appears where the rate was already correct. A declared
// vendor is never touched here at all — computeTdsThresholdOverridesForFy
// already excludes them from thresholdMap entirely, but the
// declarationOnFile check is repeated here too as a second, independent
// guard, since this function's contract (never override a declared
// vendor) shouldn't silently depend on a caller upstream getting that
// right.
// Returns { items: [...], warnings: [...] }.
function applyTdsThresholdOverride_(items, thresholdMap, vendorMaster) {
  var warnings = [];
  var updated = items.map(function (it) {
    var vm = vendorMaster[it.vendorName];
    if (vm && vm.declarationOnFile) return it; // 194C(6) — never overridden, belt-and-suspenders
    var triggered = thresholdMap[it.tbRow] === true;
    if (!triggered && !it.tdsApplicable) return it; // never applicable, never triggered — unchanged

    var rate = getPanHolderRate_(vm ? vm.pan : '');
    if (rate === null) rate = (vm && vm.tdsRate > 0) ? vm.tdsRate : null;
    if (rate === null) {
      warnings.push('Vendor "' + it.vendorName + '" crossed the Rs. 30,000/Rs. 1,00,000 194C threshold this financial year, but has no valid PAN and no fallback TDS Rate % configured in Master Data \u2014 TDS was NOT applied to this bill. Add a valid PAN or a fallback rate and re-export.');
      return it;
    }
    if (it.tdsApplicable && it.tdsRate === rate) return it; // already correct — no change, no spurious warning
    var tdsBase = it.amount - it.cgst - it.sgst - (it.hamali || 0);
    return Object.assign({}, it, {
      tdsApplicable: true,
      tdsRate: rate,
      tdsAmount: Math.round(tdsBase * rate)
    });
  });
  return { items: updated, warnings: warnings };
}

function generateTallyExport(voucherIdsJson, token) {

  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'accounts' && session.role !== 'admin') {
      return { success: false, error: 'You do not have permission to generate Tally exports.' };
    }

    var voucherIds;
    try { voucherIds = JSON.parse(voucherIdsJson); } catch (e) { return { success: false, error: 'Invalid voucher selection.' }; }
    if (!voucherIds || voucherIds.length === 0) return { success: false, error: 'No vouchers selected.' };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(20000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy processing another export. Please try again in a few seconds.' };
    }

    try {
      var avSheet = getSheet_(ALL_VOUCHERS_SHEET);
      var avData = avSheet.getDataRange().getValues();
      var ledgers = getTallyLedgerNames_();
      // Fetched once per export run, not per voucher — PAN/declaration
      // are the same for every bill against a given vendor within this
      // run, and vendors don't change mid-export.
      var vendorMaster = getVendorsWithTDS_();

      var exported = [], skipped = [];
      var sheetsByMonth = {}; // monthKey -> { sheet, entries: [] }
      var tdsThresholdWarnings = [];
      var thresholdMapByFy = {}; // FY key -> row-triggered map, computed once per FY per export run

      for (var vi = 0; vi < voucherIds.length; vi++) {
        var voucherId = String(voucherIds[vi]);
        var rowIdx = -1;
        for (var i = 1; i < avData.length; i++) {
          if (safe_(avData[i][AV.VOUCHER_ID]) === voucherId) { rowIdx = i; break; }
        }
        if (rowIdx === -1) { skipped.push({ voucherId: voucherId, reason: 'Not found.' }); continue; }

        var row = avData[rowIdx];
        if (safe_(row[AV.STATUS]) !== 'Approved') { skipped.push({ voucherId: voucherId, reason: 'Not Approved (current status: ' + safe_(row[AV.STATUS]) + ').' }); continue; }
        var queryStatusWrite = safe_(row[AV.QUERY_STATUS]);
        if (queryStatusWrite && queryStatusWrite !== 'No Query') { skipped.push({ voucherId: voucherId, reason: 'Has an open query (' + queryStatusWrite + ') \u2014 not exportable until resolved.' }); continue; }
        var wasAlreadyExported = (safe_(row[AV.TALLY_EXPORTED]) === 'Yes');
        if (wasAlreadyExported && session.role !== 'admin') {
          skipped.push({ voucherId: voucherId, reason: 'Already exported \u2014 only admin can re-export.' });
          continue;
        }

        var v = {
          voucherId: voucherId,
          date: formatDate_(row[AV.DATE]),
          actualExpenseDate: safe_(row[AV.ACTUAL_EXPENSE_DATE]) || formatDate_(row[AV.DATE]),
          expenseType: safe_(row[AV.EXPENSE_TYPE]),
          submittedBy: safe_(row[AV.SUBMITTED_BY]),
          costCentre: safe_(row[AV.COST_CENTRE]),
          amount: parseFloat(row[AV.AMOUNT]) || 0,
          description: safe_(row[AV.NOTES]),
          // REAL BUG FIXED 24 Aug 2026: this field was referenced by both
          // narration builders (buildTransportGroupNarration,
          // buildRegularNarration) but was never actually populated here
          // — v.vehicleNo was always undefined at narration-build time,
          // so the vehicle number has never appeared in ANY Tally export
          // narration, Transport or Regular, since that feature was
          // added. Every past export is affected; this only fixes it
          // going forward (re-export via admin if historical exports
          // need correcting).
          vehicleNo: safe_(row[AV.VEHICLE_NO])
        };
        v.dateForSheet = toHyphenDate_(v.date);

        var isTransport = (v.expenseType === 'Transport');
        // Vehicle number is now COMPULSORY in the narration for Transport
        // (always) and for the 3 vehicle-linked Regular ledgers (per
        // explicit instruction) — rather than silently omit it if
        // somehow blank (submission already requires it for both cases;
        // this only catches legacy pre-existing data), the export is
        // skipped with a clear reason so it can't go out with a missing
        // vehicle number, and Accounts knows exactly why.
        var vehicleRequiredHere = isTransport || VEHICLE_REQUIRED_LEDGERS.indexOf(v.expenseType) !== -1;
        if (vehicleRequiredHere && !v.vehicleNo) {
          skipped.push({ voucherId: voucherId, reason: 'Vehicle No. is required for this voucher\u2019s narration but is blank on the voucher \u2014 correct it before exporting.' });
          continue;
        }
        var entries;
        if (isTransport) {
          var items = getVendorLineItemsForExport_(voucherId);
          if (items.length === 0) { skipped.push({ voucherId: voucherId, reason: 'No Transport Breakdown line items found.' }); continue; }
          var unreviewed = items.some(function (it) { return !it.gstReviewed; });
          if (unreviewed) { skipped.push({ voucherId: voucherId, reason: 'GST not fully reviewed for all vendors (shouldn\u2019t happen if approval gate is working \u2014 check this voucher).' }); continue; }

          var fyBounds = getFinancialYearBounds_(parseRdsDateString_(v.date));
          if (!thresholdMapByFy[fyBounds.key]) thresholdMapByFy[fyBounds.key] = computeTdsThresholdOverridesForFy_(fyBounds);
          var tdsResult = applyTdsThresholdOverride_(items, thresholdMapByFy[fyBounds.key], vendorMaster);
          items = tdsResult.items;
          if (tdsResult.warnings.length > 0) tdsThresholdWarnings = tdsThresholdWarnings.concat(tdsResult.warnings);

          entries = buildTransportEntries_(v, items, ledgers);
        } else {
          if (safe_(row[AV.REGULAR_VENDOR_ROUTED]) === 'Yes') {
            var rvdSheet = getOrCreateRegularVendorDetailsSheet_();
            var rvdData = rvdSheet.getDataRange().getValues();
            for (var rvI = 1; rvI < rvdData.length; rvI++) {
              if (safe_(rvdData[rvI][RVD.VOUCHER_ID]) === voucherId) {
                v.regularVendor = {
                  vendorName: safe_(rvdData[rvI][RVD.VENDOR_NAME]),
                  cgst: parseFloat(rvdData[rvI][RVD.CGST]) || 0,
                  sgst: parseFloat(rvdData[rvI][RVD.SGST]) || 0
                };
                break;
              }
            }
            if (!v.regularVendor) { skipped.push({ voucherId: voucherId, reason: 'Marked vendor-routed but no Vendor Expense Details row found \u2014 check this voucher.' }); continue; }
          }
          entries = buildRegularEntries_(v, ledgers);
        }

        var unbalanced = findUnbalancedGroups_(entries);
        if (unbalanced.length > 0) {
          Logger.log('WARNING: Tally export Dr/Cr mismatch for voucher ' + voucherId + ': ' + unbalanced.join(', '));
          logAction_('TALLY_BALANCE_WARNING', voucherId, session.displayName || session.role, session.role, 'Dr/Cr did not balance for group(s): ' + unbalanced.join(', ') + ' \u2014 voucher skipped, not exported.');
          skipped.push({ voucherId: voucherId, reason: 'Dr/Cr did not balance \u2014 skipped, not exported. Check Audit Log.' });
          continue;
        }

        var monthKey = getMonthKeyFromDMY_(v.date);
        if (!monthKey) { skipped.push({ voucherId: voucherId, reason: 'Could not determine export month from date "' + v.date + '".' }); continue; }
        if (!sheetsByMonth[monthKey]) sheetsByMonth[monthKey] = { sheet: getOrCreateTallyExportSheet_(monthKey), entries: [] };
        sheetsByMonth[monthKey].entries = sheetsByMonth[monthKey].entries.concat(entries);

        avSheet.getRange(rowIdx + 1, AV.TALLY_EXPORTED + 1).setValue('Yes');
        avData[rowIdx][AV.TALLY_EXPORTED] = 'Yes'; // keep in-memory copy consistent for any later iteration referencing avData
        exported.push(voucherId);
      }

      Object.keys(sheetsByMonth).forEach(function (monthKey) {
        var target = sheetsByMonth[monthKey];
        if (target.entries.length === 0) return;
        // Serial numbers for Journal/Petty Cash computed from the sheet's
        // CURRENT content (before this batch's rows are appended), so a
        // second export run later in the same month continues the
        // sequence instead of restarting at 1.
        assignSerialNumbers_(target.sheet, target.entries);
        target.pendingRows = target.entries.map(function (e) { return e.row; });
        target.sheet.getRange(target.sheet.getLastRow() + 1, 1, target.pendingRows.length, EXPECTED_TALLY_EXPORT_HEADERS.length).setValues(target.pendingRows);
      });

      // Produce a downloadable .xlsx per month touched, containing ONLY
      // this run's newly-generated rows — not the whole month sheet's
      // accumulated history. Every click of Generate produces its own
      // distinct file covering just what that click exported, so
      // re-running an export later the same month doesn't hand you a file
      // that re-includes vouchers already exported (and presumably already
      // imported into Tally) earlier. Data is already safely written to
      // the Tally Export sheet(s) and TALLY_EXPORTED is already flipped
      // above — an xlsx-generation failure here (e.g. a missing OAuth
      // scope) is logged and reported, but does NOT undo the export or
      // block the response.
      var exportedFiles = [];
      Object.keys(sheetsByMonth).forEach(function (monthKey) {
        if (!sheetsByMonth[monthKey].pendingRows || sheetsByMonth[monthKey].pendingRows.length === 0) return;
        try {
          var file = exportTallyMonthAsXlsx_(monthKey, sheetsByMonth[monthKey].pendingRows);
          exportedFiles.push({ monthKey: monthKey, url: file.url, fileName: file.fileName });
        } catch (xlsxErr) {
          Logger.log('exportTallyMonthAsXlsx failed for ' + monthKey + ': ' + xlsxErr);
          logAction_('TALLY_XLSX_WARNING', '', session.displayName || session.role, session.role,
            'XLSX file generation failed for ' + monthKey + ': ' + xlsxErr + ' \u2014 data is still correctly in the Tally Export sheet, just no downloadable file this run.');
        }
      });

      logAction_('TALLY_EXPORT', '', session.displayName || session.role, session.role,
        exported.length + ' voucher(s) exported, ' + skipped.length + ' skipped. Exported: ' + exported.join(', '));

      var uniqueTdsWarnings = tdsThresholdWarnings.filter(function (w, idx) { return tdsThresholdWarnings.indexOf(w) === idx; });
      if (uniqueTdsWarnings.length > 0) {
        logAction_('TDS_THRESHOLD_WARNING', '', session.displayName || session.role, session.role, uniqueTdsWarnings.join(' | '));
      }

      return { success: true, exportedCount: exported.length, exported: exported, skipped: skipped, exportedFiles: exportedFiles, tdsThresholdWarnings: uniqueTdsWarnings,
        message: exported.length + ' voucher(s) exported successfully.' + (skipped.length ? ' ' + skipped.length + ' skipped.' : '') +
          (exportedFiles.length === 0 && exported.length > 0 ? ' (XLSX file generation failed \u2014 check Audit Log; data is safe in the Tally Export sheet.)' : '') +
          (uniqueTdsWarnings.length > 0 ? ' \u26a0\ufe0f ' + uniqueTdsWarnings.length + ' TDS threshold warning(s) \u2014 see below.' : '') };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('generateTallyExport error: ' + err);
    return { success: false, error: 'Failed to generate Tally export: ' + err.toString() };
  }
}

// Exports one month's Tally Export sheet as a standalone .xlsx file, saved
// to Drive under "Rabale Expense System / Tally Export" — the SAME top
// folder bill uploads already use (kept unchanged deliberately, so bills
// and Tally exports don't end up scattered across two differently-named
// top-level folders), with a new "Tally Export" subfolder. Filename is the
// export timestamp, per instruction.
//
// IMPORTANT: `rows` is ONLY this run's newly-generated rows — NOT the
// month sheet's full accumulated history. Every Generate click produces
// its own standalone file covering just what that click exported, so a
// second export later the same month doesn't hand you a file that
// re-includes vouchers already exported (and likely already imported into
// Tally) in an earlier run.
//
// Google Sheets has no native single-sheet-to-xlsx call, so the standard
// technique is used: copy just that sheet's data into a throwaway
// spreadsheet, export THAT via the Sheets export URL, then trash the
// throwaway spreadsheet — only the resulting .xlsx file is kept.
//
// REQUIRES: this Apps Script project's manifest (appsscript.json) must
// declare these OAuth scopes, or UrlFetchApp.fetch() below fails with a
// permission error:
//   "https://www.googleapis.com/auth/spreadsheets"
//   "https://www.googleapis.com/auth/drive"
//   "https://www.googleapis.com/auth/script.external_request"
function exportTallyMonthAsXlsx_(monthKey, rows) {
  var values = [EXPECTED_TALLY_EXPORT_HEADERS].concat(rows);

  var tempSs = SpreadsheetApp.create('Tally Export ' + monthKey + ' (temp)');
  var tempSheet = tempSs.getSheets()[0];
  tempSheet.setName(monthKey);
  tempSheet.getRange(1, 1, values.length, values[0].length).setValues(values);
  SpreadsheetApp.flush();

  var url = 'https://docs.google.com/spreadsheets/d/' + tempSs.getId() + '/export?format=xlsx';
  var token = ScriptApp.getOAuthToken();
  var response = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token } });

  var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HH-mm-ss');
  var blob = response.getBlob().setName('TallyExport_' + monthKey + '_' + timestamp + '.xlsx');

  var root = DriveApp.getRootFolder();
  var expFolder = getOrCreateDriveFolder_(root, 'Rabale Expense System');
  var exportsFolder = getOrCreateDriveFolder_(expFolder, 'Tally Export');
  var file = exportsFolder.createFile(blob);
  file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);

  // The throwaway spreadsheet's only job was producing the xlsx — discard
  // it so Drive doesn't accumulate an extra live Sheet per export run.
  DriveApp.getFileById(tempSs.getId()).setTrashed(true);

  return { url: file.getUrl(), fileName: blob.getName() };
}