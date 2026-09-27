// ============================================================================
// TRIGGERS — reserved for the future Tally-ready monthly export sheet
// ============================================================================
//
// Nothing in the app is monthly right now — "All Vouchers" and "Rabale
// Daily Sync" are both single ongoing sheets, same as always. This file is
// intentionally close to empty: the monthly-rollover pattern (a template
// tab cloned into "Vouchers 2026-08" etc.) was built here by mistake in an
// earlier version and has been rolled back.
//
// The actual future use for month-wise sheets is the Tally-ready import
// export you asked for — a separate sheet from Rabale Daily Sync, not a
// replacement for it, generated in the shape the Tally-export prototype
// produces (Rabale Petty Expenses / Journal / Petty Cash voucher types).
// That's not built yet. When it is, a daily trigger like the one this file
// used to contain will make sense again, pointed at that sheet instead of
// at vouchers.
// ============================================================================

// ============================================================================
// QUERY AGING REMINDER (per explicit instruction) — a daily email digest of
// every query that's been open QUERY_REMINDER_AGE_DAYS or longer, so
// Warehouse doesn't let one sit unanswered. Wired to a daily time-based
// trigger via setupQueryReminderTrigger() below, which only needs to be
// run ONCE from the Apps Script editor (same manual-setup convention as
// every other one-time migration in this codebase) — it creates the
// actual recurring trigger; sendQueryAgingReminders itself does nothing
// on its own until that trigger calls it daily.
// ============================================================================

// Query Thread's RAISED_DATE is written as a locale-formatted string
// (see raiseVoucherQuery, Approval.gs — `new Date().toLocaleString('en-IN')`,
// not a real Date), and Sheets MAY or may not auto-convert that on write
// depending on the cell's prior format. This tolerates either: uses the
// cell's own Date value if Sheets already converted it, otherwise falls
// back to re-parsing the string. This is only ever used for a "how many
// days has this been open" reminder heuristic, not for anything
// financial, so an occasional off-by-a-few-hours read here is low-stakes
// — unlike AV.DATE, which gets the strict, locked-format treatment
// elsewhere in this codebase because real money accounting depends on it.
function parseQueryRaisedDate_(val) {
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  var fallback = new Date(val);
  return isNaN(fallback.getTime()) ? null : fallback;
}

// Every OPEN query with a readable raised-date, oldest information first
// as read (caller sorts). ageExact is fractional days; ageDays is whole.
function readOpenQueries_(now) {
  var sheet = getSheet_(QUERY_THREAD_SHEET);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (safe_(data[i][QT.STATUS]) !== 'Open') continue;
    var raised = parseQueryRaisedDate_(data[i][QT.RAISED_DATE]);
    if (!raised) continue;
    var ageExact = (now.getTime() - raised.getTime()) / (1000 * 60 * 60 * 24);
    out.push({
      voucherId: safe_(data[i][QT.VOUCHER_ID]),
      queryType: safe_(data[i][QT.QUERY_TYPE]),
      raisedBy: safe_(data[i][QT.RAISED_BY]),
      raisedByPosition: lookupDesignationByName_(safe_(data[i][QT.RAISED_BY])),
      details: safe_(data[i][QT.QUERY_DETAILS]),
      raised: raised,
      ageExact: ageExact,
      ageDays: Math.floor(ageExact)
    });
  }
  return out;
}

// voucherId -> {submittedBy, amount}, so a query email can say whose
// voucher it is and for how much without a second lookup per row. A voucher
// that cannot be found just gets blanks; the email is never blocked by it.
function getVoucherBriefsById_() {
  var map = {};
  try {
    var sheet = getSheet_(ALL_VOUCHERS_SHEET);
    if (!sheet) return map;
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var vid = safe_(data[i][AV.VOUCHER_ID]);
      if (vid) map[vid] = { submittedBy: safe_(data[i][AV.SUBMITTED_BY]), amount: parseFloat(data[i][AV.AMOUNT]) || 0 };
    }
  } catch (err) {
    Logger.log('getVoucherBriefsById_ error: ' + err);
  }
  return map;
}

function attachVoucherBriefs_(queries) {
  var briefs = getVoucherBriefsById_();
  return queries.map(function (q) {
    var b = briefs[q.voucherId] || {};
    var copy = {};
    for (var k in q) copy[k] = q[k];
    copy.employee = b.submittedBy || '';
    copy.amount = (b.amount === undefined) ? null : b.amount;
    return copy;
  });
}

