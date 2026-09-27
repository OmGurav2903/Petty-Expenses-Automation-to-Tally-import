// ============================================================================
// USERS — Day 5. Individual logins for the 4 MULTI_USER_ROLES (submission,
// L1, accounts, L2), admin-managed. Replaces the old shared-PIN-per-role
// model for these 4 roles with named accounts, so 2-3 people sharing a
// dashboard are each individually accountable in the Audit Log, while
// permissions stay exactly role-based (anyone active in 'submission' can
// still act on ANY submission voucher — this is deliberate, so people can
// cover a query for each other when someone's out; it is NOT per-user
// ownership/restriction).
//
// ONE-TIME SETUP after deploying this version:
//   1. Set the ADMIN_PIN Script Property (see Config.gs comment).
//   2. From the Apps Script editor, select bootstrapDefaultUsers from the
//      function dropdown and click Run once. This seeds ONE starter
//      account per multi-user role so you're not locked out:
//        submission / sub.starter / Rabale@2026
//        L1         / l1.starter  / Rabale@2026
//        accounts   / acc.starter / Rabale@2026
//        L2         / l2.starter  / Rabale@2026
//      Log in as one of these, then use Admin > Manage Users to create
//      real named accounts and deactivate the starter ones.
// ============================================================================

// ----------------------------------------------------------------------------
// Password hashing — SHA-256(salt + ':' + password), salted per user.
// Apps Script has no bcrypt/scrypt available natively; salted SHA-256 is a
// real improvement over the previous plaintext-PIN-in-source model and is
// adequate for a small internal team tool, but it is NOT the same strength
// as a proper slow hash. Worth knowing, not worth blocking on for this
// deadline.
// ----------------------------------------------------------------------------
function generateSalt_() {
  // 24 hex characters from Utilities.getUuid() (secure random), not Math.random. Existing salts keep working:
  // verifyPassword() uses whatever salt is stored against the account.
  return Utilities.getUuid().replace(/-/g, '').substr(0, 24);
}

function hashPassword_(password, salt) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password);
  return bytes.map(function (b) {
    var v = (b < 0) ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function verifyPassword_(password, salt, expectedHash) {
  return hashPassword_(password, salt) === expectedHash;
}

// Run from the Apps Script editor. Measures how long ONE digest takes in this runtime, so a slower (iterated)
// password hash can be chosen from real numbers instead of guessed: every extra round is paid on every login.
// Changes nothing and stores nothing.
function benchmarkPasswordHash() {
  editorOnly_();
  var rounds = 300, bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'benchmark'), t0 = Date.now();
  for (var i = 0; i < rounds; i++) bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  var perRoundMs = (Date.now() - t0) / rounds;
  var out = { rounds: rounds, msPerRound: Math.round(perRoundMs * 1000) / 1000, secondsPerLoginAt: {} };
  [1000, 10000, 100000].forEach(function (n) { out.secondsPerLoginAt[n + ' rounds'] = Math.round(perRoundMs * n / 100) / 10; });
  Logger.log('benchmarkPasswordHash: ' + JSON.stringify(out));
  return out;
}

// Minimum bar so admin can't accidentally create a trivially-guessable
// account ("1234", "password") for a system that hands out cash. Not
// enterprise-grade policy, just a sane floor for an internal tool.
function validatePasswordStrength_(password) {
  if (!password || String(password).length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include at least one letter and one number.';
  }
  return null;
}

function validateUsername_(username) {
  var u = String(username || '').trim();
  if (!/^[a-zA-Z0-9._]{3,30}$/.test(u)) {
    return { valid: false, error: 'Username must be 3-30 characters: letters, numbers, dot, underscore only.' };
  }
  return { valid: true, username: u };
}

// Email is OPTIONAL (a user with none simply never receives notifyRole
// emails — see below), but if one IS supplied it must look like an email.
// Loose format check only — this isn't a verification system, just a
// typo guard (unlike the vendor PAN field in Master Data, which IS
// strictly format-validated — see validatePAN, Master data.gs — because
// PAN has one fixed, well-known structure and email addresses don't).
function validateOptionalEmail_(email) {
  var e = String(email || '').trim();
  if (!e) return { valid: true, email: '' };
  if (e.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    return { valid: false, error: 'That doesn\u2019t look like a valid email address.' };
  }
  return { valid: true, email: e };
}

// ----------------------------------------------------------------------------
// Sheet access
// ----------------------------------------------------------------------------
function getOrCreateUsersSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET);
    sheet.getRange(1, 1, 1, EXPECTED_USER_HEADERS.length).setValues([EXPECTED_USER_HEADERS]);
    sheet.setFrozenRows(1);
    autoFitSheetColumns_(sheet, []); // READABILITY (per explicit instruction)
  } else {
    ensureUsersDesignationHeader_(sheet);
  }
  return sheet;
}

// A Users sheet created before the Designation column existed only lacks its
// header cell — every user's cell there is simply blank, meaning "not set".
// Adds the header the first time the sheet is touched. Idempotent, one cell
// read; never blocks the caller.
function ensureUsersDesignationHeader_(sheet) {
  try {
    var cell = sheet.getRange(1, USR.DESIGNATION + 1);
    if (!safe_(cell.getValue())) cell.setValue(EXPECTED_USER_HEADERS[USR.DESIGNATION]);
  } catch (err) {
    Logger.log('ensureUsersDesignationHeader_: ' + err);
  }
}

// A position title: trimmed, whitespace collapsed, control characters and
// angle brackets removed, at most DESIGNATION_MAX_LENGTH characters. Blank is
// valid and means "not set" (screens fall back to the app-role wording).
function validateDesignation_(raw) {
  var d = String(raw === null || raw === undefined ? '' : raw).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  if (d.length > DESIGNATION_MAX_LENGTH) return { valid: false, error: 'Position is too long (maximum ' + DESIGNATION_MAX_LENGTH + ' characters).' };
  return { valid: true, designation: d };
}

