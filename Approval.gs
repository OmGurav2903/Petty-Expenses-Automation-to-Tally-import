// ============================================================================
// APPROVAL — L1 -> Accounts -> L2, with locking
// ============================================================================
//
// CHANGED FROM v8.2:
//   - Extended from a 2-stage (L1, L2) to a 3-stage (L1, Accounts, L2) chain,
//     driven by APPROVAL_SEQUENCE in Config.gs instead of hardcoded role
//     checks, so the sequence is a one-line change if it ever needs to
//     change again.
//   - updateVoucherStatus now acquires LockService.getScriptLock() around
//     the read-check-write sequence. v8.2 added this lock for voucher
//     SUBMISSION (to stop two concurrent duplicate-ID submissions racing)
//     but not for approval — meaning two people sharing the same L1 PIN
//     (which is how login works here) approving the same voucher within
//     milliseconds of each other could both read "Pending L1", both pass
//     the check, and both write. Same bug class, same fix.
//   - Looks up the voucher via findVoucherRow (current + previous month's
//     tab) instead of scanning a single "All Vouchers" sheet.
// ============================================================================

// ============================================================================
// UNOPENED-BILLS AUDIT FLAG (per explicit instruction) — read-only helper
// for updateVoucherStatus below. Confirms whether the CURRENT approving
// role opened at least one bill file (openBillFile -> logBillViewed, Main.gs
// / Audit Log.gs -> 'BILL_VIEWED' audit rows) SINCE this voucher entered its
// CURRENT pending stage — not "ever". Without that scoping, a bill opened
// by L1 in an earlier round would still count as "checked" after a
// reject+resubmit brought the same voucher back to L1 for a second look,
// which defeats the point of the flag.
//
// The Audit Log is append-only and read via getDataRange() top-to-bottom,
// so row index IS chronological order for a given voucher — no date
// parsing needed. Stage-entry boundary:
//   - role === APPROVAL_SEQUENCE[0] (L1): the most recent SUBMIT/RESUBMIT
//     row for this voucher (that's what put it in "Pending L1").
//   - any later role: the most recent APPROVE row logged by the PREVIOUS
//     role in APPROVAL_SEQUENCE (that's what advanced it into THIS role's
//     queue).
// No boundary event found (shouldn't happen outside data predating this
// feature) falls back to the voucher's entire audit history.
//
// Fails OPEN (returns true — "treat as viewed") on a missing Audit Log
// sheet, so a logging problem never manufactures a false flag on every
// single approval.
function wasAnyBillViewedThisStage_(voucherId, role) {
  var sheet = getSheet_(AUDIT_LOG_SHEET);
  if (!sheet) return true;
  var data = sheet.getDataRange().getValues();
  // Audit Log columns (see logAction, Audit Log.gs):
  // 0=Date, 1=Action, 2=VoucherId, 3=Actor, 4=Role, 5=Notes.
  var voucherRows = [];
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][2]) === voucherId) voucherRows.push(i);
  }

  var idxInSequence = APPROVAL_SEQUENCE.indexOf(role);
  var previousRole = idxInSequence > 0 ? APPROVAL_SEQUENCE[idxInSequence - 1] : null;

  var stageEntryRowIndex = -1;
  for (var v = 0; v < voucherRows.length; v++) {
    var r = voucherRows[v];
    var rowAction = safe_(data[r][1]);
    var rowRole = safe_(data[r][4]);
    var isStageEntry = previousRole === null
      ? (rowAction === 'SUBMIT' || rowAction === 'RESUBMIT')
      : (rowAction === 'APPROVE' && rowRole === previousRole);
    if (isStageEntry) stageEntryRowIndex = r; // last match wins — rows are chronological
  }

  for (var v2 = 0; v2 < voucherRows.length; v2++) {
    var r2 = voucherRows[v2];
    if (r2 <= stageEntryRowIndex) continue;
    if (safe_(data[r2][1]) === 'BILL_VIEWED' && safe_(data[r2][4]) === role) return true;
  }
  return false;
}

function updateVoucherStatus(voucherId, action, notes, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };

    var role = session.role;
    if (APPROVAL_SEQUENCE.indexOf(role) === -1) {
      return { success: false, error: 'You do not have permission to approve/reject vouchers.' };
    }

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      Logger.log('updateVoucherStatus lock timeout: ' + lockErr);
      return { success: false, error: 'System is busy processing another approval. Please try again in a few seconds.' };
    }

    try {
      var found = findVoucherRow_(voucherId);
      if (!found) return { success: false, error: 'Voucher not found: ' + voucherId };

      var currentStatus = safe_(found.rowValues[AV.STATUS]);
      var expectedStatus = getPendingStatusForRole_(role);
      if (currentStatus !== expectedStatus) {
        return { success: false, error: 'This voucher is not pending your approval (current status: ' + currentStatus + ').' };
      }

      // Edit lock (Day N) — refuses if submission currently has this
      // voucher open for edit. Closes the race where an approver's
      // reject/approve and a concurrent submitter save could interleave
      // and leave the voucher stuck (observed: rejected-while-being-
      // resubmitted left it silently still "Pending L1"). Checked inside
      // the same script lock as the read/write below, so nothing can slip
      // in between this check and the write that follows it.
      var lockConflict = checkVoucherNotLockedForActor_(found, session.displayName || role);
      if (lockConflict) return { success: false, error: lockConflict };

      // CRITICAL FIX (Day 7): an open query must block further approval
      // progression. raiseVoucherQuery intentionally never touches
      // AV.STATUS — by design, a queried voucher stays wherever it is in
      // the chain so the submitter can still see and respond to it (see
      // raiseVoucherQuery's own comments in this file). But nothing was
      // ever stopping THIS function from moving that same voucher forward
      // anyway: AV.QUERY_STATUS and AV.STATUS were completely independent
      // columns, so a voucher could sail straight through
      // L1 -> Accounts -> L2 and land on "Approved" while its Query
      // Status column still read "Query Raised — ..." untouched, because
      // approving it never once checked that column. Once Approved, the
      // submission-side "Respond to Query" flow (openRespondToQueryFlow,
      // Main.gs) also has nothing left to offer but the plain text+file
      // response modal — Approved isn't in EDITABLE_STATUSES or
      // QUERY_EDIT_STATUSES, so the scoped edit form never renders either.
      // Both symptoms share this one root cause.
      //
      // Gate every 'approve' AND 'reject' action on QUERY_STATUS being
      // cleared first, regardless of which stage originally raised the
      // query, and regardless of which stage is now acting — resolving it
      // (respondToQuery / resubmitVoucherForQueryScope /
      // resubmitVoucherAndRespondToQuery, Vouchers.gs) is the only thing
      // that resets AV.QUERY_STATUS back to 'No Query', so this can never
      // be silently bypassed the way GST review used to be for L2 (see
      // the Day 6 fix immediately below).
      //
      // CHANGED (bugfix round): 'reject' was previously left deliberately
      // ungated, on the reasoning that rejecting is always safe regardless
      // of an open query. Per explicit instruction this is reversed —
      // while a query is open, the only route forward is the submitter's
      // response (which resolves the query and, if it results in a full
      // edit+respond, can itself still end in resubmission back to
      // Pending L1). This also removes the #3/#4 conflict raised
      // alongside it: with reject blocked too, there's no state where an
      // approver's action and the submitter's in-flight query response
      // could race for the same voucher.
      var queryStatus = safe_(found.rowValues[AV.QUERY_STATUS]);
      if (queryStatus && queryStatus !== 'No Query') {
        var actionPastTense = (action === 'approve') ? 'approved' : 'rejected';
        return { success: false, error: 'This voucher has an open query (' + queryStatus + '). It cannot be ' + actionPastTense + ' until the submitter responds and the query is resolved.' };
      }

      // Accounts can't approve a transport voucher until GST has been
      // explicitly resolved (Yes-with-amounts or explicitly No) for every
      // vendor line — not just left at its untouched default. This is what
      // forces the "open it and mark No" extra step for genuinely GST-free
      // bills, so nothing gets silently skipped versus just forgotten.
      //
      // FIXED (Day 6) — CRITICAL: this check previously only fired for
      // role==='accounts'. L2 approving never re-checked it, which meant a
      // Transport voucher rejected AT L2 and then resubmitted (which
      // rewrites Transport Breakdown and can reset GST_REVIEWED on touched
      // lines — see updateTransportBreakdownLines in SheetUtils.gs) could
      // route straight back to Pending L2 and be approved with GST
      // silently un-reviewed, bypassing Accounts' sign-off entirely. L2
      // now re-checks the same gate — a voucher that reaches L2 must still
      // have every line GST-resolved, regardless of what happened to it in
      // between Accounts' original approval and now.
      // Fetched once, used by both the approve-side GST gate below and
      // the reject-side ledger reversal — a Transport voucher's expense
      // type never changes based on which action is being taken.
      var expenseType = safe_(found.rowValues[AV.EXPENSE_TYPE]);

      if (action === 'approve' && (role === 'accounts' || role === 'L2')) {
        if (expenseType === 'Transport' && !isVoucherGstFullyReviewed_(voucherId)) {
          return { success: false, error: 'GST has not been reviewed for every vendor on this voucher yet. Open the GST button and resolve Yes/No for each vendor before approving.' };
        }
        // ADDED (25 Aug 2026, item 11): the Regular-voucher counterpart to
        // the Transport gate immediately above — same "left at its
        // untouched default" loophole existed here, just without a gate to
        // close it. AV.REGULAR_VENDOR_ROUTED is 'Yes' (saveRegularVendorGst)
        // or 'No' (clearRegularVendorGst) once Accounts has explicitly
        // looked at it; blank means nobody has. Mirrors the Transport gate
        // in every respect that matters: fires for both accounts and L2 (so
        // a Regular voucher rejected at L2 and resubmitted can't slip back
        // through without re-review either), and is a pure read — it never
        // itself writes anything.
        if (expenseType !== 'Transport') {
          var regularGstState = safe_(found.rowValues[AV.REGULAR_VENDOR_ROUTED]);
          if (regularGstState !== 'Yes' && regularGstState !== 'No') {
            return { success: false, error: 'Vendor GST has not been reviewed for this voucher yet. Open the Vendor GST button and either route it through a vendor or mark No GST before approving.' };
          }
        }
      }

      var newStatus;
      if (action === 'approve') {
        newStatus = getNextStatus_(role);
      } else if (action === 'reject') {
        if (!notes || !notes.trim()) return { success: false, error: 'Rejection reason is required.' };
        newStatus = 'Rejected';

        // BUG FIX (ledger balance): a rejected voucher's bills never
        // actually happened as far as a vendor's running total is
        // concerned. Previously the amount stayed in Ledger Balance (and
        // now the FY ledger) forever unless the voucher was later
        // resubmitted (delta-netted against the still-present Transport
        // Breakdown rows) or admin-deleted (fully reversed) — a
        // rejected-and-abandoned voucher silently inflated the TDS
        // threshold check for that vendor indefinitely. Reverse it here,
        // at the moment of rejection, mirroring exactly what
        // adminDeleteVoucherCompletely already does below. Transport
        // Breakdown rows are deliberately NOT cleared (the submitter
        // still needs to see/edit them to resubmit) — only the two
        // persisted ledgers are reversed. If this voucher is later
        // resubmitted, resubmitVoucherCoreWriteOnly (Vouchers.gs) already
        // knows to treat the "old" vendor summary as zero for ledger
        // purposes in exactly this case, so the resubmission re-adds the
        // full amount with no double-reversal and no under-count.
        if (expenseType === 'Transport') {
          var vendorLinesForReject = getVendorLineItemsInternal_(voucherId);
          if (vendorLinesForReject && vendorLinesForReject.length > 0) {
            var rejectedVendorSummary = summarizeVendorLines_(vendorLinesForReject);
            applyVendorLedgerBalanceDelta_(rejectedVendorSummary, {});
            applyVendorFyLedgerBalanceDelta_(rejectedVendorSummary, {}, getFyKeyForDateValue_(safe_(found.rowValues[AV.DATE])));
          }
        }
      } else {
        return { success: false, error: 'Invalid action.' };
      }

      var now = new Date().toLocaleString('en-IN');
      var approverNote = role + ' (' + now + ')' + (notes ? ' \u2014 ' + notes : '');

      found.sheet.getRange(found.rowIndex, AV.STATUS + 1).setValue(newStatus);
      var approverCol = APPROVER_COLUMN_FOR_ROLE[role];
      if (approverCol !== undefined) {
        found.sheet.getRange(found.rowIndex, approverCol + 1).setValue(approverNote);
      }

      // Day 3: record WHICH stage rejected this voucher, so a later
      // resubmission can route back to exactly that stage instead of
      // restarting the whole L1->Accounts->L2 chain from scratch. On an
      // approve, defensively clear it too — a voucher moving forward
      // through the chain should never carry a stale "Rejected At Stage"
      // value left over from an earlier reject/resubmit cycle (in the
      // normal flow resubmitVoucher already clears this itself, but
      // clearing it here as well costs nothing and closes any gap).
      if (action === 'reject') {
        found.sheet.getRange(found.rowIndex, AV.REJECTED_AT_STAGE + 1).setValue(role);
      } else {
        found.sheet.getRange(found.rowIndex, AV.REJECTED_AT_STAGE + 1).setValue('');
      }

      // AUDIT FLAG (per explicit instruction) — informational only, never
      // blocks the approval itself: flags on the audit trail when the
      // approving role approved without opening a single bill file this
      // stage, so an auditor can spot rubber-stamped approvals after the
      // fact. See wasAnyBillViewedThisStage below for exactly what
      // "this stage" means. Reject is intentionally excluded — the risk
      // this exists to catch is approving without looking, not rejecting.
      var approveLogNotes = newStatus;
      if (action === 'approve' && !wasAnyBillViewedThisStage_(voucherId, role)) {
        approveLogNotes += ' [NO BILLS VIEWED THIS STAGE]';
      }
      logAction_(action === 'approve' ? 'APPROVE' : 'REJECT', voucherId, session.displayName || role, role, approveLogNotes);

      // Drive folder status suffix (per explicit instruction) — best
      // effort, never blocks the approval/rejection itself. Only fires on
      // the two terminal statuses; an intermediate "Pending Accounts"/
      // "Pending L2" leaves the folder name alone.
      if (newStatus === 'Approved' || newStatus === 'Rejected') {
        setVoucherDriveFolderStatusSuffix_(safe_(found.rowValues[AV.BATCH_ID]), voucherId, newStatus);
      }

      return { success: true, message: 'Voucher ' + voucherId + ' ' + (action === 'approve' ? 'approved' : 'rejected') + ' successfully.' };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('updateVoucherStatus error: ' + err);
    return { success: false, error: 'Failed to update status: ' + err.toString() };
  }
}