// kind: 'sameday' (to submission staff, raised today) or 'aging' (to the
// QUERY_REMINDER_EMAIL address, open QUERY_REMINDER_AGE_DAYS+ days).
// queries: readOpenQueries_ items, optionally with employee/amount attached.
// recipient (optional) is {displayName, designation}: the email then greets that person by name and
// position, the same as the approver digest. Without it (the aging email to a shared address, previews)
// there is no greeting.
// Returns {subject, body, htmlBody}. Subjects are exactly what these two emails have always sent.
function buildQueryReminderEmail_(kind, queries, appUrl, hasLogo, recipient) {
  var aging = kind === 'aging';
  var n = queries.length;
  var word = n === 1 ? 'y' : 'ies';
  var subject = aging ? n + ' voucher quer' + word + ' overdue for a response' : n + ' voucher quer' + word + ' from today still open';

  var lines = queries.map(function (q) {
    return '\u2022 Voucher ' + q.voucherId + ' \u2014 ' + q.queryType + ', ' + (aging ? 'open ' + q.ageDays + ' day(s), ' : '') + 'raised by ' + nameWithPosition_(q.raisedBy, q.raisedByPosition) +
      (q.details ? '\n  "' + q.details.substring(0, 150) + '"' : '');
  });
  var lead = aging
    ? n + ' quer' + (n === 1 ? 'y has' : 'ies have') + ' been open ' + QUERY_REMINDER_AGE_DAYS + '+ days and need a response:'
    : n + ' quer' + (n === 1 ? 'y was' : 'ies were') + ' raised today and still ' + (n === 1 ? 'needs' : 'need') + ' a response:';
  var greeting = (recipient && recipient.displayName) ? 'Hello ' + nameWithPosition_(recipient.displayName, recipient.designation) + ',\n\n' : '';
  var body = greeting + lead + '\n\n' + lines.join('\n\n') + '\n\nOpen the Rabale Petty Expense System > My Vouchers > Query filter to respond.';

  var shown = queries.slice(0, QUERY_EMAIL_MAX_ROWS);
  var extra = n - shown.length;
  var columns = [
    { label: 'Voucher', nowrap: true },
    { label: 'Employee' },
    { label: 'Rs.', align: 'right', nowrap: true, mono: true },
    { label: aging ? 'Open' : 'Raised', align: 'right', nowrap: true }
  ];
  var rows = shown.map(function (q) {
    var severe = aging && q.ageDays >= QUERY_REMINDER_AGE_DAYS * 2;
    return {
      cells: [
        { h: emailEsc_(q.voucherId), c: 'vid', s: 'font-weight:bold;color:#2E3192;' },
        emailNoAutoLink_(q.employee || '\u2014'),
        (q.amount === null || q.amount === undefined) ? '\u2014' : emailEsc_(emailMoney_(q.amount)),
        aging ? { h: q.ageDays + 'd', c: severe ? 'overdue' : '', s: severe ? 'color:#C0433F;font-weight:bold;' : 'font-weight:bold;' } : 'Today'
      ],
      detail: '<b style="color:#14173F;">' + emailNoAutoLink_(q.queryType) + '</b> \u00b7 raised by ' + emailNoAutoLink_(nameWithPosition_(q.raisedBy, q.raisedByPosition)) +
        (q.details ? ' \u2014 \u201c' + emailEsc_(q.details.substring(0, 150)) + '\u201d' : '')
    };
  });
  var blocks = [];
  if (recipient && recipient.displayName) {
    blocks.push('<div style="font-size:14px;color:#14173F;">Hello <b>' + emailNoAutoLink_(recipient.displayName) + '</b>' +
      (recipient.designation ? ' <span style="color:#454B6B;">(' + emailNoAutoLink_(recipient.designation) + ')</span>' : '') + ',</div>');
  }
  blocks.push(emailTable_(columns, rows));
  if (extra > 0) blocks.push('<div style="font-size:11.5px;color:#5F6684;">+ ' + extra + ' more \u2014 open the app to see them all.</div>');
  blocks.push(emailNotice_(aging ? 'danger' : 'warn', aging
    ? 'These have waited ' + QUERY_REMINDER_AGE_DAYS + ' days or more. A voucher with an open query cannot move to the next approval stage until the submitter responds.'
    : 'A voucher with an open query cannot move to the next approval stage until you respond. Open <b>My Vouchers</b> and use the <b>Query</b> filter.'));

  var htmlBody = buildBrandedEmail_({
    title: aging ? emailPlural_(n, 'query', 'queries') + ' overdue for a response' : emailPlural_(n, 'query', 'queries') + ' raised today, still open',
    subtitle: aging ? 'Open ' + QUERY_REMINDER_AGE_DAYS + '+ days \u00b7 oldest first' : 'Needs a response from the submitter',
    preheader: subject, blocks: blocks, ctaLabel: 'Open My Vouchers', ctaUrl: appUrl, hasLogo: hasLogo,
    footer: aging ? 'Sent automatically each morning by the Rabale Petty Expense System.' : 'Sent automatically each evening by the Rabale Petty Expense System.'
  });
  return { subject: subject, body: body, htmlBody: htmlBody };
}

