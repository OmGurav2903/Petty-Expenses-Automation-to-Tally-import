// ============================================================================
// RABALE PETTY EXPENSE SYSTEM — CONFIGURATION
// ============================================================================
//
// DEPLOYMENT / ONE-TIME SETUP:
//
//   1. Add the "Approved By Accounts" column (header exactly that text) at
//      the end of your "All Vouchers" sheet's header row.
//   2. Create a new sheet named exactly "Audit Log". Header row:
//      Timestamp | Action | Voucher ID | Actor | Role | Notes
//      (a 7th column, "Position (at the time)", is added automatically the
//      first time an action is logged — see logAction, Audit Log.gs)
//   3. Set an ADMIN_PIN Script Property before deploying.
//   4. Create/let auto-create a "Users" sheet, then run
//      bootstrapDefaultUsers() ONCE.
//
// ============================================================================

var SHEET_ID                = "1lKPMtBTf__PGkiZ6fz4PW1AeFwK-2VOqaGKrx8Uyx84";
var MASTER_DATA_SHEET       = "Master Data";
var ALL_VOUCHERS_SHEET      = "All Vouchers";
var RABALE_DAILY_SYNC_SHEET = "Rabale Daily Sync";
var QUERY_THREAD_SHEET      = "Query Thread";
var AUDIT_LOG_SHEET         = "Audit Log";
var TRANSPORT_BREAKDOWN_SHEET = "Transport Breakdown";
var SETTINGS_SHEET          = "Settings";
var USERS_SHEET             = "Users";
var TALLY_EXPORT_SHEET_PREFIX = "Tally Export ";
// ADDED (FY-scoped vendor ledger) — one row per Vendor + Financial Year,
// auto-created on first write by getOrCreateVendorFyLedgerSheet
// (Master data.gs), same auto-create-with-headers convention as
// getOrCreateRdsMonthSheet (Sheet Utils.gs). Lives in the main
// spreadsheet (SHEET_ID), same as Master Data — this is a TDS/vendor
// concept, not an RDS one, so it does NOT go in the separate RDS
// spreadsheet. Replaces Master Data column I ("Ledger Balance") as the
// input to resolveVendorTdsForAmount's threshold check; column I itself
// is left untouched (still lifetime, still admin-editable as an opening
// balance) — see resolveVendorTdsForAmount's comment for why.
var VENDOR_FY_LEDGER_SHEET  = "Vendor FY Ledger";

// ============================================================================
// CASH ADVANCES — REVISED AGAIN (correction #2, per explicit instruction).
// This is NOT an RDS concept: RDS's own Advance/Actual Cash in Hand
// columns stay exactly what they always were — a periodic MANUAL
// reconciliation, where Accounts occasionally splits the running Cash in
// Hand total into "how much of this is actually out with staff"
// (Advance) vs "how much is physically in the box" (Actual Cash in
// Hand). Nothing in this codebase writes to either column.
//
// This sheet is the SEPARATE tracking system for the underlying real-
// world need: Warehouse/submission staff hand cash to people ahead of
// their bills coming in, and someone needs to track who owes what.
// Lives entirely in the main spreadsheet (SHEET_ID) and the web app.
//
// ENTERED FROM THE SUBMISSION DASHBOARD (per explicit instruction — this
// moved off the Approval Dashboard; it's Submission/Warehouse staff who
// actually hand out the cash, not Accounts) — gated to the 'submission'
// role (plus 'admin'). Every other role gets read-only balance/ledger
// views (getCashAdvanceBalances/getCashAdvanceLedger, Advances.gs).
//
// GIVEN_TO is a DROPDOWN (per explicit instruction, correction #2) fed by
// the exact same list as a voucher's Submitted By field — getEmployees(),
// Master Data column A, "ledger names" in this system's own terminology
// (every person who can receive money has a personal ledger in Tally,
// employees included — hence the "IOU - " prefix convention this list
// already carries for advance/loan-type ledgers). Sharing that exact
// list, with the same stripIouPrefix display treatment, is what
// guarantees CA.GIVEN_TO and AV.SUBMITTED_BY are always the literal same
// string for the same person — no free-text spelling drift.
//
// BALANCE — REVISED: there is no reliable way to link a specific voucher
// to a specific advance (per explicit instruction — "status and linked
// voucher columns are useless"), so this no longer tries to. A person's
// balance is simply SUM(every advance ever given to them) minus SUM(every
// non-Rejected voucher ever submitted by them) — the two ledgers share
// only one thing, the person's name, and that's enough: give Rs. 1500,
// they submit vouchers of 450 + 750, balance is 300, full stop. See
// getCashAdvanceBalances/getCashAdvanceLedger (Advances.gs). A balance
// still standing 30+ days after the person's oldest advance is flagged
// in the balance view for follow-up.
// ============================================================================
var CASH_ADVANCES_SHEET = "Cash Advances";
var CA = {
  ADVANCE_ID: 0, DATE_GIVEN: 1, GIVEN_TO: 2, AMOUNT: 3, PURPOSE: 4,
  GIVEN_BY: 5, NOTES: 6, LAST_UPDATED: 7
};
var EXPECTED_CASH_ADVANCES_HEADERS = [
  'Advance ID', 'Date Given', 'Given To', 'Amount', 'Purpose',
  'Given By', 'Notes', 'Last Updated'
];
var CASH_ADVANCE_AGE_FLAG_DAYS = 30;

var USR = {
  USER_ID: 0, DISPLAY_NAME: 1, USERNAME: 2, ROLE: 3, PASSWORD_HASH: 4,
  SALT: 5, ACTIVE: 6, CREATED_AT: 7, LAST_LOGIN: 8,
  // ADDED — appended at the end, same additive-only convention as every
  // other schema change in this codebase (see AV's own comment above).
  // Powers notifyRole() (Users.gs): every active user in a role with an
  // Email set gets emailed when that role needs to be notified. Optional
  // per user — a user with no email simply never receives anything,
  // logged as a skip rather than a failure (same graceful-degradation
  // pattern as VENDOR_REQUEST_EMAIL / QUERY_REMINDER_EMAIL below).
  EMAIL: 9,
  // ADDED (item 14, 25 Aug 2026) — email verification. USR.EMAIL is
  // now a HARD gate: creating or changing a user's email writes here
  // first, not to USR.EMAIL, and only moves into USR.EMAIL once the owner of
  // the NEW address presses Yes on the confirmation page the emailed link
  // opens (respondToEmailVerification, Users.gs). The columns keep their
  // original "OTP" names so the sheet needs no change; the HASH/SALT pair now
  // holds the salted hash of the link's secret token, not a typed code.
  // Until then, USR.EMAIL is untouched — the old email (or blank, for a
  // brand-new user) stays in effect for notifyRole/item-15 notifications,
  // exactly as the confirmed design requires. OTP_SALT/HASH follow the
  // exact same salted-SHA-256 convention as PASSWORD_HASH/SALT above
  // (hashPassword/generateSalt, Users.gs) rather than a new scheme — the
  // token is never stored in plaintext. OTP_EXPIRY is a plain Date; a
  // pending change past this timestamp is discarded (never silently
  // finalized) the next time any of these columns are read — see
  // getEmailVerificationRequest/respondToEmailVerification/listUsers, all of
  // which run the same lazy-expiry check rather than relying on a time trigger.
  PENDING_EMAIL: 10, PENDING_EMAIL_OTP_HASH: 11, PENDING_EMAIL_OTP_SALT: 12,
  PENDING_EMAIL_OTP_EXPIRY: 13,
  // ADDED — the person's ACTUAL position in the company (e.g. "Warehouse
  // Manager", "Head of Finance"), as opposed to ROLE above, which is only
  // their level of ACCESS in this app (submission / L1 / accounts / L2 /
  // admin / auditor). Free text, optional, set by an admin (Manage Users).
  // Blank means "not set yet": every screen and email that shows it falls
  // back to the app-role wording it used before, so nothing breaks for a
  // user whose position has not been entered. Appended at the end (same
  // additive-only convention as every other column here); the header cell
  // is added automatically on first use (see getOrCreateUsersSheet).
  DESIGNATION: 14
};

