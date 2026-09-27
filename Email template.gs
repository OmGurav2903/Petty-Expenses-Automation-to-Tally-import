// ============================================================================
// SHARED EMAIL TEMPLATE — one branded look for every email the system sends.
//
// First used by the approver daily digest and the two query reminders
// (Triggers.gs). Every other email in the system (cash-withdrawal request /
// decision, vendor and employee requests, account notices, OTP) can move
// onto this with a few lines each: build the pieces below, pass them to
// buildBrandedEmail_, send with sendBrandedEmail_. Nothing here reads or
// writes any sheet; it only turns already-computed values into HTML.
//
// LOOK (v3): matches the login page and the app — the logo navy (#2E3192) for headings, links and the
// button, the logo red only as a small accent (the lead-in on the wave line), a soft flowing line
// (cid:wave) under the logo, rounded card, Work Sans where the mail client has it (Arial-class fallback
// elsewhere: web fonts are not supported by Gmail/Outlook). Colours live in EMAIL_C below so one edit
// re-themes every email.
//
// NO TYPED-OUT MAIL: every message that goes through sendBrandedEmail_ leaves in this layout. If a
// caller supplies only plain text (or its HTML failed to build), the plain text is laid out in the same
// template instead of being sent bare. Nothing in the system calls MailApp directly except that one place.
//
// Design rules, each one learned from a real rendering problem:
//   - Fluid width: 100% of the mail window up to 820px, so it neither leaves
//     a narrow card in a wide window nor overflows a phone.
//   - Identifier / date / amount columns never wrap (white-space:nowrap), so
//     "V-TKZD9BSZO" is never split across two lines. Free-text columns (names,
//     cost centres, query details) wrap normally and set the row height.
//   - Long details go on their own full-width line under the row instead of
//     squeezing a narrow column.
//   - On narrow screens columns marked hideSmall disappear and cell padding
//     shrinks (CSS media query; supported by Gmail web/app and Apple Mail).
//     Keep the always-visible columns short (id, amount, age): on a 390px
//     phone there is room for about four of them. Anything long belongs in
//     the full-width detail line, not in a column.
//   - Free text passes through emailNoAutoLink_, because Gmail turns text like
//     "11 Rabale" (a number followed by a place name) into a Google Maps link.
//   - Everything user-supplied is HTML-escaped. Only the builders in this file
//     produce markup.
// ============================================================================

var EMAIL_C = {
  navy: '#2E3192', navyDeep: '#1F2170', red: '#ED1C24',
  ink: '#14173F', ink2: '#454B6B', mute: '#5F6684',
  line: '#D9DDF0', lineSoft: '#E8EBF7', tint: '#F1F2FB', tintStrong: '#ECEEFB', tintLine: '#C9CDEB',
  page: '#EEF0FC'
};
var EMAIL_FONT = "'Work Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function emailEsc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// emailPlural_(3, 'voucher') -> '3 vouchers'; irregular plurals are passed
// explicitly: emailPlural_(3, 'query', 'queries') -> '3 queries'.
function emailPlural_(count, word, pluralWord) {
  return count + ' ' + (count === 1 ? word : (pluralWord || word + 's'));
}

function emailMoney_(n) {
  var v = Math.round((Number(n) || 0) * 100) / 100;
  try { return v.toLocaleString('en-IN', { minimumFractionDigits: (v % 1 === 0 ? 0 : 2), maximumFractionDigits: 2 }); } catch (e) { return String(v); }
}

// "25-7-2026" -> "25-07-2026". Anything that is not a d-m-yyyy / d/m/yyyy
// string is returned untouched rather than guessed at.
function emailDate_(raw) {
  var m = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/.exec(String(raw || '').trim());
  if (!m) return String(raw || '');
  return ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2) + '-' + m[3];
}