// Dry run, callable from the Apps Script editor: emails both query-reminder
// layouts, filled with whatever queries are open right now (any age), to the
// person running it and nobody else. Sends nothing if no query is open.
function previewQueryReminderEmailsToMe() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var me = Session.getEffectiveUser().getEmail();
  if (!me) { Logger.log('previewQueryReminderEmailsToMe: could not determine your email address.'); return; }
  var all = readOpenQueries_(new Date());
  if (all.length === 0) { Logger.log('previewQueryReminderEmailsToMe: no open queries right now, so nothing was sent.'); return; }
  all.sort(function (a, b) { return b.ageDays - a.ageDays; });
  all = attachVoucherBriefs_(all);
  var logo = getEmailLogoBlob_();
  var url = getAppUrl_();
  ['sameday', 'aging'].forEach(function (kind) {
    var msg = buildQueryReminderEmail_(kind, all, url, !!logo);
    sendBrandedEmail_({ to: me, subject: '[PREVIEW ' + kind + '] ' + msg.subject, body: msg.body, htmlBody: msg.htmlBody, logo: logo });
  });
  Logger.log('previewQueryReminderEmailsToMe: sent both layouts to ' + me + ' using ' + all.length + ' open query(ies).');
}


function sendQueryAgingReminders() {
  try {
    var recipient = getQueryReminderEmail_();
    if (!recipient) {
      Logger.log('sendQueryAgingReminders: QUERY_REMINDER_EMAIL not configured, skipping.');
      return;
    }

    var aging = readOpenQueries_(new Date()).filter(function (q) { return q.ageExact >= QUERY_REMINDER_AGE_DAYS; });
    if (aging.length === 0) return; // nothing overdue — no email, no noise

    aging.sort(function (a, b) { return b.ageDays - a.ageDays; });
    var logo = getEmailLogoBlob_();
    var msg = buildQueryReminderEmail_('aging', attachVoucherBriefs_(aging), getAppUrl_(), !!logo);
    sendBrandedEmail_({ to: recipient, subject: msg.subject, body: msg.body, htmlBody: msg.htmlBody, logo: logo });
    logAction_('QUERY_REMINDER_SENT', '', 'system', 'system', aging.length + ' overdue query(ies) emailed to ' + recipient + ': ' + aging.map(function (q) { return q.voucherId; }).join(', '));
  } catch (err) {
    Logger.log('sendQueryAgingReminders error: ' + err);
  }
}

// One-time setup — run manually from the Apps Script editor. Removes any
// existing trigger pointed at sendQueryAgingReminders first (idempotent:
// safe to re-run, e.g. after changing the hour), then creates a fresh
// daily trigger at QUERY_REMINDER_HOUR:QUERY_REMINDER_MINUTE (Config.gs), script timezone.
function setupQueryReminderTrigger() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendQueryAgingReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendQueryAgingReminders').timeBased().everyDays(1).atHour(QUERY_REMINDER_HOUR).nearMinute(QUERY_REMINDER_MINUTE).create();
  Logger.log('setupQueryReminderTrigger: daily trigger created for sendQueryAgingReminders, around ' + QUERY_REMINDER_HOUR + ':' + ('0' + QUERY_REMINDER_MINUTE).slice(-2) + ' (within 15 minutes).');
}

// ============================================================================
// SAME-DAY QUERY REMINDER (bugfix round, per explicit instruction) —
// replaces the removed in-app notification bell as the actual mechanism
// for "submission finds out a query needs a response." Distinct from
// sendQueryAgingReminders above: that one is a slow, multi-day escalation
// digest to a single fixed admin address; this one is urgent same-day
// coverage — anything raised TODAY and still open tonight gets emailed to
// every active submission user (one branded email each, greeted by name) so it's sitting in
// their inbox first thing tomorrow, rather than waiting up to
// QUERY_REMINDER_AGE_DAYS days to surface at all.
// ============================================================================

// Calendar-day-only comparison against "today", mirroring
// isFutureCalendarDate's own reasoning (Vouchers.gs) — a query "raised
// today" means the same calendar day the trigger is running on, not
// "within the last 24 hours" (which would incorrectly catch/miss queries
// near midnight depending on exact raise time).
function wasRaisedToday_(raisedDate, now) {
  if (!raisedDate) return false;
  return raisedDate.getFullYear() === now.getFullYear() &&
    raisedDate.getMonth() === now.getMonth() &&
    raisedDate.getDate() === now.getDate();
}