var EXPECTED_USER_HEADERS = [
  'User ID', 'Display Name', 'Username', 'Role', 'Password Hash', 'Salt', 'Active', 'Created At', 'Last Login', 'Email',
  'Pending Email', 'Pending Email OTP Hash', 'Pending Email OTP Salt', 'Pending Email OTP Expiry', 'Designation'
];

// Longest position title accepted (characters).
var DESIGNATION_MAX_LENGTH = 80;

// Display-name -> position lookup used to stamp audit entries (Users.gs,
// getDesignationMaps_). Cached so logging an action does not re-read the Users
// sheet every time; cleared whenever a position is set or a user is created,
// so an edit shows up immediately, and a hand-edit in the sheet within
// DESIGNATION_CACHE_SECONDS.
var DESIGNATION_CACHE_KEY = 'desig_maps_v1';
var DESIGNATION_CACHE_SECONDS = 600;

// ============================================================================
// ONE-TIME CODES — used by the self-service password reset (Auth.gs). The
// OTP_* constants below are shared with it. (Verifying an email address no
// longer uses a code: see the EMAIL_VERIFY_* constants further down.)
// ============================================================================
var OTP_LENGTH = 6;
var OTP_EXPIRY_MINUTES = 10;
// Password-reset code attempts reuse Auth.gs's registerFailedAttempt/isLocked/
// clearFailedAttempts AS-IS (MAX_LOGIN_ATTEMPTS/LOCKOUT_SECONDS) under a
// 'pwrotp_' key, so they can never collide with a real login lockout.
var OTP_RESEND_COOLDOWN_SECONDS = 30;

// Self-service password reset (Auth.gs: requestPasswordReset / confirmPasswordReset).
// Reuses OTP_LENGTH, OTP_EXPIRY_MINUTES and OTP_RESEND_COOLDOWN_SECONDS above, and
// verifies codes through registerFailedAttempt (5 wrong codes -> 15 minute lock).
// The three numbers below only exist to stop the reset form being used to flood
// someone's mailbox or to use up the day's MailApp quota, which the cash
// withdrawal and approval emails also depend on.
var PW_RESET_MAX_REQUESTS_PER_USER_PER_HOUR = 5;
var PW_RESET_MAX_REQUESTS_PER_HOUR = 40;     // all users together
var PW_RESET_MIN_MAIL_QUOTA_RESERVE = 20;    // never spend the last 20 daily emails on reset codes
var PW_RESET_MIN_RESPONSE_MS = 1500;         // evens out response time so it does not reveal which usernames exist

// Email confirmation (Users.gs: beginPendingEmailChange, getEmailVerificationRequest,
// respondToEmailVerification). When an admin sets or changes a user's email, the NEW
// address is sent a link to a page with Yes / No buttons; nothing reaches USR.EMAIL
// until someone at that mailbox presses Yes. The link carries a random token
// "<userId>.<60 hex characters>" (240 bits) whose salted hash sits in the existing
// Pending Email OTP Hash/Salt columns. It is a person answering at their leisure, not
// a code typed against a clock, so the window is a day rather than ten minutes.
var EMAIL_VERIFY_EXPIRY_HOURS = 24;
var EMAIL_VERIFY_TOKEN_PATTERN = /^U-[0-9a-f]{8}\.[0-9a-f]{60}$/;

var INELIGIBLE_CGST_LEDGER = "Ineligible Central Tax ( CGST )";
var INELIGIBLE_SGST_LEDGER = "Ineligible State Tax ( SGST)";
var TRANSPORTATION_NON_GST_LEDGER = "Transportation Non - GST";

// Regular (ledger-based) voucher ledger that specifically requires a
// vehicle number — per explicit instruction. Must exactly match the
// ledger name as it appears in Master Data / the submission form's ledger
// dropdown (also the key already used for this ledger in
// LEDGER_SYNC_COLUMN_MAP, Sheet Utils.gs) — this is deliberately the same
// string in both places, not a fuzzy/partial match, so a differently
// worded ledger (e.g. "Vehicle Fastag", which maps to the same RDS
// column) is NOT swept in by accident.
var JAKAT_TOLL_LEDGER_NAME = "Vehicle Operating - Jakat/Toll";

// Vehicle-linked Regular ledgers (per explicit instruction) — extends the
// same rule that used to apply to Jakat/Toll alone to two more ledgers.
// Must exactly match the ledger name as it appears in Master Data / the
// submission form's ledger dropdown, same non-fuzzy-match reasoning as
// JAKAT_TOLL_LEDGER_NAME above.
var VEHICLE_FASTAG_LEDGER_NAME = "Vehicle Fastag";
var VEHICLE_PETROL_LEDGER_NAME = "Vehicle Operating - Petrol";
// REVISED (per explicit instruction) — the old rule required Vehicle No.
// AND required the Description to manually restate it in text, which was
// really just a workaround for narration not stating the vehicle directly.
// Now: vehicle SELECTION (dropdown) is compulsory for exactly these three
// ledgers, restating it in Description is no longer required (narration
// states it directly instead — see buildRegularNarration, Tally
// Export.gs), and the vehicle field is blocked outright for every other
// Regular ledger — see validateVoucherCore (Vouchers.gs) and the client
// form logic that shows/hides the Vehicle No. field (Main.gs) for both
// halves of that rule.
var VEHICLE_REQUIRED_LEDGERS = [JAKAT_TOLL_LEDGER_NAME, VEHICLE_FASTAG_LEDGER_NAME, VEHICLE_PETROL_LEDGER_NAME];

