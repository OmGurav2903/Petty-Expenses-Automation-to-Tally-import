// ============================================================================
// AUDITOR DASHBOARD — strictly read-only RPCs for the 'auditor' role.
// ============================================================================
//
// Design note: the Auditor Dashboard reuses getAllVouchers (Vouchers.gs) for
// its main voucher list — that function has never been role-restricted, so
// 'auditor' already gets full-detail rows from it with zero changes there.
// This file adds the two things auditor specifically needs that nothing
// else exposes: a browsable/filterable view of the Audit Log itself, and a
// per-voucher "what changed" diff built from the structured
// VOUCHER_EDIT_SNAPSHOT entries every edit path now logs (see
// snapshotVoucherCoreForAudit, Sheet Utils.gs) plus the full-record
// snapshot adminDeleteVoucherCompletely logs on deletion (Approval.gs).
//
// EVERY function in this file must remain a pure getter — no writes, ever.
// The whole point of the Auditor Dashboard is an attributable, read-only
// trail; a write function here would defeat that by definition.
// ============================================================================

function requireAuditorSession_(token) {
  var session = validateSession_(token);
  if (!session.valid || !session.role) return { ok: false, result: { success: false, error: 'Session expired. Please log in again.' } };
  if (session.role !== 'auditor' && session.role !== 'admin') {
    return { ok: false, result: { success: false, error: 'You do not have permission to view this.' } };
  }
  return { ok: true, session: session };
}

// Browsable audit log, most-recent-first, with optional filters. All
// filters are optional and combine with AND. `limit` caps how many rows
// are returned after filtering (most-recent-first), since the Audit Log
// only grows — without a cap this would eventually try to ship the whole
// sheet to the client on every load.
function getAuditLogEntries(filters, token) {
  try {
    var auth = requireAuditorSession_(token);
    if (!auth.ok) return auth.result;

    filters = filters || {};
    var voucherIdFilter = String(filters.voucherId || '').trim();
    var actionFilter = String(filters.action || '').trim();
    var actorFilter = String(filters.actor || '').trim().toLowerCase();
    var limit = parseInt(filters.limit, 10);
    if (!limit || limit <= 0) limit = 200;

    var sheet = getSheet_(AUDIT_LOG_SHEET);
    if (!sheet) return { success: true, entries: [] };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, entries: [] };
    var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();

    var entries = [];
    for (var i = data.length - 1; i >= 0; i--) {
      var row = data[i];
      var voucherId = safe_(row[AL.VOUCHER_ID]);
      var action = safe_(row[AL.ACTION]);
      var actor = safe_(row[AL.ACTOR]);
      if (voucherIdFilter && voucherId !== voucherIdFilter) continue;
      if (actionFilter && action !== actionFilter) continue;
      if (actorFilter && actor.toLowerCase().indexOf(actorFilter) === -1) continue;
      // VOUCHER_EDIT_SNAPSHOT entries are raw JSON meant for
      // getVoucherEditHistory's diff rendering, not this plain-text log
      // view — they'd just show as an unreadable blob here, so skip them
      // in the general browse and surface them only through the
      // dedicated per-voucher history call below.
      if (action === 'VOUCHER_EDIT_SNAPSHOT') continue;
      entries.push({
        timestamp: safe_(row[AL.TIMESTAMP]),
        action: action,
        voucherId: voucherId,
        actor: actor,
        role: safe_(row[AL.ROLE]),
        position: safe_(row[AL.POSITION]),
        notes: safe_(row[AL.NOTES])
      });
      if (entries.length >= limit) break;
    }
    return { success: true, entries: entries };
  } catch (err) {
    Logger.log('getAuditLogEntries error: ' + err);
    return { success: false, error: 'Failed to load audit log: ' + err.toString() };
  }
}