// Escapes free text AND stops Gmail / Apple Mail from auto-linking it as a
// street address: each word gets its own <span> and a zero-width space
// follows each gap, so no contiguous "11 Rabale" text node exists to detect.
// Looks identical on screen; wraps exactly like normal text.
function emailNoAutoLink_(s) {
  var words = String(s === null || s === undefined ? '' : s).split(/\s+/).filter(function (w) { return w; });
  return words.map(function (w) { return '<span>' + emailEsc_(w) + '</span>'; }).join(' &#8203;');
}

// The logo attachment for cid:logo, or null if it cannot be built (callers
// then fall back to a text header; the email is never blocked by a logo).
function getEmailLogoBlob_() {
  try { return getLogoFullEmailBlob_(); } catch (e) { Logger.log('getEmailLogoBlob_: logo unavailable: ' + e); return null; }
}

// The flowing-line strip under the logo (cid:wave), or null. Purely decorative: when it cannot be built
// the header simply has no strip.
function getEmailWaveBlob_() {
  try { return getEmailWaveBlobImpl_(); } catch (e) { Logger.log('getEmailWaveBlob_: wave unavailable: ' + e); return null; }
}

// columns: [{label, align:'left'|'right', nowrap:bool, hideSmall:bool, mono:bool}]
// rows:    [{cells:[html | {h:html, s:extraStyle, c:className}], detail:html|''}]
// Every cell / detail is HTML that the caller has already escaped.
function emailTable_(columns, rows) {
  var C = EMAIL_C;
  var thBase = 'padding:10px 12px;font-family:' + EMAIL_FONT + ';font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:' + C.ink2 + ';background:' + C.tint + ';border-bottom:1px solid ' + C.line + ';font-weight:bold;';
  var h = ['<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:separate;border-spacing:0;border:1px solid ' + C.line + ';border-radius:10px;"><tr>'];
  columns.forEach(function (c) {
    var al = c.align || 'left';
    h.push('<th' + (c.hideSmall ? ' class="hs"' : '') + ' align="' + al + '" style="' + thBase + 'text-align:' + al + ';' + (c.nowrap ? 'white-space:nowrap;' : '') + '">' + emailEsc_(c.label) + '</th>');
  });
  h.push('</tr>');
  rows.forEach(function (r) {
    var hasDetail = !!r.detail;
    h.push('<tr>');
    r.cells.forEach(function (cell, i) {
      var col = columns[i];
      var al = col.align || 'left';
      var o = (typeof cell === 'string') ? { h: cell } : cell;
      var cls = [o.c || '', col.hideSmall ? 'hs' : ''].join(' ').replace(/^\s+|\s+$/g, '');
      h.push('<td' + (cls ? ' class="' + cls + '"' : '') + ' align="' + al + '" valign="top" style="padding:' + (hasDetail ? '11px 12px 3px' : '11px 12px') +
        ';font-family:' + EMAIL_FONT + ';font-size:13px;line-height:1.4;color:' + C.ink + ';text-align:' + al + ';' + (hasDetail ? '' : 'border-bottom:1px solid ' + C.lineSoft + ';') +
        (col.nowrap ? 'white-space:nowrap;' : '') + (col.mono ? 'font-family:Consolas,Menlo,monospace;' : '') + (o.s || '') + '">' + o.h + '</td>');
    });
    h.push('</tr>');
    if (hasDetail) {
      h.push('<tr><td colspan="' + columns.length + '" style="padding:0 12px 11px;font-family:' + EMAIL_FONT + ';font-size:12.5px;line-height:1.4;color:' + C.ink2 + ';border-bottom:1px solid ' + C.lineSoft + ';">' + r.detail + '</td></tr>');
    }
  });
  h.push('</table>');
  return h.join('');
}

