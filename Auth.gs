// ============================================================================
// AUTH — login, sessions, logout
// ============================================================================
// REVISED (Day 5): 'admin' still logs in with a single shared PIN (sourced
// from Script Properties now, not hardcoded — see getAdminPin() in
// Config.gs). The 4 MULTI_USER_ROLES (submission, L1, accounts, L2) now
// log in with an individual username + password (Users sheet, see
// Users.gs) instead of one shared PIN per role — so the Audit Log can
// attribute actions to a real person, not just a role. Permissions are
// UNCHANGED: they are still keyed on role only, so anyone active in a
// given role can act on any voucher at that stage (deliberate — covers
// for someone being out).
//
// Brute-force lockout is now keyed by IDENTITY, not role: for admin,
// that's still the role itself ('admin'); for the 4 multi-user roles,
// it's the typed username, so one person's mistyped password can't lock
// out their whole team, and a lockout can't be used to fingerprint which
// usernames are valid (the counter increments under the typed username
// whether or not that username actually exists).

function generateToken_() {
  // 64 hex characters (~244 random bits) from Utilities.getUuid() (a secure random v4 UUID), not Math.random.
  // Nothing depends on the length or alphabet: a session is found by looking the token up, not by parsing it.
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function isLocked_(identityKey) {
  return !!CacheService.getScriptCache().get('lock_' + identityKey);
}

function registerFailedAttempt_(identityKey) {
  var cache = CacheService.getScriptCache();
  var attKey = 'att_' + identityKey;
  var attempts = parseInt(cache.get(attKey) || '0') + 1;
  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    cache.put('lock_' + identityKey, '1', LOCKOUT_SECONDS);
    cache.remove(attKey);
    return { locked: true, attemptsLeft: 0 };
  }
  cache.put(attKey, String(attempts), LOCKOUT_SECONDS);
  return { locked: false, attemptsLeft: MAX_LOGIN_ATTEMPTS - attempts };
}

function clearFailedAttempts_(identityKey) {
  var cache = CacheService.getScriptCache();
  cache.remove('att_' + identityKey);
}

// Admin-specific counterpart to registerFailedAttempt() above — kept as a
// near-duplicate rather than a shared/parameterized function so that
// registerFailedAttempt()'s signature and thresholds stay exactly as they
// are for the 4 multi-user roles. Uses ADMIN_MAX_LOGIN_ATTEMPTS /
// ADMIN_LOCKOUT_SECONDS (Config.gs) instead of MAX_LOGIN_ATTEMPTS /
// LOCKOUT_SECONDS. isLocked() and clearFailedAttempts() above are
// identity-key-generic and already work unchanged for the 'admin' key.
function registerAdminFailedAttempt_(identityKey) {
  var cache = CacheService.getScriptCache();
  var attKey = 'att_' + identityKey;
  var attempts = parseInt(cache.get(attKey) || '0') + 1;
  if (attempts >= ADMIN_MAX_LOGIN_ATTEMPTS) {
    cache.put('lock_' + identityKey, '1', ADMIN_LOCKOUT_SECONDS);
    cache.remove(attKey);
    return { locked: true, attemptsLeft: 0 };
  }
  cache.put(attKey, String(attempts), ADMIN_LOCKOUT_SECONDS);
  return { locked: false, attemptsLeft: ADMIN_MAX_LOGIN_ATTEMPTS - attempts };
}

// ----------------------------------------------------------------------------
// SESSION RECORDS (script cache)
//   sess_<token>   the session itself (role, who, hard expiry, when it was last seen)
//   usess_<key>    which token is the account's live session. <key> is the user id, or
//                  'admin' for the shared Admin login. This is what makes "one login per
//                  account" possible: without it nothing can tell an account is in use.
//   sessend_<tok>  why a session ended (ended / replaced / reset / deactivated), kept 15 min
//                  so the page that was logged out can say so instead of just failing.
// ----------------------------------------------------------------------------
function sessionUserKey_(role, userId) {
  return role === 'admin' ? 'admin' : String(userId || '');
}

// Per-account "revocation counter". A session remembers the value it was created under; when an admin ends an
// account's sessions the counter goes up, and every older session of that account stops working at its next call,
// even if the usess_ pointer to it was lost (cache eviction, a bug). Sessions created before this existed count as 0.
function sessionEpoch_(ukey) {
  try { return parseInt(CacheService.getScriptCache().get('sepoch_' + ukey) || '0', 10) || 0; } catch (e) { return 0; }
}
function bumpSessionEpoch_(ukey) {
  if (!ukey) return;
  try { CacheService.getScriptCache().put('sepoch_' + ukey, String(sessionEpoch_(ukey) + 1), 21600); } catch (e) { Logger.log('bumpSessionEpoch_: ' + e); }
}

// The one-login rule can be paused without a redeploy: Manage Users > "Pause the one-login rule" (or the Script
// Property SINGLE_SESSION = off). The constant in Config.gs is the default when the property is not set.
function singleSessionEnforced_() {
  if (!SINGLE_SESSION_ENFORCED) return false;
  try { return PropertiesService.getScriptProperties().getProperty('SINGLE_SESSION') !== 'off'; } catch (e) { return true; }
}

function readSessionRecord_(token) {
  try {
    var raw = CacheService.getScriptCache().get('sess_' + token);
    if (!raw) return null;
    var s = JSON.parse(raw);
    return (s && s.role) ? s : null;
  } catch (e) { return null; }
}

function createSessionAndLog_(role, userId, displayName, designation) {
  var token = generateToken_();
  var ukey = sessionUserKey_(role, userId);
  var cache = CacheService.getScriptCache();
  cache.put(
    'sess_' + token,
    JSON.stringify({ role: role, userId: userId, ukey: ukey, displayName: displayName, designation: designation || '', expires: Date.now() + SESSION_EXPIRY_SECONDS * 1000, seen: Date.now(), ep: sessionEpoch_(ukey) }),
    SESSION_EXPIRY_SECONDS
  );
  if (ukey) cache.put('usess_' + ukey, token, SESSION_EXPIRY_SECONDS);
  logAction_('LOGIN', '', displayName, role, 'Logged in');
  return token;
}