// Drive folder status suffixes (per explicit instruction) — appended to a
// voucher's own Drive folder name (Rabale Expense System/<batchId>/
// <voucherId>) so its approval state is visible directly in Drive without
// opening the sheet. Applied/cleared by setVoucherDriveFolderStatusSuffix
// (Sheet Utils.gs); see its callers in Approval.gs/Vouchers.gs for exactly
// when each fires.
var VOUCHER_FOLDER_STATUS_SUFFIXES = ['Approved', 'Rejected', 'Query', 'Deleted'];

var TE = {
  VOUCHER_DATE: 0, VOUCHER_TYPE_NAME: 1, VOUCHER_NUMBER: 2, LEDGER_NAME: 3,
  LEDGER_AMT: 4, LEDGER_AMOUNT_DR_CR: 5, COST_CENTER: 6, VOUCHER_NARRATION: 7
};

var EXPECTED_TALLY_EXPORT_HEADERS = [
  'Voucher Date', 'Voucher Type Name', 'Voucher Number', 'Ledger Name', 'Ledger Amt.',
  'Ledger Amount Dr/Cr', 'Cost Center', 'Voucher Narration'
];

var AV = {
  VOUCHER_ID: 0, DATE: 1, EXPENSE_TYPE: 2, SUBMITTED_BY: 3, VEHICLE_NO: 4,
  COST_CENTRE: 5, AMOUNT: 6, STATUS: 7, BATCH_ID: 8, APPROVED_BY_L1: 9,
  APPROVED_BY_L2: 10, QUERY_STATUS: 11, TALLY_EXPORTED: 12, BILL_FILES: 13,
  NOTES: 14, APPROVED_BY_ACCOUNTS: 15, REJECTED_AT_STAGE: 16,
  SUBMITTED_BY_OPERATOR: 17,
  // ADDED (backdating/cash-release/locking build): appended at the end,
  // never inserted mid-row — this is what keeps the migration additive
  // (append columns to existing sheet) instead of a full column-shift
  // migration like the RDS Day-7 insert had to do.
  //   ACTUAL_EXPENSE_DATE — the date on the vendor's bill (can be in the
  //     past, never in the future). AV.DATE remains the submission/
  //     voucher date (always today, unchanged meaning) and is what Batch
  //     ID and RDS placement continue to key off, per explicit
  //     instruction — a backdated bill never moves RDS or the Batch ID.
  //   CASH_RELEASED / CASH_RELEASED_VOUCHER_NO — replaces the old
  //     "today's batch fully approved" gate for Cash Given. A voucher is
  //     released independently of the calendar day it was submitted on;
  //     CASH_RELEASED_VOUCHER_NO points at the RDS "Cash Given by
  //     Accounts" row that released it, so an admin edit/delete of that
  //     RDS entry can find and roll back every voucher it released.
  //   EDIT_LOCKED_BY / EDIT_LOCKED_AT — advisory pessimistic lock so a
  //     submitter mid-edit and an approver acting on the same voucher
  //     can't race each other (the reject-vs-resubmit bug). Locked_At is
  //     used to auto-expire a stale lock (see EDIT_LOCK_TIMEOUT_SECONDS)
  //     if a browser tab is closed mid-edit rather than cancelled properly.
  ACTUAL_EXPENSE_DATE: 18, CASH_RELEASED: 19, CASH_RELEASED_VOUCHER_NO: 20,
  EDIT_LOCKED_BY: 21, EDIT_LOCKED_AT: 22,
  // ADDED 24 Aug 2026 (handoff 2.C, Dual-GST vendor flow for Regular
  // expenses) — appended at the end, same additive-only convention as
  // the block above. 'Yes' once Accounts has saved a vendor-routed
  // CGST/SGST split for this Regular voucher via saveRegularVendorGst
  // (Approval.gs); Tally Export branches buildRegularEntries on this
  // flag. Never set for Transport vouchers.
  // ADDED (Cash Withdrawal Batches feature, per explicit instruction) —
  // appended at the end, same additive-only convention as every block
  // above. This is a SEPARATE downstream step from CASH_RELEASED above:
  // Cash Given is disbursement FROM the existing petty float TO a
  // voucher's submitter; this tracks the periodic step where Accounts
  // bundles already-disbursed vouchers into a REPLENISHMENT request sent
  // to L2 for approval to withdraw a matching amount from the bank.
  // Blank until a voucher is bundled into a withdrawal REQUEST
  // (triggerCashWithdrawalRequest, Approval.gs); holds that request's own
  // WITHDRAWAL_ID from the moment it's requested. Cleared back to blank
  // on every voucher a REJECTED request covered (decideCashWithdrawalBatch,
  // Approval.gs), making them eligible again for a future, corrected
  // request — mirrors exactly how unmarkVouchersCashReleasedByRdsVoucherNo
  // already reverts CASH_RELEASED above. An APPROVED request's mark is
  // permanent: those vouchers are never eligible for a second request.
  REGULAR_VENDOR_ROUTED: 23, WITHDRAWAL_BATCH_ID: 24
};

var EXPECTED_VOUCHER_HEADERS = [
  'Voucher ID', 'Date', 'Expense Type', 'Submitted By', 'Vehicle No.', 'Cost Centre',
  'Amount', 'Status', 'Batch ID', 'Approved By L1', 'Approved By L2', 'Query Status',
  'Tally Exported', 'Bill Files', 'Notes', 'Approved By Accounts', 'Rejected At Stage',
  'Submitted By Operator', 'Actual Expense Date', 'Cash Released', 'Cash Released Voucher No.',
  'Edit Locked By', 'Edit Locked At', 'Regular Vendor Routed', 'Withdrawal Batch ID'
];

// One-time migration companion to the AV additions above — appends the
// 5 new headers to the LIVE "All Vouchers" sheet if they're not already
// there. Idempotent (safe to run more than once) and additive-only
// (never touches or reorders existing columns), unlike the RDS Day-7
// column-insert migration which had to shift existing data. Run once
// from the Apps Script editor before deploying this version. See
// migrateAddVoucherColumns in Sheet Utils.gs.