// kind: 'warn' | 'ok' | 'danger' | 'info'
function emailNotice_(kind, html) {
  var c = {
    warn:   ['#FBF0DE', '#EBCF97', '#8A5A17'],
    ok:     ['#E6F4ED', '#B9DEC9', '#1F5B45'],
    danger: ['#FBEAE9', '#E7BAB8', '#8B3330'],
    info:   [EMAIL_C.tintStrong, EMAIL_C.tintLine, EMAIL_C.navyDeep]
  }[kind] || [EMAIL_C.tintStrong, EMAIL_C.tintLine, EMAIL_C.navyDeep];
  return '<div style="padding:11px 14px;background:' + c[0] + ';border:1px solid ' + c[1] + ';border-radius:10px;font-family:' + EMAIL_FONT + ';font-size:12.5px;line-height:1.5;color:' + c[2] + ';">' + html + '</div>';
}

// Label / value pairs (values already escaped) for request-style emails.
function emailKeyValues_(pairs) {
  var C = EMAIL_C;
  var h = ['<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border:1px solid ' + C.line + ';border-radius:10px;border-collapse:separate;border-spacing:0;">'];
  pairs.forEach(function (p, i) {
    var last = i === pairs.length - 1;
    h.push('<tr><td valign="top" style="padding:9px 12px;width:32%;font-family:' + EMAIL_FONT + ';font-size:12.5px;font-weight:bold;color:' + C.ink2 + ';background:' + C.tint + ';' + (last ? '' : 'border-bottom:1px solid ' + C.lineSoft + ';') + '">' + emailEsc_(p[0]) +
      '</td><td valign="top" style="padding:9px 12px;font-family:' + EMAIL_FONT + ';font-size:13px;color:' + C.ink + ';' + (last ? '' : 'border-bottom:1px solid ' + C.lineSoft + ';') + '">' + p[1] + '</td></tr>');
  });
  h.push('</table>');
  return h.join('');
}

// Highlighted headline figure, e.g. the total of a withdrawal request.
function emailTotalBox_(label, valueText) {
  var C = EMAIL_C;
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:' + C.tintStrong + ';border:1px solid ' + C.tintLine + ';border-radius:12px;"><tr>' +
    '<td style="padding:15px 18px;font-family:' + EMAIL_FONT + ';font-size:13px;font-weight:bold;color:' + C.navyDeep + ';">' + emailEsc_(label) + '</td>' +
    '<td align="right" style="padding:15px 18px;font-family:Consolas,Menlo,monospace;font-size:22px;font-weight:bold;color:' + C.navy + ';white-space:nowrap;">' + emailEsc_(valueText) + '</td></tr></table>';
}

// A one-time code shown large and centred (verification emails). The spacing
// between digits is CSS letter-spacing only, so copy-paste gives the bare code.
function emailCodeBox_(label, code) {
  var C = EMAIL_C;
  return '<div style="text-align:center;padding:20px 12px;background:' + C.tintStrong + ';border:1px solid ' + C.tintLine + ';border-radius:12px;">' +
    '<div style="font-family:' + EMAIL_FONT + ';font-size:11px;letter-spacing:.06em;text-transform:uppercase;font-weight:bold;color:' + C.ink2 + ';">' + emailEsc_(label) + '</div>' +
    '<div style="margin-top:8px;font-family:Consolas,Menlo,monospace;font-size:32px;line-height:1.1;font-weight:bold;letter-spacing:8px;color:' + C.navy + ';">' + emailEsc_(code) + '</div></div>';
}

// Plain text -> escaped paragraphs (blank line = new paragraph, newline = <br>).
function emailParagraph_(text) {
  return '<p style="margin:0;font-family:' + EMAIL_FONT + ';font-size:14px;line-height:1.6;color:' + EMAIL_C.ink + ';">' + emailEsc_(text).replace(/\r?\n/g, '<br>') + '</p>';
}