// REVISED (Day 6): queryType must be one of QUERY_CATEGORIES' real keys —
// this used to be an unvalidated free string. targetLineIndexesJson is a
// JSON array of 0-based Transport Breakdown line indexes (same numbering
// getVendorLineItems already uses), required whenever the category's
// requiresLineTarget is true AND the voucher is Transport (a Regular
// voucher has no lines to target — Amount Mismatch on a Regular voucher
// just unlocks the single amount field, no picker needed). The targeted
// line indexes get stamped with this query's ID into TB.QUERY_STATUS
// (previously an unused column) — that stamp is what the scoped-edit
// resubmit (resubmitVoucherForQueryScope, vouchers.gs) reads to know
// exactly which vendor line(s) the submitter is allowed to touch.
function raiseVoucherQuery(voucherId, queryType, queryDetails, targetLineIndexesJson, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };

    var role = session.role;
    if (APPROVAL_SEQUENCE.indexOf(role) === -1) {
      return { success: false, error: 'You do not have permission to raise queries.' };
    }
    if (!queryDetails || !queryDetails.trim()) return { success: false, error: 'Query details are required.' };

    var category = QUERY_CATEGORIES[queryType];
    if (!category) return { success: false, error: 'Unrecognized query category: ' + queryType };

    var found = findVoucherRow_(voucherId);
    if (!found) return { success: false, error: 'Voucher not found: ' + voucherId };
    var isTransport = safe_(found.rowValues[AV.EXPENSE_TYPE]) === 'Transport';

    // No Transport/Regular gate needed for 'Ledger / Vendor' — it's valid
    // for both voucher types (Ledger field on Regular, Vendor identity on
    // Transport), unlike the old Transport-only 'Wrong Vendor' category
    // this replaced.

    var targetLineIndexes = [];
    if (targetLineIndexesJson) {
      try { targetLineIndexes = JSON.parse(targetLineIndexesJson) || []; } catch (e) { targetLineIndexes = []; }
    }
    if (category.requiresLineTarget && isTransport && targetLineIndexes.length === 0) {
      return { success: false, error: 'Select at least one vendor line this query applies to.' };
    }

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      Logger.log('raiseVoucherQuery lock timeout: ' + lockErr);
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      // Re-fetch inside the lock — found/isTransport above were read
      // before acquiring it, same defensive re-check pattern used
      // elsewhere in this file.
      found = findVoucherRow_(voucherId);
      if (!found) return { success: false, error: 'Voucher not found: ' + voucherId };

      // Edit lock (Day N) — same protection as updateVoucherStatus: a
      // query being raised while submission has this voucher open for
      // edit is the same class of race as reject-vs-resubmit.
      var lockConflict = checkVoucherNotLockedForActor_(found, session.displayName || role);
      if (lockConflict) return { success: false, error: lockConflict };

      // ADDED (Day 7): a voucher can only have ONE open query at a time.
      // Without this, a second raiseVoucherQuery call while one is
      // already open would overwrite AV.QUERY_STATUS with the new
      // query's label and orphan the FIRST Query Thread row forever at
      // STATUS='Open' — findOpenQueryRow/respondToQuery only ever act on
      // the most recently-raised Open row (see findOpenQueryRow's own
      // comment above), so anything raised before it becomes permanently
      // unresolvable and invisible in the normal UI, a silent gap in the
      // audit trail.
      var existingQueryStatus = safe_(found.rowValues[AV.QUERY_STATUS]);
      if (existingQueryStatus && existingQueryStatus !== 'No Query') {
        return { success: false, error: 'This voucher already has an open query (' + existingQueryStatus + '). Wait for it to be resolved before raising another.' };
      }

      // DATE FORMAT FIX (per explicit instruction) — QT.RAISED_DATE's
      // header is literally "Raised Date"; a full date+time string there
      // read as a mismatch against every other date column in the app
      // (all of which use formatDate's dd-MM-yyyy). Query Thread carries
      // no other timestamp, so nothing here needs time-of-day.
      var now = formatDate_(new Date());
      var qid = 'Q-' + Date.now();

      // Stamp targeted Transport Breakdown lines with this query's ID
      // BEFORE creating the Query Thread row, so a failure here (missing
      // sheet, bad index) is caught before the query is considered raised.
      if (targetLineIndexes.length > 0) {
        var tbSheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
        if (!tbSheet) return { success: false, error: 'Transport Breakdown sheet not found.' };
        var tbData = tbSheet.getDataRange().getValues();
        var matchingTbRows = [];
        for (var i = 1; i < tbData.length; i++) {
          if (safe_(tbData[i][TB.VOUCHER_ID]) === voucherId) matchingTbRows.push(i + 1);
        }
        for (var t = 0; t < targetLineIndexes.length; t++) {
          var idx = targetLineIndexes[t];
          if (typeof idx !== 'number' || idx < 0 || idx >= matchingTbRows.length) {
            return { success: false, error: 'Invalid vendor line selected.' };
          }
        }
        targetLineIndexes.forEach(function (idx) {
          tbSheet.getRange(matchingTbRows[idx], TB.QUERY_STATUS + 1).setValue(qid);
        });
      }

      var qtSheet = getSheet_(QUERY_THREAD_SHEET);
      if (qtSheet) {
        try {
          var qtRow = new Array(10).fill(''); // matches the real 10-column Query Thread sheet
          qtRow[QT.QUERY_ID]      = qid;
          qtRow[QT.VOUCHER_ID]    = voucherId;
          qtRow[QT.QUERY_TYPE]    = queryType;
          qtRow[QT.RAISED_BY]     = role;
          qtRow[QT.RAISED_DATE]   = now;
          qtRow[QT.QUERY_DETAILS] = queryDetails;
          qtRow[QT.STATUS]        = 'Open';
          qtSheet.appendRow(qtRow);
        } catch (qtErr) {
          Logger.log('Failed to create query record: ' + qtErr);
        }
      }

      found.sheet.getRange(found.rowIndex, AV.QUERY_STATUS + 1).setValue('Query Raised \u2014 ' + queryType);

      logAction_('QUERY', voucherId, session.displayName || role, role,
        queryType + ': ' + queryDetails.substring(0, 80) + (targetLineIndexes.length ? ' (line(s): ' + targetLineIndexes.join(',') + ')' : ''));

      // Drive folder status suffix (per explicit instruction) — best
      // effort, never blocks the query itself.
      setVoucherDriveFolderStatusSuffix_(safe_(found.rowValues[AV.BATCH_ID]), voucherId, 'Query');

      return { success: true, message: 'Query raised. ID: ' + qid };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('raiseVoucherQuery error: ' + err);
    return { success: false, error: 'Failed to raise query: ' + err.toString() };
  }
}

// Finds the most-recent OPEN Query Thread row for voucherId — i.e. the
// last matching row (in sheet order) with QT.STATUS === 'Open'. Query Thread
// rows have no ID surfaced to the client anywhere today, so "most recent
// open, by sheet order" is the only selection strategy available without
// adding a separate endpoint just to hand out query IDs; it's also the
// correct choice in practice, since raiseVoucherQuery doesn't check for an
// existing open query before creating a new one (AV.QUERY_STATUS only ever
// reflects the latest raise), so the last Open row IS the current one.
// Internal helper — not itself an RPC, shared by getOpenQueryForVoucher
// (read) and respondToQuery (write) below so both pick the exact same row.
function findOpenQueryRow_(voucherId) {
  var sheet = getSheet_(QUERY_THREAD_SHEET);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  var found = null;
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][QT.VOUCHER_ID]) === voucherId && safe_(data[i][QT.STATUS]) === 'Open') {
      found = { sheet: sheet, rowIndex: i + 1, rowValues: data[i] };
    }
  }
  return found;
}

// Clears TB.QUERY_STATUS on every Transport Breakdown row for voucherId
// currently stamped with qid — called whenever a query is resolved,
// regardless of which of the three resolution paths (plain respondToQuery,
// full edit+respond, or scoped edit+respond) actually handled it, so a
// resolved query never leaves a vendor line looking permanently locked.
function clearQueryLineStamps_(voucherId, qid) {
  if (!qid) return;
  var tbSheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
  if (!tbSheet) return;
  var data = tbSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][TB.VOUCHER_ID]) === voucherId && safe_(data[i][TB.QUERY_STATUS]) === qid) {
      tbSheet.getRange(i + 1, TB.QUERY_STATUS + 1).setValue('');
    }
  }
}

// Read counterpart for the submission-side "respond to query" screen (Day
// 3) — without this, a submitter would be asked to respond to a query
// without ever seeing what was actually asked (AV.QUERY_STATUS on the
// voucher list is only a short type label like "Query Raised — Missing
// Bills", not the free-text details). Not named in the original brief, but
// added because respondToQuery is otherwise unusable in practice.
function getOpenQueryForVoucher(voucherId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };

    var found = findOpenQueryRow_(voucherId);
    if (!found) return { success: false, error: 'No open query found for this voucher.' };

    var queryType = safe_(found.rowValues[QT.QUERY_TYPE]);
    var qid       = safe_(found.rowValues[QT.QUERY_ID]);
    var category  = QUERY_CATEGORIES[queryType] || { fieldScope: 'full', requiresLineTarget: false };

    // Any Transport Breakdown line currently stamped with this query's ID
    // is a targeted line — surface it with vendor name/amount so the
    // submission-side edit form can label exactly which line is unlocked.
    var targetLines = [];
    if (qid) {
      var tbSheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
      if (tbSheet) {
        var tbData = tbSheet.getDataRange().getValues();
        var lineIndex = 0;
        for (var i = 1; i < tbData.length; i++) {
          if (safe_(tbData[i][TB.VOUCHER_ID]) !== voucherId) continue;
          if (safe_(tbData[i][TB.QUERY_STATUS]) === qid) {
            targetLines.push({ lineIndex: lineIndex, vendorName: safe_(tbData[i][TB.VENDOR_NAME]), amount: parseFloat(tbData[i][TB.AMOUNT]) || 0 });
          }
          lineIndex++;
        }
      }
    }

    return {
      success: true,
      queryId:       qid,
      queryType:     queryType,
      queryDetails:  safe_(found.rowValues[QT.QUERY_DETAILS]),
      raisedBy:      safe_(found.rowValues[QT.RAISED_BY]),
      raisedDate:    safe_(found.rowValues[QT.RAISED_DATE]),
      fieldScope:    category.fieldScope,
      targetLines:   targetLines
    };
  } catch (err) {
    Logger.log('getOpenQueryForVoucher error: ' + err);
    return { success: false, error: 'Failed to load query: ' + err.toString() };
  }
}

// Read-only, most-recent Query Thread entry for a voucher REGARDLESS of
// open/resolved status (bugfix round, #7) — getOpenQueryForVoucher above
// only ever returns something for a currently-open query, by design (it
// backs the submission-side response FORM). This is for the voucher
// detail modal instead, which needs to show a resolved query's details
// AND response too, not just hide the whole thing once it's answered.
// Available to any authenticated role (all dashboards' "View" opens the
// same detail modal) — read-only, no permission narrowing needed beyond
// a valid session, same as getAllVouchers itself.
function getLatestQueryThreadForVoucher(voucherId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };

    var sheet = getSheet_(QUERY_THREAD_SHEET);
    if (!sheet) return { success: true, query: null };
    var data = sheet.getDataRange().getValues();
    var latest = null;
    for (var i = 1; i < data.length; i++) {
      if (safe_(data[i][QT.VOUCHER_ID]) === voucherId) latest = data[i]; // last match wins \u2014 sheet order is chronological
    }
    if (!latest) return { success: true, query: null };

    return {
      success: true,
      query: {
        queryType:    safe_(latest[QT.QUERY_TYPE]),
        raisedBy:     safe_(latest[QT.RAISED_BY]),
        raisedDate:   safe_(latest[QT.RAISED_DATE]),
        queryDetails: safe_(latest[QT.QUERY_DETAILS]),
        response:     safe_(latest[QT.RESPONSE]),
        responseDate: safe_(latest[QT.RESPONSE_DATE]),
        status:       safe_(latest[QT.STATUS])
      }
    };
  } catch (err) {
    Logger.log('getLatestQueryThreadForVoucher error: ' + err);
    return { success: false, error: 'Failed to load query thread: ' + err.toString() };
  }
}

// Submission responds to an open query. Per raiseVoucherQuery's own
// comments, this does NOT touch AV.STATUS at all — a queried voucher stays
// wherever it already is in the approval chain; only AV.QUERY_STATUS
// resets to 'No Query' so the approver dashboards stop showing a query
// badge, and the raising approver can see the response was given.
// Submission responds to an open query, optionally attaching new bill
// files in the same response (uploaded into the SAME batchId/voucherId
// Drive folder as the voucher's original bills, then appended to
// AV.BILL_FILES) — added because a query like "Missing Bills" is often
// only actually resolvable by attaching the missing bill, not just typing
// a text explanation. Per raiseVoucherQuery's own comments, this does NOT
// touch AV.STATUS at all — a queried voucher stays wherever it already is
// in the approval chain; only AV.QUERY_STATUS resets to 'No Query'.
function respondToQuery(voucherId, response, filesJson, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'submission') return { success: false, error: 'You do not have permission to respond to queries.' };
    if (!response || !response.trim()) return { success: false, error: 'A response is required.' };

    var files = [];
    if (filesJson) {
      try { files = JSON.parse(filesJson) || []; } catch (e) { files = []; }
    }
    var fileBatchError = validateFileUploadBatch_(files);
    if (fileBatchError) return { success: false, error: fileBatchError };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var queryRow = findOpenQueryRow_(voucherId);
      if (!queryRow) return { success: false, error: 'No open query found for this voucher.' };

      var found = findVoucherRow_(voucherId);
      if (!found) return { success: false, error: 'Voucher not found: ' + voucherId };

      var existingBillFilesRaw = safe_(found.rowValues[AV.BILL_FILES]);
      var existingBillFiles = existingBillFilesRaw ? existingBillFilesRaw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : [];
      if (existingBillFiles.length + files.length > MAX_FILES_PER_UPLOAD) {
        return { success: false, error: 'Maximum ' + MAX_FILES_PER_UPLOAD + ' files allowed on one voucher \u2014 too many combined with what\u2019s already attached.' };
      }

      var newFileUrls = [];
      var failedFiles = [];
      if (files.length > 0) {
        var batchId = safe_(found.rowValues[AV.BATCH_ID]) || 'unbatched';
        var root          = DriveApp.getRootFolder();
        var expFolder     = getOrCreateDriveFolder_(root, 'Rabale Expense System');
        var batchFolder   = getOrCreateDriveFolder_(expFolder, batchId);
        var voucherFolder = getOrCreateDriveFolder_(batchFolder, voucherId);
        for (var j = 0; j < files.length; j++) {
          try {
            var f       = files[j];
            var made    = billBlobFromClientFile_(f);
            if (made.error) throw new Error(made.error);   // handled below like any failed file: reported, never stored
            var created = voucherFolder.createFile(made.blob);
            created.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
            newFileUrls.push(created.getUrl());
          } catch (fileErr) {
            Logger.log('Failed to upload file "' + (files[j].name || 'unknown') + '": ' + fileErr);
            failedFiles.push(files[j].name || 'unknown');
          }
        }
        if (newFileUrls.length > 0) {
          var mergedFiles = existingBillFiles.concat(newFileUrls);
          found.sheet.getRange(found.rowIndex, AV.BILL_FILES + 1).setValue(mergedFiles.join('\n'));
        }
      }

      // DATE FORMAT FIX (per explicit instruction) — see the identical
      // note on raiseVoucherQuery's RAISED_DATE above.
      var now = formatDate_(new Date());
      queryRow.sheet.getRange(queryRow.rowIndex, QT.RESPONSE + 1).setValue(response.trim());
      queryRow.sheet.getRange(queryRow.rowIndex, QT.RESPONSE_DATE + 1).setValue(now);
      queryRow.sheet.getRange(queryRow.rowIndex, QT.STATUS + 1).setValue('Resolved');
      clearQueryLineStamps_(voucherId, safe_(queryRow.rowValues[QT.QUERY_ID]));

      found.sheet.getRange(found.rowIndex, AV.QUERY_STATUS + 1).setValue('No Query');

      logAction_('QUERY_RESPONSE', voucherId, session.displayName || session.role, session.role,
        response.trim().substring(0, 80) + (newFileUrls.length ? ' (' + newFileUrls.length + ' file(s) attached)' : ''));
      return {
        success: true,
        message: 'Response sent for ' + voucherId + '.' + (newFileUrls.length ? ' ' + newFileUrls.length + ' file(s) attached.' : ''),
        newFileCount: newFileUrls.length,
        failedCount: failedFiles.length,
        failedFiles: failedFiles
      };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('respondToQuery error: ' + err);
    return { success: false, error: 'Failed to respond to query: ' + err.toString() };
  }
}

// ============================================================================
// ADMIN OVERRIDES ("god mode") — deliberately separate from the ordinary
// approve/reject/query flow above, deliberately logged under their own
// action names, and deliberately require a typed reason every time. The
// point of restricting these to admin isn't that admin is more trusted —
// it's that every use of an override is trivially findable later in Audit
// Log by filtering for ADMIN_*, without digging through routine approval
// traffic. None of this is capability the spreadsheet doesn't already
// have (anyone with Editor access could hand-type a status) — what this
// adds is a mandatory reason and a guaranteed-consistent set of columns,
// so a revert can never leave a stale "Approved By L2" sitting next to a
// status that says Pending L1 again.
// ============================================================================

// Moves a voucher CLEANLY to Pending<targetStage> — sets AV.STATUS, clears
// that stage's approver column and every stage after it in
// APPROVAL_SEQUENCE, and clears any stale AV.REJECTED_AT_STAGE value. This
// is the single "voucher is now sitting cleanly at stage X" operation,
// shared by adminRevertVoucher (Day 1, below) and resubmitVoucher (Day 3,
// Vouchers.gs) rather than each maintaining its own copy of the
// column-clearing logic.
//
// For adminRevertVoucher the clearing is a real, necessary effect — admin
// can revert to an EARLIER stage than a voucher currently sits at, which
// means a later stage's approver column genuinely does need wiping so a
// re-approval starts clean.
//
// For resubmitVoucher specifically, this clearing is provably a no-op in
// every reachable case: rejecting a voucher never sets that stage's own
// approver column (see updateVoucherStatus's reject branch), and nothing
// AFTER a rejecting stage ever got the chance to approve either — so
// there's nothing stale left at or after the stage a resubmission routes
// back to. It's still routed through this same shared helper rather than
// skipped, so both callers guarantee the exact same invariant instead of
// two independently-maintained copies of it that could drift apart later.
// The REJECTED_AT_STAGE clear IS a real effect for both callers, though —
// a voucher freshly placed at a pending stage should never keep showing a
// stale "rejected at" value from a previous cycle.
//
// Returns the new status string, or null if targetStage isn't a valid
// stage (caller should have already validated this before calling).
function moveVoucherToStage_(found, targetStage) {
  var targetIdx = APPROVAL_SEQUENCE.indexOf(targetStage);
  if (targetIdx === -1) return null;
  var newStatus = getPendingStatusForRole_(targetStage);
  found.sheet.getRange(found.rowIndex, AV.STATUS + 1).setValue(newStatus);
  for (var i = targetIdx; i < APPROVAL_SEQUENCE.length; i++) {
    var col = APPROVER_COLUMN_FOR_ROLE[APPROVAL_SEQUENCE[i]];
    found.sheet.getRange(found.rowIndex, col + 1).setValue('');
  }
  found.sheet.getRange(found.rowIndex, AV.REJECTED_AT_STAGE + 1).setValue('');
  return newStatus;
}