// Username lookup. Case-insensitive by default (used for uniqueness
// checks at creation — usernames are unique across ALL roles, not just
// within one role, and staying case-insensitive here prevents someone
// creating a confusable near-duplicate like "john" alongside "John").
// Pass exactCase=true for LOGIN specifically (24 Aug 2026, per explicit
// instruction — usernames are now case-sensitive at login): a typed
// username must match the stored one byte-for-byte, not just
// case-folded, so "Rakesh" and "rakesh" are treated as different login
// attempts even though they can never both exist as separate accounts
// (the case-insensitive uniqueness check above already prevents that).
function findUserByUsername_(username, exactCase) {
  var sheet = getOrCreateUsersSheet_();
  var data = sheet.getDataRange().getValues();
  var needle = String(username || '').trim();
  if (!exactCase) needle = needle.toLowerCase();
  for (var i = 1; i < data.length; i++) {
    var stored = String(data[i][USR.USERNAME]).trim();
    var match = exactCase ? (stored === needle) : (stored.toLowerCase() === needle);
    if (match) {
      return { sheet: sheet, rowIndex: i + 1, rowValues: data[i] };
    }
  }
  return null;
}

function findUserById_(userId) {
  var sheet = getOrCreateUsersSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][USR.USER_ID]).trim() === String(userId).trim()) {
      return { sheet: sheet, rowIndex: i + 1, rowValues: data[i] };
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Admin-facing RPCs
// ----------------------------------------------------------------------------

// Returns every user (all roles) minus password/salt — admin's Manage
// Users panel. Not locked (read-only).
function listUsers(token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };
    var sheet = getOrCreateUsersSheet_();
    var data = sheet.getDataRange().getValues();
    var users = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!safe_(row[USR.USER_ID])) continue;

      // Lazy self-cleanup (item 14): a pending email whose OTP has expired
      // is discarded right here, the same as on any other read/write path
      // that touches it \u2014 so a stale pending row can never surface as
      // "still pending" in the admin panel just because nobody happened to
      // call verify/cancel on it.
      var pendingEmail = safe_(row[USR.PENDING_EMAIL]);
      var pendingEmailMinutesLeft = null;
      if (pendingEmail) {
        if (discardExpiredPendingEmail_({ sheet: sheet, rowIndex: i + 1, rowValues: row })) {
          pendingEmail = '';
        } else {
          var expiryRaw = row[USR.PENDING_EMAIL_OTP_EXPIRY];
          var expiryDate = (expiryRaw instanceof Date) ? expiryRaw : new Date(expiryRaw);
          pendingEmailMinutesLeft = Math.max(1, Math.ceil((expiryDate.getTime() - Date.now()) / 60000));
        }
      }

      users.push({
        userId: safe_(row[USR.USER_ID]),
        displayName: safe_(row[USR.DISPLAY_NAME]),
        username: safe_(row[USR.USERNAME]),
        role: safe_(row[USR.ROLE]),
        active: safe_(row[USR.ACTIVE]) === 'Yes',
        createdAt: safe_(row[USR.CREATED_AT]),
        lastLogin: safe_(row[USR.LAST_LOGIN]),
        email: safe_(row[USR.EMAIL]),
        designation: safe_(row[USR.DESIGNATION]),
        pendingEmail: pendingEmail,
        pendingEmailMinutesLeft: pendingEmailMinutesLeft,
        // 'online' = seen in the last SESSION_ACTIVE_WINDOW_SECONDS; 'idle' = logged in but not seen
        // recently (probably abandoned); '' = no session.
        sessionState: userSessionState_(safe_(row[USR.USER_ID]))
      });
    }
    users.sort(function (a, b) {
      if (a.role !== b.role) return a.role < b.role ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
    return { success: true, users: users, sessionRuleEnforced: singleSessionEnforced_() };
  } catch (err) {
    Logger.log('listUsers error: ' + err);
    return { success: false, error: 'Failed to load users: ' + err.toString() };
  }
}

function userSessionState_(userId) {
  try {
    var live = findLiveSessionForUser_(String(userId));
    if (!live) return '';
    return sessionIsActive_(live.rec) ? 'online' : 'idle';
  } catch (e) { return ''; }
}