// o: {title, subtitle, preheader, blocks:[html], ctaLabel, ctaUrl, footer, hasLogo}
// ctaUrl is only rendered when it is an https URL.
function buildBrandedEmail_(o) {
  var C = EMAIL_C;
  var wave = o.hasWave === false ? null : getEmailWaveBlob_();
  var h = [];
  h.push('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no"><meta name="x-apple-disable-message-reformatting">' +
    '<style>@media only screen and (max-width:600px){.hs{display:none!important}.px{padding-left:18px!important;padding-right:18px!important}.wrap{padding:8px!important}.wrap th,.wrap td{padding-left:8px!important;padding-right:8px!important}}</style></head>');
  h.push('<body style="margin:0;padding:0;background:' + C.page + ';">');
  if (o.preheader) h.push('<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;">' + emailEsc_(o.preheader) + '</div>');
  h.push('<div class="wrap" style="background:' + C.page + ';padding:28px 12px;font-family:' + EMAIL_FONT + ';">');
  h.push('<div style="width:100%;max-width:820px;margin:0 auto;background:#FFFFFF;border:1px solid ' + C.line + ';border-radius:16px;overflow:hidden;">');
  h.push('<div class="px" style="padding:26px 32px 0;">' + (o.hasLogo
    ? '<img src="cid:logo" alt="Target Learning Ventures Pvt. Ltd." width="280" style="display:block;width:280px;max-width:100%;height:auto;border:0;">'
    : '<div style="font-family:' + EMAIL_FONT + ';font-size:17px;font-weight:bold;color:' + C.navy + ';">Target Learning Ventures Pvt. Ltd.</div>') + '</div>');
  if (wave) h.push('<div class="px" style="padding:12px 32px 0;"><img src="cid:wave" alt="" width="756" style="display:block;width:100%;max-width:100%;height:auto;border:0;"></div>');
  h.push('<div class="px" style="padding:14px 32px 4px;"><div style="font-family:' + EMAIL_FONT + ';font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-.3px;color:' + C.ink + ';">' + emailEsc_(o.title) + '</div>' +
    (o.subtitle ? '<div style="font-family:' + EMAIL_FONT + ';font-size:14px;color:' + C.ink2 + ';margin-top:6px;">' + emailNoAutoLink_(o.subtitle) + '</div>' : '') + '</div>');
  (o.blocks || []).forEach(function (b) { if (b) h.push('<div class="px" style="padding:14px 32px 0;">' + b + '</div>'); });
  if (o.ctaUrl && /^https:\/\//i.test(o.ctaUrl)) {
    h.push('<div class="px" style="padding:22px 32px 6px;"><a href="' + emailEsc_(o.ctaUrl) + '" style="display:inline-block;background:' + C.navy + ';color:#FFFFFF;text-decoration:none;font-family:' + EMAIL_FONT + ';font-weight:bold;font-size:15px;padding:13px 26px;border-radius:10px;">' +
      emailEsc_(o.ctaLabel || 'Open the app') + '</a></div>');
  }
  h.push('<div class="px" style="padding:20px 32px 26px;font-family:' + EMAIL_FONT + ';font-size:12px;line-height:1.5;color:' + C.mute + ';">' + emailEsc_(o.footer || 'Sent automatically by the Rabale Petty Expense System.') + '</div>');
  h.push('</div>');
  h.push('<div style="text-align:center;padding:14px 0 0;font-family:' + EMAIL_FONT + ';font-size:11.5px;color:' + C.mute + ';">Target Learning Ventures Pvt. Ltd. &nbsp;&middot;&nbsp; Transforming lives through learning</div>');
  h.push('</div></body></html>');
  return h.join('');
}