// Moves a voucher to Pending<targetStage>, regardless of its current status
// (Pending-anything, Approved, or Rejected all allowed) — this single
// function covers both "L1 approved by mistake, send it back" and
// "un-reject this", since both are really the same operation: put it back
// at a specific stage.
function adminRevertVoucher(voucherId, targetStage, reason, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };

    var targetIdx = APPROVAL_SEQUENCE.indexOf(targetStage);
    if (targetIdx === -1) return { success: false, error: 'Invalid target stage.' };
    if (!reason || !reason.trim()) return { success: false, error: 'A reason is required.' };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var found = findVoucherRow_(voucherId);
      if (!found) return { success: false, error: 'Voucher not found: ' + voucherId };

      var previousStatus = safe_(found.rowValues[AV.STATUS]);
      var newStatus = moveVoucherToStage_(found, targetStage);

      // BUG FIX (ledger balance): this function can "un-reject" a voucher
      // (Rejected -> Pending<stage>) entirely independently of the normal
      // resubmit flow — moveVoucherToStage only touches status columns,
      // it never rewrites Transport Breakdown or touches either ledger.
      // But updateVoucherStatus's reject branch (this file) already
      // reversed this voucher's vendor lines out of both ledgers at the
      // moment it was rejected. Un-rejecting it here puts it back in the
      // live approval pipeline without restoring that contribution unless
      // it's re-applied here — the exact inverse of the reject-time
      // reversal, using the voucher's still-intact Transport Breakdown
      // rows (never cleared on reject) as the source of what to re-add.
      if (previousStatus === 'Rejected') {
        var isTransportForRevert = safe_(found.rowValues[AV.EXPENSE_TYPE]) === 'Transport';
        if (isTransportForRevert) {
          var vendorLinesForRevert = getVendorLineItemsInternal_(voucherId);
          if (vendorLinesForRevert && vendorLinesForRevert.length > 0) {
            var revertVendorSummary = summarizeVendorLines_(vendorLinesForRevert);
            applyVendorLedgerBalanceDelta_({}, revertVendorSummary);
            applyVendorFyLedgerBalanceDelta_({}, revertVendorSummary, getFyKeyForDateValue_(safe_(found.rowValues[AV.DATE])));
          }
        }
      }

      logAction_('ADMIN_REVERT', voucherId, session.displayName || session.role, session.role,
        'From "' + previousStatus + '" to "' + newStatus + '" \u2014 ' + reason.trim());

      // Drive folder status suffix (per explicit instruction) — the
      // voucher is back in the live approval pipeline, so any
      // Approved/Rejected/Query suffix from before this revert no longer
      // applies. Best effort, never blocks the revert itself.
      setVoucherDriveFolderStatusSuffix_(safe_(found.rowValues[AV.BATCH_ID]), voucherId, '');

      return { success: true, message: 'Voucher ' + voucherId + ' reverted to ' + newStatus + '.' };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('adminRevertVoucher error: ' + err);
    return { success: false, error: 'Failed to revert voucher: ' + err.toString() };
  }
}

// Admin-only: changes a voucher's ID after the fact. Deliberately NOT
// reachable from submission's edit flow — resubmitVoucher never reads or
// writes AV.VOUCHER_ID, by design (per explicit instruction, the ID is
// immutable there). Changing it has consequences across multiple sheets
// (Transport Breakdown, Rabale Daily Sync, Query Thread) plus the Drive
// folder structure, so this requires admin and a mandatory typed reason,
// same pattern as adminRevertVoucher.
//
// Blocked entirely once the voucher has been Tally-exported
// (AV.TALLY_EXPORTED === 'Yes') — the exported Tally sheet rows and TDS
// narration text already have the OLD ID baked in as plain text, with no
// realistic way to retroactively fix a .xlsx a human may have already
// downloaded or imported. Renaming after export would silently desync the
// real accounting record from what All Vouchers shows from then on.
function adminChangeVoucherId(oldVoucherId, newVoucherId, reason, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin') return { success: false, error: 'You do not have permission to change voucher IDs.' };
    if (!reason || !reason.trim()) return { success: false, error: 'A reason is required.' };

    var newIdValidation = validateVoucherId_(newVoucherId);
    if (!newIdValidation.valid) return { success: false, error: newIdValidation.error };
    newVoucherId = newIdValidation.id;

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var found = findVoucherRow_(oldVoucherId);
      if (!found) return { success: false, error: 'Voucher not found: ' + oldVoucherId };
      if (oldVoucherId === newVoucherId) return { success: false, error: 'New voucher ID is the same as the current one.' };
      if (findVoucherRow_(newVoucherId)) return { success: false, error: 'Voucher number ' + newVoucherId + ' already exists.' };
      if (safe_(found.rowValues[AV.TALLY_EXPORTED]) === 'Yes') {
        return { success: false, error: 'This voucher has already been exported to Tally \u2014 its ID can no longer be changed (the exported file already references the old number).' };
      }

      found.sheet.getRange(found.rowIndex, AV.VOUCHER_ID + 1).setValue(newVoucherId);

      // Keep Transport Breakdown line items linked to the renamed voucher.
      var tbSheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
      if (tbSheet) {
        var tbData = tbSheet.getDataRange().getValues();
        for (var i = 1; i < tbData.length; i++) {
          if (safe_(tbData[i][TB.VOUCHER_ID]) === oldVoucherId) {
            tbSheet.getRange(i + 1, TB.VOUCHER_ID + 1).setValue(newVoucherId);
          }
        }
      }

      // Keep the Rabale Daily Sync row linked too. RDS now lives in its
      // own spreadsheet, split by month — resolve the right tab from this
      // voucher's own date (dates are locked on every edit path, so the
      // voucher's month tab can't have moved since it was written).
      try {
        var rdsSs = SpreadsheetApp.openById(getRdsSpreadsheetId_());
        var rdsSheet = rdsSs.getSheetByName(getRdsMonthSheetName_(parseRdsDateString_(safe_(found.rowValues[AV.DATE]))));
        if (rdsSheet) {
          var rdsRow = findRabaleDailySyncRow_(rdsSheet, oldVoucherId);
          if (rdsRow) rdsRow.sheet.getRange(rdsRow.rowIndex, RS.VOUCHER_NO + 1).setValue(newVoucherId);
        }
      } catch (rdsErr) {
        Logger.log('Voucher rename: could not update Rabale Daily Sync row: ' + rdsErr);
        logAction_('SYNC_WARNING', newVoucherId, 'system', 'system', 'Rename did not propagate to Rabale Daily Sync: ' + rdsErr);
      }

      // Keep Query Thread history linked.
      var qtSheet = getSheet_(QUERY_THREAD_SHEET);
      if (qtSheet) {
        var qtData = qtSheet.getDataRange().getValues();
        for (var j = 1; j < qtData.length; j++) {
          if (safe_(qtData[j][QT.VOUCHER_ID]) === oldVoucherId) {
            qtSheet.getRange(j + 1, QT.VOUCHER_ID + 1).setValue(newVoucherId);
          }
        }
      }

      // Best-effort: rename the Drive folder too, so it stays
      // human-readable and matching. Bill links themselves are direct
      // file URLs (not folder-path-dependent), so they keep working
      // regardless of whether this step succeeds — logged, not blocking.
      try {
        var batchId = safe_(found.rowValues[AV.BATCH_ID]);
        if (batchId) {
          var root = DriveApp.getRootFolder();
          var expIt = root.getFoldersByName('Rabale Expense System');
          if (expIt.hasNext()) {
            var expFolder = expIt.next();
            var batchIt = expFolder.getFoldersByName(batchId);
            if (batchIt.hasNext()) {
              var batchFolder = batchIt.next();
              var voucherIt = batchFolder.getFoldersByName(oldVoucherId);
              if (voucherIt.hasNext()) voucherIt.next().setName(newVoucherId);
            }
          }
        }
      } catch (folderErr) {
        Logger.log('adminChangeVoucherId: Drive folder rename failed (non-critical): ' + folderErr);
      }

      logAction_('ADMIN_CHANGE_VOUCHER_ID', newVoucherId, session.displayName || session.role, session.role,
        'Renamed from ' + oldVoucherId + ' to ' + newVoucherId + ' \u2014 ' + reason.trim());

      return { success: true, message: 'Voucher ' + oldVoucherId + ' renamed to ' + newVoucherId + '.' };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('adminChangeVoucherId error: ' + err);
    return { success: false, error: 'Failed to change voucher ID: ' + err.toString() };
  }
}

// ============================================================================
// ADMIN — COMPLETE VOUCHER DELETION (per explicit instruction) — removes a
// voucher entirely from the system: the All Vouchers row, its Transport
// Breakdown lines, and its Query Thread history. This is irreversible by
// design (unlike adminRevertVoucher, which only moves a stage backward) —
// the full original row is captured into the Audit Log before anything is
// deleted, so "irreversible in the sheet" still leaves a complete manual
// recovery trail for whoever reads the log.
//
// Two-step confirmation for an already-Tally-exported voucher: the first
// call without confirmExportOverride=true is REFUSED with
// requiresExportOverrideConfirm:true if AV.TALLY_EXPORTED is 'Yes' —
// deleting a voucher that's already in an accounting export creates a
// reconciliation gap, so this can't be a single accidental click. Once
// confirmed, the matching row(s) in that month's Tally Export sheet are
// highlighted (not deleted — that sheet is the accounting record) and the
// deletion is logged with enough detail to reconstruct what happened.
//
// Drive bill files are RENAMED with a " (Deleted)" suffix, never actually
// removed from Drive — per explicit instruction, source documents backing
// a financial record stay retrievable even after the voucher record
// itself is gone, which is exactly what an auditor would expect.
// ============================================================================
function adminDeleteVoucherCompletely(voucherId, reason, confirmExportOverride, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };
    if (!reason || !reason.trim()) return { success: false, error: 'A reason is required.' };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var found = findVoucherRow_(voucherId);
      if (!found) return { success: false, error: 'Voucher not found: ' + voucherId };

      var wasExported = safe_(found.rowValues[AV.TALLY_EXPORTED]) === 'Yes';
      if (wasExported && confirmExportOverride !== true) {
        return {
          success: false,
          requiresExportOverrideConfirm: true,
          error: 'Voucher ' + voucherId + ' has already been Tally-exported. Deleting it now will leave a gap between the accounting export and All Vouchers \u2014 the export row will be flagged, but nothing there auto-corrects. Confirm again to proceed anyway.'
        };
      }

      // Snapshot EVERYTHING before touching a single sheet — this is what
      // the Audit Log entry is built from, since after deletion none of
      // this is queryable from the sheets themselves anymore.
      var isTransport = safe_(found.rowValues[AV.EXPENSE_TYPE]) === 'Transport';
      var vendorLines = isTransport ? getVendorLineItemsInternal_(voucherId) : [];
      var snapshot = {
        voucherId: voucherId,
        date: safe_(found.rowValues[AV.DATE]),
        actualExpenseDate: safe_(found.rowValues[AV.ACTUAL_EXPENSE_DATE]),
        expenseType: safe_(found.rowValues[AV.EXPENSE_TYPE]),
        submittedBy: safe_(found.rowValues[AV.SUBMITTED_BY]),
        vehicleNo: safe_(found.rowValues[AV.VEHICLE_NO]),
        costCentre: safe_(found.rowValues[AV.COST_CENTRE]),
        amount: parseFloat(found.rowValues[AV.AMOUNT]) || 0,
        status: safe_(found.rowValues[AV.STATUS]),
        batchId: safe_(found.rowValues[AV.BATCH_ID]),
        approvedByL1: safe_(found.rowValues[AV.APPROVED_BY_L1]),
        approvedByAccounts: safe_(found.rowValues[AV.APPROVED_BY_ACCOUNTS]),
        approvedByL2: safe_(found.rowValues[AV.APPROVED_BY_L2]),
        queryStatus: safe_(found.rowValues[AV.QUERY_STATUS]),
        tallyExported: safe_(found.rowValues[AV.TALLY_EXPORTED]),
        billFiles: safe_(found.rowValues[AV.BILL_FILES]),
        notes: safe_(found.rowValues[AV.NOTES]),
        submittedByOperator: safe_(found.rowValues[AV.SUBMITTED_BY_OPERATOR]),
        cashReleased: safe_(found.rowValues[AV.CASH_RELEASED]),
        cashReleasedVoucherNo: safe_(found.rowValues[AV.CASH_RELEASED_VOUCHER_NO]),
        vendorLines: vendorLines.map(function (v) {
          return { vendorName: v.vendorName, amount: v.amount, tdsApplicable: v.tdsApplicable, tdsAmount: v.tdsAmount, cgst: v.cgst, sgst: v.sgst };
        })
      };

      // Rename Drive bill files (never delete them) — the voucher folder
      // is Rabale Expense System / <batchId> / <voucherId> / <files>, the
      // same structure adminChangeVoucherId already navigates. Looked up
      // via findVoucherDriveFolder (not a plain getFoldersByName(voucherId))
      // since the folder may already carry an Approved/Rejected/Query
      // suffix from earlier in its lifecycle.
      var renamedFileCount = 0;
      var voucherFolderForDelete = null;
      try {
        var batchId = snapshot.batchId;
        if (batchId) {
          voucherFolderForDelete = findVoucherDriveFolder_(batchId, voucherId);
          if (voucherFolderForDelete) {
            var files = voucherFolderForDelete.getFiles();
            while (files.hasNext()) {
              var f = files.next();
              if (f.getName().indexOf('(Deleted)') === -1) {
                f.setName(f.getName() + ' (Deleted)');
                renamedFileCount++;
              }
            }
          }
        }
      } catch (driveErr) {
        Logger.log('adminDeleteVoucherCompletely: Drive rename failed (non-critical): ' + driveErr);
      }

      // Drive folder status suffix (per explicit instruction) — best
      // effort, never blocks the deletion itself. Always overwrites any
      // prior suffix (Approved/Rejected/Query): deletion is terminal and
      // irreversible by design, so it's the one status that should win
      // regardless of what the voucher's folder said before.
      if (snapshot.batchId) {
        setVoucherDriveFolderStatusSuffix_(snapshot.batchId, voucherId, 'Deleted');
      }

      // Highlight the matching row(s) in the Tally Export sheet, if any.
      var highlightedExportRows = 0;
      if (wasExported) {
        highlightedExportRows = highlightDeletedVoucherInTallyExportSheet_(voucherId, snapshot.date);
      }

      // Delete Transport Breakdown lines, then the All Vouchers row
      // itself. Query Thread rows are left in place deliberately — they
      // reference the voucher ID as plain text, not a live foreign key,
      // and deleting query history would remove exactly the kind of
      // detail an auditor reading the log later would want.
      clearTransportBreakdownRows_(voucherId);
      found.sheet.deleteRow(found.rowIndex);

      // Ledger Balance (Master Data column I, legacy) AND the Vendor FY
      // Ledger — a deleted voucher's bills never actually happened as far
      // as the vendor's running total is concerned, so reverse every
      // vendor line this voucher contributed, using the snapshot taken
      // before deletion above.
      if (isTransport && vendorLines.length > 0) {
        var deletedVendorSummary = summarizeVendorLines_(vendorLines);
        applyVendorLedgerBalanceDelta_(deletedVendorSummary, {});
        applyVendorFyLedgerBalanceDelta_(deletedVendorSummary, {}, getFyKeyForDateValue_(snapshot.date));
      }

      logAction_('ADMIN_DELETE_VOUCHER', voucherId, session.displayName || session.role, session.role,
        reason.trim() + (wasExported ? ' \u2014 WAS ALREADY TALLY-EXPORTED (export sheet flagged, ' + highlightedExportRows + ' row(s))' : '') +
        (renamedFileCount > 0 ? '; ' + renamedFileCount + ' Drive file(s) renamed with (Deleted) suffix' : '') +
        '; full record: ' + JSON.stringify(snapshot));

      return {
        success: true,
        message: 'Voucher ' + voucherId + ' permanently deleted.' + (wasExported ? ' It was already Tally-exported \u2014 the export sheet row has been flagged.' : ''),
        wasExported: wasExported
      };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('adminDeleteVoucherCompletely error: ' + err);
    return { success: false, error: 'Failed to delete voucher: ' + err.toString() };
  }
}