// The account's live (unexpired) session, or null. A pointer to a session that no
// longer exists is cleaned up here.
function findLiveSessionForUser_(ukey) {
  if (!ukey) return null;
  var cache = CacheService.getScriptCache();
  var token = cache.get('usess_' + ukey);
  if (!token) return null;
  var rec = readSessionRecord_(token);
  if (!rec || rec.ukey !== ukey || Date.now() > rec.expires) { cache.remove('usess_' + ukey); return null; }
  return { token: token, rec: rec };
}

// Seen within SESSION_ACTIVE_WINDOW_SECONDS -> somebody is really using it.
function sessionIsActive_(rec) {
  return (Date.now() - (Number(rec.seen) || 0)) < SESSION_ACTIVE_WINDOW_SECONDS * 1000;
}

// Removes a session everywhere. reason (optional) is remembered for the page that was using it.
function endSession_(token, reason) {
  if (!token) return;
  var cache = CacheService.getScriptCache();
  var rec = readSessionRecord_(token);
  if (reason) cache.put('sessend_' + token, reason, 900);
  cache.remove('sess_' + token);
  if (rec && rec.ukey && cache.get('usess_' + rec.ukey) === token) cache.remove('usess_' + rec.ukey);
}

// Ends whatever session the account has. Returns true if there was one.
function endUserSession_(ukey, reason) {
  var live = findLiveSessionForUser_(ukey);
  if (live) endSession_(live.token, reason);
  else CacheService.getScriptCache().remove('usess_' + ukey);
  bumpSessionEpoch_(ukey); // also kills any session of this account that the pointer above did not know about
  return !!live;
}

function sessionEndReason_(token) {
  try { return CacheService.getScriptCache().get('sessend_' + token) || 'expired'; } catch (e) { return 'expired'; }
}

// Records "seen now", at most once per SESSION_TOUCH_MIN_INTERVAL_SECONDS. Never blocks or fails
// the caller. Re-reads just before writing so a session that was ended a moment ago is not
// brought back to life by a call that was already in flight.
function touchSessionRecord_(token, rec) {
  try {
    var now = Date.now();
    if (now - (Number(rec.seen) || 0) < SESSION_TOUCH_MIN_INTERVAL_SECONDS * 1000) return;
    var cache = CacheService.getScriptCache();
    if (!cache.get('sess_' + token)) return;
    rec.seen = now;
    var left = Math.max(1, Math.ceil((rec.expires - now) / 1000));
    cache.put('sess_' + token, JSON.stringify(rec), left);
  } catch (e) { /* non-blocking */ }
}

function alreadyLoggedInMessage_(retryAfterSeconds) {
  var mins = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return 'This account is already logged in on another device or browser. ' +
    'If that was closed without logging out, you can log in again in about ' + (mins === 1 ? 'a minute' : mins + ' minutes') + '. ' +
    'Otherwise, ask your administrator to end that session.';
}

// Called only AFTER the password has been verified. Under the script lock, so two logins for the
// same account at the same moment cannot both succeed.
// Returns { token } on success, or { blocked:true, retryAfterSeconds } / { blocked:true, busy:true }.
function establishSession_(role, userId, displayName, designation, takeover) {
  var ukey = sessionUserKey_(role, userId);
  var enforce = singleSessionEnforced_() && (role !== 'admin' || SINGLE_SESSION_APPLIES_TO_ADMIN);
  var lock = LockService.getScriptLock();
  var held = false;
  try {
    try { lock.waitLock(8000); held = true; } catch (lockErr) { return { blocked: true, busy: true }; }
    if (enforce) {
      var live = findLiveSessionForUser_(ukey);
      if (live) {
        if (sessionIsActive_(live.rec) && takeover === true && role === 'admin') {
          // Admin override: the correct Admin credential was just verified, so the other Admin session may be ended.
          endSession_(live.token, 'ended');
          logAction_('ADMIN_SESSION_TAKEOVER', '', displayName, role, 'The Admin ended the other active Admin session at login (override).');
        } else if (sessionIsActive_(live.rec)) {
          var retry = Math.max(1, Math.ceil(((Number(live.rec.seen) || 0) + SESSION_ACTIVE_WINDOW_SECONDS * 1000 - Date.now()) / 1000));
          logAction_('LOGIN_BLOCKED_ACTIVE_SESSION', '', displayName, role, 'Correct password, but this account already has an active session.');
          return { blocked: true, retryAfterSeconds: retry, canTakeover: role === 'admin' };
        } else {
          endSession_(live.token, 'replaced');
          logAction_('SESSION_REPLACED', '', displayName, role, 'The earlier session had not been seen for ' + SESSION_ACTIVE_WINDOW_SECONDS + '+ seconds (tab closed or device asleep); the new login took over.');
        }
      }
    }
    return { token: createSessionAndLog_(role, userId, displayName, designation) };
  } finally {
    if (held) { try { lock.releaseLock(); } catch (e) {} }
  }
}

// The reply for a correct password that was refused because the account is already in use.
function blockedLoginReply_(res) {
  if (res.busy) return { success: false, error: 'System is busy. Please try again in a few seconds.' };
  return { success: false, alreadyLoggedIn: true, retryAfterSeconds: res.retryAfterSeconds, canTakeover: res.canTakeover === true, error: alreadyLoggedInMessage_(res.retryAfterSeconds) };
}

