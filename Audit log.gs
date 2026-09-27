// ============================================================================
// AUDIT LOG
// ============================================================================
// Unchanged from v8.2.

// CHANGED — every entry now also records the actor's position in the company
// at that moment (7th column). The Role column is untouched and stays the app
// role, because other code depends on it. The position lookup can never stop
// an action being logged: any failure there just leaves the cell blank.
var _auditPositionHeaderChecked = false; // one header check per execution, not per entry

function ensureAuditPositionHeader_(sheet) {
  if (_auditPositionHeaderChecked) return;
  _auditPositionHeaderChecked = true;
  try {
    var cell = sheet.getRange(1, AL.POSITION + 1);
    if (!safe_(cell.getValue())) cell.setValue(AUDIT_LOG_POSITION_HEADER);
  } catch (err) {
    Logger.log('ensureAuditPositionHeader_: ' + err);
  }
}

function logAction_(action, voucherId, actor, role, notes) {
  try {
    var s = getSheet_(AUDIT_LOG_SHEET);
    if (!s) {
      Logger.log('WARNING: Audit log sheet "' + AUDIT_LOG_SHEET + '" not found. Event not logged: ' + action);
      return;
    }
    var position = '';
    try { position = lookupDesignationByName_(actor); } catch (posErr) { position = ''; }
    ensureAuditPositionHeader_(s);
    s.appendRow([new Date().toLocaleString('en-IN'), action, voucherId || '', actor || '', role || '', notes || '', position]);
  } catch (e) {
    Logger.log('CRITICAL: logAction failed: ' + e);
  }
}

// ADDED (bugfix round, #10) — records when a bill file is opened, from
// the voucher detail modal. Fire-and-forget from the client (no
// withSuccessHandler awaited before the file opens \u2014 see viewDetail,
// Main.gs), so this never delays or blocks the actual file open. No
// permission narrowing beyond a valid session: every role that can view
// a voucher's bills can already see who's viewing them in the Audit Log.
function logBillViewed(voucherId, fileLabel, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false };
    logAction_('BILL_VIEWED', voucherId, session.displayName || session.role, session.role, fileLabel || '');
    return { success: true };
  } catch (err) {
    Logger.log('logBillViewed error: ' + err);
    return { success: false };
  }
}