function sendSameDayQueryReminders() {
  try {
    var now = new Date();
    var todaysOpen = readOpenQueries_(now).filter(function (q) { return wasRaisedToday_(q.raised, now); });
    if (todaysOpen.length === 0) return; // nothing raised today is still open — no email, no noise

    var logo = getEmailLogoBlob_();
    var briefs = attachVoucherBriefs_(todaysOpen);
    var appUrl = getAppUrl_();
    var recipients = getActiveUsersForRole_('submission');
    if (recipients.length === 0) Logger.log('sendSameDayQueryReminders: no active submission user with an email on file \u2014 nobody to notify.');
    var sentCount = 0;
    recipients.forEach(function (rcpt) {
      try {
        // built per person so each is greeted by their own name and position, like the approver digest
        var msg = buildQueryReminderEmail_('sameday', briefs, appUrl, !!logo, rcpt);
        sendBrandedEmail_({ to: rcpt.email, subject: msg.subject, body: msg.body, htmlBody: msg.htmlBody, logo: logo });
        sentCount++;
      } catch (mailErr) {
        Logger.log('sendSameDayQueryReminders: failed to email ' + rcpt.email + ': ' + mailErr);
      }
    });
    logAction_('SAME_DAY_QUERY_REMINDER_SENT', '', 'system', 'system', todaysOpen.length + ' query(ies) emailed to ' + sentCount + ' submission user(s): ' + todaysOpen.map(function (q) { return q.voucherId; }).join(', '));
  } catch (err) {
    Logger.log('sendSameDayQueryReminders error: ' + err);
  }
}

// One-time setup — run manually from the Apps Script editor, same
// convention as setupQueryReminderTrigger above. Fires at
// SAME_DAY_QUERY_REMINDER_HOUR (Config.gs, default 21 = 9pm).
function setupSameDayQueryReminderTrigger() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendSameDayQueryReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendSameDayQueryReminders').timeBased().everyDays(1).atHour(SAME_DAY_QUERY_REMINDER_HOUR).create();
  Logger.log('setupSameDayQueryReminderTrigger: daily ' + SAME_DAY_QUERY_REMINDER_HOUR + ':00 trigger created for sendSameDayQueryReminders.');
}

// ============================================================================
// APPROVER DAILY DIGEST (per explicit instruction) — every active L1,
// Accounts and L2 user with an email on file gets ONE email each morning
// listing the vouchers currently waiting on THEIR stage, oldest first, so
// nothing sits unnoticed between logins. Separate from the two query
// reminders above: those are about queries raised on vouchers (aimed at
// submission staff); this is about vouchers waiting for an approval
// decision (aimed at approvers).
//
// Rules (all deliberate):
//   - "Awaiting you" = at your stage AND no open query. That is the exact
//     rule the Approval Queue uses to hide Approve/Reject (see
//     renderVouchers in Main.gs), so the email never lists something the
//     approver cannot act on. Queried vouchers are counted separately as
//     "held on a query" — the submitter has to respond, nothing for the
//     approver to do.
//   - No awaiting vouchers at your stage = no email (no noise, same
//     convention as sendQueryAgingReminders).
//   - Read-only. Never changes a voucher, balance, status or sheet.
//   - "Age" is days since the voucher's submission date (AV.DATE). Stage-
//     level timestamps are not recorded, so it cannot be "days at this
//     stage" — the email labels it accordingly.
//   - Recipients come from the Users sheet (active, role match, email on
//     file) via getActiveUsersForRole. An approver with no email on
//     file gets nothing; a stage with vouchers waiting but NO recipient is
//     written to the Audit Log so the gap is visible instead of silent.
//   - Layout/markup lives in EmailTemplates.gs, shared with every other
//     branded email.
// ============================================================================
// Names of the approval STEPS (workflow terms), not of people: the person is
// identified by their own name and position in the greeting, so the email never
// calls someone an "L1 Approver" — an access level — instead of what they are.
var DIGEST_STAGE_LABELS = { 'L1': 'Level 1 approval', 'accounts': 'Accounts approval', 'L2': 'Level 2 approval' };

// Returns { L1: {awaiting:[], onQuery:[]}, accounts: {...}, L2: {...} }.
// awaiting is sorted oldest first, then largest amount first.
function collectPendingVouchersByStage_() {
  var byRole = {};
  var roleByStatus = {};
  APPROVAL_SEQUENCE.forEach(function (r) {
    byRole[r] = { awaiting: [], onQuery: [] };
    roleByStatus[STATUS_FOR_ROLE[r]] = r;
  });
  var sheet = getSheet_(ALL_VOUCHERS_SHEET);
  if (!sheet) return byRole;
  var data = sheet.getDataRange().getValues();
  var todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var vid = safe_(row[AV.VOUCHER_ID]);
    if (!vid) continue;
    var role = roleByStatus[safe_(row[AV.STATUS])];
    if (!role) continue;
    var submitted = parseRdsDateString_(safe_(row[AV.DATE]));
    var item = {
      voucherId: vid,
      date: emailDate_(safe_(row[AV.DATE])),
      ageDays: Math.max(0, Math.round((todayStart.getTime() - submitted.getTime()) / 86400000)),
      submittedBy: safe_(row[AV.SUBMITTED_BY]),
      costCentre: safe_(row[AV.COST_CENTRE]),
      amount: parseFloat(row[AV.AMOUNT]) || 0
    };
    var queryStatus = safe_(row[AV.QUERY_STATUS]) || 'No Query';
    (queryStatus === 'No Query' ? byRole[role].awaiting : byRole[role].onQuery).push(item);
  }
  APPROVAL_SEQUENCE.forEach(function (r) {
    byRole[r].awaiting.sort(function (a, b) { return (b.ageDays - a.ageDays) || (b.amount - a.amount); });
    byRole[r].onQuery.sort(function (a, b) { return b.ageDays - a.ageDays; });
  });
  return byRole;
}

