// ============================================================================
// SYSTEM NOTIFICATION EMAILS — the builders for every transactional email
// (cash-withdrawal request and decision, vendor request, employee request,
// account notices), all on the shared branded template (EmailTemplates.gs).
//
// Each email has TWO pure functions, deliberately separate:
//   xxxText_(o)              -> the plain-text body. Simple string assembly,
//                               exactly what these emails have always said.
//                               Called directly by the call site, BEFORE the
//                               send, so it sits on the critical path and is
//                               kept as plain as possible.
//   xxxHtml_(o, url, logo)   -> the branded HTML. Only ever called from inside
//                               sendNotification_, which catches any error and
//                               sends the plain text instead — so a bug in the
//                               HTML can never stop a withdrawal request, a
//                               lock-out notice or a vendor request.
// Neither reads a sheet, sends anything or changes anything. The call sites
// (Approval.gs, Master data.gs, Users.gs) keep their own validation, ordering
// and error handling and just hand these values over.
//
// Rules for all of them:
//   - Subjects are NOT built here and are unchanged. The withdrawal decision
//     email threads onto the request by its "Re: <request subject>", so the
//     subject must stay byte-identical to what was stored.
//   - Every value is HTML-escaped before it goes into markup.
// ============================================================================

// ---------------------------------------------------------------- position
// "Meena Rao (Warehouse Manager)". A person is described by their ACTUAL
// position in the company, never by their access level in this app. Blank
// position -> just the name.
function nameWithPosition_(name, designation) {
  return String(name === null || name === undefined ? '' : name) + (designation ? ' (' + designation + ')' : '');
}

// The bracketed description of whoever decided a cash-withdrawal request.
// With a position: "Director - Finance", or "Head of IT, on L2\u2019s behalf" when an
// admin recorded it for L2. Without one it is EXACTLY the wording these emails
// always used ("L2" / "Admin, on L2\u2019s behalf"), so nothing changes for a user
// whose position has not been entered yet.
function withdrawalDeciderLabel_(role, designation) {
  var onBehalf = role !== 'L2';
  if (designation) return designation + (onBehalf ? ', on L2\u2019s behalf' : '');
  return onBehalf ? 'Admin, on L2\u2019s behalf' : 'L2';
}

// ---------------------------------------------------------------- withdrawal
function withdrawalRequestActionText_() {
  return 'Please approve or reject this request in the app: open the Approval Queue and use the "Cash Withdrawal Approval (Bank Replenishment)" panel. ' +
    'If you cannot use the app, reply to this email and Admin will record your decision.';
}

function withdrawalMissingText_(missing) {
  return missing.length + ' voucher(s) could not be matched in Rabale Daily Sync and are excluded from this request (excluded from both the total above and the attachment): ' +
    missing.join(', ') + '. These remain eligible for a future request.';
}

// o: {withdrawalId, batchIds:[..], periodFrom, periodTo, voucherCount,
//     totalAmount, missingVoucherIds:[..]}
function withdrawalRequestText_(o) {
  var missing = o.missingVoucherIds || [];
  var lines = [
    'Accounts is requesting approval to withdraw cash from the bank to replenish the petty cash float.',
    '',
    'Withdrawal ID: ' + o.withdrawalId,
    'Batch(es): ' + o.batchIds.join(', '),
    'Period: ' + o.periodFrom + ' to ' + o.periodTo,
    'Voucher count: ' + o.voucherCount,
    'Total amount: Rs. ' + o.totalAmount.toLocaleString('en-IN'),
    '',
    'The attached Excel sheet is the full Rabale Daily Sync detail (through Cash in Hand) for exactly these vouchers.',
    '',
    withdrawalRequestActionText_()
  ];
  if (missing.length > 0) lines.push('', 'Note: ' + withdrawalMissingText_(missing));
  return lines.join('\n');
}