// REVISED — role dropdown removed from the login page per explicit
// instruction. Role is now inferred purely from WHICH identity the
// username resolves to: the reserved ADMIN_USERNAME constant for Admin,
// or whatever role is stored against that username in the Users sheet
// for everyone else. This works safely because usernames are already
// enforced globally unique at creation time (createUser/seedDefaultUsers,
// via findUserByUsername) — there was never a legitimate case where the
// same username needed a role picker to disambiguate; the old
// `storedRole === role` check this replaces was really only rejecting a
// mismatched dropdown selection, not adding real security.
function verifyLogin(username, secret, takeover) {
  try {
    if (!username || !secret) return { success: false, error: 'All fields are required.' };

    var enteredUsername = String(username || '').trim();

    if (enteredUsername.toLowerCase() === ADMIN_USERNAME.toLowerCase()) {
      // Admin now has its own lockout — a documented risk-acceptance
      // trade-off (unlimited PIN guesses) has been reconsidered now that
      // every other role has account-level lockout. Keyed on the literal
      // string 'admin' (not the typed username) since Admin is one shared
      // identity, unlike the other 4 roles where the identity key is the
      // person's own username. Threshold is higher and the window shorter
      // than the multi-user roles (ADMIN_MAX_LOGIN_ATTEMPTS /
      // ADMIN_LOCKOUT_SECONDS, Config.gs) via a separate
      // registerAdminFailedAttempt(), not the shared registerFailedAttempt()
      // (which hardcodes MAX_LOGIN_ATTEMPTS/LOCKOUT_SECONDS internally).
      if (isLocked_('admin')) return { success: false, locked: true, selfReset: false, error: 'This account is locked. Try again in 5 minutes.' };

      var correctPin = getAdminPin_();
      var pinOk = String(secret).trim() === String(correctPin).trim();
      if (!pinOk) {
        logAction_('LOGIN_FAILED', '', enteredUsername, 'admin', 'Incorrect admin PIN');
        var adminAttResult = registerAdminFailedAttempt_('admin');
        if (adminAttResult.locked) {
          logAction_('LOGIN_LOCKED', '', enteredUsername, 'admin', 'Too many failed attempts');
          return { success: false, locked: true, selfReset: false, error: 'Account locked. Too many incorrect attempts. Try again in 5 minutes.' };
        }
        return { success: false, error: 'Incorrect username or password.' };
      }
      var tfa = adminSecondFactorMode_();
      if (tfa === 'unconfigured') {
        logAction_('ADMIN_2FA_NOT_CONFIGURED', '', enteredUsername, 'admin', 'Correct Admin PIN, but the ADMIN_EMAIL Script Property is missing or not a valid email address, so the login code cannot be sent.');
        return { success: false, error: 'Admin sign-in needs an email address for the login code. Set the ADMIN_EMAIL Script Property (Project Settings), or set ADMIN_2FA to off.' };
      }
      if (tfa === 'on') return adminStartSecondFactor_(enteredUsername); // no session and no counter reset until the code is entered
      logAction_('ADMIN_2FA_OFF', '', enteredUsername, 'admin', 'Admin logged in with the second factor switched off (Script Property ADMIN_2FA = off).');
      clearFailedAttempts_('admin');
      var adminSession = establishSession_('admin', 'admin', 'Admin', '', takeover === true); // takeover: Admin override only, ignored for everyone else
      if (adminSession.blocked) return blockedLoginReply_(adminSession);
      return { success: true, token: adminSession.token, role: 'admin', displayName: 'Admin' };
    }

    // Lockout key stays lowercased (rate-limiting bucket, not an identity
    // match) — deliberately so, otherwise typing a wrong-case variant of
    // a real username would count against a SEPARATE lockout counter,
    // giving an attacker unlimited attempts by just cycling case. Login
    // matching itself (findUserByUsername below) is now case-sensitive;
    // this key is only about not letting case-cycling reset the clock.
    var uKey = enteredUsername.toLowerCase();
    if (isLocked_(uKey)) return { success: false, locked: true, selfReset: true, error: 'This account is locked. Try again in 15 minutes.' };

    var found = findUserByUsername_(enteredUsername, true);
    var valid = false;
    var storedRole = null;
    if (found) {
      storedRole = safe_(found.rowValues[USR.ROLE]);
      var active = safe_(found.rowValues[USR.ACTIVE]) === 'Yes';
      var storedHash = safe_(found.rowValues[USR.PASSWORD_HASH]);
      var storedSalt = safe_(found.rowValues[USR.SALT]);
      if (MULTI_USER_ROLES.indexOf(storedRole) !== -1 && active && verifyPassword_(secret, storedSalt, storedHash)) {
        valid = true;
      }
    }

    if (!valid) {
      // Deliberately generic — never reveals whether the username exists,
      // whether the account is inactive, or the password is wrong; all
      // three look identical from outside, and all three still count
      // against the lockout.
      var attResult = registerFailedAttempt_(uKey);
      if (attResult.locked) {
        logAction_('LOGIN_LOCKED', '', enteredUsername, storedRole || 'unknown', 'Too many failed attempts');
        // ADDED (item 15): only notify when the typed username actually
        // matched a real account (`found` truthy) — a nonexistent username
        // can still trip this same lockout key (see the comment above uKey)
        // and there is nobody to email in that case.
        if (found) {
          notifyUserOfAccountEvent_(found.rowValues, 'USER_LOCKED_OUT',
            'Rabale Petty Expense System \u2014 your account has been locked',
            'Hello ' + safe_(found.rowValues[USR.DISPLAY_NAME]) + ',\n\nYour account on the Rabale Petty Expense System has been locked ' +
            'after too many incorrect password attempts. It will automatically unlock in 15 minutes, or an administrator can unlock it sooner. ' +
            'You can also choose "Forgot password" on the login page to set a new password with a code emailed to you.\n\n' +
            'If this wasn\u2019t you, please let your administrator know.');
        }
        return { success: false, locked: true, selfReset: true, error: 'Account locked. Too many incorrect attempts. Try again in 15 minutes.' };
      }
      return { success: false, error: 'Incorrect username or password. ' + attResult.attemptsLeft + ' attempt(s) remaining.' };
    }

    clearFailedAttempts_(uKey);

    var displayName = safe_(found.rowValues[USR.DISPLAY_NAME]);
    var userId = safe_(found.rowValues[USR.USER_ID]);
    var designation = safe_(found.rowValues[USR.DESIGNATION]);
    var established = establishSession_(storedRole, userId, displayName, designation);
    if (established.blocked) return blockedLoginReply_(established);
    try { found.sheet.getRange(found.rowIndex, USR.LAST_LOGIN + 1).setValue(new Date().toLocaleString('en-IN')); } catch (e) { /* non-blocking */ }
    return { success: true, token: established.token, role: storedRole, displayName: displayName, designation: designation };
  } catch (err) {
    Logger.log('verifyLogin error: ' + err);
    return { success: false, error: 'Authentication error. Please try again.' };
  }
}