// CHANGED (Day 7): "Cash Given by Accounts" inserted immediately after
// Cash in Hand, before Advance — per explicit instruction. Every column
// from here on out shifted by +1 versus the old layout (ADVANCE was 29,
// is now 30; ACTUAL_CASH_IN_HAND was 30, is now 31). Every reader in this
// codebase goes through these named constants, never a raw column
// number, so that shift is safe in CODE. It is NOT automatically safe on
// an already-existing live spreadsheet tab — see
// migrateRdsInsertCashGivenColumn() in SheetUtils.gs, which MUST be run
// once, manually, from the Apps Script editor before this version is
// deployed, to physically insert the matching column on every month tab
// that already exists. A brand-new tab created AFTER this deploy
// (getOrCreateRdsMonthSheet) needs no migration — it's built with the
// new layout from row 1.
// ============================================================================
// RDS LEDGER COLUMN SCHEMA — v2 (per explicit instruction, mapping_new_RDS.xlsx).
// Replaces the old 22 synthetic "expense category" columns (Electricity,
// B'day Celebration, Office Expense, Transportation, ...) with 19 columns
// that map directly to real Tally ledger names, one column per ledger
// except the many "Repairs & Maintenance - <asset>" ledgers, which still
// share one REPAIRS_MAINTENANCE column (per the mapping file). 15 ledgers
// that were in active use under the old scheme (Electricity Charges,
// Telephone Expense, Mobile Bill, Water Charges, Manpower Supply Expenses,
// Garland, Binding Material, Internet Charges, Transportation/Labour
// Charges/Loading & Unloading Charge, both Diesel ledgers, Petrol
// Reimbursement/Petrol - Others, Medicine, Purchase for Project) are
// RETIRED per explicit instruction — remove them from Master Data's
// ledger list (column M, live spreadsheet — not something code can do)
// so submission can no longer select them; LEDGER_SYNC_COLUMN_MAP below
// no longer references them either.
//
// SCOPE OF THIS CHANGE — deliberately NOT applied to any month tab that
// already exists. An already-written tab's amounts sit under the OLD
// grouped columns (e.g. every "Food Exp"/"Parking Charges"/"Staff
// Welfare"/etc. voucher this month is already summed into one "Office
// Expense" cell) — RDS itself never recorded which individual ledger each
// amount came from, so there is no way to split that historical total
// back out into the new per-ledger columns without guessing. Only a
// BRAND NEW month tab (created by getOrCreateRdsMonthSheet from here
// forward) gets the new layout — see getRdsHeaderRow's header-source
// change in Sheet Utils.gs for how that's now guaranteed rather than left
// to "copy whatever the last tab looked like".
//
// ADDING A NEW LEDGER IN FUTURE (per explicit instruction — kept in code,
// not sheet-driven): append a new RS key + LEDGER_SYNC_COLUMN_MAP entry
// immediately BEFORE TOTAL (there is no Pending Voucher column on the real
// header — the ledger block runs straight into Total/Cash in hand/Advance/
// Actual Cash in Hand/Cash given by accounts), and append the matching
// header text to EXPECTED_RDS_HEADERS_FALLBACK in the same position — appending at the
// end of the ledger block (rather than inserting in the middle) is what
// keeps every other column's index and every already-created tab's
// layout undisturbed. Takes effect on the next new month tab; add the
// header manually to the CURRENT in-progress tab too if it needs to
// appear before then.
// ============================================================================
// CORRECTED (per the actual live header, pasted directly from the RDS
// spreadsheet) — this replaces a schema that had drifted from reality in
// two ways:
//   1. PENDING_VOUCHER never existed as a real column on the live sheet
//      and was never written by any function in this codebase (verified:
//      zero references outside this file before this fix) — removed
//      outright rather than left as a dead reserved slot.
//   2. CASH_GIVEN_BY_ACCOUNTS is the LAST column on the real sheet, not
//      inserted before Advance as the old "Day 7" layout assumed. Every
//      reader/writer in this codebase goes through these named constants
//      (never a raw column number), so correcting the indices here is
//      sufficient to realign every call site at once — see
//      RDS_SCRIPT_OWNED_LAST_COL below, which also had to change because
//      of this: the script-owned range is no longer one contiguous block
//      ending at Cash Given, since Advance/Actual Cash in Hand now sit
//      BETWEEN Cash in Hand and Cash Given, not after them.
var RS = {
  VOUCHER_NO: 0, DATE: 1, EMPLOYEE_NAME: 2, VEHICLE_NO: 3, COST_CENTRE: 4,
  BIRTHDAY_CAKE_CHOCOLATES: 5, CONVEYANCE_OTHERS: 6, FOOD_EXP: 7, HOUSE_KEEPING_MATERIAL: 8,
  LODGING_BOARDING: 9, OFFICE_EXPENSES: 10, PACKING_MATERIAL: 11, PANTRY_MATERIAL: 12,
  PARKING_CHARGES: 13, POSTAGE_COURIER: 14, PRINTING_STATIONERY: 15, REPAIRS_MAINTENANCE: 16,
  STAFF_WELFARE: 17, TEA_COFFEE: 18, TRANSPORTATION_NON_GST: 19, TRAVELLING_EXPENSES: 20,
  VEHICLE_FASTAG: 21, VEHICLE_JAKAT_TOLL: 22, VEHICLE_PETROL: 23,
  TOTAL: 24, CASH_IN_HAND: 25, ADVANCE: 26, ACTUAL_CASH_IN_HAND: 27,
  CASH_GIVEN_BY_ACCOUNTS: 28
};

// Row-type sentinel stored in RS.EMPLOYEE_NAME for a "Cash Given by
// Accounts" row, exactly the same convention 'Opening Balance' already
// uses — recomputeRdsCashInHand (SheetUtils.gs) detects both this way.
// Also doubles as this column's header text (see
// EXPECTED_RDS_HEADERS_FALLBACK below and getOrCreateRdsMonthSheet's
// header-copy logic) since both are the same human-readable label.
var RDS_CASH_GIVEN_ROW_LABEL = 'Cash Given by Accounts';