// ============================================================================
// GST ENTRY (Day 1) — Accounts fills in CGST/SGST per vendor line item on a
// transport voucher, at approval time rather than at submission, since
// Accounts is the one with the bill in hand. Deliberately not gated to a
// specific voucher status — GST can be entered/corrected any time before
// Tally export, so it doesn't block the approval workflow.
// ============================================================================

// Returns true only if every Transport Breakdown line item for voucherId
// has GST_REVIEWED = 'Yes' AND, for any line where GST is actually applied
// (cgst>0 or sgst>0), a non-blank LR number. A voucher with no matching
// rows returns true (vacuous — shouldn't happen for a real transport
// voucher, and blocking approval on a data-integrity gap here would just
// be confusing; that kind of gap is a Transport Breakdown write failure, a
// different problem).
function isVoucherGstFullyReviewed_(voucherId) {
  var sheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
  if (!sheet) return true;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][TB.VOUCHER_ID]) !== voucherId) continue;
    if (safe_(data[i][TB.GST_REVIEWED]) !== 'Yes') return false;
    var cgst = parseFloat(data[i][TB.CGST]) || 0;
    var sgst = parseFloat(data[i][TB.SGST]) || 0;
    if ((cgst > 0 || sgst > 0) && !safe_(data[i][TB.LR_NO])) return false;
  }
  return true;
}

// Returns every Transport Breakdown row for voucherId, in sheet order, with
// a 0-based lineIndex. lineIndex (not vendor name) is what the client sends
// back on save, because submission doesn't dedupe vendor names within a
// voucher — the same vendor can legitimately appear twice, and name alone
// wouldn't be a safe way to identify which row to update.
function getVendorLineItems(voucherId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (APPROVAL_SEQUENCE.indexOf(session.role) === -1 && session.role !== 'admin' && session.role !== 'auditor') {
      return { success: false, error: 'You do not have permission to view vendor line items.' };
    }

    var items = getVendorLineItemsInternal_(voucherId);
    if (items.length === 0) return { success: false, error: 'No vendor line items found for ' + voucherId + '.' };
    return { success: true, items: items };
  } catch (err) {
    Logger.log('getVendorLineItems error: ' + err);
    return { success: false, error: 'Failed to load vendor line items: ' + err.toString() };
  }
}

// Plain read, no session/permission check — for server-side internal use
// only (e.g. resubmitVoucherForQueryScope in Vouchers.gs, called by the
// 'submission' role, which the public RPC above deliberately does NOT
// allow). Never expose this directly as an RPC.
function getVendorLineItemsInternal_(voucherId) {
  var sheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var items = [];
  var lineIndex = 0;
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][TB.VOUCHER_ID]) !== voucherId) continue;
    items.push({
      lineIndex:     lineIndex++,
      vendorName:    safe_(data[i][TB.VENDOR_NAME]),
      amount:        parseFloat(data[i][TB.AMOUNT]) || 0,
      tdsApplicable: safe_(data[i][TB.TDS_APPLICABLE]) === 'Yes',
      tdsRate:       parseFloat(data[i][TB.TDS_RATE]) || 0,
      tdsAmount:     parseFloat(data[i][TB.TDS_AMOUNT]) || 0,
      cgst:          parseFloat(data[i][TB.CGST]) || 0,
      sgst:          parseFloat(data[i][TB.SGST]) || 0,
      hamali:        parseFloat(data[i][TB.HAMALI]) || 0,
      gstReviewed:   safe_(data[i][TB.GST_REVIEWED]) === 'Yes',
      lrNo:          safe_(data[i][TB.LR_NO]),
      returnParcel:  safe_(data[i][TB.RETURN_PARCEL]) === 'Yes'
    });
  }
  return items;
}

// Saves CGST/SGST/Hamali/LR No for one or more vendor line items on a
// transport voucher in a single locked pass. lineItemsJson is
// [{lineIndex, cgst, sgst, hamali, lrNo}, ...] — lineIndex matches what
// getVendorLineItems returned (NOT a raw sheet row number, NOT vendor
// name). Sets GST_REVIEWED='Yes' on every row touched, even if both GST
// values are entered as 0 — that's what distinguishes "Accounts confirmed
// no GST" from "nobody has looked at this yet."
//
// LR number is REQUIRED whenever cgst+sgst > 0 for that line (a GST-shown
// bill must have an LR number before it can be saved as reviewed) — blank
// LR is only acceptable when GST is 0/0.
//
// IMPORTANT: CGST/SGST are components OF the vendor's bill amount, not
// additions on top of it. cgst+sgst can therefore never exceed the line's
// amount; this and the LR requirement are validated for every line before
// ANY row is written (validate-all-then-write-all, so a bad line in a
// batch can't leave some rows updated and others not).
function updateVendorLineItemGst(voucherId, lineItemsJson, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'accounts') return { success: false, error: 'You do not have permission to enter GST.' };

    var lineItems;
    try { lineItems = JSON.parse(lineItemsJson); } catch (e) { return { success: false, error: 'Invalid GST data.' }; }
    if (!lineItems || lineItems.length === 0) return { success: false, error: 'No line items provided.' };

    for (var li = 0; li < lineItems.length; li++) {
      var cgstCheck = parseFloat(lineItems[li].cgst);
      var sgstCheck = parseFloat(lineItems[li].sgst);
      var hamaliCheck = parseFloat(lineItems[li].hamali);
      if (isNaN(hamaliCheck)) hamaliCheck = 0; // hamali is optional per line — a missing/blank field is 0, not a validation error
      if (isNaN(cgstCheck) || cgstCheck < 0 || isNaN(sgstCheck) || sgstCheck < 0 || hamaliCheck < 0) {
        return { success: false, error: 'CGST, SGST, and Hamali must be numbers of 0 or more.' };
      }
      if ((cgstCheck + sgstCheck) > 0 && !String(lineItems[li].lrNo || '').trim()) {
        return { success: false, error: 'LR number is required for any vendor line with GST applied.' };
      }
    }

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var sheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
      if (!sheet) return { success: false, error: 'Transport Breakdown sheet not found.' };

      var data = sheet.getDataRange().getValues();
      // sheet row number + amount + TDS status, in the same order lineIndex
      // was assigned by getVendorLineItems. TDS status is needed here
      // because TDS gets recomputed below, net of GST.
      var matchingRows = [];
      for (var i = 1; i < data.length; i++) {
        if (safe_(data[i][TB.VOUCHER_ID]) === voucherId) {
          matchingRows.push({
            row: i + 1,
            amount: parseFloat(data[i][TB.AMOUNT]) || 0,
            tdsApplicable: safe_(data[i][TB.TDS_APPLICABLE]) === 'Yes',
            tdsRate: parseFloat(data[i][TB.TDS_RATE]) || 0
          });
        }
      }
      if (matchingRows.length === 0) return { success: false, error: 'No vendor line items found for ' + voucherId + '.' };

      // Pass 1: resolve + validate every line before writing anything.
      var EPS = 0.01; // float rounding tolerance
      var toWrite = [];
      for (var j = 0; j < lineItems.length; j++) {
        var idx = lineItems[j].lineIndex;
        if (typeof idx !== 'number' || idx < 0 || idx >= matchingRows.length) {
          return { success: false, error: 'A line item no longer matches this voucher — please reload and try again.' };
        }
        var target = matchingRows[idx];
        var cgst = parseFloat(lineItems[j].cgst) || 0;
        var sgst = parseFloat(lineItems[j].sgst) || 0;
        var hamali = parseFloat(lineItems[j].hamali) || 0;
        var lrNo = String(lineItems[j].lrNo || '').trim();
        if (cgst + sgst + hamali > target.amount + EPS) {
          return { success: false, error: 'CGST + SGST + Hamali (Rs.' + (cgst + sgst + hamali).toFixed(2) + ') cannot exceed the bill amount (Rs.' + target.amount.toFixed(2) + ') \u2014 these are part of the total, not added on top.' };
        }
        // TDS was originally computed at submission time on the full bill
        // amount, since GST/hamali weren't known yet (both are 0 by
        // default at that point, so the original figure was already
        // correct for a bill with neither). Now that both are known, TDS
        // must be recalculated on the amount EXCLUDING GST and hamali —
        // recomputed fresh every save (idempotent: for a GST=0/hamali=0
        // line this reduces to the same full-amount calculation as
        // before). This is the actual figure used in the Journal
        // TDS-withholding lines at export time, not just a display value —
        // getting this right here is what makes the exported accounting
        // correct, not just the narration text.
        var tdsAmount = target.tdsApplicable ? Math.round((target.amount - cgst - sgst - hamali) * target.tdsRate) : 0;
        toWrite.push({ row: target.row, cgst: cgst, sgst: sgst, hamali: hamali, lrNo: lrNo, tdsApplicable: target.tdsApplicable, tdsAmount: tdsAmount });
      }

      // Pass 2: every line validated, now write.
      for (var k = 0; k < toWrite.length; k++) {
        sheet.getRange(toWrite[k].row, TB.CGST + 1).setValue(toWrite[k].cgst);
        sheet.getRange(toWrite[k].row, TB.SGST + 1).setValue(toWrite[k].sgst);
        sheet.getRange(toWrite[k].row, TB.HAMALI + 1).setValue(toWrite[k].hamali);
        sheet.getRange(toWrite[k].row, TB.LR_NO + 1).setValue(toWrite[k].lrNo);
        sheet.getRange(toWrite[k].row, TB.GST_REVIEWED + 1).setValue('Yes');
        if (toWrite[k].tdsApplicable) sheet.getRange(toWrite[k].row, TB.TDS_AMOUNT + 1).setValue(toWrite[k].tdsAmount);
      }

      logAction_('GST_UPDATE', voucherId, session.displayName || session.role, session.role,
        toWrite.length + ' vendor line item(s) updated');

      return { success: true, message: 'GST saved for ' + toWrite.length + ' vendor line item(s).' };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('updateVendorLineItemGst error: ' + err);
    return { success: false, error: 'Failed to save GST: ' + err.toString() };
  }
}

// ============================================================================
// DUAL-GST VENDOR FLOW — REGULAR EXPENSES (handoff 2.C, confirmed 24 Aug
// 2026). Accounts-side-only toggle on a Regular voucher's review screen —
// nothing on the submission side, no per-line items (a Regular voucher is
// always a single amount, unlike Transport's vendor-line-item structure).
// TDS is NOT applicable to this flow (per explicit instruction), so there's
// no TDS math here at all, unlike updateVendorLineItemGst above.
//
// Saving here does two things in one locked pass: writes/updates the
// voucher's row in Vendor Expense Details (RVD), and stamps
// AV.REGULAR_VENDOR_ROUTED = 'Yes' on the voucher so buildRegularEntries
// (Tally Export.gs) knows to branch into the 3-entry vendor-routed flow
// instead of the plain 2-entry one. Only callable pre-export — once a
// voucher is Tally Exported, admin must use the same re-export path any
// other post-export correction goes through (unchanged, out of scope here).
function saveRegularVendorGst(voucherId, vendorName, cgst, sgst, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'accounts') return { success: false, error: 'You do not have permission to enter vendor GST.' };

    vendorName = String(vendorName || '').trim();
    if (!vendorName) return { success: false, error: 'Vendor is required.' };

    var vendors = getRegularVendorsList_();
    if (!vendors.hasOwnProperty(vendorName)) {
      return { success: false, error: 'Unknown vendor "' + vendorName + '". Ask admin to register it first.' };
    }

    var cgstVal = parseFloat(cgst) || 0;
    var sgstVal = parseFloat(sgst) || 0;
    if (cgstVal < 0 || sgstVal < 0) return { success: false, error: 'CGST and SGST must be numbers of 0 or more.' };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var found = findVoucherRow_(voucherId);
      if (!found) return { success: false, error: 'Voucher not found.' };
      if (safe_(found.rowValues[AV.EXPENSE_TYPE]) === 'Transport') {
        return { success: false, error: 'This is a Transport voucher \u2014 use GST Entry, not vendor routing.' };
      }
      if (safe_(found.rowValues[AV.TALLY_EXPORTED]) === 'Yes') {
        return { success: false, error: 'This voucher has already been exported to Tally.' };
      }
      var amount = parseFloat(found.rowValues[AV.AMOUNT]) || 0;
      var EPS = 0.01;
      if (cgstVal + sgstVal > amount + EPS) {
        return { success: false, error: 'CGST + SGST (Rs.' + (cgstVal + sgstVal).toFixed(2) + ') cannot exceed the voucher amount (Rs.' + amount.toFixed(2) + ') \u2014 GST is part of the total, not added on top.' };
      }

      var rvdSheet = getOrCreateRegularVendorDetailsSheet_();
      var data = rvdSheet.getDataRange().getValues();
      var existingRow = -1;
      for (var i = 1; i < data.length; i++) {
        if (safe_(data[i][RVD.VOUCHER_ID]) === voucherId) { existingRow = i + 1; break; }
      }
      if (existingRow === -1) {
        rvdSheet.appendRow([voucherId, vendorName, cgstVal, sgstVal]);
      } else {
        rvdSheet.getRange(existingRow, RVD.VENDOR_NAME + 1).setValue(vendorName);
        rvdSheet.getRange(existingRow, RVD.CGST + 1).setValue(cgstVal);
        rvdSheet.getRange(existingRow, RVD.SGST + 1).setValue(sgstVal);
      }

      found.sheet.getRange(found.rowIndex, AV.REGULAR_VENDOR_ROUTED + 1).setValue('Yes');

      logAction_('REGULAR_VENDOR_GST', voucherId, session.displayName || session.role, session.role,
        'Vendor-routed to "' + vendorName + '" (CGST ' + cgstVal + ', SGST ' + sgstVal + ')');

      return { success: true, message: 'Vendor GST saved for ' + voucherId + '.' };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('saveRegularVendorGst error: ' + err);
    return { success: false, error: 'Failed to save vendor GST: ' + err.toString() };
  }
}

// Turns vendor routing back off for a Regular voucher — clears
// AV.REGULAR_VENDOR_ROUTED and removes any Vendor Expense Details row, so
// buildRegularEntries falls back to the plain 2-entry flow. Same
// pre-export-only guard as saveRegularVendorGst.
function clearRegularVendorGst(voucherId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'accounts') return { success: false, error: 'You do not have permission to edit vendor GST.' };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var found = findVoucherRow_(voucherId);
      if (!found) return { success: false, error: 'Voucher not found.' };
      if (safe_(found.rowValues[AV.TALLY_EXPORTED]) === 'Yes') {
        return { success: false, error: 'This voucher has already been exported to Tally.' };
      }

      var rvdSheet = getOrCreateRegularVendorDetailsSheet_();
      var data = rvdSheet.getDataRange().getValues();
      for (var i = data.length - 1; i >= 1; i--) {
        if (safe_(data[i][RVD.VOUCHER_ID]) === voucherId) rvdSheet.deleteRow(i + 1);
      }
      found.sheet.getRange(found.rowIndex, AV.REGULAR_VENDOR_ROUTED + 1).setValue('No');

      logAction_('REGULAR_VENDOR_GST_CLEAR', voucherId, session.displayName || session.role, session.role, 'Vendor routing removed');
      return { success: true, message: 'Vendor routing removed for ' + voucherId + '.' };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('clearRegularVendorGst error: ' + err);
    return { success: false, error: 'Failed to clear vendor GST: ' + err.toString() };
  }
}

// Read-only fetch for the review screen — existing vendor-routed state (if
// any) plus the plain vendor list, in one call.
function getRegularVendorGstForVoucher(voucherId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };

    var rvdSheet = getOrCreateRegularVendorDetailsSheet_();
    var data = rvdSheet.getDataRange().getValues();
    var existing = null;
    for (var i = 1; i < data.length; i++) {
      if (safe_(data[i][RVD.VOUCHER_ID]) === voucherId) {
        existing = { vendorName: safe_(data[i][RVD.VENDOR_NAME]), cgst: parseFloat(data[i][RVD.CGST]) || 0, sgst: parseFloat(data[i][RVD.SGST]) || 0 };
        break;
      }
    }
    return { success: true, existing: existing, vendors: Object.keys(getRegularVendorsList_()).sort() };
  } catch (err) {
    Logger.log('getRegularVendorGstForVoucher error: ' + err);
    return { success: false, error: 'Failed to load vendor GST: ' + err.toString() };
  }
}