// Pure function: subject / plain-text / HTML for one stage. recipient is
// {displayName, designation} for a real send (the email greets them by name
// and position) or null for a preview.
function buildApproverDigest_(role, byRole, appUrl, hasLogo, recipient) {
  var mine = byRole[role];
  var awaiting = mine.awaiting;
  var label = DIGEST_STAGE_LABELS[role] || role;
  var n = awaiting.length;
  var total = 0;
  awaiting.forEach(function (v) { total += v.amount; });
  var oldest = n ? awaiting[0].ageDays : 0;
  var shown = awaiting.slice(0, APPROVER_DIGEST_MAX_ROWS);
  var extra = n - shown.length;
  var pipeline = APPROVAL_SEQUENCE.map(function (r) { return [STATUS_FOR_ROLE[r], byRole[r].awaiting.length + byRole[r].onQuery.length]; });

  var subject = 'Approval digest: ' + emailPlural_(n, 'voucher') + ' awaiting your approval' +
    (oldest > 0 ? ' (oldest ' + emailPlural_(oldest, 'day') + ')' : '');

  // ---- plain text (fallback for clients that do not render HTML)
  var t = [];
  if (recipient && recipient.displayName) { t.push('Hello ' + nameWithPosition_(recipient.displayName, recipient.designation) + ','); t.push(''); }
  t.push(emailPlural_(n, 'voucher') + ' awaiting your decision in the ' + label + ' queue (total Rs. ' + emailMoney_(total) + ').');
  t.push('');
  shown.forEach(function (v) {
    t.push('\u2022 ' + v.voucherId + ' | submitted ' + v.date + ' (' + emailPlural_(v.ageDays, 'day') + ' ago) | ' + v.submittedBy +
      ' | ' + v.costCentre + ' | Rs. ' + emailMoney_(v.amount));
  });
  if (extra > 0) t.push('+ ' + extra + ' more \u2014 open the app to see them all.');
  if (mine.onQuery.length) {
    t.push('');
    t.push(emailPlural_(mine.onQuery.length, 'more voucher') + ' at your stage ' + (mine.onQuery.length === 1 ? 'is' : 'are') +
      ' on hold because a query is open (the submitter must respond first): ' +
      mine.onQuery.slice(0, 10).map(function (v) { return v.voucherId; }).join(', ') + (mine.onQuery.length > 10 ? ', \u2026' : ''));
  }
  t.push('');
  t.push('Whole pipeline right now: ' + pipeline.map(function (p) { return p[0] + ' ' + p[1]; }).join(' | '));
  if (appUrl) { t.push(''); t.push('Open the app: ' + appUrl); }
  t.push('');
  t.push('Sent automatically each morning by the Rabale Petty Expense System.');

  // ---- HTML
  var columns = [
    { label: 'Voucher', nowrap: true },
    { label: 'Submitted', nowrap: true, hideSmall: true },
    { label: 'Age', align: 'right', nowrap: true },
    { label: 'By' },
    { label: 'Cost centre', hideSmall: true },
    { label: 'Rs.', align: 'right', nowrap: true, mono: true }
  ];
  var rows = shown.map(function (v) {
    var overdue = v.ageDays >= APPROVER_DIGEST_OVERDUE_DAYS;
    return { cells: [
      { h: emailEsc_(v.voucherId), c: 'vid', s: 'font-weight:bold;color:#2E3192;' },
      emailEsc_(v.date),
      { h: v.ageDays + 'd', c: overdue ? 'overdue' : '', s: overdue ? 'color:#C0433F;font-weight:bold;' : '' },
      emailNoAutoLink_(v.submittedBy),
      emailNoAutoLink_(v.costCentre),
      emailEsc_(emailMoney_(v.amount))
    ] };
  });
  var blocks = [];
  if (recipient && recipient.displayName) {
    blocks.push('<div style="font-size:14px;color:#14173F;">Hello <b>' + emailNoAutoLink_(recipient.displayName) + '</b>' +
      (recipient.designation ? ' <span style="color:#454B6B;">(' + emailNoAutoLink_(recipient.designation) + ')</span>' : '') + ',</div>');
  }
  blocks.push(emailTable_(columns, rows));
  blocks.push('<div style="font-size:11.5px;color:#5F6684;">' + (extra > 0 ? '+ ' + extra + ' more, oldest first \u2014 open the app to see them all. &nbsp;\u00b7&nbsp; ' : '') +
    'Age = days since the voucher was submitted. Red = ' + APPROVER_DIGEST_OVERDUE_DAYS + ' days or more.</div>');
  if (mine.onQuery.length) {
    blocks.push(emailNotice_('warn', '<b>' + emailEsc_(emailPlural_(mine.onQuery.length, 'more voucher')) + '</b> at your stage ' + (mine.onQuery.length === 1 ? 'is' : 'are') +
      ' on hold because a query is open \u2014 the submitter must respond first, nothing for you to do: ' +
      emailEsc_(mine.onQuery.slice(0, 10).map(function (v) { return v.voucherId; }).join(', ')) + (mine.onQuery.length > 10 ? ', \u2026' : '')));
  }
  blocks.push('<div style="font-size:12.5px;color:#454B6B;">Whole pipeline right now: ' + pipeline.map(function (p) {
    return '<b>' + emailEsc_(p[0]) + '</b> ' + p[1];
  }).join(' &nbsp;\u00b7&nbsp; ') + '</div>');

  var htmlBody = buildBrandedEmail_({
    title: emailPlural_(n, 'voucher') + ' awaiting your approval',
    subtitle: label + ' queue \u00b7 total Rs. ' + emailMoney_(total) + (oldest > 0 ? ' \u00b7 oldest waiting ' + emailPlural_(oldest, 'day') : ''),
    preheader: emailPlural_(n, 'voucher') + ' waiting for your decision' + (oldest > 0 ? ', oldest ' + emailPlural_(oldest, 'day') : ''),
    blocks: blocks, ctaLabel: 'Open the Approval Queue', ctaUrl: appUrl, hasLogo: hasLogo,
    footer: 'Sent automatically each morning by the Rabale Petty Expense System.'
  });
  return { subject: subject, body: t.join('\n'), htmlBody: htmlBody };
}