// The same layout for a message that only exists as plain text (subject + paragraphs). Used by
// notifyRole and as the safety net inside sendBrandedEmail_, so no email can go out unstyled.
// A last paragraph that starts "If ..." (advice) is boxed. appUrl (https) adds an "Open the app" button.
function buildPlainEmailHtml_(subject, plainBody, hasLogo, appUrl) {
  var title = String(subject || 'Rabale Petty Expense System').replace(/^Rabale Petty Expense System\s*[\u2014\-]\s*/, '');
  title = title ? title.charAt(0).toUpperCase() + title.slice(1) : 'Rabale Petty Expense System';
  var paras = String(plainBody || '').split(/\n\s*\n/).filter(function (p) { return p.replace(/\s+/g, '') !== ''; });
  var boxLast = paras.length > 1 && /^If\b/.test(paras[paras.length - 1]);
  var blocks = paras.map(function (p, i) {
    return (boxLast && i === paras.length - 1) ? emailNotice_('info', emailEsc_(p).replace(/\r?\n/g, '<br>')) : emailParagraph_(p);
  });
  return buildBrandedEmail_({
    title: title, subtitle: 'Rabale Petty Expense System', preheader: title, blocks: blocks,
    ctaLabel: 'Open the app', ctaUrl: appUrl || '', hasLogo: hasLogo,
    footer: 'Sent automatically by the Rabale Petty Expense System.'
  });
}

// One message. Throws on failure (callers decide what a failure means).
// o: {to, cc, subject, body, htmlBody, logo (Blob|null), name}
// This is the only place in the project that sends mail. If no HTML was supplied it is built from the
// plain text here, so nothing leaves as a bare typed-out message.
function sendBrandedEmail_(o) {
  var html = o.htmlBody || null;
  var logo = o.logo || null;
  if (!html && o.body) {
    try {
      logo = logo || getEmailLogoBlob_();
      html = buildPlainEmailHtml_(o.subject, o.body, !!logo, '');
    } catch (buildErr) {
      Logger.log('sendBrandedEmail_: could not lay out the plain text, sending it as is: ' + buildErr);
      html = null;
    }
  }
  var opts = { to: o.to, subject: o.subject, body: o.body, name: o.name || 'Rabale Petty Expense System' };
  if (html) opts.htmlBody = html;
  if (o.cc) opts.cc = o.cc;
  var inline = {};
  if (html && logo && html.indexOf('cid:logo') !== -1) inline.logo = logo;
  if (html && html.indexOf('cid:wave') !== -1) { var wave = getEmailWaveBlob_(); if (wave) inline.wave = wave; }
  if (Object.keys(inline).length) opts.inlineImages = inline;
  if (o.attachments && o.attachments.length) opts.attachments = o.attachments;
  MailApp.sendEmail(opts);
}

// The safe way to send any system notification. buildHtml(hasLogo) returns
// the HTML body. If building it throws for ANY reason, the plain-text
// version is laid out in the same template instead (sendBrandedEmail_): a bug in a
// template must never be able to stop a withdrawal request, a lock-out notice or a vendor
// request from going out, and must not make it arrive unstyled either.
// Send failures still throw, exactly as a bare MailApp.sendEmail would, so
// every caller's existing error handling keeps working unchanged.
// o: {to, cc, subject, body (plain text), attachments}
function sendNotification_(o, buildHtml) {
  var logo = getEmailLogoBlob_();
  var html = null;
  try { html = buildHtml(!!logo); } catch (buildErr) { Logger.log('sendNotification_: HTML build failed, laying out the plain text instead: ' + buildErr); }
  sendBrandedEmail_({ to: o.to, cc: o.cc, subject: o.subject, body: o.body, htmlBody: html, logo: logo, attachments: o.attachments });
}

// One email per active user in a role (same semantics as notifyRole in
// Users.gs: nobody sees a colleague's address, one bad address cannot stop
// the rest). Returns the number actually sent.
function notifyRoleBranded_(role, subject, plainBody, htmlBody, logo) {
  var emails = getActiveUserEmailsForRole_(role);
  if (emails.length === 0) {
    Logger.log('notifyRoleBranded_: no active user with an email configured for role "' + role + '" \u2014 skipped: ' + subject);
    return 0;
  }
  var sent = 0;
  emails.forEach(function (email) {
    try {
      sendBrandedEmail_({ to: email, subject: subject, body: plainBody, htmlBody: htmlBody, logo: logo });
      sent++;
    } catch (mailErr) {
      Logger.log('notifyRoleBranded_: failed to email ' + email + ': ' + mailErr);
    }
  });
  return sent;
}