function validateSession_(token) {
  if (!token) return { valid: false, role: null };
  try {
    var raw = CacheService.getScriptCache().get('sess_' + token);
    if (!raw) return { valid: false, role: null, reason: sessionEndReason_(token) };
    var s = JSON.parse(raw);
    if (!s.role) return { valid: false, role: null, reason: 'expired' };
    if (Date.now() > s.expires) { endSession_(token, 'expired'); return { valid: false, role: null, reason: 'expired' }; }
    var ukeyNow = s.ukey || sessionUserKey_(s.role, s.userId);
    if ((Number(s.ep) || 0) !== sessionEpoch_(ukeyNow)) { endSession_(token, 'ended'); return { valid: false, role: null, reason: 'ended' }; }
    touchSessionRecord_(token, s); // every call counts as "still here"
    return { valid: true, role: s.role, userId: s.userId || null, displayName: s.displayName || s.role, designation: s.designation || '' };
  } catch (e) { return { valid: false, role: null }; }
}

// The page pings this every SESSION_HEARTBEAT_SECONDS (and when the tab becomes visible again).
// It keeps the account marked as in use, and tells the page at once if its session has ended
// (expired, ended by an administrator, replaced, password reset, deactivated).
function touchSession(token) {
  var s = validateSession_(token);
  if (!s.valid) return { valid: false, reason: s.reason || 'expired' };
  return { valid: true, heartbeatSeconds: SESSION_HEARTBEAT_SECONDS };
}

function logout(token) {
  try {
    if (token) {
      var raw = CacheService.getScriptCache().get('sess_' + token);
      if (raw) {
        try {
          var s = JSON.parse(raw);
          if (s.role) logAction_('LOGOUT', '', s.displayName || s.role, s.role, 'Logged out');
        } catch (e) {}
      }
      endSession_(token, ''); // also frees the account for its next login
    }
  } catch (e) {}
  return { success: true };
}

// ============================================================================
// SELF-SERVICE PASSWORD RESET — "Forgot password" and lockout recovery.
// ============================================================================
// Two RPCs that are callable WITHOUT a session (same exposure as verifyLogin):
//   requestPasswordReset(username)                     -> emails a one-time code
//   confirmPasswordReset(username, code, newPassword)  -> sets the new password
//
// Rules, each one deliberate:
//  * The code goes ONLY to the verified email on the account (USR.EMAIL) — never
//    to a pending, unverified address and never to an address typed into the form.
//  * requestPasswordReset answers identically whether or not the username exists,
//    is active, has an email, or has been throttled. This is the same
//    no-enumeration rule verifyLogin and the lockout counters already follow.
//    The real reason is written to the Audit Log for accounts that exist.
//  * Eligible: the 4 working roles (submission, L1, accounts, L2). NOT the Admin
//    (its PIN is a Script Property and there is no mailbox to send to) and NOT the
//    Auditor (auditors are excluded from every account email — see
//    notifyUserOfAccountEvent). Both contact an administrator instead.
//  * The code is kept only as a salted hash in CacheService, for
//    OTP_EXPIRY_MINUTES, and works once. The email is sent BEFORE anything is
//    stored (send-before-write), so a failed send leaves nothing behind.
//  * Wrong codes go through registerFailedAttempt under a 'pwrotp_' key: 5 wrong
//    -> 15 minute lock and the code is discarded.
//  * A successful reset also clears that username's LOGIN lockout. That is the
//    lockout-recovery path: owning the mailbox is the proof of identity.
// Helpers end in "_" so Apps Script does not expose them to the browser.
// ============================================================================
var PW_RESET_TOO_MANY_MESSAGE = 'Too many incorrect codes. Try again in 15 minutes, or ask your administrator to reset your password.';
var PW_RESET_BAD_CODE_MESSAGE = 'That code is incorrect or has expired. Check the latest email, or request a new code.';

function pwResetGenericMessage_() {
  return 'If that username belongs to an active account with an email address on file, a ' + OTP_LENGTH + '-digit code has been sent to it. ' +
    'It is valid for ' + OTP_EXPIRY_MINUTES + ' minutes. If nothing arrives, the account may have no email address on file \u2014 please ask your administrator to reset your password.';
}

// Six digits from Utilities.getUuid() (a random v4 UUID) rather than Math.random.
// Bytes are accepted only below 250 so that "% 10" is not biased, and the two
// bytes that hold the fixed UUID version / variant bits are skipped.
function pwResetOtp_() {
  var randomByteOffsets = [0, 2, 4, 6, 8, 10, 14, 18, 20, 22, 24, 26, 28, 30];
  var digits = '';
  while (digits.length < OTP_LENGTH) {
    var hex = Utilities.getUuid().replace(/-/g, '');
    for (var i = 0; i < randomByteOffsets.length && digits.length < OTP_LENGTH; i++) {
      var b = parseInt(hex.substr(randomByteOffsets[i], 2), 16);
      if (b < 250) digits += String(b % 10);
    }
  }
  return digits;
}

// Fixed-window counter in the script cache. Returns the new count.
function pwResetBump_(cacheKey, windowSeconds) {
  var cache = CacheService.getScriptCache();
  var now = Date.now();
  var count = 0, start = now;
  var raw = cache.get(cacheKey);
  if (raw) {
    var parts = String(raw).split('|');
    count = parseInt(parts[0], 10) || 0;
    start = parseInt(parts[1], 10) || now;
    if (now - start >= windowSeconds * 1000) { count = 0; start = now; }
  }
  count++;
  var remaining = Math.max(1, Math.ceil((start + windowSeconds * 1000 - now) / 1000));
  cache.put(cacheKey, count + '|' + start, remaining);
  return count;
}

function pwResetPad_(startedAt) {
  var wait = PW_RESET_MIN_RESPONSE_MS - (Date.now() - startedAt);
  if (wait > 0) Utilities.sleep(wait);
}

// Who a reset code may be sent to. reason: 'ok' | 'no_user' | 'admin' | 'role' | 'inactive' | 'no_email'
function pwResetLookup_(typed) {
  if (typed.toLowerCase() === ADMIN_USERNAME.toLowerCase()) return { found: null, reason: 'admin' };
  var found = findUserByUsername_(typed);
  if (!found) return { found: null, reason: 'no_user' };
  var role = safe_(found.rowValues[USR.ROLE]);
  if (MULTI_USER_ROLES.indexOf(role) === -1 || role === 'auditor') return { found: found, reason: 'role' };
  if (safe_(found.rowValues[USR.ACTIVE]) !== 'Yes') return { found: found, reason: 'inactive' };
  if (!safe_(found.rowValues[USR.EMAIL])) return { found: found, reason: 'no_email' };
  return { found: found, reason: 'ok' };
}