// previewTo = null for the real send; an address for a dry run that emails
// only that one person (see previewApproverDigestsToMe).
function runApproverDigests_(previewTo) {
  try {
    var byRole = collectPendingVouchersByStage_();
    var appUrl = getAppUrl_();
    var logo = getEmailLogoBlob_();
    var summary = [];
    APPROVAL_SEQUENCE.forEach(function (role) {
      var awaitingCount = byRole[role].awaiting.length;
      if (awaitingCount === 0) return;
      var recipients = previewTo ? [{ email: previewTo, displayName: '', designation: '' }] : getActiveUsersForRole_(role);
      if (recipients.length === 0) {
        summary.push(role + ': ' + awaitingCount + ' awaiting but NO active user with an email on file');
        return;
      }
      var sent = 0;
      recipients.forEach(function (rcpt) {
        try {
          // built per recipient so each one is greeted by their own name and position
          var msg = buildApproverDigest_(role, byRole, appUrl, !!logo, previewTo ? null : rcpt);
          sendBrandedEmail_({ to: rcpt.email, subject: (previewTo ? '[PREVIEW ' + role + '] ' : '') + msg.subject, body: msg.body, htmlBody: msg.htmlBody, logo: logo });
          sent++;
        } catch (mailErr) {
          Logger.log('runApproverDigests_: failed to email ' + rcpt.email + ': ' + mailErr);
        }
      });
      summary.push(role + ': ' + awaitingCount + ' awaiting, emailed ' + sent + ' of ' + recipients.length);
    });
    if (summary.length > 0) {
      logAction_(previewTo ? 'APPROVER_DIGEST_PREVIEW' : 'APPROVER_DIGEST_SENT', '', 'system', 'system', summary.join(' | '));
    }
    return summary;
  } catch (err) {
    Logger.log('runApproverDigests_ error: ' + err);
    return [];
  }
}

// The function the daily trigger calls.
function sendApproverDigests() {
  runApproverDigests_(null);
}

// Dry run, callable from the Apps Script editor: sends each stage's digest
// to whoever is running it (the deploying user) and NOBODY else, so the
// layout and the logo can be checked without emailing any approver.
function previewApproverDigestsToMe() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var me = Session.getEffectiveUser().getEmail();
  if (!me) { Logger.log('previewApproverDigestsToMe: could not determine your email address.'); return; }
  var summary = runApproverDigests_(me);
  Logger.log('previewApproverDigestsToMe: ' + (summary.length ? summary.join(' | ') : 'nothing awaiting at any stage, so nothing was sent.'));
}