// REVISED (Day 5): lockout is now keyed by identity, not role — for the 4
// multi-user roles that means the individual's username, since each
// person has their own login and their own attempt counter (see Auth.gs).
// Unlocks a specific USER, not a whole role. Deliberately doesn't cover
// 'admin' itself — there's no role above admin to unlock it with, so an
// admin lockout has no self-service recovery (wait 15 minutes, or clear it
// directly from the Apps Script editor's CacheService).
function adminUnlockUser(userId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };

    var found = findUserById_(userId);
    if (!found) return { success: false, error: 'User not found.' };
    var username = safe_(found.rowValues[USR.USERNAME]);
    var displayName = safe_(found.rowValues[USR.DISPLAY_NAME]);

    var cache = CacheService.getScriptCache();
    var key = username.toLowerCase();
    cache.remove('lock_' + key);
    cache.remove('att_' + key);

    logAction_('ADMIN_UNLOCK', '', session.displayName, session.role, 'Unlocked user: ' + displayName + ' (' + username + ')');
    notifyUserOfAccountEvent_(found.rowValues, 'USER_UNLOCKED',
      'Rabale Petty Expense System \u2014 your account has been unlocked',
      'Hello ' + displayName + ',\n\nYour account on the Rabale Petty Expense System has been unlocked by an administrator. You can log in again now.');
    return { success: true, message: 'User "' + displayName + '" unlocked.' };
  } catch (err) {
    Logger.log('adminUnlockUser error: ' + err);
    return { success: false, error: 'Failed to unlock user: ' + err.toString() };
  }
}

// ============================================================================
// RDS CASH GIVEN (Day 7) — Accounts hands physical cash to the warehouse to
// replenish the petty cash float, once every voucher submitted THAT DAY
// (i.e. every voucher sharing today's Batch ID — see batchIdForDate,
// Vouchers.gs, which has always been purely date-derived) has reached
// Approved. Strictly accounts-only, matching updateVendorLineItemGst's own
// role gate — no admin bypass, per explicit instruction; admin retains
// its own separate god-mode tools (adminRevertVoucher etc.) for anything
// that needs overriding outside this flow. Multiple entries per day are
// expected and allowed — each Add is independently gated against the
// CURRENT state of today's batch at the moment it's clicked, not cached
// from an earlier check.
// ============================================================================

// Shared by both RPCs below — scans ALL of "All Vouchers" (not just
// today's batch) for every voucher that is Approved, has no open query,
// and has not yet been marked Cash Released. Per-voucher amount and
// batch grouping metadata are returned alongside the totals (24 Aug
// 2026 revision — see addRdsCashGiven below for why) so the caller can
// offer batch/voucher selection without a second sheet scan.
// Internal — WITHDRAWAL_ID -> true for every APPROVED Cash Withdrawal
// Batch request. Cash Given is gated on this (see
// getUnreleasedApprovedVouchersStatus below), per the revised sequencing:
// cash can only be handed out once L2 has approved the bank withdrawal it
// comes from, not before. Small full-sheet scan — this sheet grows by one
// row per withdrawal request (at most a handful a month), far below the
// volume of every other full-sheet scan already in this codebase.
function getApprovedWithdrawalIds_() {
  var sheet = getOrCreateCashWithdrawalBatchesSheet_();
  var data = sheet.getDataRange().getValues();
  var approved = {};
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][WB.STATUS]) === WITHDRAWAL_STATUS_APPROVED) {
      approved[safe_(data[i][WB.WITHDRAWAL_ID])] = true;
    }
  }
  return approved;
}

// "Ready to release" — REVISED (Cash Withdrawal Batches feature, per
// explicit instruction): a voucher only counts here once its bank-
// withdrawal request has been approved by L2 (AV.WITHDRAWAL_BATCH_ID
// points at an APPROVED request), on top of the pre-existing Approved +
// no-open-query + not-already-released checks. Before this feature,
// EVERY Approved/unreleased/unqueried voucher landed here regardless of
// any withdrawal approval; now an Approved voucher whose withdrawal
// request hasn't been sent yet, or is still Pending L2 Approval, is
// correctly excluded until that approval closes the loop. This is the
// function every "Ready to Release" / Cash Given surface reads from
// (getDashboardSummary, getRdsCashGivenStatus, addRdsCashGiven's own
// re-check) — the gate applies everywhere at once.
function getUnreleasedApprovedVouchersStatus_() {
  var sheet = getSheet_(ALL_VOUCHERS_SHEET);
  var data = sheet.getDataRange().getValues();
  var approvedWithdrawalIds = getApprovedWithdrawalIds_();

  var voucherIds = [], totalAmount = 0;
  var amountsById = {}, metaById = {};
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][AV.STATUS]) !== 'Approved') continue;
    var queryStatus = safe_(data[i][AV.QUERY_STATUS]);
    if (queryStatus && queryStatus !== 'No Query') continue; // Approved-but-requeried — not releasable yet
    if (safe_(data[i][AV.CASH_RELEASED]) === 'Yes') continue; // already covered by a prior Cash Given entry
    var withdrawalBatchId = safe_(data[i][AV.WITHDRAWAL_BATCH_ID]);
    if (!withdrawalBatchId || !approvedWithdrawalIds[withdrawalBatchId]) continue; // no approved bank withdrawal to release this cash from yet
    var vid = safe_(data[i][AV.VOUCHER_ID]);
    var amt = parseFloat(data[i][AV.AMOUNT]) || 0;
    voucherIds.push(vid);
    totalAmount += amt;
    amountsById[vid] = amt;
    metaById[vid] = {
      batchId: safe_(data[i][AV.BATCH_ID]) || 'Unbatched',
      date: safe_(data[i][AV.DATE]),
      submittedBy: safe_(data[i][AV.SUBMITTED_BY]),
      expenseType: safe_(data[i][AV.EXPENSE_TYPE])
    };
  }

  return { voucherIds: voucherIds, count: voucherIds.length, totalAmount: totalAmount, amountsById: amountsById, metaById: metaById };
}

// ============================================================================
// LANDING DASHBOARD (#18, design pass) — one aggregation pass over All
// Vouchers + Transport Breakdown feeding every stat card, the top-vendors
// table, and the expense-type pie chart's per-batch breakdown. Deliberately
// ONE RPC rather than one per widget: every number on this page is read
// from the same in-memory snapshot of the sheet, so the numbers can never
// disagree with each other because two separate calls landed a few
// seconds apart and caught a voucher mid-approval.
// ============================================================================
function getDashboardSummary(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };

    var sheet = getSheet_(ALL_VOUCHERS_SHEET);
    var data = sheet.getDataRange().getValues();

    var pendingCount = 0, openQueryCount = 0;
    var now = new Date();
    var thisMonthTotal = 0, lastMonthTotal = 0;
    var lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var batchTotals = {}; // batchId -> { expenseType -> amount }
    var batchIdsSeen = [];

    for (var i = 1; i < data.length; i++) {
      var vid = safe_(data[i][AV.VOUCHER_ID]);
      if (!vid) continue;
      var status = safe_(data[i][AV.STATUS]);
      var queryStatus = safe_(data[i][AV.QUERY_STATUS]);
      var amount = parseFloat(data[i][AV.AMOUNT]) || 0;
      var expenseType = safe_(data[i][AV.EXPENSE_TYPE]) || 'Other';
      var batchId = safe_(data[i][AV.BATCH_ID]);

      if (status === 'Pending L1' || status === 'Pending Accounts' || status === 'Pending L2') pendingCount++;
      if (queryStatus && queryStatus !== 'No Query') openQueryCount++;

      if (status === 'Approved') {
        var d = parseRdsDateString_(safe_(data[i][AV.DATE]));
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) thisMonthTotal += amount;
        else if (d.getFullYear() === lastMonthDate.getFullYear() && d.getMonth() === lastMonthDate.getMonth()) lastMonthTotal += amount;
      }

      if (batchId) {
        if (!batchTotals[batchId]) { batchTotals[batchId] = {}; batchIdsSeen.push(batchId); }
        batchTotals[batchId][expenseType] = (batchTotals[batchId][expenseType] || 0) + amount;
      }
    }

    // Top vendors — aggregated from Transport Breakdown (the real vendor
    // ledger, not employee names — AV.SUBMITTED_BY is the reimbursement
    // target, unrelated to who was actually paid). All-time total per
    // vendor, top 5 by amount.
    var vendorTotals = {};
    var tbSheet = getSheet_(TRANSPORT_BREAKDOWN_SHEET);
    if (tbSheet) {
      var tbData = tbSheet.getDataRange().getValues();
      for (var j = 1; j < tbData.length; j++) {
        var vendorName = safe_(tbData[j][TB.VENDOR_NAME]);
        if (!vendorName) continue;
        vendorTotals[vendorName] = (vendorTotals[vendorName] || 0) + (parseFloat(tbData[j][TB.AMOUNT]) || 0);
      }
    }
    var topVendors = Object.keys(vendorTotals)
      .map(function (name) { return { name: name, amount: vendorTotals[name] }; })
      .sort(function (a, b) { return b.amount - a.amount; })
      .slice(0, 5);

    // Batch IDs sorted newest-first (they're 'B-YYYY-MM-DD', so string
    // sort is already chronological) — last 12 for the pie chart toggle,
    // enough for roughly the last two working weeks without the dropdown
    // becoming unwieldy.
    batchIdsSeen.sort().reverse();
    var recentBatchIds = batchIdsSeen.slice(0, 12);
    var batchBreakdown = {};
    recentBatchIds.forEach(function (bid) {
      batchBreakdown[bid] = Object.keys(batchTotals[bid]).map(function (type) {
        return { type: type, amount: batchTotals[bid][type] };
      });
    });

    var released = getUnreleasedApprovedVouchersStatus_();

    return {
      success: true,
      readyToRelease: { count: released.count, amount: released.totalAmount },
      pendingApproval: { count: pendingCount },
      openQueries: { count: openQueryCount },
      monthTotal: { current: thisMonthTotal, previous: lastMonthTotal },
      topVendors: topVendors,
      batchIds: recentBatchIds,
      batchBreakdown: batchBreakdown
    };
  } catch (err) {
    Logger.log('getDashboardSummary error: ' + err);
    return { success: false, error: 'Failed to load dashboard: ' + err.toString() };
  }
}

// ============================================================================
// SUBMISSION LANDING DASHBOARD — the submission role's counterpart to
// getDashboardSummary above, but deliberately a SEPARATE function rather
// than a role-branch inside it: the L1/accounts/L2/admin dashboard is
// company-wide financial data (top vendors, ready-to-release cash, every
// batch's expense-type split) that submission has no business reason to
// see. This scopes everything to the CURRENT logged-in operator's own
// work instead, filtering on AV.SUBMITTED_BY_OPERATOR — the same "who
// actually keyed this voucher in" field the existing My Vouchers "My
// Submissions" toggle already filters on (see Main.gs) — never
// AV.SUBMITTED_BY, which is the reimbursement target and unrelated to who
// is logged in. One aggregation pass over All Vouchers, same reasoning as
// getDashboardSummary: every number on the page comes from one snapshot
// so nothing can disagree with itself.
// ============================================================================
function getSubmissionDashboardSummary(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };

    var operator = session.displayName || '';
    var sheet = getSheet_(ALL_VOUCHERS_SHEET);
    var data = sheet.getDataRange().getValues();

    var pendingCount = 0, openQueryCount = 0, rejectedCount = 0;
    var pendingL1Count = 0, pendingAccountsCount = 0, pendingL2Count = 0;
    var now = new Date();
    var monthSubmittedCount = 0, monthSubmittedAmount = 0;
    var monthApprovedCount = 0, monthApprovedAmount = 0;
    var recent = [];
    var attention = []; // vouchers with an open query, or rejected: the ones that need the submitter to act

    for (var i = 1; i < data.length; i++) {
      var vid = safe_(data[i][AV.VOUCHER_ID]);
      if (!vid) continue;
      if (safe_(data[i][AV.SUBMITTED_BY_OPERATOR]) !== operator) continue;

      var status = safe_(data[i][AV.STATUS]);
      var queryStatus = safe_(data[i][AV.QUERY_STATUS]);
      var amount = parseFloat(data[i][AV.AMOUNT]) || 0;
      var d = parseRdsDateString_(safe_(data[i][AV.DATE]));
      var isThisMonth = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();

      if (status === 'Pending L1' || status === 'Pending Accounts' || status === 'Pending L2') pendingCount++;
      if (status === 'Pending L1') pendingL1Count++;
      else if (status === 'Pending Accounts') pendingAccountsCount++;
      else if (status === 'Pending L2') pendingL2Count++;
      if (status === 'Rejected') rejectedCount++;
      var hasOpenQuery = !!(queryStatus && queryStatus !== 'No Query');
      if (hasOpenQuery) openQueryCount++;
      if (hasOpenQuery || status === 'Rejected') {
        attention.push({
          voucherId: vid, date: safe_(data[i][AV.DATE]), expenseType: safe_(data[i][AV.EXPENSE_TYPE]),
          amount: amount, status: status, queryStatus: queryStatus, sortDate: d.getTime()
        });
      }

      if (isThisMonth) {
        monthSubmittedCount++;
        monthSubmittedAmount += amount;
        if (status === 'Approved') { monthApprovedCount++; monthApprovedAmount += amount; }
      }

      recent.push({
        voucherId: vid, date: safe_(data[i][AV.DATE]), expenseType: safe_(data[i][AV.EXPENSE_TYPE]),
        amount: amount, status: status, queryStatus: queryStatus, sortDate: d.getTime()
      });
    }

    function publicRow(r) {
      return { voucherId: r.voucherId, date: r.date, expenseType: r.expenseType, amount: r.amount, status: r.status, queryStatus: r.queryStatus };
    }
    recent.sort(function (a, b) { return b.sortDate - a.sortDate; });
    recent = recent.slice(0, SUBMISSION_RECENT_LIMIT).map(publicRow);
    attention.sort(function (a, b) { return b.sortDate - a.sortDate; });
    var attentionCount = attention.length;
    attention = attention.slice(0, SUBMISSION_ATTENTION_LIMIT).map(publicRow);

    return {
      success: true,
      myPending: { count: pendingCount },
      myOpenQueries: { count: openQueryCount },
      myRejected: { count: rejectedCount },
      myMonthSubmitted: { count: monthSubmittedCount, amount: monthSubmittedAmount },
      myMonthApproved: { count: monthApprovedCount, amount: monthApprovedAmount },
      stages: {
        pendingL1: pendingL1Count, pendingAccounts: pendingAccountsCount, pendingL2: pendingL2Count,
        openQueries: openQueryCount, rejected: rejectedCount, approvedThisMonth: monthApprovedCount
      },
      attention: attention,
      attentionCount: attentionCount,
      recentVouchers: recent
    };
  } catch (err) {
    Logger.log('getSubmissionDashboardSummary error: ' + err);
    return { success: false, error: 'Failed to load dashboard: ' + err.toString() };
  }
}

// How many rows the Submission role's Recent Submissions page and the
// "Needs your attention" panel on its dashboard show.
var SUBMISSION_RECENT_LIMIT = 25;
var SUBMISSION_ATTENTION_LIMIT = 6;

// READ-ONLY. The latest running Cash in Hand from the Rabale Daily Sync tab for
// the current month, or the previous month's tab if this month has no balance
// yet -- the same "last row with a numeric Cash in Hand" scan the RDS engine
// itself uses (getLastCashInHandFromSheet, Sheet Utils.gs), plus the date of
// that row. Never creates a tab and never writes. Returns null if there is no
// balance anywhere. Throws if the RDS spreadsheet cannot be opened.
function readRdsCashInHand_() {
  var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
  var today = new Date();
  var tabNames = [getRdsMonthSheetName_(today), getPreviousRdsMonthSheetName_(today)];
  for (var t = 0; t < tabNames.length; t++) {
    var sheet = ss.getSheetByName(tabNames[t]);
    if (!sheet) continue;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) continue;
    var values = sheet.getRange(2, 1, lastRow - 1, RS.CASH_IN_HAND + 1).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      var v = values[i][RS.CASH_IN_HAND];
      if (v !== '' && v !== null && !isNaN(parseFloat(v))) {
        var d = values[i][RS.DATE];
        return { amount: parseFloat(v), asOf: (d instanceof Date && !isNaN(d.getTime())) ? formatDate_(d) : '', tab: tabNames[t] };
      }
    }
  }
  return null;
}

// Feeds the "Cash in hand vs advances given" chart on the Submission
// Dashboard. A separate RPC from getSubmissionDashboardSummary on purpose: it
// opens a second spreadsheet (slow), and if that spreadsheet is unreachable
// only this one chart should say so -- not the whole dashboard.
function getSubmissionCashPosition(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (['submission', 'accounts', 'admin'].indexOf(session.role) === -1) return { success: false, error: 'You do not have permission to view this.' };
    var pos = readRdsCashInHand_();
    if (!pos) return { success: true, available: false };
    return { success: true, available: true, cashInHand: pos.amount, asOf: pos.asOf, tab: pos.tab };
  } catch (err) {
    Logger.log('getSubmissionCashPosition error: ' + err);
    return { success: false, error: 'Could not read Cash in Hand from Rabale Daily Sync: ' + err.toString() };
  }
}