function pwResetReadCode_(userId) {
  try {
    var raw = CacheService.getScriptCache().get('pwr_' + userId);
    if (!raw) return null;
    var rec = JSON.parse(raw);
    if (!rec || !rec.h || !rec.s || !rec.exp || Date.now() > rec.exp) return null;
    return rec;
  } catch (e) { return null; }
}

function pwResetHandleRequest_(typed) {
  var lookup = pwResetLookup_(typed);
  var found = lookup.found;
  if (!found) return; // unknown username, or the Admin: nothing to send, nothing logged

  var userId = safe_(found.rowValues[USR.USER_ID]);
  var displayName = safe_(found.rowValues[USR.DISPLAY_NAME]);
  var role = safe_(found.rowValues[USR.ROLE]);
  var cache = CacheService.getScriptCache();

  // Asked again within the cool-down: ignore silently (the form has its own timer).
  if (isLocked_('pwrcool_' + userId)) return;
  cache.put('lock_pwrcool_' + userId, '1', OTP_RESEND_COOLDOWN_SECONDS);

  var perUser = pwResetBump_('pwrreq_' + userId, 3600);
  if (perUser > PW_RESET_MAX_REQUESTS_PER_USER_PER_HOUR) {
    if (perUser === PW_RESET_MAX_REQUESTS_PER_USER_PER_HOUR + 1) {
      logAction_('PASSWORD_RESET_OTP_THROTTLED', '', displayName, role, 'More than ' + PW_RESET_MAX_REQUESTS_PER_USER_PER_HOUR + ' reset codes requested within an hour \u2014 further requests ignored until the hour is up.');
    }
    return;
  }

  if (lookup.reason !== 'ok') {
    var why = { role: 'this account type does not use emailed reset codes', inactive: 'the account is deactivated', no_email: 'there is no verified email address on file' }[lookup.reason] || lookup.reason;
    logAction_('PASSWORD_RESET_OTP_SKIPPED', '', displayName, role, 'A reset code was requested but not sent: ' + why + '.');
    return;
  }

  var scriptWide = pwResetBump_('pwrglobal', 3600);
  if (scriptWide > PW_RESET_MAX_REQUESTS_PER_HOUR) {
    if (scriptWide === PW_RESET_MAX_REQUESTS_PER_HOUR + 1) {
      logAction_('PASSWORD_RESET_OTP_THROTTLED', '', 'system', 'system', 'More than ' + PW_RESET_MAX_REQUESTS_PER_HOUR + ' reset codes requested across all users within an hour \u2014 further requests ignored until the hour is up.');
    }
    return;
  }
  var quota = MailApp.getRemainingDailyQuota();
  if (quota < PW_RESET_MIN_MAIL_QUOTA_RESERVE) {
    logAction_('PASSWORD_RESET_OTP_SKIPPED', '', displayName, role, 'A reset code was requested but not sent: only ' + quota + ' emails are left in today\u2019s quota, which is being kept for approval emails.');
    return;
  }

  var email = safe_(found.rowValues[USR.EMAIL]);
  var otp = pwResetOtp_();
  var salt = generateSalt_();
  var hash = hashPassword_(otp, salt);
  var mail = { displayName: displayName, designation: safe_(found.rowValues[USR.DESIGNATION]), otp: otp, expiryMinutes: OTP_EXPIRY_MINUTES };
  try {
    sendNotification_({
      to: email,
      subject: 'Rabale Petty Expense System \u2014 your password reset code',
      body: passwordResetOtpText_(mail)
    }, function (hasLogo) { return passwordResetOtpHtml_(mail, hasLogo); });
  } catch (mailErr) {
    Logger.log('pwResetHandleRequest_: failed to send reset code to ' + email + ': ' + mailErr);
    logAction_('PASSWORD_RESET_OTP_FAILED', '', displayName, role, 'Could not send a reset code to ' + email + ': ' + mailErr);
    return; // nothing was stored, so there is nothing to clean up
  }
  cache.put('pwr_' + userId, JSON.stringify({ h: hash, s: salt, exp: Date.now() + OTP_EXPIRY_MINUTES * 60000 }), OTP_EXPIRY_MINUTES * 60);
  clearFailedAttempts_('pwrotp_' + typed.toLowerCase()); // a fresh code gets a fresh attempt budget
  logAction_('PASSWORD_RESET_OTP_SENT', '', displayName, role, 'Password reset code sent to ' + email);
}

function requestPasswordReset(username) {
  var startedAt = Date.now();
  var reply = { success: true, message: pwResetGenericMessage_() };
  try {
    var typed = String(username || '').trim();
    if (!typed) return { success: false, error: 'Enter your username.' };
    if (typed.length > 60) return reply; // longer than any real username (30 max)
    pwResetHandleRequest_(typed);
  } catch (err) {
    Logger.log('requestPasswordReset error: ' + err);
  }
  pwResetPad_(startedAt);
  return reply;
}