function withdrawalRequestHtml_(o, appUrl, hasLogo) {
  var missing = o.missingVoucherIds || [];
  var blocks = [
    emailTotalBox_('Total amount requested', 'Rs. ' + emailMoney_(o.totalAmount)),
    emailKeyValues_([
      ['Withdrawal ID', emailEsc_(o.withdrawalId)],
      ['Batch(es)', emailEsc_(o.batchIds.join(', '))],
      ['Period', emailEsc_(o.periodFrom) + ' to ' + emailEsc_(o.periodTo)],
      ['Vouchers', emailEsc_(o.voucherCount)]
    ]),
    emailNotice_('info', '<b>Attached:</b> the full Rabale Daily Sync detail (through Cash in Hand) for exactly these vouchers, as an Excel sheet.')
  ];
  if (missing.length > 0) blocks.push(emailNotice_('warn', '<b>Note:</b> ' + emailEsc_(withdrawalMissingText_(missing))));
  blocks.push(emailNotice_('info', '<b>To decide:</b> open the Approval Queue and use the <b>Cash Withdrawal Approval (Bank Replenishment)</b> panel to approve or reject. ' +
    'If you cannot use the app, reply to this email and Admin will record your decision.'));
  return buildBrandedEmail_({
    title: 'Cash withdrawal approval required',
    subtitle: 'Bank replenishment of the petty cash float \u00b7 ' + o.periodFrom + ' to ' + o.periodTo,
    preheader: 'Rs. ' + emailMoney_(o.totalAmount) + ' \u00b7 ' + emailPlural_(o.voucherCount, 'voucher') + ' \u00b7 approval required',
    blocks: blocks, ctaLabel: 'Open the Approval Queue', ctaUrl: appUrl, hasLogo: hasLogo,
    footer: 'Sent by the Rabale Petty Expense System on behalf of Accounts.'
  });
}

function withdrawalFollowUpText_(approved) {
  return approved
    ? 'Accounts can now withdraw the cash and release it against these vouchers in the app.'
    : 'No cash is to be released against these vouchers. Every voucher in this request is unbundled again and can be included in a corrected request.';
}

// o: {withdrawalId, decision ('Approved'|'Rejected'), approved:bool, decidedBy,
//     decidedByRole, decidedOn, batchIds:text, periodFrom, periodTo,
//     voucherCount, totalAmount, notes}
function withdrawalDecisionText_(o) {
  var lines = [
    'Cash withdrawal request ' + o.withdrawalId + ' has been ' + (o.approved ? 'APPROVED' : 'REJECTED') + '.',
    '',
    'Decision: ' + o.decision,
    'Decided by: ' + o.decidedBy + ' (' + o.decidedByRole + ')',
    'Decided on: ' + o.decidedOn,
    '',
    'Withdrawal ID: ' + o.withdrawalId,
    'Batch(es): ' + o.batchIds,
    'Period: ' + o.periodFrom + ' to ' + o.periodTo,
    'Voucher count: ' + o.voucherCount,
    'Total amount: Rs. ' + o.totalAmount.toLocaleString('en-IN')
  ];
  if (o.notes) lines.push('', 'Notes: ' + o.notes);
  lines.push('', withdrawalFollowUpText_(o.approved));
  return lines.join('\n');
}

function withdrawalDecisionHtml_(o, appUrl, hasLogo) {
  var blocks = [
    emailNotice_(o.approved ? 'ok' : 'danger', '<b>' + (o.approved ? 'Approved.' : 'Rejected.') + '</b> ' + emailEsc_(withdrawalFollowUpText_(o.approved))),
    emailTotalBox_('Total amount', 'Rs. ' + emailMoney_(o.totalAmount)),
    emailKeyValues_([
      ['Decision', '<b>' + emailEsc_(o.decision) + '</b>'],
      ['Decided by', emailEsc_(o.decidedBy) + ' (' + emailEsc_(o.decidedByRole) + ')'],
      ['Decided on', emailEsc_(o.decidedOn)],
      ['Withdrawal ID', emailEsc_(o.withdrawalId)],
      ['Batch(es)', emailEsc_(o.batchIds)],
      ['Period', emailEsc_(o.periodFrom) + ' to ' + emailEsc_(o.periodTo)],
      ['Vouchers', emailEsc_(o.voucherCount)]
    ])
  ];
  if (o.notes) blocks.push(emailNotice_('info', '<b>Notes:</b> ' + emailEsc_(o.notes)));
  return buildBrandedEmail_({
    title: 'Cash withdrawal request ' + (o.approved ? 'approved' : 'rejected'),
    subtitle: o.withdrawalId + ' \u00b7 Rs. ' + emailMoney_(o.totalAmount) + ' \u00b7 ' + o.periodFrom + ' to ' + o.periodTo,
    preheader: 'Cash withdrawal request ' + o.withdrawalId + ' has been ' + (o.approved ? 'approved' : 'rejected') + '.',
    blocks: blocks, ctaLabel: 'Open the Approval Queue', ctaUrl: appUrl, hasLogo: hasLogo,
    footer: 'Sent by the Rabale Petty Expense System.'
  });
}