// One-time setup (also part of setupAllScheduledTriggers): idempotent,
// safe to re-run after changing APPROVER_DIGEST_HOUR.
function setupApproverDigestTrigger() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendApproverDigests') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendApproverDigests').timeBased().everyDays(1).atHour(APPROVER_DIGEST_HOUR).create();
  Logger.log('setupApproverDigestTrigger: daily ' + APPROVER_DIGEST_HOUR + ':00 trigger created for sendApproverDigests.');
}

// ============================================================================
// RDS DAY BOUNDARY (redesign, per explicit instruction) — replaces the old
// PURELY REACTIVE day-open check inside updateRabaleDailySync (Sheet
// Utils.gs), which only ever created an Opening Balance row when the NEXT
// voucher happened to land on a different calendar day than the last row
// in the sheet. That's fine when vouchers are typed in same-day, but it
// silently breaks under a real filing backlog: if warehouse staff skip 2-3
// days of paperwork under workload and then file it all at once, those 2-3
// calendar days never get their own Opening Balance row at all — they
// collapse into a single block the moment the backlog finally arrives,
// with no day boundary in between. That's exactly the failure mode a
// day-by-day Cash Advance breakdown depends on NOT happening.
//
// closeRdsDay() runs on its own daily trigger, independent of whether any
// voucher is ever submitted that day, and guarantees today's Opening
// Balance row exists before the day's first voucher (if any) can arrive.
// updateRabaleDailySync's own isNewDay check is untouched and remains in
// place as a defensive fallback (it becomes a no-op on any day this
// trigger already ran, since the row it would create already exists) —
// belt-and-braces in case the trigger is ever deleted or misfires.
// ============================================================================

// Idempotent and safe to run more than once on the same day: if today's
// Opening Balance row already exists (e.g. a voucher was submitted at
// 12:01am, before this trigger's own run), this is a no-op.
function closeRdsDay() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    Logger.log('closeRdsDay: lock timeout — will retry on tomorrow\u2019s trigger run.');
    logAction_('SYNC_WARNING', '', 'system', 'system', 'closeRdsDay busy \u2014 today\u2019s day-open skipped, next trigger run will retry.');
    return;
  }
  try {
    var ss = SpreadsheetApp.openById(getRdsSpreadsheetId_());
    var today = new Date();
    var monthInfo = getOrCreateRdsMonthSheet_(ss, today);
    var sheet = monthInfo.sheet;
    var colCount = Math.max(sheet.getLastColumn(), RS.CASH_GIVEN_BY_ACCOUNTS + 1);

    var lastRow = sheet.getLastRow();
    var lastDateVal = lastRow >= 2 ? sheet.getRange(lastRow, RS.DATE + 1).getValue() : null;
    var todayAlreadyOpen = !monthInfo.isNewSheet && lastRow >= 2 && isSameCalendarDay_(lastDateVal, today);
    if (todayAlreadyOpen) {
      Logger.log('closeRdsDay: today\u2019s Opening Balance row already exists, nothing to do.');
      return;
    }

    // ADDED (25 Aug 2026, RDS Advance/Closing Balance feature, Option A \u2014
    // confirmed design) — before opening the new day below, write the day
    // being CLOSED's consolidated staff-to-staff Cash Advances total onto
    // its own last row (whichever row that already is: the day's last
    // voucher, or its own Opening Balance row if zero vouchers were filed
    // that day) rather than inserting a new synthetic row. Advance = that
    // day's total from the Cash Advances sheet; Actual Cash in Hand =
    // that row's own Cash in Hand minus Advance. A per-person breakdown
    // goes on the Advance cell via setNote() so the consolidated figure
    // stays auditable without adding rows. The row is bolded to read as
    // the day's closing snapshot, same treatment Opening Balance/Cash
    // Given rows already get \u2014 and recomputeRdsCashInHand (Sheet
    // Utils.gs) now recognizes a populated RS.ADVANCE cell as its own
    // "keep this row bold" case, so the formatting survives any future
    // recompute triggered by an unrelated voucher elsewhere in the same
    // month tab, not just the moment it's set here.
    //
    // Guarded by RS.ADVANCE already being blank on that row (safe() on a
    // real 0 returns '0', not '' \u2014 so a day that genuinely had zero
    // advances still only gets written once) — a retried trigger run
    // after a lock-timeout must never double-count a day's advances.
    // Only runs when there's an actual previous day's block to close
    // (lastRow >= 2); a brand-new sheet's very first run has nothing yet.
    if (lastRow >= 2) {
      var closingAdvanceCell = sheet.getRange(lastRow, RS.ADVANCE + 1);
      if (safe_(closingAdvanceCell.getValue()) === '') {
        var closingCashInHand = getLastCashInHandFromSheet_(sheet);
        if (closingCashInHand !== null) {
          var closingSummary = getCashAdvancesGivenOnDate_(lastDateVal);
          closingAdvanceCell.setValue(closingSummary.total);
          sheet.getRange(lastRow, RS.ACTUAL_CASH_IN_HAND + 1).setValue(closingCashInHand - closingSummary.total);
          if (closingSummary.byPerson.length > 0) {
            var noteLines = closingSummary.byPerson.map(function (p) { return p.name + ': Rs. ' + p.amount.toLocaleString('en-IN'); });
            closingAdvanceCell.setNote('Cash advances given ' + formatDate_(lastDateVal) + ':\n' + noteLines.join('\n'));
          }
          sheet.getRange(lastRow, 1, 1, colCount).setFontWeight('bold');
          logAction_('RDS_DAY_CLOSED', '', 'system', 'system',
            formatDate_(lastDateVal) + ' closed: Advance Rs. ' + closingSummary.total + ', Actual Cash in Hand Rs. ' + (closingCashInHand - closingSummary.total));
        }
      }
    }

    var sameTabLastBalance = (!monthInfo.isNewSheet && lastRow >= 2) ? getLastCashInHandFromSheet_(sheet) : null;
    var opening = resolveRdsOpeningBalance_(ss, today, sameTabLastBalance);
    if (lastRow >= 2) sheet.appendRow(new Array(colCount).fill('')); // spacer between yesterday's block and today's
    var openRow = new Array(colCount).fill('');
    openRow[RS.DATE] = today;
    openRow[RS.EMPLOYEE_NAME] = 'Opening Balance';
    openRow[RS.CASH_IN_HAND] = opening;
    sheet.appendRow(openRow);

    logAction_('RDS_DAY_OPENED', '', 'system', 'system', 'Opening Balance row created for ' + formatDate_(today) + ': Rs. ' + opening);
  } catch (err) {
    Logger.log('closeRdsDay error: ' + err);
    logAction_('SYNC_WARNING', '', 'system', 'system', 'closeRdsDay failed: ' + err);
  } finally {
    lock.releaseLock();
  }
}