// ============================================================================
// CASH WITHDRAWAL BATCHES (per explicit instruction) — the bank-
// replenishment approval workflow. One row per withdrawal REQUEST (never
// per voucher): Accounts selects a set of fully-resolved, already-cash-
// released batches; triggerCashWithdrawalRequest (Approval.gs) writes one
// row here, emails L2 (cc accounts) an xlsx extract of the covered RDS
// rows, and this row's STATUS is later closed out by decideCashWithdrawalBatch
// once L2's reply comes back — approval happens over email, outside the
// app, so this sheet (plus AV.WITHDRAWAL_BATCH_ID) is the audit trail that
// makes that external decision reconstructible and prevents the same
// voucher being requested twice. New sheet, auto-created on first use —
// see getOrCreateCashWithdrawalBatchesSheet (Sheet Utils.gs).
// ============================================================================
var CASH_WITHDRAWAL_BATCHES_SHEET = 'Cash Withdrawal Batches';
var WB = {
  WITHDRAWAL_ID: 0, REQUESTED_DATE: 1, REQUESTED_BY: 2, BATCH_IDS: 3,
  PERIOD_FROM: 4, PERIOD_TO: 5, VOUCHER_COUNT: 6, TOTAL_AMOUNT: 7,
  STATUS: 8, DECIDED_BY: 9, DECIDED_DATE: 10, DECISION_NOTES: 11, EXCEL_URL: 12,
  EMAIL_SUBJECT: 13, DECIDED_VIA: 14
};
var EXPECTED_CASH_WITHDRAWAL_BATCHES_HEADERS = [
  'Withdrawal ID', 'Requested Date', 'Requested By', 'Batch IDs', 'Period From',
  'Period To', 'Voucher Count', 'Total Amount', 'Status', 'Decided By',
  'Decided Date', 'Decision Notes', 'Excel URL', 'Email Subject', 'Decided Via'
];
// WB.EMAIL_SUBJECT / WB.DECIDED_VIA appended 16 Sep 2026 (in-app L2
// approval). Both are APPENDED at the end of the row — no existing column
// index shifts, so legacy rows stay readable and every existing read/write
// keeps working untouched. EMAIL_SUBJECT stores the EXACT subject line of
// the request email sent to L2 so the decision email can be sent as
// 'Re: <that subject>' and land in the same Gmail conversation; legacy rows
// have it blank and fall back to a reconstructed subject (see
// withdrawalRequestSubject_, Approval.gs). DECIDED_VIA records whether the
// decision was made in-app by L2 or recorded by Admin on L2's behalf.
// getOrCreateCashWithdrawalBatchesSheet (Sheet Utils.gs) back-fills the two
// new header cells on an existing sheet.
var WITHDRAWAL_DECIDED_VIA_APP = 'L2 in-app';
var WITHDRAWAL_DECIDED_VIA_ADMIN = 'Admin recorded L2 reply';
// STATUS values: 'Pending L2 Approval' (set on request) -> 'Approved' or
// 'Rejected' (set by decideCashWithdrawalBatch — L2 decides in-app, admin
// retains the same power as a fallback; see Approval.gs).
var WITHDRAWAL_STATUS_PENDING = 'Pending L2 Approval';
var WITHDRAWAL_STATUS_APPROVED = 'Approved';
var WITHDRAWAL_STATUS_REJECTED = 'Rejected';

var TB = {
  VOUCHER_ID: 0, VENDOR_NAME: 1, AMOUNT: 2, TDS_APPLICABLE: 3, TDS_RATE: 4,
  TDS_AMOUNT: 5, BILL_FILES: 6, QUERY_STATUS: 7, CGST: 8, SGST: 9,
  GST_REVIEWED: 10, RETURN_PARCEL: 11, LR_NO: 12, HAMALI: 13
};
// TB.HAMALI added 24 Aug 2026 (handoff item 2.B) — hamali (loading/unloading)
// charges per vendor line on a Transport voucher. TDS-excluded, same
// treatment as CGST/SGST. Column appended at the END of the row (13),
// never inserted mid-row, so no existing column index above shifts.

var ALLOWED_TDS_RATES = [1, 2];

// Dual-GST vendor flow for Regular expenses (handoff 2.C, confirmed 24 Aug
// 2026 — "Rabale - Petty Cash" IS the voucher type meant by "Rabale Cash
// Voucher"). Deliberately separate from Transport's vendor system end to
// end: its own master vendor list (no TDS fields — TDS not applicable to
// this flow per explicit instruction) and its own per-voucher CGST/SGST
// sheet. Names avoid the word "Transport" per explicit instruction, to
// prevent confusion with TB / TRANSPORT_BREAKDOWN_SHEET above.
var REGULAR_VENDOR_MASTER_SHEET = 'Regular Expense Vendors';
var RVM = { VENDOR_NAME: 0, PAN: 1 };
var EXPECTED_REGULAR_VENDOR_MASTER_HEADERS = ['Vendor Name', 'PAN'];

var REGULAR_VENDOR_DETAILS_SHEET = 'Vendor Expense Details';
var RVD = { VOUCHER_ID: 0, VENDOR_NAME: 1, CGST: 2, SGST: 3 };
var EXPECTED_REGULAR_VENDOR_DETAILS_HEADERS = ['Voucher ID', 'Vendor Name', 'CGST', 'SGST'];

// Vendor FY Ledger sheet layout (see VENDOR_FY_LEDGER_SHEET above).
var VFL = { VENDOR_NAME: 0, FINANCIAL_YEAR: 1, BALANCE: 2 };
var EXPECTED_VENDOR_FY_LEDGER_HEADERS = ['Vendor Name', 'Financial Year', 'Balance'];

var QT = {
  QUERY_ID: 0, VOUCHER_ID: 1, QUERY_TYPE: 2, RAISED_BY: 3, RAISED_DATE: 4,
  QUERY_DETAILS: 5, ASSIGNED_TO: 6, RESPONSE: 7, RESPONSE_DATE: 8, STATUS: 9
};

// Audit Log columns — see Audit Log.gs's logAction, which has always
// appended in this exact order; formalized as named constants here only
// now that the Auditor Dashboard needs to READ this sheet programmatically
// (previously it was write-only from every other file's perspective).
var AL = { TIMESTAMP: 0, ACTION: 1, VOUCHER_ID: 2, ACTOR: 3, ROLE: 4, NOTES: 5,
  // ADDED — the actor's position in the company AT THE MOMENT of the action
  // (a snapshot, so a later promotion or correction never rewrites history).
  // ROLE above stays the app role and must stay that way: real logic keys off
  // it (wasAnyBillViewedThisStage, Approval.gs, matches on role codes), which
  // is why position is its own column rather than a replacement. Blank for
  // entries written before this column existed, for system actions, and for
  // people whose position was not set.
  POSITION: 6 };
var AUDIT_LOG_POSITION_HEADER = 'Position (at the time)';

// 'auditor' added as a 5th named-login role (not a shared PIN like admin)
// — deliberate: the whole point of the Auditor Dashboard is an
// attributable, individually-logged read-only trail, which a shared
// credential would undermine. Uses the same Admin > Manage Users panel
// and login flow as the other 4 multi-user roles, just strictly
// read-only server-side (every auditor-facing RPC must be a getter,
// never a writer — enforced by role checks, not by omission).
var MULTI_USER_ROLES = ['submission', 'L1', 'accounts', 'L2', 'auditor'];

// Unlike an earlier version of this getter, there is no insecure fallback
// PIN here — same pattern as getRdsSpreadsheetId() below: if the Script
// Property is missing, fail loudly instead of silently authenticating
// Admin against a value that was sitting in plain text in source control.
function getAdminPin_() {
  var p = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  if (!p) {
    Logger.log('WARNING: ADMIN_PIN Script Property not set — refusing to authenticate Admin. Set it under Project Settings > Script Properties.');
    logAction_('SETTINGS_WARNING', '', 'system', 'system', 'ADMIN_PIN Script Property not set; Admin login blocked.');
    throw new Error('ADMIN_PIN Script Property not set. Set it under Project Settings > Script Properties before Admin can log in.');
  }
  return p;
}

// Hardcoded per explicit instruction — step one toward username-driven
// role inference (the role dropdown is still in place for now; this is
// just Admin's identity getting a real username ahead of that). Not a
// secret on its own — it's checked alongside the PIN, same as any
// username+password pair elsewhere in the app, and is never looked up
// from the Users sheet the way the 4 multi-user roles are.
var ADMIN_USERNAME = 'AdminRabale';