// Marks every voucher in `voucherIds` as released against `rdsVoucherNo`
// (the RDS "Cash Given by Accounts" entry's own voucher number, so an
// admin edit/delete of that entry can find and roll every one of them
// back — see adminRemoveRdsCashGiven below). Called once, right after
// appendRdsCashGivenRow succeeds, inside the same script lock.
function markVouchersCashReleased_(voucherIds, rdsVoucherNo) {
  if (!voucherIds || voucherIds.length === 0) return;
  var sheet = getSheet_(ALL_VOUCHERS_SHEET);
  var data = sheet.getDataRange().getValues();
  var idSet = {};
  voucherIds.forEach(function (id) { idSet[id] = true; });
  for (var i = 1; i < data.length; i++) {
    if (!idSet[safe_(data[i][AV.VOUCHER_ID])]) continue;
    sheet.getRange(i + 1, AV.CASH_RELEASED + 1).setValue('Yes');
    sheet.getRange(i + 1, AV.CASH_RELEASED_VOUCHER_NO + 1).setValue(rdsVoucherNo);
  }
}

// Inverse of markVouchersCashReleased — every voucher whose
// CASH_RELEASED_VOUCHER_NO matches a given RDS entry is reverted back to
// unreleased. Used only when an admin edits or removes that RDS entry
// (see adminOverrideRdsCashGiven / adminRemoveRdsCashGiven), so Accounts
// can cleanly re-release the correct amount against the same backlog
// rather than those vouchers being silently stuck "released" against a
// Cash Given entry that no longer reflects reality.
function unmarkVouchersCashReleasedByRdsVoucherNo_(rdsVoucherNo) {
  var sheet = getSheet_(ALL_VOUCHERS_SHEET);
  var data = sheet.getDataRange().getValues();
  var reverted = [];
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][AV.CASH_RELEASED_VOUCHER_NO]) !== rdsVoucherNo) continue;
    sheet.getRange(i + 1, AV.CASH_RELEASED + 1).setValue('No');
    sheet.getRange(i + 1, AV.CASH_RELEASED_VOUCHER_NO + 1).setValue('');
    reverted.push(safe_(data[i][AV.VOUCHER_ID]));
  }
  return reverted;
}

// Read-only status for the Approval Dashboard's Cash Given panel
// (accounts role only) — the unreleased-approved-backlog total plus
// today's already-added Cash Given entries, so Accounts can see what's
// already gone out today before adding more.
function getRdsCashGivenStatus(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'accounts') return { success: false, error: 'You do not have permission to view this.' };

    var unreleased = getUnreleasedApprovedVouchersStatus_();

    // Per-voucher detail, grouped client-side by batchId — this is what
    // lets Accounts select specific batches/vouchers instead of the cash
    // release always covering the entire backlog (24 Aug 2026 fix — see
    // addRdsCashGiven below for the full rationale).
    var unreleasedVouchers = unreleased.voucherIds.map(function (vid) {
      var meta = unreleased.metaById[vid] || {};
      return {
        voucherId: vid, amount: unreleased.amountsById[vid] || 0,
        batchId: meta.batchId, date: meta.date, submittedBy: meta.submittedBy, expenseType: meta.expenseType
      };
    });

    var todaysEntries = [];
    try {
      var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
      var today = new Date();
      var sheet = ss.getSheetByName(getRdsMonthSheetName_(today));
      if (sheet) {
        var data = sheet.getDataRange().getValues();
        for (var i = 1; i < data.length; i++) {
          if (safe_(data[i][RS.EMPLOYEE_NAME]) !== RDS_CASH_GIVEN_ROW_LABEL) continue;
          if (!isSameCalendarDay_(data[i][RS.DATE], today)) continue;
          todaysEntries.push({
            voucherNo: safe_(data[i][RS.VOUCHER_NO]),
            amount: parseFloat(data[i][RS.CASH_GIVEN_BY_ACCOUNTS]) || 0,
            time: safe_(data[i][RS.DATE]) // formatted for display via safe(); exact clock time isn't tracked separately, matching how voucher rows also only carry a date, not a timestamp
          });
        }
      }
    } catch (rdsErr) {
      Logger.log('getRdsCashGivenStatus: could not read today\'s Cash Given entries: ' + rdsErr);
      // Non-fatal — the gate/status readout above is still valid and returned.
    }

    return {
      success: true,
      unreleasedCount: unreleased.count,
      unreleasedAmount: unreleased.totalAmount,
      unreleasedVoucherIds: unreleased.voucherIds,
      unreleasedVouchers: unreleasedVouchers,
      todaysEntries: todaysEntries
    };
  } catch (err) {
    Logger.log('getRdsCashGivenStatus error: ' + err);
    return { success: false, error: 'Failed to load status: ' + err.toString() };
  }
}

// Accounts adds one Cash Given entry, released against a SELECTED subset
// of the unreleased-approved backlog — voucherIdsJson (batches/vouchers
// picked in the UI). Every id is re-validated against the CURRENT
// unreleased-approved set inside the lock (not trusted from the client
// snapshot), so a voucher approved/queried/already-released by someone
// else in the gap between the client's last fetch and this click is
// caught rather than silently released or silently skipped. Vouchers
// NOT selected are untouched — they remain in the unreleased-approved
// set and keep showing as "Ready to Release" on every dashboard that
// reads getUnreleasedApprovedVouchersStatus, exactly as before.
//
// REVISED 24 Aug 2026, fixing a real bug: this used to ALWAYS release
// the entire unreleased-approved backlog regardless of the typed
// amount — typing a partial amount (to hand over less cash than the
// full backlog because the rest isn't ready yet) still marked EVERY
// unreleased voucher as released, silently. voucherIdsJson is REQUIRED
// now — there is no longer an implicit "release everything" fallback,
// since that's exactly the behavior that caused the bug (Rs. 94,454.45
// approved, Rs. 55,446 typed, the whole Rs. 94,454.45 cleared). The
// amount field itself is still free-text and independent of the
// selected total (matches what's actually counted out in cash, which
// can legitimately differ by a rounding rupee or two) — only the
// RELEASE SCOPE changed, not the amount-entry philosophy.
function addRdsCashGiven(amount, voucherIdsJson, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'accounts') return { success: false, error: 'You do not have permission to do this.' };

    amount = parseFloat(amount);
    if (isNaN(amount) || amount <= 0) return { success: false, error: 'Enter a valid amount greater than 0.' };

    var requestedIds;
    try { requestedIds = JSON.parse(voucherIdsJson) || []; } catch (e) { return { success: false, error: 'Invalid voucher selection.' }; }
    if (requestedIds.length === 0) return { success: false, error: 'Select at least one batch or voucher to release cash against.' };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      // Re-check the gate INSIDE the lock, same defensive re-check
      // pattern used everywhere else in this file — a voucher could be
      // approved/queried by someone else in the gap between the client's
      // last status fetch and this click.
      var unreleased = getUnreleasedApprovedVouchersStatus_();
      if (unreleased.count === 0) {
        return { success: false, error: 'No Approved, unreleased vouchers to release cash against.' };
      }

      var unreleasedSet = {};
      unreleased.voucherIds.forEach(function (id) { unreleasedSet[id] = true; });
      var invalidIds = requestedIds.filter(function (id) { return !unreleasedSet[id]; });
      if (invalidIds.length > 0) {
        return { success: false, error: 'One or more selected vouchers are no longer eligible for release (already released, queried, or no longer Approved) \u2014 refresh and try again: ' + invalidIds.join(', ') };
      }

      var selectedTotal = 0;
      requestedIds.forEach(function (id) { selectedTotal += unreleased.amountsById[id] || 0; });

      var result = appendRdsCashGivenRow_(amount);
      if (!result.success) return result;

      markVouchersCashReleased_(requestedIds, result.voucherNo);

      logAction_('RDS_CASH_GIVEN', result.voucherNo, session.displayName || session.role, session.role,
        'Rs.' + amount + ' given to warehouse, released against ' + requestedIds.length + ' voucher(s) (Rs.' + selectedTotal + ' computed total; Rs.' + unreleased.totalAmount + ' was the full unreleased backlog): ' + requestedIds.join(', '));

      return { success: true, message: 'Rs. ' + amount.toLocaleString('en-IN') + ' recorded as Cash Given to warehouse, released against ' + requestedIds.length + ' voucher(s) (Rs. ' + selectedTotal.toLocaleString('en-IN') + ' computed).' };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('addRdsCashGiven error: ' + err);
    return { success: false, error: 'Failed to record Cash Given: ' + err.toString() };
  }
}

// ----------------------------------------------------------------------------
// Admin Cash Given override — edit or fully remove a mistaken Cash Given
// entry. CHANGED (backdating/cash-release build): no longer "TODAY-only"
// — release now spans the whole unreleased backlog regardless of day, so
// admin needs to be able to correct/remove ANY past entry, not just
// today's. Removing an entry now also reverses its effect on every
// voucher it released (unmarkVouchersCashReleasedByRdsVoucherNo) — the
// old comment here ("doesn't need to unlock anything") predates the
// per-voucher CASH_RELEASED tracking and is no longer true: without this,
// a deleted entry would leave its vouchers permanently stuck marked
// "released" even though the cash was never actually given, silently
// excluding them from every future Cash Given total. Editing the AMOUNT
// only (not removing) does NOT unmark anything — the same vouchers are
// still correctly covered, just by a corrected figure.
// ----------------------------------------------------------------------------

function getTodaysRdsCashGivenEntriesForAdmin(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin') return { success: false, error: 'You do not have permission to view this.' };
    // Function name kept for client-call compatibility; now returns
    // recent (current + previous month), not strictly today's — see
    // listRecentRdsCashGivenEntries (Sheet Utils.gs) for why.
    return { success: true, entries: listRecentRdsCashGivenEntries_() };
  } catch (err) {
    Logger.log('getTodaysRdsCashGivenEntriesForAdmin error: ' + err);
    return { success: false, error: 'Failed to load entries: ' + err.toString() };
  }
}

function adminOverrideRdsCashGiven(voucherNo, newAmount, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };
    voucherNo = String(voucherNo || '').trim();
    if (!voucherNo) return { success: false, error: 'No entry selected.' };
    newAmount = parseFloat(newAmount);
    if (isNaN(newAmount) || newAmount <= 0) return { success: false, error: 'Enter a valid amount greater than 0.' };

    var result = adminEditRdsCashGivenAmount_(voucherNo, newAmount);
    if (!result.success) return result;

    logAction_('RDS_CASH_GIVEN_ADMIN_EDIT', voucherNo, session.displayName || session.role, session.role,
      'Admin corrected Cash Given entry ' + voucherNo + ' to Rs.' + newAmount);
    return { success: true, message: 'Cash Given entry updated to Rs. ' + newAmount.toLocaleString('en-IN') + '.' };
  } catch (err) {
    Logger.log('adminOverrideRdsCashGiven error: ' + err);
    return { success: false, error: 'Failed to update entry: ' + err.toString() };
  }
}

function adminRemoveRdsCashGiven(voucherNo, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };
    voucherNo = String(voucherNo || '').trim();
    if (!voucherNo) return { success: false, error: 'No entry selected.' };

    var result = adminDeleteRdsCashGivenEntry_(voucherNo);
    if (!result.success) return result;

    var reverted = unmarkVouchersCashReleasedByRdsVoucherNo_(voucherNo);

    logAction_('RDS_CASH_GIVEN_ADMIN_DELETE', voucherNo, session.displayName || session.role, session.role,
      'Admin removed Cash Given entry ' + voucherNo + ' \u2014 ' + reverted.length + ' voucher(s) reverted to unreleased: ' + reverted.join(', '));
    return { success: true, message: 'Cash Given entry removed. ' + reverted.length + ' voucher(s) are unreleased again and will be included in the next Cash Given total.' };
  } catch (err) {
    Logger.log('adminRemoveRdsCashGiven error: ' + err);
    return { success: false, error: 'Failed to remove entry: ' + err.toString() };
  }
}

// ============================================================================
// CASH WITHDRAWAL BATCHES (per explicit instruction, REVISED) — the
// bank-replenishment approval workflow now GATES Cash Given rather than
// following it. Sequence:
//   1. A batch is fully approved (nothing Pending/Queried left in it).
//   2. Accounts selects it here and requests withdrawal approval — this
//      is BEFORE any cash changes hands. No RDS row is written yet.
//   3. L2 replies by email approving (external to the app).
//   4. Admin marks the request Approved (decideCashWithdrawalBatch below).
//   5. ONLY NOW does Accounts get the option to actually hand out cash —
//      getUnreleasedApprovedVouchersStatus (below addRdsCashGiven) now
//      requires a voucher's WITHDRAWAL_BATCH_ID to point at an APPROVED
//      request before it counts as "ready to release". This is the
//      change from the first version of this feature: I had originally
//      built the withdrawal request as a step AFTER Cash Given (proving
//      out already-disbursed vouchers for replenishment) — backwards
//      from what's actually wanted, which is that cash can't be handed
//      out until the bank withdrawal it comes from has been approved.
//
// A batch (AV.BATCH_ID — always one calendar day, see generateBatchId/
// batchIdForDate in Vouchers.gs) is selectable for a NEW withdrawal
// request only when:
//   1. No voucher in it is still Pending L1/Accounts/L2, and none has an
//      open query — i.e. the batch is fully resolved, per explicit
//      instruction.
//   2. It has at least one Approved voucher not already tied to ANY
//      withdrawal request (AV.WITHDRAWAL_BATCH_ID blank) — whether that
//      prior request is still pending or already approved; either way it
//      isn't available for a second request.
//
// Only vouchers that are Approved, not already tied to a withdrawal
// request, AND not already cash-released (a defensive, legacy-data
// guard — in the normal flow a voucher's cash is never released before
// its withdrawal request exists, so this should never actually trigger)
// count toward a request's total. Rejected vouchers in an otherwise-
// eligible batch are simply excluded from the count, same as they're
// excluded from Cash Given.
// ============================================================================

