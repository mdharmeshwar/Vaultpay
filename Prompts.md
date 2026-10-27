# Sprint 20 AI Assistance Record

This file records the AI assistance used for this implementation session. It is not a fabricated reconstruction of earlier conversations.

## User-provided implementation brief

The user supplied the Sprint 20 VaultPay Financial Core master brief requesting an in-place repository audit and implementation of a role-based invoicing portal, invoice ownership protection, Stripe Checkout, raw-body signature-verified webhooks, idempotent payment processing, private PDF receipts, Nodemailer delivery, tests, setup/deployment configuration, and an accurate final acceptance report. The brief prohibited claiming unverified payment, email, or deployment success.

## Work performed with AI assistance

- Audited the workspace and confirmed it contained no application, database, package manifest, or technical handoff document.
- Chose a minimal Express and static JavaScript application with SQLite persistence rather than replacing an existing system.
- Implemented HS256 JWT verification (issuer, audience, expiry), password hashing, Admin/Client API authorization, resource ownership checks, input validation, and server-side invoice amounts.
- Implemented Stripe Checkout using server-stored invoice values, test-mode-only server credentials, raw-body `constructEvent` verification, amount/currency/session association checks, atomic invoice transitions, and Stripe event deduplication.
- Implemented private local PDF receipt generation and email delivery status handling. Email configuration is optional and missing SMTP is recorded as `not_configured`.
- Added tests for authentication, role enforcement, cross-client IDOR, invoice amount calculation, signature rejection, payment amount verification, idempotent event processing, and authorized receipt download.
- Used `npm audit` after dependency installation; it identified vulnerable Nodemailer 6.x, so Nodemailer was upgraded to patched 10.2.1.

## Debugging notes and corrected defects

- The environment had no Visual Studio C++ build tools for compiling `better-sqlite3` on Node 24, so persistence was changed to Node's built-in SQLite API; its experimental status is documented.
- Test requests initially JSON-serialized a Buffer and therefore did not exercise the exact signed raw webhook payload. Tests now send the exact raw JSON string.
- Webhook currency comparison initially failed because Stripe normalizes currency to lowercase while invoice records retain uppercase ISO codes; comparison now normalizes both sides.
- Receipt generation writes a uniquely named temporary PDF and atomically renames it into the private receipts directory.
- Checkout return URLs carry an invoice identifier and display a pending message only; they do not update payment status.

## Security decisions

- JWTs are bearer tokens held in session storage for this minimal browser client; no role value in browser storage is trusted for API authorization.
- Admin invoice creation uses decimal input parsing to integer minor units. Client-supplied payment amount, owner, or status is ignored or rejected.
- Client invoice listings are filtered by authenticated user identity in SQL; detail, PDF, receipt, and payment-session operations apply ownership checks.
- Only a verified Stripe event with a matching persisted session, client reference, invoice, amount, currency, and paid status can transition an invoice.
- Credentials are placeholders or blank in `.env.example`; no actual secrets or sample user passwords are committed.

## Validation status and known limitations

- `npm test`: passed, 5 tests; includes invalid/expired auth, RBAC, cross-client API and document denials, server-derived checkout amount/idempotency, paid/void invoice blocking, missing/invalid/tampered webhook signatures, event type/amount/currency/session checks, receipt generation, duplicate event handling, authorized receipt download, and SMTP failure/retry behavior.
- `npm run check`: passed for backend, frontend, and test JavaScript files.
- `npm audit`: passed with 0 vulnerabilities after upgrading Nodemailer.
- Local browser smoke test: verified Admin sign-in, client registration, invoice creation, the Client dashboard displaying its assigned invoice, and direct Client navigation to `/admin/dashboard` displaying `403 Unauthorized`.
- Local `/api/health` returned HTTP 200. Automated API tests verified that each Client receives only their own invoice list.
- `docker --version` is available, but `docker build` was blocked because the Docker Desktop Linux engine/daemon is not running. No Stripe charge, real Checkout, SMTP delivery, hosted deployment, or live webhook delivery was performed.
- SQLite is experimental in the Node runtime used. Local PDF receipts and SQLite need persistent storage; current design is single-instance only. Production database/object-storage migration and operational recovery are unresolved.