// ------------------------------------------------------------------ requests
// o: {vendorName, requestedBy, dateText, notes}
function vendorRequestText_(o) {
  return 'A new vendor has been requested for the Rabale Petty Expense System.\n\n' +
    'Vendor name: ' + o.vendorName + '\n' +
    'Requested by: ' + o.requestedBy + '\n' +
    'Date: ' + o.dateText + '\n' +
    (o.notes ? '\nNotes: ' + o.notes + '\n' : '') +
    '\nThe vendor\u2019s bill is attached. Please review and add the vendor (with TDS applicability and rate) via the Admin > Vendor Addition tab.' +
    (o.driveUrl ? '\n\nA copy of the bill is also saved in Google Drive: ' + o.driveUrl : '');
}

function vendorRequestHtml_(o, appUrl, hasLogo) {
  var pairs = [['Vendor name', '<b>' + emailEsc_(o.vendorName) + '</b>'], ['Requested by', emailNoAutoLink_(o.requestedBy)], ['Date', emailEsc_(o.dateText)]];
  if (o.notes) pairs.push(['Notes', emailEsc_(o.notes)]);
  var blocks = [
    emailKeyValues_(pairs),
    emailNotice_('info', '<b>Attached:</b> the vendor\u2019s bill. Please review it and add the vendor, with TDS applicability and rate, under <b>Admin \u203a Vendor Addition</b>.')
  ];
  if (o.driveUrl && /^https:\/\//i.test(o.driveUrl)) {
    blocks.push(emailNotice_('ok', '<b>Saved copy:</b> the bill is also stored in Google Drive \u2014 <a href="' + emailEsc_(o.driveUrl) + '" style="color:#1F5B45;font-weight:bold;">open it in Drive</a>.'));
  }
  return buildBrandedEmail_({
    title: 'New vendor request',
    subtitle: o.vendorName + ' \u00b7 requested by ' + o.requestedBy,
    preheader: 'New vendor request: ' + o.vendorName,
    blocks: blocks,
    ctaLabel: 'Open the app', ctaUrl: appUrl, hasLogo: hasLogo,
    footer: 'Sent by the Rabale Petty Expense System.'
  });
}

function employeeAddHowToText_(sheetName) {
  return 'open the "' + sheetName + '" sheet and type the name in column A, in the first empty row directly under the last employee ' +
    '(leave no blank rows between names \u2014 the list stops reading at the first blank). It shows up in Submitted By the next time Submit Voucher is opened.';
}

// o: {employeeName, requestedBy, dateText, notes, sheetName}
function employeeRequestText_(o) {
  return 'A new employee has been requested, to be added to the Submitted By list in the Rabale Petty Expense System.\n\n' +
    'Employee name: ' + o.employeeName + '\n' +
    'Requested by: ' + o.requestedBy + '\n' +
    'Date: ' + o.dateText + '\n' +
    (o.notes ? '\nNotes: ' + o.notes + '\n' : '') +
    '\nTo add: ' + employeeAddHowToText_(o.sheetName);
}

// sheetUrl is optional (a link to the Master Data tab); no button without it.
function employeeRequestHtml_(o, sheetUrl, hasLogo) {
  var pairs = [['Employee name', '<b>' + emailEsc_(o.employeeName) + '</b>'], ['Requested by', emailNoAutoLink_(o.requestedBy)], ['Date', emailEsc_(o.dateText)]];
  if (o.notes) pairs.push(['Notes', emailEsc_(o.notes)]);
  return buildBrandedEmail_({
    title: 'New employee request',
    subtitle: o.employeeName + ' \u00b7 requested by ' + o.requestedBy,
    preheader: 'New employee request: ' + o.employeeName,
    blocks: [
      emailKeyValues_(pairs),
      emailNotice_('info', '<b>To add:</b> ' + emailEsc_(employeeAddHowToText_(o.sheetName)))
    ],
    ctaLabel: 'Open the Master Data sheet', ctaUrl: sheetUrl, hasLogo: hasLogo,
    footer: 'Sent by the Rabale Petty Expense System.'
  });
}

