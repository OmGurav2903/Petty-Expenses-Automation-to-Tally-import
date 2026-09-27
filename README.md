Petty Cash & Expense Voucher Management System
================================================

A Google Apps Script application for managing petty-cash expense vouchers end-to-end
on top of Google Sheets: submission, multi-stage approval, cash advances, vendor/ledger
master data, audit logging, and export to Tally accounting software.

What it does
------------

- Voucher submission & approval workflow — a 3-stage approval chain
  (Submission -> L1 -> Accounts -> L2) with row-level locking to prevent concurrent
  edits.
- Role-based authentication — individual named logins for the four working roles
  (submission, L1, accounts, L2) plus a shared-PIN admin role, with per-user
  accountability in the audit trail.
- Cash advances — request, approval, and reconciliation of employee cash advances.
- Master data management — employees, vendors, cost centres, ledgers, and vehicles.
- Ledger auto-suggestion — suggests the correct accounting ledger for a voucher
  based on the description, seeded from historical data and improving as it learns
  from corrections.
- Tally export — generates exports formatted for import into Tally accounting
  software.
- Audit log — records who did what and when, across all roles.
- Auditor dashboard — a strictly read-only view for an auditor role, reusing
  existing data-access functions rather than duplicating query logic.
- Automated notifications — transactional emails (cash-advance requests/decisions,
  vendor and employee requests, account notices) built from a shared branded
  template.

Structure
---------

Auth.gs               - Login, sessions, logout
Users.gs               - User account management (per-role)
Approval.gs            - Multi-stage approval workflow
Vouchers.gs            - Voucher submission and listing
Advances.gs            - Cash advance requests and tracking
Master.gs              - Employees, vendors, cost centres, ledgers, vehicles
Ledger Seed.gs         - Historical seed data for ledger suggestion
Ledger Suggest.gs      - Ledger auto-suggestion engine
Tally Export.gs        - Export formatting for Tally accounting software
Auditor.gs             - Read-only auditor dashboard RPCs
Audit log.gs           - Audit logging
Notification.gs        - Transactional email builders
Email template.gs      - Shared branded email template
Config.gs              - Application configuration
Logos.gs               - Branding/logo assets
Sheet utils.gs         - Shared spreadsheet helper functions
Triggers.gs            - Scheduled/automated triggers
Main.GS                - Main entry point and routing
CHANGES.md             - Version history and change log
tools/                 - Test harness, hardening checks, and surface analysis scripts

Requirements
------------

- A Google account with access to Google Sheets and Apps Script.
- clasp (https://github.com/google/clasp) (optional) if you want to push/pull this
  code to an Apps Script project from the command line instead of the web editor.

Development tools
-----------------

The tools/ directory contains Node.js and Python scripts used during development:

- test_v5.js, test_ledger_suggest.js, test_ledger_suggest_client.js,
  client_admin_test.js — test suites.
- harden.js — security/hardening checks, with output captured in
  harden_report.json.
- surface.js — API surface analysis, output in surface.json / surface_rest.txt.
- undef_check.js, protocol_checks.py, final_surface_check.js — static checks.
- build_seed.py — builds ledger seed data from historical records.
- run_all_checks.sh — runs the full check suite.

See tools/README.md for details on running these.

Notes
-----

- This project has not yet been wired up to clasp; there is no .clasp.json or
  appsscript.json in the repo. Add these if you want command-line push/pull to an
  Apps Script project.
- Main.GS uses an uppercase .GS extension, inconsistent with the rest of the
  .gs files. This is preserved as-is to avoid unintended history/mapping changes;
  consider renaming for consistency if this project is wired up to clasp.