function createUser(displayName, role, username, password, email, designation, token) {
  var lock = LockService.getScriptLock();
  try {
    var session = validateSession_(token);
    if (!session.valid || session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };

    displayName = String(displayName || '').trim();
    if (!displayName) return { success: false, error: 'Display name is required.' };
    if (MULTI_USER_ROLES.indexOf(role) === -1) return { success: false, error: 'Invalid role.' };

    var uv = validateUsername_(username);
    if (!uv.valid) return { success: false, error: uv.error };

    var pwError = validatePasswordStrength_(password);
    if (pwError) return { success: false, error: pwError };

    var ev = validateOptionalEmail_(email);
    if (!ev.valid) return { success: false, error: ev.error };

    var dv = validateDesignation_(designation);
    if (!dv.valid) return { success: false, error: dv.error };

    try { lock.waitLock(15000); } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    if (findUserByUsername_(uv.username)) {
      return { success: false, error: 'Username "' + uv.username + '" is already taken.' };
    }

    var sheet = getOrCreateUsersSheet_();
    var userId = 'U-' + Utilities.getUuid().slice(0, 8);
    var salt = generateSalt_();
    var hash = hashPassword_(password, salt);
    var newRow = new Array(EXPECTED_USER_HEADERS.length).fill('');
    newRow[USR.USER_ID]       = userId;
    newRow[USR.DISPLAY_NAME]  = displayName;
    newRow[USR.USERNAME]      = uv.username;
    newRow[USR.ROLE]          = role;
    newRow[USR.PASSWORD_HASH] = hash;
    newRow[USR.SALT]          = salt;
    newRow[USR.ACTIVE]        = 'Yes';
    newRow[USR.CREATED_AT]    = new Date().toLocaleString('en-IN');
    newRow[USR.LAST_LOGIN]    = '';
    newRow[USR.DESIGNATION]   = dv.designation;
    // CHANGED (item 14): email is NEVER written directly to USR.EMAIL here
    // anymore \u2014 it's the hard OTP gate applying to account creation too,
    // same as an edit. newRow[USR.EMAIL] stays blank; if an email was
    // supplied it goes to Pending Email + an OTP is sent to IT (not
    // written anywhere final) immediately below, once the row exists.
    sheet.appendRow(newRow);
    clearDesignationCache_();

    var pendingNote = '';
    if (ev.email) {
      try {
        beginPendingEmailChange_({ sheet: sheet, rowIndex: sheet.getLastRow(), rowValues: newRow }, ev.email, session);
        pendingNote = ' A confirmation email was sent to ' + ev.email + ' \u2014 the email is used once its owner presses Yes.';
      } catch (otpErr) {
        pendingNote = ' Note: the confirmation email failed to send (' + otpErr.message + ') \u2014 use Set Email to retry.';
      }
    }

    logAction_('USER_CREATE', '', session.displayName, session.role, 'Created user "' + displayName + '" (' + uv.username + ', role: ' + role + (dv.designation ? ', position: ' + dv.designation : '') + ')' + (ev.email ? ', pending email: ' + ev.email : ''));
    return { success: true, userId: userId, message: 'User "' + displayName + '" created.' + pendingNote };
  } catch (err) {
    Logger.log('createUser error: ' + err);
    return { success: false, error: 'Failed to create user: ' + err.toString() };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ----------------------------------------------------------------------------
// EMAIL CONFIRMATION (item 14, 25 Aug 2026; reworked 20 Sep 2026) — shared
// helpers used by createUser (above), setUserEmail, cancelPendingEmailChange,
// listUsers' lazy self-cleanup, and the public confirmation RPCs further down.
//
// How it works: the admin enters an address. The system emails THAT address a
// link to a page ("Confirm this email address" with Yes / No). Only a Yes
// pressed on that page moves the address into USR.EMAIL. The admin never sees
// or handles a code.
// ----------------------------------------------------------------------------
function clearPendingEmailColumns_(found) {
  found.sheet.getRange(found.rowIndex, USR.PENDING_EMAIL + 1).setValue('');
  found.sheet.getRange(found.rowIndex, USR.PENDING_EMAIL_OTP_HASH + 1).setValue('');
  found.sheet.getRange(found.rowIndex, USR.PENDING_EMAIL_OTP_SALT + 1).setValue('');
  found.sheet.getRange(found.rowIndex, USR.PENDING_EMAIL_OTP_EXPIRY + 1).setValue('');
}

// Discards a pending email change if its link has expired, run lazily on
// every read/write path that touches pending-email state (setUserEmail,
// getEmailVerificationRequest, respondToEmailVerification, listUsers) instead
// of a time-based trigger — the confirmed design (it expires, is discarded, and
// the admin redoes it), and there is no other reason for this codebase to poll
// every user row on a timer. Returns true if it discarded something.
function discardExpiredPendingEmail_(found) {
  var pending = safe_(found.rowValues[USR.PENDING_EMAIL]);
  var expiryRaw = found.rowValues[USR.PENDING_EMAIL_OTP_EXPIRY];
  if (!pending || !expiryRaw) return false;
  var expiryDate = (expiryRaw instanceof Date) ? expiryRaw : new Date(expiryRaw);
  if (isNaN(expiryDate.getTime()) || expiryDate.getTime() > Date.now()) return false;
  clearPendingEmailColumns_(found);
  logAction_('USER_EMAIL_VERIFY_EXPIRED', '', 'system', 'system', 'Pending email confirmation expired for "' + safe_(found.rowValues[USR.DISPLAY_NAME]) + '" (' + pending + ')');
  return true;
}

// 60 random hex characters (240 bits) from Utilities.getUuid() (random v4
// UUIDs) rather than Math.random. The two characters that hold a UUID's fixed
// version / variant bits are skipped.
function emailVerifySecret_() {
  var out = '';
  while (out.length < 60) {
    var hex = Utilities.getUuid().replace(/-/g, '');
    out += hex.substr(0, 12) + hex.substr(13, 3) + hex.substr(17, 15);
  }
  return out.substr(0, 60);
}

// Emails the NEW address a confirmation link, THEN — only if the send worked —
// writes Pending Email + the salted hash of the link's secret + its expiry
// (send-before-write: a failed send leaves nothing half-set). Throws (caller
// decides how to handle) if the link cannot be built or the send fails.
function beginPendingEmailChange_(found, newEmail, session) {
  var appUrl = getAppUrl_();
  if (!appUrl) throw new Error('the APP_URL Script Property is not set to the web app\u2019s /exec address, so the confirmation link cannot be built');

  var userId = safe_(found.rowValues[USR.USER_ID]);
  var displayName = safe_(found.rowValues[USR.DISPLAY_NAME]);
  var secret = emailVerifySecret_();
  var salt = generateSalt_();
  var hash = hashPassword_(secret, salt);
  var expiry = new Date(Date.now() + EMAIL_VERIFY_EXPIRY_HOURS * 3600000);
  var link = appUrl + (appUrl.indexOf('?') === -1 ? '?' : '&') + 'verifyEmail=' + userId + '.' + secret;

  var mail = {
    displayName: displayName, designation: safe_(found.rowValues[USR.DESIGNATION]), email: newEmail,
    requestedBy: session.displayName || 'An administrator', link: link, expiryHours: EMAIL_VERIFY_EXPIRY_HOURS
  };
  try {
    // Plain text is built here (Notification.gs); the branded HTML is built
    // inside sendNotification_ and falls back to this plain text if it fails.
    sendNotification_({
      to: newEmail,
      subject: 'Rabale Petty Expense System \u2014 please confirm this email address',
      body: emailVerifyRequestText_(mail)
    }, function (hasLogo) { return emailVerifyRequestHtml_(mail, hasLogo); });
  } catch (mailErr) {
    Logger.log('beginPendingEmailChange: failed to send confirmation to ' + newEmail + ': ' + mailErr);
    throw new Error('could not send to ' + newEmail + ' (' + mailErr + ')');
  }

  found.sheet.getRange(found.rowIndex, USR.PENDING_EMAIL + 1).setValue(newEmail);
  found.sheet.getRange(found.rowIndex, USR.PENDING_EMAIL_OTP_HASH + 1).setValue(hash);
  found.sheet.getRange(found.rowIndex, USR.PENDING_EMAIL_OTP_SALT + 1).setValue(salt);
  found.sheet.getRange(found.rowIndex, USR.PENDING_EMAIL_OTP_EXPIRY + 1).setValue(expiry);
  logAction_('USER_EMAIL_VERIFY_SENT', '', session.displayName, session.role, 'Confirmation email sent to ' + newEmail + ' for "' + displayName + '"');
}

// Admin sets/updates a user's email address \u2014 separate RPC rather than
// folded into createUser's edit path, since there is no general "edit
// user" RPC today (display name/role/username are immutable after
// creation by design, same as everywhere else in this file); email is
// the one field that plausibly needs correcting after the fact.
//
// CHANGED (item 14): this no longer writes USR.EMAIL directly for a
// non-blank address \u2014 it starts (or restarts) the pending-email confirmation
// instead; respondToEmailVerification is what actually finalizes it. Setting
// the same pending address again is how the admin RESENDS the link (the old
// link stops working the moment a new one is issued). Clearing an
// email (blank) still applies immediately \u2014 removing an address needs no
// reachability confirmation, only adding/changing to a new one does.
function setUserEmail(userId, email, token) {
  var lock = LockService.getScriptLock();
  try {
    var session = validateSession_(token);
    if (!session.valid || session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };

    var ev = validateOptionalEmail_(email);
    if (!ev.valid) return { success: false, error: ev.error };

    try { lock.waitLock(15000); } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    var found = findUserById_(userId);
    if (!found) return { success: false, error: 'User not found.' };

    if (!ev.email) {
      found.sheet.getRange(found.rowIndex, USR.EMAIL + 1).setValue('');
      clearPendingEmailColumns_(found);
      var clearedName = safe_(found.rowValues[USR.DISPLAY_NAME]);
      logAction_('USER_EMAIL_SET', '', session.displayName, session.role, 'Email for "' + clearedName + '" cleared');
      return { success: true, message: 'Email cleared.' };
    }

    if (ev.email === safe_(found.rowValues[USR.EMAIL])) {
      return { success: false, error: 'That is already this user\u2019s verified email.' };
    }

    var resendKey = 'otpresend_' + userId;
    if (isLocked_(resendKey)) {
      return { success: false, error: 'Please wait a few seconds before requesting another code.' };
    }
    CacheService.getScriptCache().put('lock_' + resendKey, '1', OTP_RESEND_COOLDOWN_SECONDS);

    try {
      beginPendingEmailChange_(found, ev.email, session);
    } catch (otpErr) {
      return { success: false, error: 'Failed to send the confirmation email: ' + otpErr.message };
    }
    return { success: true, pending: true, message: 'Confirmation email sent to ' + ev.email + '. The email is used once its owner opens it and presses Yes.' };
  } catch (err) {
    Logger.log('setUserEmail error: ' + err);
    return { success: false, error: 'Failed to update email: ' + err.toString() };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ----------------------------------------------------------------------------
// PUBLIC CONFIRMATION PAGE + RPCs. Callable WITHOUT a session — the person
// answering is whoever owns the mailbox, not an app user — so, like verifyLogin,
// they authenticate only by holding the token from the emailed link. The token
// is 240 random bits, single use, and expires (EMAIL_VERIFY_EXPIRY_HOURS); its
// format is checked before any sheet is read.
//
// Opening the link (doGet, Main.gs) only DISPLAYS the question. It changes
// nothing, because mail scanners (Outlook Safe Links, Gmail) open every link in
// an email. Only respondToEmailVerification, called by the Yes / No buttons on
// the page, writes anything.
// ----------------------------------------------------------------------------
var EMAIL_VERIFY_INVALID_MESSAGE = 'This link is no longer valid. It may have expired, already been used, or been cancelled. Ask your administrator to send a new one.';

// Returns { ok: true, user: found } or { ok: false }. Never throws.
function emailVerifyFindPending_(token) {
  try {
    var t = String(token || '');
    if (!EMAIL_VERIFY_TOKEN_PATTERN.test(t)) return { ok: false };
    var dot = t.indexOf('.');
    var found = findUserById_(t.substring(0, dot));
    if (!found) return { ok: false };
    if (discardExpiredPendingEmail_(found)) return { ok: false };
    if (!safe_(found.rowValues[USR.PENDING_EMAIL])) return { ok: false };
    var storedHash = safe_(found.rowValues[USR.PENDING_EMAIL_OTP_HASH]);
    var storedSalt = safe_(found.rowValues[USR.PENDING_EMAIL_OTP_SALT]);
    if (!storedHash || !storedSalt || !verifyPassword_(t.substring(dot + 1), storedSalt, storedHash)) return { ok: false };
    return { ok: true, user: found };
  } catch (err) {
    Logger.log('emailVerifyFindPending_: ' + err);
    return { ok: false };
  }
}

// What the confirmation page asks about. Read-only.
function getEmailVerificationRequest(token) {
  var f = emailVerifyFindPending_(token);
  if (!f.ok) return { success: false, error: EMAIL_VERIFY_INVALID_MESSAGE };
  var row = f.user.rowValues;
  return { success: true, displayName: safe_(row[USR.DISPLAY_NAME]), designation: safe_(row[USR.DESIGNATION]), email: safe_(row[USR.PENDING_EMAIL]) };
}

// The Yes / No buttons. accept must be exactly true to confirm; anything else
// is treated as No. Yes is the only path that ever writes USR.EMAIL for a
// non-blank address.
function respondToEmailVerification(token, accept) {
  var lock = LockService.getScriptLock();
  var lockHeld = false;
  try {
    if (!EMAIL_VERIFY_TOKEN_PATTERN.test(String(token || ''))) return { success: false, error: EMAIL_VERIFY_INVALID_MESSAGE };
    try { lock.waitLock(15000); lockHeld = true; } catch (lockErr) {
      return { success: false, error: 'The system is busy. Please try again in a few seconds.' };
    }
    // Looked up under the lock, so one link can only ever be answered once.
    var f = emailVerifyFindPending_(token);
    if (!f.ok) return { success: false, error: EMAIL_VERIFY_INVALID_MESSAGE };
    var found = f.user;
    var displayName = safe_(found.rowValues[USR.DISPLAY_NAME]);
    var pendingEmail = safe_(found.rowValues[USR.PENDING_EMAIL]);

    if (accept === true) {
      found.sheet.getRange(found.rowIndex, USR.EMAIL + 1).setValue(pendingEmail);
      clearPendingEmailColumns_(found);
      logAction_('USER_EMAIL_VERIFIED', '', 'Email owner', 'external', 'Email for "' + displayName + '" confirmed by its owner and set to ' + pendingEmail);
      return { success: true, accepted: true, message: 'Thank you. ' + pendingEmail + ' is now linked to the account for ' + displayName + '. You can close this page.' };
    }
    clearPendingEmailColumns_(found);
    logAction_('USER_EMAIL_VERIFY_REJECTED', '', 'Email owner', 'external', 'The owner of ' + pendingEmail + ' said it should not be linked to "' + displayName + '" \u2014 pending change discarded');
    return { success: true, accepted: false, message: 'Okay. Nothing was changed, and the address was not linked. You can close this page.' };
  } catch (err) {
    Logger.log('respondToEmailVerification error: ' + err);
    return { success: false, error: 'Something went wrong. Please try again.' };
  } finally {
    if (lockHeld) { try { lock.releaseLock(); } catch (e) {} }
  }
}

// The standalone confirmation page served by doGet (Main.gs) for
// ?verifyEmail=<token>. Everything variable is written with textContent, never
// as HTML. The token is embedded only if it matches the exact token format
// (so nothing else can ever reach the script), as a JSON string.
function emailVerifyPageHtml_(token) {
  var t = String(token || '');
  var safeToken = EMAIL_VERIFY_TOKEN_PATTERN.test(t) ? t : '';
  var logo = '';
  try { logo = '<img src="' + getLogoFullDataUri_() + '" alt="Target Learning Ventures Pvt. Ltd." style="display:block;width:100%;max-width:300px;height:auto;margin:0 0 22px;">'; } catch (e) { logo = ''; }
  // Same look as the login page and the emails: logo navy, soft tinted background, rounded card, flowing-line divider.
  var css = 'body{margin:0;background:linear-gradient(160deg,#EEF0FC 0%,#F7F8FD 55%,#FDF1F1 100%);font-family:"Work Sans",-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#14173F;-webkit-font-smoothing:antialiased}' +
    '.wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}' +
    '.card{width:100%;max-width:460px;background:rgba(255,255,255,.92);border:1px solid #D9DDF0;border-radius:20px;padding:30px;box-shadow:0 30px 60px -32px rgba(31,33,112,.45)}' +
    '.wave{height:12px;margin:0 0 20px;background:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 400 12\' preserveAspectRatio=\'none\'><path d=\'M0 6 C50 0 90 12 150 6 S250 0 300 6 S370 11 400 5\' fill=\'none\' stroke=\'%232e3192\' stroke-opacity=\'.34\' stroke-width=\'1.4\' stroke-linecap=\'round\'/></svg>") no-repeat center/100% 100%}' +
    'h1{font-size:24px;line-height:1.15;margin:0 0 14px;font-weight:800;letter-spacing:-.02em}p{font-size:15px;line-height:1.55;margin:0 0 14px}.fine{font-size:13px;color:#454B6B}' +
    '.who{background:#F1F2FB;border:1px solid #D9DDF0;border-radius:12px;padding:12px 14px;font-size:15px;line-height:1.6;margin:0 0 14px}' +
    'button{font-family:inherit;font-size:15px;font-weight:700;border-radius:12px;padding:14px 18px;cursor:pointer;width:100%;margin-top:10px;border:1.5px solid #2E3192}' +
    'button:focus-visible{outline:3px solid #2E3192;outline-offset:2px}' +
    '#yes{background:#2E3192;color:#fff}#yes:hover{background:#1F2170}#no{background:#fff;color:#2E3192}#no:hover{background:#F5F6FD}' +
    'button:disabled{opacity:.55;cursor:not-allowed}.hidden{display:none}' +
    '.ok{color:#1F5B45}.bad{color:#8B3330}';
  var script = 'var TOKEN=' + JSON.stringify(safeToken) + ';' +
    'function $(id){return document.getElementById(id);}' +
    'function showDone(kind,title,text){$("stLoading").className="hidden";$("stAsk").className="hidden";' +
      '$("doneTitle").textContent=title;$("doneTitle").className=kind;$("doneText").textContent=text;$("stDone").className="";}' +
    'if(!TOKEN){showDone("bad","This link cannot be used",' + JSON.stringify(EMAIL_VERIFY_INVALID_MESSAGE) + ');}' +
    'else{google.script.run.withSuccessHandler(function(r){' +
      'if(!r||!r.success){showDone("bad","This link cannot be used",(r&&r.error)||' + JSON.stringify(EMAIL_VERIFY_INVALID_MESSAGE) + ');return;}' +
      '$("who").textContent=r.displayName+(r.designation?" ("+r.designation+")":"");$("addr").textContent=r.email;' +
      '$("stLoading").className="hidden";$("stAsk").className="";})' +
    '.withFailureHandler(function(e){showDone("bad","Something went wrong","Please reload this page in a moment. "+e);})' +
    '.getEmailVerificationRequest(TOKEN);}' +
    'function answer(yes){$("yes").disabled=true;$("no").disabled=true;$("askErr").textContent="";' +
      'google.script.run.withSuccessHandler(function(r){' +
        'if(!r||!r.success){showDone("bad","This could not be saved",(r&&r.error)||"Please try again.");return;}' +
        'showDone(r.accepted?"ok":"",r.accepted?"Thank you":"Nothing was changed",r.message);})' +
      '.withFailureHandler(function(e){$("yes").disabled=false;$("no").disabled=false;$("askErr").textContent="Something went wrong, nothing was saved. Please try again. "+e;})' +
      '.respondToEmailVerification(TOKEN,yes);}' +
    '$("yes").addEventListener("click",function(){answer(true);});$("no").addEventListener("click",function(){answer(false);});';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Confirm your email address</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet"><style>' + css + '</style></head><body><div class="wrap"><div class="card">' + logo +
    '<div class="wave" aria-hidden="true"></div><h1>Confirm your email address</h1>' +
    '<div id="stLoading"><p>Checking your link...</p></div>' +
    '<div id="stAsk" class="hidden">' +
      '<p>Should this email address be linked to the following account on the Rabale Petty Expense System?</p>' +
      '<div class="who"><div>Account: <b id="who"></b></div><div>Email address: <b id="addr"></b></div></div>' +
      '<p class="fine">Press Yes only if this is your email address and you know this account. This only confirms the address. It does not log anyone in or change anything else.</p>' +
      '<p id="askErr" class="bad" role="alert"></p>' +
      '<button id="yes" type="button">Yes, this is my email address</button><button id="no" type="button">No, this is not right</button>' +
    '</div>' +
    '<div id="stDone" class="hidden"><h1 id="doneTitle"></h1><p id="doneText"></p></div>' +
    '</div></div><script>' + script + '</script></body></html>';
}

// Lets admin abandon a pending change without waiting for it to expire
// (e.g. typo'd the new address). Any link already emailed stops working.
function cancelPendingEmailChange(userId, token) {
  try {
    var session = validateSession_(token);
    if (!session.valid || session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };

    var found = findUserById_(userId);
    if (!found) return { success: false, error: 'User not found.' };
    if (!safe_(found.rowValues[USR.PENDING_EMAIL])) return { success: false, error: 'No pending email change to cancel.' };

    clearPendingEmailColumns_(found);
    logAction_('USER_EMAIL_VERIFY_CANCELLED', '', session.displayName, session.role, 'Pending email change cancelled for "' + safe_(found.rowValues[USR.DISPLAY_NAME]) + '"');
    return { success: true, message: 'Pending email change cancelled.' };
  } catch (err) {
    Logger.log('cancelPendingEmailChange error: ' + err);
    return { success: false, error: 'Failed to cancel: ' + err.toString() };
  }
}

// ----------------------------------------------------------------------------
// Role-level email notification (bugfix round) — the actual replacement
// for the removed notification bell. Roles here are shared logins ("anyone
// active in L1 can act on any voucher" — see this file's header comment),
// so there is no single correct recipient for "notify L1"; every active
// user in that role with an email on file gets emailed. A role with nobody
// configured is a silent no-op (Logger.log only), same graceful-degradation
// convention as VENDOR_REQUEST_EMAIL/QUERY_REMINDER_EMAIL — a missing
// config value should never throw up through a caller that's usually
// mid-transaction (e.g. raiseVoucherQuery).
// ----------------------------------------------------------------------------
function getActiveUserEmailsForRole_(role) {
  return getActiveUsersForRole_(role).map(function (u) { return u.email; });
}

// The same active, email-bearing users as above, with who they are, for
// emails that greet the recipient by name and position (the approver digest).
// One entry per distinct email address.
function getActiveUsersForRole_(role) {
  var sheet = getOrCreateUsersSheet_();
  var data = sheet.getDataRange().getValues();
  var users = [];
  var seen = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (safe_(row[USR.ROLE]) !== role) continue;
    if (safe_(row[USR.ACTIVE]) !== 'Yes') continue;
    var email = safe_(row[USR.EMAIL]);
    if (!email || seen[email]) continue;
    seen[email] = true;
    users.push({ email: email, displayName: safe_(row[USR.DISPLAY_NAME]), designation: safe_(row[USR.DESIGNATION]) });
  }
  return users;
}

// ----------------------------------------------------------------------------
// POSITION LOOKUP BY NAME — stamps each Audit Log entry with the actor's
// position (logAction, Audit Log.gs), and adds a position to emails that only
// know a person's display name (e.g. who raised a query).
//
// Keyed on display name because that is what every logAction call passes.
// Display names are not enforced unique, so a name shared by two users with
// DIFFERENT positions maps to '' (blank) rather than guessing which one it
// was. Read-only; never throws to a caller; a failed lookup is simply blank.
// ----------------------------------------------------------------------------
var _designationMapsMemo = null; // per-execution copy of the cached maps

function getDesignationMaps_() {
  if (_designationMapsMemo) return _designationMapsMemo;
  var cache = null;
  var maps = null;
  try {
    cache = CacheService.getScriptCache();
    var raw = cache.get(DESIGNATION_CACHE_KEY);
    if (raw) maps = JSON.parse(raw);
  } catch (cacheErr) { maps = null; }
  if (!maps) {
    maps = { byName: {} };
    var sheet = getSheet_(USERS_SHEET);
    if (sheet) {
      var data = sheet.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        var name = safe_(data[i][USR.DISPLAY_NAME]);
        if (!name) continue;
        var d = safe_(data[i][USR.DESIGNATION]);
        if (Object.prototype.hasOwnProperty.call(maps.byName, name)) {
          if (maps.byName[name] !== d) maps.byName[name] = ''; // ambiguous: do not guess
        } else {
          maps.byName[name] = d;
        }
      }
    }
    try { if (cache) cache.put(DESIGNATION_CACHE_KEY, JSON.stringify(maps), DESIGNATION_CACHE_SECONDS); } catch (putErr) { /* cache is an optimisation only */ }
  }
  _designationMapsMemo = maps;
  return maps;
}

function lookupDesignationByName_(displayName) {
  try {
    var name = safe_(displayName);
    if (!name) return '';
    var byName = getDesignationMaps_().byName;
    return Object.prototype.hasOwnProperty.call(byName, name) ? byName[name] : '';
  } catch (err) {
    Logger.log('lookupDesignationByName_: ' + err);
    return '';
  }
}

function clearDesignationCache_() {
  _designationMapsMemo = null;
  try { CacheService.getScriptCache().remove(DESIGNATION_CACHE_KEY); } catch (err) { /* nothing cached is fine */ }
}

// Sends one email per recipient (not one email with everyone in "to") so
// nobody sees a colleague's address, and so a bad address on one account
// (MailApp throws per-send) doesn't stop the others from going out.
// Returns the count actually sent — callers use this only for logging,
// never to decide whether to fail the caller's own operation.
// Goes through the shared branded template like every other email (the plain text
// is turned into the same layout), so it can never send a bare typed-out message.
function notifyRole_(role, subject, body) {
  var logo = getEmailLogoBlob_();
  var html = null;
  try { html = buildPlainEmailHtml_(subject, body, !!logo, getAppUrl_()); } catch (buildErr) { Logger.log('notifyRole: HTML build failed: ' + buildErr); }
  return notifyRoleBranded_(role, subject, body, html, logo);
}

// ----------------------------------------------------------------------------
// SINGLE-USER ACCOUNT-EVENT NOTIFICATION (item 15, 25 Aug 2026) — the
// one-specific-person counterpart to notifyRole() above, for password
// reset / deactivation / lockout / lockout-cleared. notifyRole broadcasts
// to every active user in a role, which is wrong for these four events:
// each one is about exactly the one account it happened to, so this takes
// a user row (from findUserById/findUserByUsername) directly rather than
// a role.
//
// Auditor exclusion: CONFIRMED (not assumed) that Auditor is a normal
// MULTI_USER_ROLES member that can have USR.EMAIL populated exactly like
// every other role (createUser/setUserEmail don't special-case it) — so
// "no email on file" does NOT already cover the exclusion for free, and
// this checks role === 'auditor' explicitly rather than relying on that.
//
// Same graceful-degradation posture as every other MailApp call site in
// this codebase: a missing email is a skip, a send failure is caught and
// logged, and NEITHER ever throws back to the caller — none of these four
// operations (password reset, deactivation, lockout, unlock) may fail or
// be blocked because a notification email didn't go out.
function notifyUserOfAccountEvent_(userRow, eventLogAction, subject, body) {
  try {
    if (!userRow) return;
    var role = safe_(userRow[USR.ROLE]);
    if (role === 'auditor') {
      Logger.log('notifyUserOfAccountEvent: skipped (' + eventLogAction + ') \u2014 Auditor accounts never receive these emails.');
      return;
    }
    var email = safe_(userRow[USR.EMAIL]);
    var displayName = safe_(userRow[USR.DISPLAY_NAME]);
    if (!email) {
      Logger.log('notifyUserOfAccountEvent: skipped (' + eventLogAction + ') for "' + displayName + '" \u2014 no email on file.');
      logAction_(eventLogAction + '_EMAIL_SKIPPED', '', 'system', 'system', 'No email on file for "' + displayName + '".');
      return;
    }
    try {
      // HTML version built from the same plain-text `body` (Notifications.gs,
      // buildAccountEventEmail_); if that ever fails the plain text still goes.
      sendNotification_({ to: email, subject: subject, body: body }, function (hasLogo) {
        return buildAccountEventEmail_(eventLogAction, displayName, subject, body, new Date().toLocaleString('en-IN'), getAppUrl_(), hasLogo, safe_(userRow[USR.DESIGNATION]));
      });
      logAction_(eventLogAction + '_EMAIL_SENT', '', 'system', 'system', 'Notified "' + displayName + '" at ' + email + '.');
    } catch (mailErr) {
      Logger.log('notifyUserOfAccountEvent: failed to email ' + email + ': ' + mailErr);
      logAction_(eventLogAction + '_EMAIL_FAILED', '', 'system', 'system', 'Failed to email "' + displayName + '" at ' + email + ': ' + mailErr);
    }
  } catch (err) {
    // Belt-and-braces: this whole function is fire-and-forget from every
    // caller's perspective, so even an unexpected error here (e.g. a
    // malformed userRow) must never propagate up into a password
    // reset/deactivation/lockout and block it.
    Logger.log('notifyUserOfAccountEvent unexpected error: ' + err);
  }
}

// Admin sets or clears a user's position in the company. Position is display
// text only — it has no effect on what the user can do (that is ROLE) — so
// it can be corrected at any time. Blank clears it.
function setUserDesignation(userId, designation, token) {
  var lock = LockService.getScriptLock();
  try {
    var session = validateSession_(token);
    if (!session.valid || session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };
    var dv = validateDesignation_(designation);
    if (!dv.valid) return { success: false, error: dv.error };
    try { lock.waitLock(15000); } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }
    var found = findUserById_(userId);
    if (!found) return { success: false, error: 'User not found.' };
    var displayName = safe_(found.rowValues[USR.DISPLAY_NAME]);
    var previous = safe_(found.rowValues[USR.DESIGNATION]);
    found.sheet.getRange(found.rowIndex, USR.DESIGNATION + 1).setValue(dv.designation);
    clearDesignationCache_();
    logAction_('USER_DESIGNATION_SET', '', session.displayName, session.role,
      'Position for "' + displayName + '": ' + (previous ? '"' + previous + '"' : '(not set)') + ' \u2192 ' + (dv.designation ? '"' + dv.designation + '"' : '(cleared)'));
    return { success: true, designation: dv.designation, message: dv.designation ? 'Position for "' + displayName + '" set to "' + dv.designation + '".' : 'Position for "' + displayName + '" cleared.' };
  } catch (err) {
    Logger.log('setUserDesignation error: ' + err);
    return { success: false, error: 'Failed to update position: ' + err.toString() };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function setUserActive(userId, active, token) {
  var lock = LockService.getScriptLock();
  try {
    var session = validateSession_(token);
    if (!session.valid || session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };

    try { lock.waitLock(15000); } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    var found = findUserById_(userId);
    if (!found) return { success: false, error: 'User not found.' };

    found.sheet.getRange(found.rowIndex, USR.ACTIVE + 1).setValue(active ? 'Yes' : 'No');
    if (!active) endUserSession_(String(userId), 'deactivated'); // a deactivated user must not stay logged in
    var displayName = safe_(found.rowValues[USR.DISPLAY_NAME]);
    logAction_(active ? 'USER_ACTIVATE' : 'USER_DEACTIVATE', '', session.displayName, session.role, 'User "' + displayName + '"');
    // ADDED (item 15): notify on deactivation only, per spec — activation
    // (re-enabling) isn't an event the user needs alerted about.
    if (!active) {
      notifyUserOfAccountEvent_(found.rowValues, 'USER_DEACTIVATE',
        'Rabale Petty Expense System \u2014 your account has been deactivated',
        'Hello ' + displayName + ',\n\nYour account on the Rabale Petty Expense System has been deactivated by an administrator. ' +
        'You will not be able to log in until it is reactivated.\n\nIf you believe this is a mistake, please contact your administrator.');
    }
    return { success: true };
  } catch (err) {
    Logger.log('setUserActive error: ' + err);
    return { success: false, error: 'Failed to update user: ' + err.toString() };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Admin sets someone's password directly (lost/forgotten password path).
function resetUserPassword(userId, newPassword, token) {
  var lock = LockService.getScriptLock();
  try {
    var session = validateSession_(token);
    if (!session.valid || session.role !== 'admin') return { success: false, error: 'You do not have permission to do this.' };

    var pwError = validatePasswordStrength_(newPassword);
    if (pwError) return { success: false, error: pwError };

    try { lock.waitLock(15000); } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    var found = findUserById_(userId);
    if (!found) return { success: false, error: 'User not found.' };

    var salt = generateSalt_();
    var hash = hashPassword_(newPassword, salt);
    found.sheet.getRange(found.rowIndex, USR.PASSWORD_HASH + 1).setValue(hash);
    found.sheet.getRange(found.rowIndex, USR.SALT + 1).setValue(salt);
    endUserSession_(String(userId), 'reset'); // the old password's session must not outlive the reset

    var displayName = safe_(found.rowValues[USR.DISPLAY_NAME]);
    logAction_('USER_PASSWORD_RESET', '', session.displayName, session.role, 'Password reset for "' + displayName + '" by admin');
    notifyUserOfAccountEvent_(found.rowValues, 'USER_PASSWORD_RESET',
      'Rabale Petty Expense System \u2014 your password was reset',
      'Hello ' + displayName + ',\n\nYour password on the Rabale Petty Expense System was just reset by an administrator. ' +
      'If you did not expect this, please contact your administrator immediately.');
    return { success: true };
  } catch (err) {
    Logger.log('resetUserPassword error: ' + err);
    return { success: false, error: 'Failed to reset password: ' + err.toString() };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Self-service — any logged-in multi-user-role person changes their own
// password from inside their own dashboard. Requires the current password,
// same as any normal "change password" flow.
function changeOwnPassword(oldPassword, newPassword, token) {
  var lock = LockService.getScriptLock();
  try {
    var session = validateSession_(token);
    if (!session.valid || !session.userId || MULTI_USER_ROLES.indexOf(session.role) === -1) {
      return { success: false, error: 'This account type does not use a password change here.' };
    }

    var pwError = validatePasswordStrength_(newPassword);
    if (pwError) return { success: false, error: pwError };

    try { lock.waitLock(15000); } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    var found = findUserById_(session.userId);
    if (!found) return { success: false, error: 'Account not found. Please log in again.' };

    var storedHash = safe_(found.rowValues[USR.PASSWORD_HASH]);
    var storedSalt = safe_(found.rowValues[USR.SALT]);
    if (!verifyPassword_(oldPassword, storedSalt, storedHash)) {
      return { success: false, error: 'Current password is incorrect.' };
    }

    var newSalt = generateSalt_();
    var newHash = hashPassword_(newPassword, newSalt);
    found.sheet.getRange(found.rowIndex, USR.PASSWORD_HASH + 1).setValue(newHash);
    found.sheet.getRange(found.rowIndex, USR.SALT + 1).setValue(newSalt);

    logAction_('USER_PASSWORD_CHANGE', '', session.displayName, session.role, 'Self-service password change');
    notifyUserOfAccountEvent_(found.rowValues, 'USER_PASSWORD_CHANGE',
      'Rabale Petty Expense System \u2014 your password was changed',
      'Hello ' + safe_(found.rowValues[USR.DISPLAY_NAME]) + ',\n\nYour password on the Rabale Petty Expense System was just changed. ' +
      'If you did not make this change, please contact your administrator immediately.');
    return { success: true };
  } catch (err) {
    Logger.log('changeOwnPassword error: ' + err);
    return { success: false, error: 'Failed to change password: ' + err.toString() };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ----------------------------------------------------------------------------
// One-time manual setup — run ONCE from the Apps Script editor (select this
// function in the dropdown, click Run). Safe to re-run: skips any username
// that already exists rather than creating duplicates. Starter passwords
// are intentionally simple/known so you can log in immediately and create
// real accounts — deactivate these once real accounts exist.
// ----------------------------------------------------------------------------
function bootstrapDefaultUsers() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var starters = [
    { displayName: 'Submission Starter', role: 'submission', username: 'sub.starter' },
    { displayName: 'L1 Starter',         role: 'L1',         username: 'l1.starter' },
    { displayName: 'Accounts Starter',   role: 'accounts',   username: 'acc.starter' },
    { displayName: 'L2 Starter',         role: 'L2',         username: 'l2.starter' }
  ];
  var starterPassword = 'Rabale@2026';
  var sheet = getOrCreateUsersSheet_();
  var created = [];
  starters.forEach(function (s) {
    if (findUserByUsername_(s.username)) { return; }
    var userId = 'U-' + Utilities.getUuid().slice(0, 8);
    var salt = generateSalt_();
    var hash = hashPassword_(starterPassword, salt);
    var newRow = new Array(EXPECTED_USER_HEADERS.length).fill('');
    newRow[USR.USER_ID]       = userId;
    newRow[USR.DISPLAY_NAME]  = s.displayName;
    newRow[USR.USERNAME]      = s.username;
    newRow[USR.ROLE]          = s.role;
    newRow[USR.PASSWORD_HASH] = hash;
    newRow[USR.SALT]          = salt;
    newRow[USR.ACTIVE]        = 'Yes';
    newRow[USR.CREATED_AT]    = new Date().toLocaleString('en-IN');
    newRow[USR.LAST_LOGIN]    = '';
    sheet.appendRow(newRow);
    created.push(s.username);
  });
  Logger.log('bootstrapDefaultUsers: created ' + created.length + ' starter account(s): ' + created.join(', ') + '. Starter password for all: ' + starterPassword);
  return created;
}