// Converts a 'B-YYYY-MM-DD' batch id to 'dd-MM-yyyy' for display —
// batchIdForDate (Vouchers.gs) is the inverse. Falls back to the raw
// input if it doesn't match the expected shape, defensively, rather than
// throwing on a malformed/legacy batch id.
function batchIdToDisplayDate_(batchId) {
  var m = String(batchId || '').match(/^B-(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return batchId;
  return m[3] + '-' + m[2] + '-' + m[1];
}

// Canonical subject line for the request email sent to L2. Factored out
// of triggerCashWithdrawalRequest so decideCashWithdrawalBatch can
// reconstruct the EXACT same string for legacy rows written before
// WB.EMAIL_SUBJECT existed. The decision email is sent as
// 'Re: <request subject>', and Gmail only groups the two into one
// conversation when the subjects match character for character.
function withdrawalRequestSubject_(totalAmount, periodFrom, periodTo) {
  return 'Cash Withdrawal Approval Required \u2014 Rs. ' + (parseFloat(totalAmount) || 0).toLocaleString('en-IN') +
    ' (' + periodFrom + ' to ' + periodTo + ')';
}

// Internal (not itself an RPC) — one full scan of All Vouchers, grouped by
// AV.BATCH_ID, classifying each batch per the rules above. Shared by
// getEligibleWithdrawalBatches (read) and triggerCashWithdrawalRequest
// (write, re-validates inside the lock rather than trusting the client's
// last fetch — same defensive pattern as addRdsCashGiven).
function computeWithdrawalBatchEligibility_() {
  var sheet = getSheet_(ALL_VOUCHERS_SHEET);
  var data = sheet.getDataRange().getValues();

  var batches = {}; // batchId -> { date, voucherCount, blockedCount, eligibleVoucherIds, eligibleAmount, alreadyRequestedCount }
  var batchOrder = [];

  for (var i = 1; i < data.length; i++) {
    var vid = safe_(data[i][AV.VOUCHER_ID]);
    if (!vid) continue;
    var batchId = safe_(data[i][AV.BATCH_ID]);
    if (!batchId) continue;

    if (!batches[batchId]) {
      batches[batchId] = {
        batchId: batchId, date: safe_(data[i][AV.DATE]), voucherCount: 0, blockedCount: 0,
        eligibleVoucherIds: [], eligibleAmount: 0, alreadyRequestedCount: 0
      };
      batchOrder.push(batchId);
    }
    var b = batches[batchId];
    b.voucherCount++;

    var status = safe_(data[i][AV.STATUS]);
    var queryStatus = safe_(data[i][AV.QUERY_STATUS]);
    var cashReleased = safe_(data[i][AV.CASH_RELEASED]);
    var withdrawalBatchId = safe_(data[i][AV.WITHDRAWAL_BATCH_ID]);
    var amount = parseFloat(data[i][AV.AMOUNT]) || 0;

    var isUnresolved = (status === 'Pending L1' || status === 'Pending Accounts' || status === 'Pending L2') ||
      (queryStatus && queryStatus !== 'No Query');

    if (isUnresolved) { b.blockedCount++; continue; }
    if (status !== 'Approved') continue; // Rejected — not part of any withdrawal figure

    if (withdrawalBatchId) { b.alreadyRequestedCount++; continue; }
    if (cashReleased === 'Yes') continue; // legacy-data guard — see header comment above; excluded, doesn't block the batch

    b.eligibleVoucherIds.push(vid);
    b.eligibleAmount += amount;
  }

  var result = [];
  batchOrder.forEach(function (batchId) {
    var b = batches[batchId];
    result.push({
      batchId: b.batchId, date: b.date, voucherCount: b.voucherCount,
      // A batch is SELECTABLE only when nothing in it is still blocked
      // AND it has at least one voucher left to actually request.
      selectable: b.blockedCount === 0 && b.eligibleVoucherIds.length > 0,
      blockedCount: b.blockedCount, alreadyRequestedCount: b.alreadyRequestedCount,
      eligibleVoucherIds: b.eligibleVoucherIds, eligibleCount: b.eligibleVoucherIds.length,
      eligibleAmount: b.eligibleAmount
    });
  });
  // Newest first — batchId is 'B-YYYY-MM-DD', so string sort is already
  // chronological (same trick getDashboardSummary's batchIdsSeen uses).
  result.sort(function (a, b) { return b.batchId.localeCompare(a.batchId); });
  return result;
}

// Read-only RPC — accounts/admin/L2/auditor can all see the withdrawal
// queue (auditor per its existing read-only-everything-cash posture; L2
// so they can cross-check what's about to land in their inbox).
function getEligibleWithdrawalBatches(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (['accounts', 'admin', 'L2', 'auditor'].indexOf(session.role) === -1) {
      return { success: false, error: 'You do not have permission to view this.' };
    }
    var batches = computeWithdrawalBatchEligibility_();
    return { success: true, batches: batches };
  } catch (err) {
    Logger.log('getEligibleWithdrawalBatches error: ' + err);
    return { success: false, error: 'Failed to load withdrawal batches: ' + err.toString() };
  }
}

// Builds the xlsx attachment — RDS columns 0..RS.CASH_IN_HAND only (Voucher
// No. through Cash in Hand; Advance/Actual Cash in Hand/Cash Given by
// Accounts are deliberately excluded, per explicit instruction: "RDS only
// till Cash in Hand column") for exactly the selected voucher IDs, pulled
// from whichever RDS month tab(s) each voucher's date falls in (a
// withdrawal request can span a month boundary if it covers a slow week).
// Same throwaway-spreadsheet export technique as exportTallyMonthAsXlsx
// (Tally Export.gs) — Sheets has no native single-range-to-xlsx call.
// REVISED (per explicit instruction) — the extract now also carries, for
// every calendar day represented among the selected vouchers, that day's
// Opening Balance row from the source RDS tab, and ends with a bold
// grand-Total row. Neither existed before: a reviewer (L2) previously saw
// only bare voucher rows with no starting cash position to judge them
// against, and no single figure to check against the email's stated
// total without adding the column up by hand.
function buildCashWithdrawalExtractXlsx_(voucherIds, withdrawalId) {
  var idSet = {};
  voucherIds.forEach(function (id) { idSet[id] = true; });
  var remaining = voucherIds.length;

  var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
  var sheets = ss.getSheets();
  var colCount = RS.CASH_IN_HAND + 1; // 0..25 inclusive
  // Keyed by a sortable 'yyyy-MM-dd' string so rows from different month
  // tabs (a request can span a month boundary — see the header comment
  // above) still merge into one correctly-ordered sequence: { openingRow,
  // voucherRows: [...] }.
  var byDate = {};
  var missingVoucherIds = [];

  function dateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function formatRow(row) {
    return row.slice(0, colCount).map(function (cell, ci) {
      // RS.DATE is a real Date on most rows — format it the same way the
      // rest of the app displays dates rather than leaving Sheets to
      // pick its own serial/locale rendering in the exported file.
      return ci === RS.DATE ? formatDate_(cell) : cell;
    });
  }

  // Every RDS month tab is scanned (cheap at this data volume, same
  // posture as every other full-sheet scan in this codebase) rather than
  // trying to derive which month tab(s) to open from AV.DATE up front —
  // that would need a second lookup pass into All Vouchers for no real
  // savings, since a withdrawal request is at most a handful of batches.
  // Two passes per sheet: the first finds the requested vouchers and
  // notes which calendar day(s) they fall on; the second (only run if
  // this sheet actually matched something) finds that day's Opening
  // Balance row — a voucher and its own day's Opening Balance are always
  // in the same month tab, so no cross-tab lookup is needed for it.
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var lastRow = sh.getLastRow();
    if (lastRow < 2) continue;
    var data = sh.getRange(2, 1, lastRow - 1, Math.max(sh.getLastColumn(), colCount)).getValues();
    var datesNeededThisSheet = {};
    for (var r = 0; r < data.length; r++) {
      var voucherNo = safe_(data[r][RS.VOUCHER_NO]);
      if (!voucherNo || !idSet[voucherNo]) continue;
      var d = data[r][RS.DATE];
      var key = (d instanceof Date && !isNaN(d.getTime())) ? dateKey(d) : 'unknown';
      if (!byDate[key]) byDate[key] = { openingRow: null, voucherRows: [] };
      byDate[key].voucherRows.push(formatRow(data[r]));
      datesNeededThisSheet[key] = true;
      delete idSet[voucherNo];
      remaining--;
    }
    var neededKeys = Object.keys(datesNeededThisSheet);
    if (neededKeys.length === 0) continue;
    for (var r2 = 0; r2 < data.length; r2++) {
      if (safe_(data[r2][RS.EMPLOYEE_NAME]) !== 'Opening Balance') continue;
      var od = data[r2][RS.DATE];
      if (!(od instanceof Date) || isNaN(od.getTime())) continue;
      var okey = dateKey(od);
      if (datesNeededThisSheet[okey] && byDate[okey] && !byDate[okey].openingRow) {
        byDate[okey].openingRow = formatRow(data[r2]);
      }
    }
  }
  Object.keys(idSet).forEach(function (id) { missingVoucherIds.push(id); });

  var sortedDateKeys = Object.keys(byDate).sort();
  var extractRows = [];
  var grandTotal = 0;
  sortedDateKeys.forEach(function (key) {
    var block = byDate[key];
    if (block.openingRow) extractRows.push(block.openingRow);
    block.voucherRows.forEach(function (row) {
      extractRows.push(row);
      grandTotal += parseFloat(row[RS.TOTAL]) || 0;
    });
  });

  var headers = EXPECTED_RDS_HEADERS_FALLBACK.slice(0, colCount);
  var totalRow = new Array(colCount).fill('');
  totalRow[RS.EMPLOYEE_NAME] = 'TOTAL';
  totalRow[RS.TOTAL] = grandTotal;
  var values = [headers].concat(extractRows).concat([totalRow]);
  var totalRowNumber = values.length; // 1-based sheet row this lands on, header included

  var tempSs = SpreadsheetApp.create('Cash Withdrawal ' + withdrawalId + ' (temp)');
  var tempSheet = tempSs.getSheets()[0];
  tempSheet.setName(withdrawalId);
  tempSheet.getRange(1, 1, values.length, values[0].length).setValues(values);
  // Bold the Total row (per explicit instruction) so it reads at a glance
  // against the plain voucher/opening-balance rows above it. Opening
  // Balance rows keep the same bold treatment they already carry on the
  // live RDS sheet (recomputeRdsCashInHand, Sheet Utils.gs) for the same
  // reason — this only needs to additionally bold the new Total row.
  tempSheet.getRange(totalRowNumber, 1, 1, colCount).setFontWeight('bold');
  sortedDateKeys.forEach(function (key, idx) {
    if (!byDate[key].openingRow) return;
    // Row 1 is the header; every date block before this one contributed
    // exactly (1 opening row, if any) + voucherRows.length rows, so the
    // opening row's sheet position is derivable without re-scanning.
    var rowNum = 2;
    for (var i = 0; i < idx; i++) {
      var b = byDate[sortedDateKeys[i]];
      rowNum += (b.openingRow ? 1 : 0) + b.voucherRows.length;
    }
    tempSheet.getRange(rowNum, 1, 1, colCount).setFontWeight('bold');
  });
  SpreadsheetApp.flush();

  var url = 'https://docs.google.com/spreadsheets/d/' + tempSs.getId() + '/export?format=xlsx';
  var oauthToken = ScriptApp.getOAuthToken();
  var response = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + oauthToken } });
  var blob = response.getBlob().setName('CashWithdrawal_' + withdrawalId + '.xlsx');

  var root = DriveApp.getRootFolder();
  var expFolder = getOrCreateDriveFolder_(root, 'Rabale Expense System');
  var withdrawalsFolder = getOrCreateDriveFolder_(expFolder, 'Cash Withdrawal Batches');
  var file = withdrawalsFolder.createFile(blob);
  file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);

  DriveApp.getFileById(tempSs.getId()).setTrashed(true);

  return {
    blob: blob, url: file.getUrl(),
    rowCount: extractRows.length, missingVoucherIds: missingVoucherIds,
    grandTotal: grandTotal
  };
}

// Accounts selects one or more currently-selectable batches and triggers
// the request. Every batchId is re-validated against the CURRENT
// eligibility snapshot inside the lock (never trusted from the client's
// last fetch) — a voucher that got approved-but-not-released, queried, or
// already requested by someone else in the gap since the client's last
// load is caught here rather than silently mis-totaled. Sends FROM
// whichever account this script executes as (the Execute As: Me deployment
// setting — see Config.gs's ADMIN_PIN notes for why that's already the
// admin account), so no separate "from" configuration is needed to
// satisfy "triggered from the admin email id".
function triggerCashWithdrawalRequest(batchIdsJson, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'accounts') return { success: false, error: 'You do not have permission to do this.' };

    var requestedBatchIds;
    try { requestedBatchIds = JSON.parse(batchIdsJson) || []; } catch (e) { requestedBatchIds = []; }
    if (!requestedBatchIds.length) return { success: false, error: 'Select at least one batch.' };

    var l2Emails = getActiveUserEmailsForRole_('L2');
    if (l2Emails.length === 0) {
      return { success: false, error: 'No active L2 user has an email on file — add one before sending a withdrawal request.' };
    }
    var accountsEmails = getActiveUserEmailsForRole_('accounts');

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      Logger.log('triggerCashWithdrawalRequest lock timeout: ' + lockErr);
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    try {
      var currentBatches = computeWithdrawalBatchEligibility_();
      var batchById = {};
      currentBatches.forEach(function (b) { batchById[b.batchId] = b; });

      var voucherIds = [];
      var totalAmount = 0;
      var invalidBatchIds = [];
      requestedBatchIds.forEach(function (bid) {
        var b = batchById[bid];
        if (!b || !b.selectable) { invalidBatchIds.push(bid); return; }
        voucherIds = voucherIds.concat(b.eligibleVoucherIds);
        totalAmount += b.eligibleAmount;
      });

      if (invalidBatchIds.length > 0) {
        return { success: false, error: 'These batch(es) are no longer eligible (approved elsewhere, queried, or already requested since you loaded this page) — refresh and try again: ' + invalidBatchIds.join(', ') };
      }
      if (voucherIds.length === 0) return { success: false, error: 'No eligible vouchers in the selected batch(es).' };

      var sortedBatchIds = requestedBatchIds.slice().sort();
      // Batch IDs are 'B-YYYY-MM-DD' (see batchIdForDate, Vouchers.gs) —
      // reformatted to dd-MM-yyyy here to match how every other date in
      // this app is displayed (formatDate, Sheet Utils.gs), rather than
      // leaving the email/log showing the raw YYYY-MM-DD batch-id form.
      var periodFrom = batchIdToDisplayDate_(sortedBatchIds[0]);
      var periodTo = batchIdToDisplayDate_(sortedBatchIds[sortedBatchIds.length - 1]);
      var withdrawalId = 'WD-' + Date.now();

      var extract = buildCashWithdrawalExtractXlsx_(voucherIds, withdrawalId);
      // Reconciliation guardrail: the amount in the email body must equal
      // the sum actually sitting in the attached sheet, not a
      // separately-derived All Vouchers figure that could in principle
      // drift from RDS. If any voucher's RDS row couldn't be found (sync
      // gap), that voucher's amount is excluded from BOTH the email total
      // and the attachment together, and it's called out explicitly in
      // both the email and the audit log rather than silently
      // under/over-stating the ask to L2.
      var reconciledTotal = totalAmount;
      if (extract.missingVoucherIds.length > 0) {
        var missingAmount = 0;
        var found2 = null;
        extract.missingVoucherIds.forEach(function (mvid) {
          found2 = findVoucherRow_(mvid);
          if (found2) missingAmount += parseFloat(found2.rowValues[AV.AMOUNT]) || 0;
        });
        reconciledTotal -= missingAmount;
      }

      var subject = withdrawalRequestSubject_(reconciledTotal, periodFrom, periodTo);
      // Email content lives in Notifications.gs: withdrawalRequestText_ builds the
      // plain-text body (what this email has always said, apart from the
      // decision instruction), and the HTML version is built from the same
      // values inside sendNotification_, which falls back to the plain text
      // if the HTML cannot be built. The subject above is
      // untouched — the decision email threads onto it.
      var requestMail = {
        withdrawalId: withdrawalId, batchIds: sortedBatchIds, periodFrom: periodFrom, periodTo: periodTo,
        voucherCount: voucherIds.length, totalAmount: reconciledTotal, missingVoucherIds: extract.missingVoucherIds
      };
      var requestBodyText = withdrawalRequestText_(requestMail);

      // BUG FIX (per explicit instruction — "didn't shoot mail even after
      // clicking the button") — the send now happens FIRST, before any
      // state-mutating write. The original order wrote AV.WITHDRAWAL_BATCH_ID
      // on every voucher AND appended the 'Pending L2 Approval' row to the
      // Cash Withdrawal Batches sheet, THEN attempted MailApp.sendEmail. If
      // that send failed for any reason (daily quota exhausted, malformed
      // recipient, transient Google-side error), those writes had ALREADY
      // happened and were never rolled back — leaving the exact batch you
      // just tried to request permanently marked "already requested" with
      // no email ever having gone out, and no way to retry without an
      // admin noticing and manually rejecting the phantom request first.
      // Sending first means a failed attempt leaves nothing behind: no
      // voucher is tagged, no row is written, and you can just click the
      // button again.
      //
      // The identity MailApp.sendEmail actually sends as — with this
      // manifest's "executeAs": "USER_DEPLOYING", that's whichever Google
      // account most recently ran Deploy (Apps Script editor > Deploy >
      // Manage deployments shows "Deployed by" for the active deployment)
      // — is captured via Session.getEffectiveUser() and logged into the
      // audit trail below on BOTH the success and failure path, so "which
      // mail is this sending from" is answerable by reading the Audit Log
      // sheet going forward instead of having to guess or redeploy to find
      // out. A consumer Gmail account (not Google Workspace) has only a
      // 100-recipient/day MailApp quota, SHARED across every email this
      // whole app sends (OTP codes, account-event notices, query
      // reminders, this) — getRemainingDailyQuota() is checked below so a
      // quota problem returns a clear, specific error instead of a
      // generic thrown exception.
      var sendingIdentity = Session.getEffectiveUser().getEmail() || '(unknown \u2014 Session.getEffectiveUser() returned nothing)';
      var remainingQuota = MailApp.getRemainingDailyQuota();
      if (remainingQuota <= 0) {
        logAction_('CASH_WITHDRAWAL_SEND_FAILED', withdrawalId, session.displayName || session.role, session.role,
          'Daily MailApp quota exhausted for ' + sendingIdentity + ' \u2014 no vouchers tagged, no request recorded, safe to retry once quota resets.');
        return { success: false, error: 'This deployment\u2019s email account (' + sendingIdentity + ') has used up its daily email quota. Nothing was changed \u2014 try again after quota resets (Google resets consumer Gmail quota around midnight Pacific time), or deploy under a Google Workspace account for a much higher daily limit.' };
      }

      try {
        sendNotification_({
          to: l2Emails.join(','),
          cc: accountsEmails.join(','),
          subject: subject,
          body: requestBodyText,
          attachments: [extract.blob]
        }, function (hasLogo) { return withdrawalRequestHtml_(requestMail, getAppUrl_(), hasLogo); });
      } catch (mailErr) {
        Logger.log('triggerCashWithdrawalRequest: MailApp.sendEmail failed, sending as ' + sendingIdentity + ': ' + mailErr);
        logAction_('CASH_WITHDRAWAL_SEND_FAILED', withdrawalId, session.displayName || session.role, session.role,
          'MailApp.sendEmail failed sending as ' + sendingIdentity + ' to L2 (' + l2Emails.join(', ') + '): ' + mailErr + ' \u2014 no vouchers tagged, no request recorded, safe to retry.');
        return { success: false, error: 'Failed to send the email (sending as ' + sendingIdentity + '): ' + mailErr.toString() + '. Nothing was changed \u2014 fix the underlying issue and try again.' };
      }

      // Only now, after the email has actually gone out, do the writes
      // that mark this batch as requested.
      var avSheet = getSheet_(ALL_VOUCHERS_SHEET);
      var avData = avSheet.getDataRange().getValues();
      var idSet = {};
      voucherIds.forEach(function (id) { idSet[id] = true; });
      for (var r = 1; r < avData.length; r++) {
        if (!idSet[safe_(avData[r][AV.VOUCHER_ID])]) continue;
        avSheet.getRange(r + 1, AV.WITHDRAWAL_BATCH_ID + 1).setValue(withdrawalId);
      }

      // DATE FORMAT FIX (per explicit instruction) — WB.REQUESTED_DATE's
      // header is "Requested Date"; matches every other date column's
      // dd-MM-yyyy now instead of a full date+time string.
      var now = formatDate_(new Date());
      var wbSheet = getOrCreateCashWithdrawalBatchesSheet_();
      var wbRow = new Array(EXPECTED_CASH_WITHDRAWAL_BATCHES_HEADERS.length).fill('');
      wbRow[WB.WITHDRAWAL_ID] = withdrawalId;
      wbRow[WB.REQUESTED_DATE] = now;
      wbRow[WB.REQUESTED_BY] = session.displayName || session.role;
      wbRow[WB.BATCH_IDS] = sortedBatchIds.join(', ');
      wbRow[WB.PERIOD_FROM] = periodFrom;
      wbRow[WB.PERIOD_TO] = periodTo;
      wbRow[WB.VOUCHER_COUNT] = voucherIds.length;
      wbRow[WB.TOTAL_AMOUNT] = reconciledTotal;
      wbRow[WB.STATUS] = WITHDRAWAL_STATUS_PENDING;
      wbRow[WB.EXCEL_URL] = extract.url;
      wbRow[WB.EMAIL_SUBJECT] = subject;
      wbSheet.appendRow(wbRow);

      logAction_('CASH_WITHDRAWAL_REQUESTED', withdrawalId, session.displayName || session.role, session.role,
        sortedBatchIds.join(', ') + ' \u2014 ' + voucherIds.length + ' voucher(s), Rs. ' + reconciledTotal.toLocaleString('en-IN') +
        ' \u2014 sent as ' + sendingIdentity + ' to L2 (' + l2Emails.join(', ') + '), cc accounts (' + accountsEmails.join(', ') + '), remaining daily quota was ' + remainingQuota +
        (extract.missingVoucherIds.length > 0 ? ' \u2014 EXCLUDED (no RDS row found): ' + extract.missingVoucherIds.join(', ') : ''));

      return {
        success: true,
        withdrawalId: withdrawalId,
        voucherCount: voucherIds.length,
        totalAmount: reconciledTotal,
        message: 'Withdrawal request ' + withdrawalId + ' sent to L2 (' + l2Emails.length + ' recipient(s)), cc accounts.'
      };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('triggerCashWithdrawalRequest error: ' + err);
    return { success: false, error: 'Failed to send withdrawal request: ' + err.toString() };
  }
}