// --------------------------------------------------------- email verification
// Sent to a NEW email address when an admin sets or changes a user's email
// (Users.gs, beginPendingEmailChange). The button opens a page with Yes / No
// buttons; the person never has to read a code to anyone. The link itself
// changes nothing when opened (mail scanners open every link), only the Yes
// button on the page does. The account is identified by name AND position so
// the mailbox owner can see exactly which person the request is about, and
// who asked for it.
// o: {displayName, designation (may be ''), email, requestedBy, link, expiryHours}
function emailVerifyRequestText_(o) {
  return 'Hello,\n\n' +
    o.requestedBy + ' asked to link this email address (' + o.email + ') to the account for "' + o.displayName + '"' +
    (o.designation ? ' (' + o.designation + ')' : '') + ' on the Rabale Petty Expense System. ' +
    'Emails for that account, such as query reminders, would then come to this address.\n\n' +
    'To answer, open this link and press Yes or No:\n' + o.link + '\n\n' +
    'The link works once and for ' + o.expiryHours + ' hours. Please do not forward this email: anyone who opens the link can answer for you.\n\n' +
    'If you were not expecting this, ignore the email or press No on that page. Nothing changes unless someone presses Yes.';
}

function emailVerifyRequestHtml_(o, hasLogo) {
  var pairs = [['Account', '<b>' + emailEsc_(o.displayName) + '</b>']];
  if (o.designation) pairs.push(['Position', emailEsc_(o.designation)]);
  pairs.push(['Email address', emailNoAutoLink_(o.email)]);
  pairs.push(['Requested by', emailEsc_(o.requestedBy)]);
  return buildBrandedEmail_({
    title: 'Confirm this email address',
    subtitle: 'Rabale Petty Expense System \u00b7 ' + o.displayName + (o.designation ? ' \u00b7 ' + o.designation : ''),
    preheader: 'Please confirm that this email address belongs with the account for ' + o.displayName,
    blocks: [
      emailParagraph_('Hello,\nAn administrator asked to link this email address to the account below. Emails for that account, such as query reminders, would then come here.'),
      emailKeyValues_(pairs),
      emailNotice_('info', 'Open the page and press <b>Yes</b> only if this is your email address and you know this account. Pressing <b>No</b>, or doing nothing, changes nothing.'),
      emailNotice_('warn', 'The link works once and for <b>' + emailEsc_(o.expiryHours) + ' hours</b>. Please do not forward this email: anyone who opens the link can answer for you.')
    ],
    ctaLabel: 'Review this request', ctaUrl: o.link, hasLogo: hasLogo,
    footer: 'This is an automatic message. If you were not expecting it, you can ignore it.'
  });
}

// ---------------------------------------------------------- password reset code
// The code emailed to a user who chose "Forgot password" on the login page
// (Auth.gs, requestPasswordReset). Unlike the email-verification code above,
// the person types THIS code into the app themselves, so the wording says the
// opposite: do not give it to anyone. Deliberately no link and no button.
// o: {displayName, designation (may be ''), otp, expiryMinutes}
function passwordResetOtpText_(o) {
  return 'Hello ' + o.displayName + ',\n\n' +
    'A password reset was requested for your account on the Rabale Petty Expense System.\n\n' +
    'Reset code: ' + o.otp + '\n\n' +
    'Enter this code on the \"Forgot password\" screen of the login page. It expires in ' + o.expiryMinutes + ' minutes and can be used once. ' +
    'Do not share it with anyone, including an administrator.\n\n' +
    'If you did not ask for this, ignore this email \u2014 your password will not change unless the code is entered.';
}

function passwordResetOtpHtml_(o, hasLogo) {
  var pairs = [['Account', '<b>' + emailEsc_(o.displayName) + '</b>']];
  if (o.designation) pairs.push(['Position', emailEsc_(o.designation)]);
  return buildBrandedEmail_({
    title: 'Reset your password',
    subtitle: 'Rabale Petty Expense System \u00b7 ' + o.displayName + (o.designation ? ' \u00b7 ' + o.designation : ''),
    preheader: 'Your password reset code is ' + o.otp + ' (valid ' + o.expiryMinutes + ' minutes)',
    blocks: [
      emailParagraph_('Hello ' + o.displayName + ',\nA password reset was requested for the account below.'),
      emailKeyValues_(pairs),
      emailCodeBox_('Password reset code', o.otp),
      emailNotice_('info', 'Enter this code on the <b>Forgot password</b> screen of the login page. It expires in <b>' + emailEsc_(o.expiryMinutes) + ' minutes</b> and can be used once. Do not share it with anyone, including an administrator.'),
      emailNotice_('warn', 'If you did not ask for this, ignore this email \u2014 your password will not change unless the code is entered.')
    ],
    hasLogo: hasLogo,
    footer: 'This is an automatic message. Nothing in it needs a reply.'
  });
}