function confirmPasswordReset(username, otpCode, newPassword) {
  var lock = LockService.getScriptLock();
  var lockHeld = false;
  try {
    var typed = String(username || '').trim();
    var code = String(otpCode || '').trim();
    var pw = (newPassword === null || newPassword === undefined) ? '' : String(newPassword);
    if (!typed || !code || !pw) return { success: false, error: 'Username, code and new password are all required.' };
    if (typed.length > 60) return { success: false, error: PW_RESET_BAD_CODE_MESSAGE };

    var pwError = validatePasswordStrength_(pw); // checked first so fixing a weak password never costs a code attempt
    if (pwError) return { success: false, error: pwError };

    var attKey = 'pwrotp_' + typed.toLowerCase();
    if (isLocked_(attKey)) return { success: false, tooMany: true, error: PW_RESET_TOO_MANY_MESSAGE };

    var lookup = pwResetLookup_(typed);
    var eligible = lookup.reason === 'ok';
    var userId = eligible ? safe_(lookup.found.rowValues[USR.USER_ID]) : '';
    var rec = eligible ? pwResetReadCode_(userId) : null;
    var codeOk = !!rec && /^[0-9]+$/.test(code) && verifyPassword_(code, rec.s, rec.h);

    if (!codeOk) {
      // Counted under the typed username whether or not it exists, so this is
      // indistinguishable from outside — same rule as the login lockout.
      var att = registerFailedAttempt_(attKey);
      if (att.locked) {
        if (eligible) {
          CacheService.getScriptCache().remove('pwr_' + userId);
          logAction_('PASSWORD_RESET_LOCKED', '', safe_(lookup.found.rowValues[USR.DISPLAY_NAME]), safe_(lookup.found.rowValues[USR.ROLE]), 'Too many incorrect reset codes \u2014 the code was discarded.');
        }
        return { success: false, tooMany: true, error: PW_RESET_TOO_MANY_MESSAGE };
      }
      return { success: false, error: PW_RESET_BAD_CODE_MESSAGE + ' ' + att.attemptsLeft + ' attempt(s) remaining.' };
    }

    try { lock.waitLock(15000); lockHeld = true; } catch (lockErr) {
      return { success: false, error: 'System is busy. Please try again in a few seconds.' };
    }

    // Re-check under the lock so one code can only ever be used once, and so an
    // account deactivated in the meantime cannot complete a reset.
    var fresh = findUserById_(userId);
    var rec2 = pwResetReadCode_(userId);
    if (!fresh || safe_(fresh.rowValues[USR.ACTIVE]) !== 'Yes' || !rec2 || !verifyPassword_(code, rec2.s, rec2.h)) {
      return { success: false, error: PW_RESET_BAD_CODE_MESSAGE };
    }

    var newSalt = generateSalt_();
    var newHash = hashPassword_(pw, newSalt);
    fresh.sheet.getRange(fresh.rowIndex, USR.PASSWORD_HASH + 1).setValue(newHash);
    fresh.sheet.getRange(fresh.rowIndex, USR.SALT + 1).setValue(newSalt);

    var cache = CacheService.getScriptCache();
    cache.remove('pwr_' + userId);
    clearFailedAttempts_(attKey);
    var loginKey = String(fresh.rowValues[USR.USERNAME]).trim().toLowerCase();
    var wasLocked = isLocked_(loginKey);
    cache.remove('lock_' + loginKey);
    cache.remove('att_' + loginKey);

    endUserSession_(userId, 'reset'); // a reset must not leave an older session running
    var displayName = safe_(fresh.rowValues[USR.DISPLAY_NAME]);
    logAction_('USER_PASSWORD_SELF_RESET', '', displayName, safe_(fresh.rowValues[USR.ROLE]),
      'Password reset by the account holder with an emailed code' + (wasLocked ? '; the login lockout was cleared' : ''));
    notifyUserOfAccountEvent_(fresh.rowValues, 'USER_PASSWORD_SELF_RESET',
      'Rabale Petty Expense System \u2014 your password was reset',
      'Hello ' + displayName + ',\n\nYour password on the Rabale Petty Expense System was just reset using \"Forgot password\" on the login page. ' +
      'Any lockout on your account was cleared and you can log in with the new password now.\n\n' +
      'If you did not do this, please contact your administrator immediately.');
    return { success: true, message: 'Your password has been reset. You can log in with it now.' };
  } catch (err) {
    Logger.log('confirmPasswordReset error: ' + err);
    return { success: false, error: 'Could not reset the password. Please try again.' };
  } finally {
    if (lockHeld) { try { lock.releaseLock(); } catch (e) {} }
  }
}

// ============================================================================
// ADMIN SECOND FACTOR (v5). After the Admin PIN is right, a 6-digit code is emailed to the address in the
// ADMIN_EMAIL Script Property and must be typed in before any session exists.
//   * Nothing is created after the PIN alone; the PIN only starts a "challenge" (adm2fa_<id> in the script cache).
//   * The code is stored hashed (same salted hash as reset codes), works once, expires after OTP_EXPIRY_MINUTES,
//     and allows ADMIN_2FA_MAX_CODE_ATTEMPTS wrong tries. Every wrong code also spends the shared Admin lockout
//     budget (ADMIN_MAX_LOGIN_ATTEMPTS), so it cannot be guessed by requesting fresh challenges.
//   * The failed-attempt counter is only cleared after a COMPLETE login (PIN + code), not after the PIN.
//   * Emergency switch, no redeploy: Script Property ADMIN_2FA = off  (every such login is written to the Audit Log).
//   * If ADMIN_EMAIL is missing or invalid the Admin login is refused with a clear message (same "fail loudly"
//     rule as ADMIN_PIN) rather than silently skipping the second factor.
//   * The one-login rule and the Admin override still work: they run after the code, on the same challenge.
// ============================================================================
var ADMIN_2FA_MAX_CODE_ATTEMPTS = 5;
var ADMIN_2FA_SEND_ERROR = 'The login code could not be sent. Try again in a few minutes, or contact the owner.';
var ADMIN_2FA_RESTART = 'That login has expired. Please log in again.';