// Read-only RPC — same role gate as getEligibleWithdrawalBatches, for a
// "Withdrawal Requests" history panel (status, who requested, who decided).
function getCashWithdrawalBatchesLog(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (['accounts', 'admin', 'L2', 'auditor'].indexOf(session.role) === -1) {
      return { success: false, error: 'You do not have permission to view this.' };
    }
    var sheet = getOrCreateCashWithdrawalBatchesSheet_();
    var data = sheet.getDataRange().getValues();
    var rows = [];
    for (var i = 1; i < data.length; i++) {
      if (!safe_(data[i][WB.WITHDRAWAL_ID])) continue;
      rows.push({
        withdrawalId: safe_(data[i][WB.WITHDRAWAL_ID]), requestedDate: safe_(data[i][WB.REQUESTED_DATE]),
        requestedBy: safe_(data[i][WB.REQUESTED_BY]), batchIds: safe_(data[i][WB.BATCH_IDS]),
        periodFrom: safe_(data[i][WB.PERIOD_FROM]), periodTo: safe_(data[i][WB.PERIOD_TO]),
        voucherCount: data[i][WB.VOUCHER_COUNT] || 0, totalAmount: parseFloat(data[i][WB.TOTAL_AMOUNT]) || 0,
        status: safe_(data[i][WB.STATUS]), decidedBy: safe_(data[i][WB.DECIDED_BY]),
        decidedDate: safe_(data[i][WB.DECIDED_DATE]), decisionNotes: safe_(data[i][WB.DECISION_NOTES]),
        excelUrl: safe_(data[i][WB.EXCEL_URL])
      });
    }
    rows.reverse(); // most recent request first
    return { success: true, requests: rows };
  } catch (err) {
    Logger.log('getCashWithdrawalBatchesLog error: ' + err);
    return { success: false, error: 'Failed to load withdrawal history: ' + err.toString() };
  }
}

// Records the L2 decision on a withdrawal request.
//
// CHANGED 16 Sep 2026 (per explicit instruction): L2 now decides IN THE
// APP rather than replying by email and waiting for an admin to
// transcribe it. Both roles are accepted:
//   - 'L2'    : the intended path. L2 sees the request email, logs in,
//               approves (or rejects) here.
//   - 'admin' : retained as a fallback ONLY (L2 out of office, replied by
//               email, locked out). Admin was previously the only allowed
//               role; removing it would strand any request whose L2
//               cannot log in, so it stays — but WB.DECIDED_VIA now
//               records which of the two paths was used, so "did L2
//               actually click this themselves" is answerable from the
//               sheet rather than inferred from the Decided By name.
// Accounts is still deliberately NOT allowed: the role that raises the
// request must not be the role that approves it.
//
// On a decision, an email goes OUT to accounts with L2 in cc — the mirror
// image of the request email (to L2, cc accounts). It is sent as
// 'Re: <the request email's exact subject>' so both land in one Gmail
// conversation; see withdrawalRequestSubject_ above and the threading
// note on WB.EMAIL_SUBJECT in Config.gs.
//
// SEND BEFORE WRITE, for the same reason as triggerCashWithdrawalRequest:
// the notification IS the deliverable here, not a courtesy. If the
// decision were written first and the send then failed, the request would
// sit permanently Approved with accounts never told — and unretryable,
// because the Pending guard below would reject every further attempt.
// Sending first means a failed send leaves the request Pending and the
// button simply works on the next click. The cost of this ordering is the
// opposite, far milder failure: send succeeds, write throws, L2 clicks
// again and accounts gets a duplicate notification for a decision that is
// then correctly recorded.
//
// Within the write, WB.STATUS is set LAST. Every other decision column is
// written first, so a partial failure mid-write leaves the row Pending
// (retryable, metadata harmlessly overwritten on retry) and never
// half-decided.
//
// CONCURRENCY (2-3 L2 approvers, per explicit instruction to test this):
// the whole read-check-send-write sequence runs inside the script lock,
// and the Pending guard is evaluated against data read INSIDE that lock —
// never against the client's last fetch. Two L2s approving the same
// request at the same moment therefore serialize: the first wins and
// sends exactly one email; the second finds the status already decided,
// writes nothing, sends nothing, and gets an explicit error naming who
// decided it. A REJECTED decision reverts every voucher this request
// covered back to unbundled (AV.WITHDRAWAL_BATCH_ID cleared) so they are
// eligible for a corrected request — same mechanism as
// unmarkVouchersCashReleasedByRdsVoucherNo. An APPROVED decision is
// terminal and does not touch AV.WITHDRAWAL_BATCH_ID.
function decideCashWithdrawalBatch(withdrawalId, decision, notes, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.role) return { success: false, error: 'Session expired. Please log in again.' };
    if (session.role !== 'admin' && session.role !== 'L2') {
      return { success: false, error: 'You do not have permission to do this.' };
    }
    if (decision !== WITHDRAWAL_STATUS_APPROVED && decision !== WITHDRAWAL_STATUS_REJECTED) {
      return { success: false, error: 'Invalid decision.' };
    }
    withdrawalId = String(withdrawalId || '').trim();
    if (!withdrawalId) return { success: false, error: 'No withdrawal request specified.' };
    notes = String(notes == null ? '' : notes).trim();

    // Recipients are resolved BEFORE the lock (a Users-sheet read, not
    // part of the critical section) so a misconfiguration fails fast
    // without holding the script lock against everyone else.
    var accountsEmails = getActiveUserEmailsForRole_('accounts');
    if (accountsEmails.length === 0) {
      return { success: false, error: 'No active Accounts user has an email on file \u2014 the decision notification could not be delivered, so nothing was recorded. Add the email and try again.' };
    }
    var l2Emails = getActiveUserEmailsForRole_('L2');

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      Logger.log('decideCashWithdrawalBatch lock timeout: ' + lockErr);
      return { success: false, error: 'System is busy \u2014 another approval may be going through right now. Nothing was changed; refresh and try again in a few seconds.' };
    }

    try {
      var sheet = getOrCreateCashWithdrawalBatchesSheet_();
      var data = sheet.getDataRange().getValues();
      var rowIndex = -1;
      for (var i = 1; i < data.length; i++) {
        if (safe_(data[i][WB.WITHDRAWAL_ID]) === withdrawalId) { rowIndex = i; break; }
      }
      if (rowIndex === -1) return { success: false, error: 'Withdrawal request not found: ' + withdrawalId };
      var currentStatus = safe_(data[rowIndex][WB.STATUS]);
      if (currentStatus !== WITHDRAWAL_STATUS_PENDING) {
        // The concurrent-approver case. Naming who decided it and when
        // turns "it just failed" into "your colleague already did this",
        // which is the difference between a retry loop and a resolved
        // question.
        var alreadyBy = safe_(data[rowIndex][WB.DECIDED_BY]);
        var alreadyOn = safe_(data[rowIndex][WB.DECIDED_DATE]);
        return {
          success: false, alreadyDecided: true, status: currentStatus,
          error: 'This request was already ' + currentStatus.toLowerCase() + (alreadyBy ? ' by ' + alreadyBy : '') + (alreadyOn ? ' on ' + alreadyOn : '') +
            '. No second email was sent and nothing was changed.'
        };
      }

      var row = data[rowIndex];
      var totalAmount = parseFloat(row[WB.TOTAL_AMOUNT]) || 0;
      var periodFrom = safe_(row[WB.PERIOD_FROM]);
      var periodTo = safe_(row[WB.PERIOD_TO]);
      // Legacy rows (written before WB.EMAIL_SUBJECT existed) have no
      // stored subject — rebuild the identical string rather than send an
      // unthreaded one-off.
      var requestSubject = safe_(row[WB.EMAIL_SUBJECT]) || withdrawalRequestSubject_(totalAmount, periodFrom, periodTo);
      var decidedBy = session.displayName || session.role;
      var decidedVia = session.role === 'L2' ? WITHDRAWAL_DECIDED_VIA_APP : WITHDRAWAL_DECIDED_VIA_ADMIN;
      // DATE FORMAT FIX (per explicit instruction) — WB.DECIDED_DATE's
      // header is "Decided Date"; the SHEET cell now gets the same
      // dd-MM-yyyy every other date column uses. The email body keeps
      // full date+time (nowForEmail) — Accounts reading the notification
      // benefits from knowing what time of day it was decided, and that
      // line was never the thing reported as inconsistent.
      var now = formatDate_(new Date());
      var nowForEmail = new Date().toLocaleString('en-IN');

      var sendingIdentity = Session.getEffectiveUser().getEmail() || '(unknown \u2014 Session.getEffectiveUser() returned nothing)';
      var remainingQuota = MailApp.getRemainingDailyQuota();
      if (remainingQuota <= 0) {
        logAction_('CASH_WITHDRAWAL_DECISION_SEND_FAILED', withdrawalId, decidedBy, session.role,
          'Daily MailApp quota exhausted for ' + sendingIdentity + ' \u2014 decision NOT recorded, request left Pending, safe to retry once quota resets.');
        return { success: false, error: 'This deployment\u2019s email account (' + sendingIdentity + ') has used up its daily email quota, so Accounts could not be notified. The request is still Pending and nothing was changed \u2014 try again after the quota resets.' };
      }

      var subject = 'Re: ' + requestSubject;
      // Email content lives in Notifications.gs (withdrawalDecisionText_ / Html_).
      // Subject ('Re: ' + the stored request subject) is unchanged, so this
      // still threads onto the original request.
      var decisionMail = {
        withdrawalId: withdrawalId, decision: decision, approved: decision === WITHDRAWAL_STATUS_APPROVED,
        decidedBy: decidedBy, decidedByRole: withdrawalDeciderLabel_(session.role, session.designation), decidedOn: nowForEmail,
        batchIds: safe_(row[WB.BATCH_IDS]), periodFrom: periodFrom, periodTo: periodTo,
        voucherCount: (row[WB.VOUCHER_COUNT] || 0), totalAmount: totalAmount, notes: notes
      };
      var decisionBodyText = withdrawalDecisionText_(decisionMail);

      try {
        sendNotification_({
          to: accountsEmails.join(','),
          cc: l2Emails.join(','),
          subject: subject,
          body: decisionBodyText
        }, function (hasLogo) { return withdrawalDecisionHtml_(decisionMail, getAppUrl_(), hasLogo); });
      } catch (mailErr) {
        Logger.log('decideCashWithdrawalBatch: MailApp.sendEmail failed, sending as ' + sendingIdentity + ': ' + mailErr);
        logAction_('CASH_WITHDRAWAL_DECISION_SEND_FAILED', withdrawalId, decidedBy, session.role,
          'MailApp.sendEmail failed sending as ' + sendingIdentity + ' to accounts (' + accountsEmails.join(', ') + '): ' + mailErr +
          ' \u2014 decision NOT recorded, request left Pending, safe to retry.');
        return { success: false, error: 'Failed to notify Accounts by email (sending as ' + sendingIdentity + '): ' + mailErr.toString() + '. The request is still Pending and nothing was changed \u2014 fix the underlying issue and try again.' };
      }

      // Email is out. Now record the decision — STATUS last, so a failure
      // part-way leaves the row Pending rather than half-decided.
      sheet.getRange(rowIndex + 1, WB.DECIDED_BY + 1).setValue(decidedBy);
      sheet.getRange(rowIndex + 1, WB.DECIDED_DATE + 1).setValue(now);
      sheet.getRange(rowIndex + 1, WB.DECISION_NOTES + 1).setValue(notes);
      sheet.getRange(rowIndex + 1, WB.DECIDED_VIA + 1).setValue(decidedVia);
      sheet.getRange(rowIndex + 1, WB.STATUS + 1).setValue(decision);

      var revertedCount = 0;
      if (decision === WITHDRAWAL_STATUS_REJECTED) {
        var avSheet = getSheet_(ALL_VOUCHERS_SHEET);
        var avData = avSheet.getDataRange().getValues();
        for (var r = 1; r < avData.length; r++) {
          if (safe_(avData[r][AV.WITHDRAWAL_BATCH_ID]) !== withdrawalId) continue;
          avSheet.getRange(r + 1, AV.WITHDRAWAL_BATCH_ID + 1).setValue('');
          revertedCount++;
        }
      }

      logAction_('CASH_WITHDRAWAL_' + decision.toUpperCase(), withdrawalId, decidedBy, session.role,
        decision + ' via ' + decidedVia + (notes ? ' \u2014 ' + notes : '') +
        ' \u2014 notified accounts (' + accountsEmails.join(', ') + ') cc L2 (' + l2Emails.join(', ') + ') as ' + sendingIdentity +
        ', remaining daily quota was ' + remainingQuota +
        (revertedCount > 0 ? ' \u2014 ' + revertedCount + ' voucher(s) reverted, eligible for a future request' : ''));

      return {
        success: true,
        message: decision === WITHDRAWAL_STATUS_APPROVED
          ? 'Withdrawal request ' + withdrawalId + ' approved. Accounts has been emailed (you are in cc).'
          : 'Withdrawal request ' + withdrawalId + ' rejected. Accounts has been emailed (you are in cc). ' + revertedCount + ' voucher(s) are eligible for a future request.'
      };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('decideCashWithdrawalBatch error: ' + err);
    return { success: false, error: 'Failed to record decision: ' + err.toString() };
  }
}