var SESSION_EXPIRY_SECONDS = 3600;

// ----------------------------------------------------------------------------
// ONE LOGIN PER ACCOUNT (Auth.gs). While an account has a live session, a second
// login with the correct password is refused (nothing is counted as a failed
// attempt, and the refusal is only ever shown AFTER the password is verified, so
// it cannot be used to find out who is online).
//
// "Live" means the session was seen recently. The browser pings every
// SESSION_HEARTBEAT_SECONDS and every server call also counts. If nothing has been
// seen for SESSION_ACTIVE_WINDOW_SECONDS the session is treated as abandoned (tab
// closed without logging out, laptop asleep, no signal): the next correct login
// ends it and takes over. Without that, someone who simply closed the tab would be
// locked out of their own account until the 1-hour session expired.
//   Trade-off: after closing the tab without logging out, the user waits up to
//   SESSION_ACTIVE_WINDOW_SECONDS before logging in again (the login page counts it
//   down). An administrator can end a session immediately (Manage Users > End session).
// ----------------------------------------------------------------------------
var SINGLE_SESSION_ENFORCED         = true;   // default; Manage Users > "Pause the one-login rule" (Script Property SINGLE_SESSION=off) overrides it without a redeploy
var SINGLE_SESSION_APPLIES_TO_ADMIN = true;   // the Admin PIN is shared; set false to let two admins be in at once
var SESSION_ACTIVE_WINDOW_SECONDS   = 150;
var SESSION_HEARTBEAT_SECONDS       = 45;     // sent to the browser; keep it well under the window above
var SESSION_TOUCH_MIN_INTERVAL_SECONDS = 20;  // a busy user does not rewrite the cache on every call
var MAX_LOGIN_ATTEMPTS      = 5;
var LOCKOUT_SECONDS        = 900;
// Admin's own lockout thresholds — deliberately separate from
// MAX_LOGIN_ATTEMPTS/LOCKOUT_SECONDS above (not reused, since those are
// hardcoded inside registerFailedAttempt() and shared by the 4
// multi-user roles). Higher attempt count / shorter window than the
// multi-user roles: Admin is a single shared identity typed daily by a
// small number of trusted people, so a tighter 5-attempt lockout would
// risk locking out a legitimate typo-prone admin more than it would slow
// a real attacker. This closes the previously-documented no-lockout gap
// while keeping the admin flow usable.
var ADMIN_MAX_LOGIN_ATTEMPTS = 20;
var ADMIN_LOCKOUT_SECONDS    = 300;
var MAX_FILE_SIZE_BYTES    = 5 * 1024 * 1024;
var MAX_FILES_PER_UPLOAD    = 25;
var MAX_TOTAL_UPLOAD_BYTES  = 30 * 1024 * 1024;

var APPROVAL_SEQUENCE = ['L1', 'accounts', 'L2'];

var STATUS_FOR_ROLE = {
  'L1': 'Pending L1', 'accounts': 'Pending Accounts', 'L2': 'Pending L2'
};

var APPROVER_COLUMN_FOR_ROLE = {
  'L1': AV.APPROVED_BY_L1, 'accounts': AV.APPROVED_BY_ACCOUNTS, 'L2': AV.APPROVED_BY_L2
};

function getPendingStatusForRole_(role) { return STATUS_FOR_ROLE[role] || null; }

function getNextStatus_(role) {
  var idx = APPROVAL_SEQUENCE.indexOf(role);
  if (idx === -1) return null;
  if (idx === APPROVAL_SEQUENCE.length - 1) return 'Approved';
  return STATUS_FOR_ROLE[APPROVAL_SEQUENCE[idx + 1]];
}

// ============================================================================
// RABALE DAILY SYNC (Day 6) — moved to its OWN spreadsheet, separate from
// the operational one (SHEET_ID). Reasoning: this sheet exists so accounts
// staff can open it directly and read it, which means it can't live
// alongside Users (password hashes) or Audit Log without either loosening
// sharing on the whole operational spreadsheet or defeating the point of
// a human-readable presentation sheet. One month per tab ("August 2026"),
// per explicit instruction.
//
// SETUP: create a new Google Sheet, then add its ID as Script Property
// "RDS_SHEET_ID". Unlike ADMIN_PIN there is no insecure fallback here —
// there's no safe default spreadsheet to fall back to, so this throws
// loudly instead of silently writing nowhere.
var RDS_SHEET_ID_PROPERTY_KEY = 'RDS_SHEET_ID';
function getRdsSpreadsheetId_() {
  var id = PropertiesService.getScriptProperties().getProperty(RDS_SHEET_ID_PROPERTY_KEY);
  if (!id) throw new Error('RDS_SHEET_ID Script Property not set. Create the Rabale Daily Sync spreadsheet and add its ID under Project Settings > Script Properties.');
  return id;
}

// Trial-run seed figure, per explicit instruction — used ONLY when no
// prior month's tab exists anywhere to carry a closing balance forward
// from (i.e. the very first entry this system has ever logged).
var RDS_INITIAL_OPENING_BALANCE = 225000;

// Script writes Voucher No. through Cash Given by Accounts — everything
// up to and including the running balance AND the Cash Given column,
// which is entered only through the web app (addRdsCashGiven,
// Approval.gs), never hand-typed. Advance and Actual Cash in Hand remain
// manual-entry only — the script never reads or writes them; see the
// Cash Advances comment above for what those two columns actually are
// (a periodic manual reconciliation, not a per-transaction log) and why
// the separate Cash Advances tracking system deliberately does NOT write
// here.
//
// CORRECTED — on the real header, Advance/Actual Cash in Hand sit BETWEEN
// Cash in Hand and Cash Given by Accounts, not after both of them, so the
// script-owned columns are no longer one contiguous block. This is now
// TWO ranges instead of one — see protectRdsScriptOwnedRange in
// SheetUtils.gs, which protects [1..RDS_SCRIPT_OWNED_LAST_COL] (through
// Cash in Hand) AND the single Cash Given by Accounts column separately,
// leaving exactly the two manual-entry columns open in between.
var RDS_SCRIPT_OWNED_LAST_COL = RS.CASH_IN_HAND + 1;

// ADDED — open scratch space for Warehouse staff past the data columns.
// Nothing in this codebase reads or writes these columns; they exist
// purely so the tab's grid physically extends past AF (Actual Cash in
// Hand) instead of ending there, which is what was actually causing
// "can't go beyond column AF" — that column was simply the last one the
// grid had ever been sized to, not a permission or protection boundary.
var RDS_SCRATCH_COLUMNS_COUNT = 15;