// One-time setup — run manually from the Apps Script editor (or via
// setupAllScheduledTriggers below), same convention as every other trigger
// setup in this file. Fires at RDS_DAY_CLOSE_HOUR (Config.gs, default 1 =
// 1am), well before any voucher submission is realistically expected.
function setupRdsDayCloseTrigger() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'closeRdsDay') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('closeRdsDay').timeBased().everyDays(1).atHour(RDS_DAY_CLOSE_HOUR).create();
  Logger.log('setupRdsDayCloseTrigger: daily ' + RDS_DAY_CLOSE_HOUR + ':00 trigger created for closeRdsDay.');
}

// ============================================================================
// SETUP-ALL CONVENIENCE WRAPPER — every trigger in this file follows the
// same "run this one function once from the Apps Script editor" convention,
// which is exactly the failure mode that silently broke the same-day query
// reminder email: it's an easy step to forget, there's no UI to prompt
// anyone to do it, and forgetting it produces no visible error anywhere —
// the app keeps working normally, emails just never go out.
//
// This wraps every setup*Trigger function in one idempotent call so a
// single admin action re-installs (or repairs) all of them at once,
// instead of depending on someone remembering three separate manual steps.
// Callable from the Apps Script editor directly, or via
// repairScheduledTriggers below, wired to an Admin-tab button in the app.
// ============================================================================
function setupAllScheduledTriggers() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  setupQueryReminderTrigger();
  setupSameDayQueryReminderTrigger();
  setupApproverDigestTrigger();
  setupRdsDayCloseTrigger();
  Logger.log('setupAllScheduledTriggers: all scheduled triggers (re)installed.');
}

// Admin-only RPC wrapper around setupAllScheduledTriggers, so this is
// reachable from inside the app instead of requiring Apps Script editor
// access every time it needs to be (re-)run. NOTE — this can still fail
// even when called correctly: ScriptApp.newTrigger() requires the
// script.scriptapp OAuth scope, and MailApp.sendEmail (used by every
// trigger this installs) requires script.send_mail. Both are documented
// as a currently-open issue for this project (manifest scope additions or
// a revoke-and-reauthorize needed) — if this RPC throws or the triggers it
// installs still never fire, check appsscript.json's oauthScopes for both
// before assuming the trigger logic itself is at fault again.
function repairScheduledTriggers(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };
    TRUSTED_SERVER_CALL_ = true; // a verified Admin is asking: the editor-only trigger setup helpers may run for this call
    setupAllScheduledTriggers();
    logAction_('TRIGGERS_REPAIRED', '', session.displayName || session.role, session.role, 'All scheduled triggers reinstalled.');
    return { success: true, message: 'Scheduled jobs reinstalled: query aging digest, same-day query alert, approver daily digest, RDS day-open.' };
  } catch (err) {
    Logger.log('repairScheduledTriggers error: ' + err);
    return { success: false, error: 'Failed to install triggers: ' + err.toString() + ' \u2014 if this mentions a permission/scope error, the fix is in appsscript.json (oauthScopes), not here.' };
  }
}