// ------------------------------------------------------------ Admin login code
// The second factor for the Admin login (Auth.gs, adminStartSecondFactor_). Sent only after the Admin PIN was
// entered correctly. o: {otp, expiryMinutes}
function adminLoginCodeText_(o) {
  return 'Hello,\n\n' +
    'The correct Admin PIN was just entered on the Rabale Petty Expense System.\n\n' +
    'Admin login code: ' + o.otp + '\n\n' +
    'Enter this code on the login page to finish logging in. It expires in ' + o.expiryMinutes + ' minutes and can be used once. ' +
    'Do not share it with anyone.\n\n' +
    'If this was not you, someone knows the Admin PIN. Change the ADMIN_PIN Script Property now and check the Audit Log.';
}

function adminLoginCodeHtml_(o, hasLogo) {
  return buildBrandedEmail_({
    title: 'Your Admin login code',
    subtitle: 'Rabale Petty Expense System \u00b7 Admin',
    preheader: 'Your Admin login code is ' + o.otp + ' (valid ' + o.expiryMinutes + ' minutes)',
    blocks: [
      emailParagraph_('Hello,\nThe correct Admin PIN was just entered on the Rabale Petty Expense System.'),
      emailCodeBox_('Admin login code', o.otp),
      emailNotice_('info', 'Enter this code on the login page to finish logging in. It expires in <b>' + emailEsc_(o.expiryMinutes) + ' minutes</b> and can be used once. Do not share it with anyone.'),
      emailNotice_('warn', 'If this was not you, someone knows the Admin PIN. Change the <b>ADMIN_PIN</b> Script Property now and check the Audit Log.')
    ],
    hasLogo: hasLogo,
    footer: 'This is an automatic message. Nothing in it needs a reply.'
  });
}

// ------------------------------------------------------------ account notices
// One HTML builder for the six account events. The plain-text `body` written
// at each call site stays the single source of the wording: this only turns
// its paragraphs into HTML (the last paragraph is boxed when it is advice
// starting "If ..."), so the two versions can never disagree.
//
// Deliberately NO login link on the security notices (locked out, deactivated,
// password reset, password changed): an email about your account that links
// to a sign-in page is exactly the shape of a phishing message, so these tell
// the person to contact their administrator instead. Only the "unlocked"
// notice carries the app link, because logging in again is its whole point.
var ACCOUNT_EVENT_STYLES = {
  'USER_LOCKED_OUT':      { kind: 'danger', title: 'Your account has been locked', link: false },
  'USER_UNLOCKED':        { kind: 'ok',     title: 'Your account has been unlocked', link: true },
  'USER_DEACTIVATE':      { kind: 'danger', title: 'Your account has been deactivated', link: false },
  'USER_PASSWORD_RESET':  { kind: 'warn',   title: 'Your password was reset', link: false },
  'USER_PASSWORD_SELF_RESET': { kind: 'warn', title: 'Your password was reset', link: false },
  'USER_PASSWORD_CHANGE': { kind: 'info',   title: 'Your password was changed', link: false }
};

function buildAccountEventEmail_(eventLogAction, displayName, subject, body, whenText, appUrl, hasLogo, designation) {
  var style = ACCOUNT_EVENT_STYLES[eventLogAction] || { kind: 'info', title: subject, link: false };
  var paras = String(body || '').split(/\n\s*\n/).filter(function (p) { return p.replace(/\s+/g, '') !== ''; });
  var blocks = [];
  var boxLast = paras.length > 1 && /^If\b/.test(paras[paras.length - 1]);
  paras.forEach(function (p, i) {
    if (boxLast && i === paras.length - 1) blocks.push(emailNotice_(style.kind === 'ok' ? 'info' : style.kind, emailEsc_(p)));
    else blocks.push(emailParagraph_(p));
  });
  var facts = [['Account', emailEsc_(displayName)]];
  if (designation) facts.push(['Position', emailEsc_(designation)]);
  facts.push(['When', emailEsc_(whenText)]);
  blocks.push(emailKeyValues_(facts));
  return buildBrandedEmail_({
    title: style.title,
    subtitle: 'Rabale Petty Expense System \u00b7 account notice',
    preheader: subject,
    blocks: blocks, ctaLabel: 'Open the app', ctaUrl: style.link ? appUrl : '', hasLogo: hasLogo,
    footer: 'This is an automatic notice. If something here does not look right, contact your administrator.'
  });
}