// Last-resort header text if NEITHER the new RDS spreadsheet nor the
// original single-sheet "Rabale Daily Sync" (in the main spreadsheet) has
// any header row to copy from yet — see getRdsHeaderRow in SheetUtils.gs,
// which always prefers copying the real header text over using this.
// Placeholder wording only; correct by hand in the sheet if this path is
// ever actually hit.
// Header row for every NEW month tab going forward (see getRdsHeaderRow,
// Sheet Utils.gs, which now uses this constant directly rather than
// copying an existing tab's headers) — this IS the RDS ledger column
// schema v2 described above, not just a last-resort fallback anymore.
// Order must match the RS object exactly, column for column.
var EXPECTED_RDS_HEADERS_FALLBACK = [
  'Voucher No.', 'Date', 'Employee Name', 'Vehicle No. / Machine', 'Cost Centre',
  'Birthday Cake & Chocolates', 'Conveyance - Others', 'Food Exp', 'House Keeping Material: Thane & Rabale',
  'Lodging & Boarding Exp', 'Office Expenses', 'Packing Material', 'Pantry Material',
  'Parking Charges', 'Postage & Courier Charges', 'Printing & Stationery', 'Repairs & Maintainance',
  'Staff Welfare', 'Tea & Coffee', 'Transportation Non - GST', 'Travelling Expenses',
  'Vehicle Fastag', 'Vehicle Operating - Jakat/Toll', 'Vehicle Operating - Petrol',
  'Total', 'Cash in hand', 'Advance', 'Actual Cash in Hand', 'Cash given by accounts'
];

// ============================================================================
// QUERY CATEGORIES (Day 6) — data-driven, mirrors APPROVAL_SEQUENCE's own
// "config not code" convention. Each category declares its field scope
// (what the submitter may change when resubmitting in response to a query
// raised AFTER L1 has already approved — i.e. status is Pending Accounts or
// Pending L2, not the older Pending L1 / Rejected full-edit path, which is
// unchanged and still fully permissive).
//
// fieldScope values: 'actualExpenseDate' | 'submittedBy' | 'vehicleNo' |
// 'costCentre' | 'ledgerOrVendor' | 'amount' | 'description' | 'billFiles' | 'full'
// requiresLineTarget: true means the raiser must pick 1+ specific Transport
// Breakdown line(s) when raising the query (only meaningful for Transport
// vouchers — Regular vouchers have no lines to target, 'amount' scope on a
// Regular voucher just unlocks the single amount field, no picker needed).
//
// REVISED 24 Aug 2026 — rebuilt to one category per submission field
// (excluding Voucher Date and Voucher No., which are never editable via
// any query response — Voucher Date is structurally immutable, Voucher
// No. isn't part of this RPC's input at all) plus 'Other' as the sole
// catch-all for a full-voucher edit. 10 submission fields (Voucher Date,
// Voucher No., Actual Expense Date, Submitted By, Vehicle No., Cost
// Centre, Ledger/Expense Category [or Vendor, for Transport], Amount,
// Description, Bill Files) minus the 2 excluded = 8, plus Other = 9
// categories total. 'Ledger / Vendor' deliberately covers BOTH the
// Regular Ledger field and the Transport per-line Vendor identity — they
// occupy the same conceptual slot (what/who this expense went to) and a
// Transport voucher has no separate Ledger field to begin with, so one
// category serves both, same pattern the old 'Wrong Cost Centre/Ledger'
// combined category already used for two fields at once.
var QUERY_CATEGORIES = {
  'Actual Expense Date':  { fieldScope: 'actualExpenseDate', requiresLineTarget: false },
  'Submitted By':          { fieldScope: 'submittedBy',       requiresLineTarget: false },
  'Vehicle No.':           { fieldScope: 'vehicleNo',         requiresLineTarget: false },
  'Cost Centre':           { fieldScope: 'costCentre',        requiresLineTarget: false },
  'Ledger / Vendor':       { fieldScope: 'ledgerOrVendor',    requiresLineTarget: true  },
  'Amount':                { fieldScope: 'amount',            requiresLineTarget: true  },
  'Description':           { fieldScope: 'description',       requiresLineTarget: false },
  'Bill Files':            { fieldScope: 'billFiles',         requiresLineTarget: false },
  'Other':                 { fieldScope: 'full',              requiresLineTarget: false }
};

// Statuses where a query-scoped edit becomes available — field access is
// always gated by QUERY_CATEGORIES' fieldScope, never fully open, at any
// stage a query can be raised. Previously excluded 'Pending L1', which
// meant an L1-raised query fell through to the old unrestricted full-edit
// path (EDITABLE_STATUSES) instead of the category scoping — the actual
// cause of two separate bug reports (query categorization appearing not
// to apply, and editing being possible on a plain unqueried voucher):
// EDITABLE_STATUSES used to include 'Pending L1' unconditionally, so nothing
// about a query mattered for it at all. Now that EDITABLE_STATUSES
// (Vouchers.gs) is 'Rejected' only, this is the ONLY edit path available on
// a still-in-flight voucher, at every stage a query can legitimately exist.
var QUERY_EDIT_STATUSES = ['Pending L1', 'Pending Accounts', 'Pending L2'];

// ============================================================================
// VOUCHER EDIT LOCK — advisory pessimistic lock (AV.EDIT_LOCKED_BY /
// EDIT_LOCKED_AT), separate from LockService.getScriptLock() (which only
// ever guards a single write from colliding with another write, not a
// human's multi-minute editing session). Acquired when a submitter opens
// a voucher for edit/query-response, released on save/cancel, and
// auto-expired after this many seconds so a closed tab or crashed
// browser can't permanently strand a voucher. Every approver action
// (approve/reject/query) AND every submission edit-open must check this
// before proceeding — see acquireVoucherEditLock/releaseVoucherEditLock/
// isVoucherLockedForOther in Vouchers.gs.
// ============================================================================
var EDIT_LOCK_TIMEOUT_SECONDS = 600; // 10 minutes of inactivity

// ============================================================================
// NEW VENDOR REQUEST (submission → email) and QUERY-AGING REMINDER
// (scheduled trigger → email) — both recipient addresses are Script
// Properties, never hardcoded, so they're editable without a redeploy
// (same pattern as ADMIN_PIN / RDS_SHEET_ID above). Unlike ADMIN_PIN
// there is no insecure fallback: an unset recipient means the feature
// cleanly reports "not configured" rather than silently emailing nobody
// or throwing an unhandled exception up through google.script.run.
// ============================================================================
var VENDOR_REQUEST_EMAIL_PROPERTY_KEY = 'VENDOR_REQUEST_EMAIL';
function getVendorRequestEmail_() {
  var email = PropertiesService.getScriptProperties().getProperty(VENDOR_REQUEST_EMAIL_PROPERTY_KEY);
  if (!email) {
    Logger.log('WARNING: VENDOR_REQUEST_EMAIL Script Property not set.');
  }
  return email || null;
}