function adminEmail_() {
  var e = '';
  try { e = String(PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL') || '').trim(); } catch (x) { e = ''; }
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e) ? e : '';
}

// 'on' | 'off' | 'unconfigured'
function adminSecondFactorMode_() {
  try { if (PropertiesService.getScriptProperties().getProperty('ADMIN_2FA') === 'off') return 'off'; } catch (x) { /* fall through */ }
  return adminEmail_() ? 'on' : 'unconfigured';
}

function maskEmail_(email) {
  var p = String(email || '').split('@');
  return (p[0] ? p[0].charAt(0) : '') + '***@' + (p[1] || '');
}

// Sends a fresh code. Returns '' on success or an error text. Never stores anything itself.
function adminSendCode_(otp) {
  var quota = 0;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (q) { quota = 1; }
  if (quota < 1) return ADMIN_2FA_SEND_ERROR;
  var mail = { otp: otp, expiryMinutes: OTP_EXPIRY_MINUTES };
  try {
    sendNotification_({
      to: adminEmail_(),
      subject: 'Rabale Petty Expense System \u2014 your Admin login code',
      body: adminLoginCodeText_(mail)
    }, function (hasLogo) { return adminLoginCodeHtml_(mail, hasLogo); });
  } catch (mailErr) {
    Logger.log('adminSendCode_: ' + mailErr);
    logAction_('ADMIN_2FA_SEND_FAILED', '', ADMIN_USERNAME, 'admin', 'Could not send the Admin login code: ' + mailErr);
    return ADMIN_2FA_SEND_ERROR;
  }
  return '';
}

function adminReadChallenge_(cid) {
  if (!/^[0-9a-f]{64}$/.test(String(cid || ''))) return null;
  try {
    var raw = CacheService.getScriptCache().get('adm2fa_' + cid);
    var rec = raw ? JSON.parse(raw) : null;
    return (rec && rec.exp && Date.now() <= rec.exp) ? rec : null;
  } catch (e) { return null; }
}

function adminWriteChallenge_(cid, rec) {
  CacheService.getScriptCache().put('adm2fa_' + cid, JSON.stringify(rec), Math.max(1, Math.ceil((rec.exp - Date.now()) / 1000)));
}

function adminDropChallenge_(cid) {
  var cache = CacheService.getScriptCache();
  cache.remove('adm2fa_' + cid);
  if (cache.get('adm2fa_current') === cid) cache.remove('adm2fa_current');
}

// Step 1, called from verifyLogin once the PIN is right.
function adminStartSecondFactor_(typedUsername) {
  var cache = CacheService.getScriptCache();
  if (isLocked_('adm2facool')) return { success: false, error: 'A login code was just sent. Please wait a few seconds before trying again.' };
  cache.put('lock_adm2facool', '1', OTP_RESEND_COOLDOWN_SECONDS);
  var otp = pwResetOtp_(), salt = generateSalt_(), hash = hashPassword_(otp, salt);
  var err = adminSendCode_(otp);
  if (err) return { success: false, error: err };
  var old = cache.get('adm2fa_current'); // only one challenge at a time: a new PIN entry retires the previous one
  if (old) cache.remove('adm2fa_' + old);
  var cid = generateToken_();
  adminWriteChallenge_(cid, { h: hash, s: salt, exp: Date.now() + OTP_EXPIRY_MINUTES * 60000, att: 0, ok: false });
  cache.put('adm2fa_current', cid, OTP_EXPIRY_MINUTES * 60);
  logAction_('ADMIN_2FA_CODE_SENT', '', typedUsername, 'admin', 'Admin login code sent to ' + maskEmail_(adminEmail_()));
  return { success: false, needs2fa: true, challengeId: cid, maskedEmail: maskEmail_(adminEmail_()), expiryMinutes: OTP_EXPIRY_MINUTES, resendSeconds: OTP_RESEND_COOLDOWN_SECONDS };
}

// "Send a new code" on the code screen. Needs the challenge id that only someone who just passed the PIN holds.
function resendAdminSecondFactor(challengeId) {
  try {
    var rec = adminReadChallenge_(challengeId);
    if (!rec || rec.ok) return { success: false, restart: true, error: ADMIN_2FA_RESTART };
    if (isLocked_('admin')) return { success: false, restart: true, locked: true, error: 'This account is locked. Try again in 5 minutes.' };
    if (isLocked_('adm2facool')) return { success: false, error: 'A code was just sent. Please wait a few seconds.' };
    CacheService.getScriptCache().put('lock_adm2facool', '1', OTP_RESEND_COOLDOWN_SECONDS);
    var otp = pwResetOtp_(), salt = generateSalt_(), hash = hashPassword_(otp, salt);
    var err = adminSendCode_(otp);
    if (err) return { success: false, error: err };
    adminWriteChallenge_(challengeId, { h: hash, s: salt, exp: Date.now() + OTP_EXPIRY_MINUTES * 60000, att: 0, ok: false });
    logAction_('ADMIN_2FA_CODE_SENT', '', ADMIN_USERNAME, 'admin', 'A new Admin login code was sent to ' + maskEmail_(adminEmail_()));
    return { success: true, resendSeconds: OTP_RESEND_COOLDOWN_SECONDS };
  } catch (err2) {
    Logger.log('resendAdminSecondFactor error: ' + err2);
    return { success: false, error: 'Could not send a new code. Please try again.' };
  }
}

// Step 2. takeover===true only from the Admin override button, after the code was accepted.
function verifyAdminSecondFactor(challengeId, code, takeover) {
  try {
    var cid = String(challengeId || '');
    var rec = adminReadChallenge_(cid);
    if (!rec) return { success: false, restart: true, error: ADMIN_2FA_RESTART };
    if (isLocked_('admin')) return { success: false, restart: true, locked: true, selfReset: false, error: 'This account is locked. Try again in 5 minutes.' };

    if (!rec.ok) {
      var c = String(code || '').trim();
      var good = /^[0-9]+$/.test(c) && c.length === OTP_LENGTH && verifyPassword_(c, rec.s, rec.h);
      if (!good) {
        rec.att = (Number(rec.att) || 0) + 1;
        logAction_('LOGIN_FAILED', '', ADMIN_USERNAME, 'admin', 'Incorrect Admin login code');
        var att = registerAdminFailedAttempt_('admin'); // shares the Admin lockout budget
        if (att.locked || rec.att >= ADMIN_2FA_MAX_CODE_ATTEMPTS) {
          adminDropChallenge_(cid);
          if (att.locked) logAction_('LOGIN_LOCKED', '', ADMIN_USERNAME, 'admin', 'Too many failed attempts');
          return { success: false, restart: true, locked: att.locked === true, selfReset: false,
            error: att.locked ? 'Account locked. Too many incorrect attempts. Try again in 5 minutes.' : 'Too many incorrect codes. Please log in again.' };
        }
        adminWriteChallenge_(cid, rec);
        return { success: false, error: 'That code is incorrect or has expired. Check the latest email. ' + (ADMIN_2FA_MAX_CODE_ATTEMPTS - rec.att) + ' attempt(s) remaining.' };
      }
      rec.ok = true; // both factors are now proven; kept until the session exists so the override button can finish without a second code
      adminWriteChallenge_(cid, rec);
    }

    var session = establishSession_('admin', 'admin', 'Admin', '', takeover === true);
    if (session.blocked) return blockedLoginReply_(session);
    adminDropChallenge_(cid);
    clearFailedAttempts_('admin');
    logAction_('ADMIN_2FA_OK', '', ADMIN_USERNAME, 'admin', 'Admin login code accepted');
    return { success: true, token: session.token, role: 'admin', displayName: 'Admin' };
  } catch (err3) {
    Logger.log('verifyAdminSecondFactor error: ' + err3);
    return { success: false, error: 'Could not complete the login. Please try again.' };
  }
}

// Guard for helpers meant to be run from the Apps Script editor. Every top-level function without a trailing "_"
// can be called by any visitor's browser (google.script.run), so an editor-only helper must refuse everyone
// except the person actually running it in the editor. For a visitor, Session.getActiveUser() is empty or is
// somebody other than the account the script runs as; in the editor both are the person pressing Run.
// A server function that has ALREADY verified a logged-in Admin (e.g. repairScheduledTriggers, the Admin-tab
// button) sets this for the rest of that one execution, so it can use helpers that are otherwise editor-only.
// Each browser call is its own execution, so a visitor can never set it.
var TRUSTED_SERVER_CALL_ = false;

function editorOnly_() {
  if (TRUSTED_SERVER_CALL_) return;
  var active = '', eff = '';
  try { active = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e1) { active = ''; }
  try { eff = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e2) { eff = ''; }
  if (!active || !eff || active !== eff) {
    Logger.log('editorOnly_: refused a call that did not come from the script editor.');
    throw new Error('This helper can only be run from the Apps Script editor.');
  }
}

// ============================================================================
// ADMIN: SESSION OVERRIDES (fallbacks for when session tracking misbehaves)
// ============================================================================
//   adminEndUserSession   one person: logged out everywhere, even if the app cannot see their session
//   adminEndAllSessions   every user (the calling Admin stays in)
//   setSingleSessionEnforced   pauses / resumes the one-login rule without a redeploy
//   Admin login "override"     verifyLogin(..., takeover=true) ends another Admin session (only after the PIN is right)
//   clearAllSessionsFromEditor + Script Property SINGLE_SESSION=off   the same, from the Apps Script editor
function requireAdminSession_(token) {
  var session = validateSession_(token);
  if (!session.valid || !session.role) return { error: 'Session expired. Please log in again.' };
  if (session.role !== 'admin') return { error: 'You do not have permission to do this.' };
  return { session: session };
}

function adminEndUserSession(userId, token) {
  try {
    var gate = requireAdminSession_(token);
    if (gate.error) return { success: false, error: gate.error };
    var session = gate.session;
    var found = findUserById_(userId);
    if (!found) return { success: false, error: 'User not found.' };
    var displayName = safe_(found.rowValues[USR.DISPLAY_NAME]);
    var ended = endUserSession_(String(userId), 'ended'); // always revokes, even when no session is showing
    logAction_('SESSION_ENDED_BY_ADMIN', '', session.displayName, session.role, (ended ? 'Ended the session of ' : 'Revoked any sessions (none showing) of ') + '"' + displayName + '"');
    return { success: true, ended: ended, message: (ended ? 'Session ended. ' : 'No session was showing, but any session ' + displayName + ' may still have has been revoked. ') + displayName + ' can log in again now.' };
  } catch (err) {
    Logger.log('adminEndUserSession error: ' + err);
    return { success: false, error: 'Failed to end the session: ' + err.toString() };
  }
}

// Logs every user out. The calling Admin is not affected (nor any other Admin session).
function adminEndAllSessions(token) {
  try {
    var gate = requireAdminSession_(token);
    if (gate.error) return { success: false, error: gate.error };
    var session = gate.session;
    var data = getOrCreateUsersSheet_().getDataRange().getValues();
    var n = 0, total = 0;
    for (var i = 1; i < data.length; i++) {
      var id = String(data[i][USR.USER_ID] || '').trim();
      if (!id) continue;
      total++;
      if (endUserSession_(id, 'ended')) n++;
    }
    logAction_('SESSIONS_ENDED_ALL_BY_ADMIN', '', session.displayName, session.role, 'Ended every user session (' + n + ' were showing as logged in; all ' + total + ' accounts revoked).');
    return { success: true, ended: n, message: 'All user sessions ended (' + n + ' were logged in). Everyone can log in again now.' };
  } catch (err) {
    Logger.log('adminEndAllSessions error: ' + err);
    return { success: false, error: 'Failed to end the sessions: ' + err.toString() };
  }
}

// enabled=false pauses the one-login rule (accounts can then be logged in more than once); true resumes it.
function setSingleSessionEnforced(enabled, token) {
  try {
    var gate = requireAdminSession_(token);
    if (gate.error) return { success: false, error: gate.error };
    var props = PropertiesService.getScriptProperties();
    if (enabled === true) props.deleteProperty('SINGLE_SESSION'); else props.setProperty('SINGLE_SESSION', 'off');
    logAction_(enabled === true ? 'SESSION_RULE_RESUMED' : 'SESSION_RULE_PAUSED', '', gate.session.displayName, gate.session.role,
      enabled === true ? 'One-login-per-account rule turned back on.' : 'One-login-per-account rule paused: accounts can be logged in more than once until it is turned back on.');
    var on = singleSessionEnforced_();
    return { success: true, enforced: on, message: on ? 'One-login rule is on.' : 'One-login rule is paused. Turn it back on when the problem is fixed.' };
  } catch (err) {
    Logger.log('setSingleSessionEnforced error: ' + err);
    return { success: false, error: 'Failed to change the setting: ' + err.toString() };
  }
}

// Run from the Apps Script editor if the Admin login itself is stuck behind a session that cannot
// be reached from the app (or after a deploy, to start everyone fresh). Everyone is logged out.
function clearAllSessionsFromEditor() {
  editorOnly_(); // refuses anyone who is not running this from the Apps Script editor
  var n = 0;
  if (endUserSession_('admin', 'ended')) n++;
  var data = getOrCreateUsersSheet_().getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var id = String(data[i][USR.USER_ID] || '').trim();
    if (id && endUserSession_(id, 'ended')) n++;
  }
  logAction_('SESSIONS_CLEARED', '', 'system', 'system', n + ' session(s) ended from the script editor.');
  Logger.log('clearAllSessionsFromEditor: ended ' + n + ' session(s).');
  return n;
}