// Full chronological history for ONE voucher — every plain log entry
// (approve/reject/query/etc, human-readable) interleaved with parsed
// before/after diffs wherever a VOUCHER_EDIT_SNAPSHOT or
// ADMIN_DELETE_VOUCHER entry exists for it. This is what powers the
// "version 1 vs version 2" button in the Auditor Dashboard's voucher
// detail view.
function getVoucherEditHistory(voucherId, token) {
  try {
    var auth = requireAuditorSession_(token);
    if (!auth.ok) return auth.result;

    voucherId = String(voucherId || '').trim();
    if (!voucherId) return { success: false, error: 'Voucher ID is required.' };

    var sheet = getSheet_(AUDIT_LOG_SHEET);
    if (!sheet) return { success: true, timeline: [] };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, timeline: [] };
    var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();

    var timeline = [];
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      if (safe_(row[AL.VOUCHER_ID]) !== voucherId) continue;
      var action = safe_(row[AL.ACTION]);
      var notes = safe_(row[AL.NOTES]);
      var entry = {
        timestamp: safe_(row[AL.TIMESTAMP]),
        action: action,
        actor: safe_(row[AL.ACTOR]),
        role: safe_(row[AL.ROLE]),
        position: safe_(row[AL.POSITION]),
        hasDiff: false
      };

      if (action === 'VOUCHER_EDIT_SNAPSHOT') {
        entry.hasDiff = true;
        entry.diff = parseAuditSnapshotDiff_(notes);
        entry.notes = 'Voucher edited \u2014 see diff.';
      } else if (action === 'ADMIN_DELETE_VOUCHER') {
        // The delete snapshot is a single full-record object, not a
        // {before, after} pair — present it as "before -> (deleted)" so
        // the same diff renderer can be reused without a special case
        // in the client for this one action type.
        entry.hasDiff = true;
        try {
          var deletedSnapshot = JSON.parse(notes.substring(notes.indexOf('{')));
          entry.diff = { before: deletedSnapshot, after: null };
        } catch (parseErr) {
          entry.hasDiff = false;
        }
        entry.notes = notes.split(';')[0]; // just the human reason, not the trailing JSON, for the plain-text line
      } else {
        entry.notes = notes;
      }

      timeline.push(entry);
    }

    return { success: true, timeline: timeline };
  } catch (err) {
    Logger.log('getVoucherEditHistory error: ' + err);
    return { success: false, error: 'Failed to load voucher history: ' + err.toString() };
  }
}

// Parses a VOUCHER_EDIT_SNAPSHOT notes payload ('{"before":{...},"after":{...}}')
// into {before, after, changedFields: [{field, before, after}, ...]} — the
// changedFields list is what lets the client render just the differences
// rather than the whole object, without duplicating field-comparison logic
// in client JS.
function parseAuditSnapshotDiff_(notesJson) {
  var parsed;
  try { parsed = JSON.parse(notesJson); } catch (e) { return null; }
  if (!parsed || !parsed.before || !parsed.after) return null;

  var changedFields = [];
  var allKeys = {};
  Object.keys(parsed.before).forEach(function (k) { allKeys[k] = true; });
  Object.keys(parsed.after).forEach(function (k) { allKeys[k] = true; });
  Object.keys(allKeys).sort().forEach(function (key) {
    var b = parsed.before[key], a = parsed.after[key];
    if (String(b) !== String(a)) {
      changedFields.push({ field: key, before: b, after: a });
    }
  });

  return { before: parsed.before, after: parsed.after, changedFields: changedFields };
}

// Cross-reference view for "compare with Tally entries" — every Tally
// Export sheet row for a given voucher ID, across whichever month tab it
// landed in (resolved from the voucher's own Voucher Date, same as
// generateTallyExport itself does). Returns an empty list (not an error)
// if the voucher was never exported — that's a normal, valid state to
// display, not a failure.
function getTallyExportRowsForVoucher(voucherId, token) {
  try {
    var auth = requireAuditorSession_(token);
    if (!auth.ok) return auth.result;

    voucherId = String(voucherId || '').trim();
    if (!voucherId) return { success: false, error: 'Voucher ID is required.' };

    var found = findVoucherRow_(voucherId);
    if (!found) return { success: false, error: 'Voucher not found: ' + voucherId };

    var monthKey = getMonthKeyFromDMY_(safe_(found.rowValues[AV.DATE]));
    if (!monthKey) return { success: true, rows: [] };

    var ss = getSpreadsheet_();
    var sheet = ss.getSheetByName(TALLY_EXPORT_SHEET_PREFIX + monthKey);
    if (!sheet) return { success: true, rows: [] };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, rows: [] };

    var data = sheet.getRange(2, 1, lastRow - 1, EXPECTED_TALLY_EXPORT_HEADERS.length).getValues();
    var rows = [];
    for (var i = 0; i < data.length; i++) {
      if (safe_(data[i][TE.VOUCHER_NUMBER]) !== voucherId) continue;
      rows.push({
        voucherDate: safe_(data[i][TE.VOUCHER_DATE]),
        voucherTypeName: safe_(data[i][TE.VOUCHER_TYPE_NAME]),
        ledgerName: safe_(data[i][TE.LEDGER_NAME]),
        ledgerAmt: parseFloat(data[i][TE.LEDGER_AMT]) || 0,
        drCr: safe_(data[i][TE.LEDGER_AMOUNT_DR_CR]),
        costCenter: safe_(data[i][TE.COST_CENTER]),
        narration: safe_(data[i][TE.VOUCHER_NARRATION])
      });
    }
    return { success: true, rows: rows };
  } catch (err) {
    Logger.log('getTallyExportRowsForVoucher error: ' + err);
    return { success: false, error: 'Failed to load Tally export rows: ' + err.toString() };
  }
}