// EMPLOYEE_REQUEST_EMAIL is deliberately its own Script Property, not a
// fallback onto VENDOR_REQUEST_EMAIL — employee master-data additions may
// need a different approver (e.g. HR/Admin) than vendor bill review does,
// and silently routing employee requests to whoever handles vendor
// requests could land them with someone who doesn't expect that job.
var EMPLOYEE_REQUEST_EMAIL_PROPERTY_KEY = 'EMPLOYEE_REQUEST_EMAIL';
function getEmployeeRequestEmail_() {
  var email = PropertiesService.getScriptProperties().getProperty(EMPLOYEE_REQUEST_EMAIL_PROPERTY_KEY);
  if (!email) {
    Logger.log('WARNING: EMPLOYEE_REQUEST_EMAIL Script Property not set.');
  }
  return email || null;
}

var QUERY_REMINDER_EMAIL_PROPERTY_KEY = 'QUERY_REMINDER_EMAIL';
function getQueryReminderEmail_() {
  var email = PropertiesService.getScriptProperties().getProperty(QUERY_REMINDER_EMAIL_PROPERTY_KEY);
  if (!email) {
    Logger.log('WARNING: QUERY_REMINDER_EMAIL Script Property not set.');
  }
  return email || null;
}

// A query open this many days or longer triggers the daily reminder
// email (Triggers.gs). Default 2 — adjust here, not in code that reads it.
var QUERY_REMINDER_AGE_DAYS = 2;

// SAME-DAY query reminder (Triggers.gs, sendSameDayQueryReminders) — a
// SEPARATE, more urgent notification from the QUERY_REMINDER_AGE_DAYS
// digest above: any query raised TODAY and still open at this hour gets
// emailed to every active 'submission' user (via notifyRole, Users.gs)
// tonight, so it's sitting in their inbox first thing tomorrow morning
// rather than waiting up to QUERY_REMINDER_AGE_DAYS days for the
// aging-escalation digest to pick it up. 21 = 9pm, script timezone.
var SAME_DAY_QUERY_REMINDER_HOUR = 21;

// RDS DAY-CLOSE (redesign, per explicit instruction) — the hour
// closeRdsDay's daily trigger runs (Triggers.gs). Deliberately early
// (just after midnight, not end-of-day) so today's Opening Balance row
// exists in the RDS spreadsheet BEFORE the day's first voucher can
// possibly arrive — the whole point of this trigger is to make the day
// boundary a calendar-driven fact, not something inferred after the
// fact from whenever the next voucher happens to show up.
var RDS_DAY_CLOSE_HOUR = 1;

// APPROVER DAILY DIGEST (Triggers.gs, sendApproverDigests) — one email per
// active L1 / Accounts / L2 user each morning listing the vouchers waiting
// on their stage. 9 = 9am script timezone (Asia/Kolkata per appsscript.json).
// A voucher waiting APPROVER_DIGEST_OVERDUE_DAYS or more days since its
// submission date is highlighted red in the email — presentation only, it
// changes nothing about the voucher. The table shows at most
// APPROVER_DIGEST_MAX_ROWS rows (oldest first); any remainder is summarised
// as "+N more" with a pointer to the app.
var APPROVER_DIGEST_HOUR = 9;

// Query-aging reminder to submitters (setupQueryReminderTrigger, Triggers.gs). Was hard-coded to atHour(9).
// Apps Script cannot fire at an exact minute: atHour(h).nearMinute(m) means "some time within 15 minutes of
// h:m", so 8 / 15 lands between 08:00 and 08:30 script time (Asia/Kolkata per appsscript.json).
// After changing these, run setupQueryReminderTrigger() once from the editor: an installed trigger keeps its
// old time until it is recreated.
var QUERY_REMINDER_HOUR   = 8;
var QUERY_REMINDER_MINUTE = 15;
var APPROVER_DIGEST_OVERDUE_DAYS = 2;
var APPROVER_DIGEST_MAX_ROWS = 25;

// Rows shown in the query-reminder emails (Triggers.gs) before "+N more".
var QUERY_EMAIL_MAX_ROWS = 25;

// Drive folder (inside 'Rabale Expense System') holding a copy of every bill
// emailed with a new-vendor request: Vendor Requests / <vendor> (<date>) / <file>.
var VENDOR_REQUEST_DRIVE_FOLDER = 'Vendor Requests';

// The link put in emails. Set the APP_URL Script Property to your live
// "Web app" deployment URL (the one ending /exec: Deploy > Manage
// deployments > Web app > copy URL). It is read here and nowhere else.
// If it is unset we fall back to ScriptApp.getService().getUrl(), which is
// NOT reliable: run from the script editor it returns the private test
// (/dev) URL, which only people with edit access to this project can open
// and which runs the unsaved latest code rather than the deployed version.
// A /dev URL is therefore never used \u2014 the email simply omits the button
// (and logs a warning) until APP_URL is set. Only https URLs are accepted.
var APP_URL_PROPERTY_KEY = 'APP_URL';
function getAppUrl_() {
  var configured = PropertiesService.getScriptProperties().getProperty(APP_URL_PROPERTY_KEY);
  if (configured) {
    configured = String(configured).trim();
    if (/^https:\/\//i.test(configured)) return configured;
    Logger.log('WARNING: APP_URL Script Property is not an https URL \u2014 ignored.');
    return '';
  }
  var detected = '';
  try { detected = ScriptApp.getService().getUrl() || ''; } catch (e) { Logger.log('getAppUrl: no web app URL: ' + e); }
  if (/\/dev\/?$/.test(detected)) {
    Logger.log('WARNING: only a test (/dev) URL is available and it is not used in emails \u2014 set the APP_URL Script Property to the /exec deployment URL.');
    return '';
  }
  return detected;
}

// Highlight color applied to a Tally Export sheet row when the voucher
// it corresponds to is later deleted by admin (see adminDeleteVoucher,
// Approval.gs) — the loud, visible flag requested alongside the audit
// log entry and the confirmation warning, so anyone opening the export
// sheet for reconciliation sees it immediately without reading the log.
var TALLY_EXPORT_DELETED_VOUCHER_HIGHLIGHT = '#F4C7C3';

// ----------------------------------------------------------------------------
// LOGIN PAGE SETTINGS (both optional Script Properties)
//   SUPPORT_CONTACT  who to contact, e.g. "Meena Rao, ext. 214". Shown in the login page help line.
//                    Blank: the page says "your administrator".
//   FAVICON_URL      https URL of the browser-tab icon. Blank: the T mark embedded in Logos.gs is used.
// ----------------------------------------------------------------------------
function getSupportContactText_() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty('SUPPORT_CONTACT');
    return v ? String(v).replace(/[\u0000-\u001f]/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, 120) : '';
  } catch (e) { return ''; }
}

function getFaviconUrl_() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty('FAVICON_URL');
    if (v && /^https:\/\//i.test(String(v).trim())) return String(v).trim();
  } catch (e) { /* fall through to the embedded icon */ }
  return getFaviconDataUri_();
}
