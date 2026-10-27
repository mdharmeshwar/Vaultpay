# VaultPay Financial Core

VaultPay is a small, single-instance invoicing portal for Nexus Corporate Services. It uses Express, the Node.js built-in SQLite API, a static responsive frontend, Stripe Checkout (test mode only), PDFKit, and Nodemailer.

## Local setup

Requirements: Node.js 22.13 or newer (tested on Node 24.11; the built-in `node:sqlite` API is currently experimental) and npm.

```powershell
npm install
Copy-Item .env.example .env
```

Set a private, random `JWT_SECRET` of at least 32 characters in `.env`. Leave Stripe and SMTP values empty until testing those integrations. Set an administrator identity temporarily in the PowerShell environment, then seed the first administrator:

```powershell
$env:ADMIN_EMAIL = "admin@example.test"
$env:ADMIN_NAME = "VaultPay Administrator"
$env:ADMIN_PASSWORD = "use-a-private-password-of-at-least-12-characters"
npm run seed:admin
Remove-Item Env:ADMIN_EMAIL, Env:ADMIN_NAME, Env:ADMIN_PASSWORD
npm start
```

Open `http://localhost:3000`. Add client accounts from the Admin dashboard. Client passwords are set by the administrator during account creation; arrange delivery through a secure out-of-band channel. Do not use real customer data for a demo.

## Environment variables

| Variable | Purpose | Exposure |
|---|---|---|
| `PORT` | HTTP port (default `3000`) | Server |
| `DATABASE_PATH` | SQLite database file (default `./data/vaultpay.sqlite`) | Server |
| `RECEIPTS_DIR` | Private local PDF receipt directory | Server |
| `JWT_SECRET` | HS256 token signing key (minimum 32 random characters) | Server only |
| `CLIENT_URL` | Portal origin used for Checkout return URLs | Server |
| `STRIPE_SECRET_KEY` | Stripe **test-mode** secret key (`sk_test_...`) | Server only |
| `STRIPE_WEBHOOK_SECRET` | Signing secret from the Stripe CLI or test webhook (`whsec_...`) | Server only |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP connection settings | Server only |
| `SMTP_USER`, `SMTP_PASS` | Optional SMTP authentication | Server only |
| `MAIL_FROM` | Configured sender address | Server only |
| `SUPPORT_EMAIL` | Optional support address printed on receipts | Server |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | One-time first-admin seeding inputs | Server only; do not commit |

No secrets are used in browser configuration or bundled frontend assets. `.env` files and local data are ignored by Git.

## Tests and checks

```powershell
npm test
npm run check
npm audit --omit=dev
```

Tests use an in-memory SQLite database and signed synthetic Stripe test events. They do not make real charges, contact Stripe, or send email.

## Stripe test-mode workflow

1. Configure a Stripe test secret key as `STRIPE_SECRET_KEY`.
2. Start the server with `npm start`.
3. In another terminal, run `stripe listen --forward-to localhost:3000/api/webhooks/stripe`; configure the displayed local signing secret as `STRIPE_WEBHOOK_SECRET` and restart the server.
4. Create an invoice for a test client and log in as that client. Use **Pay invoice** to start Checkout.
5. Complete Checkout with `4242 4242 4242 4242`, a valid future expiry, any suitable test CVC, and a test postal code.
6. Confirm the invoice changes to Paid only after the verified webhook. Download the receipt from the invoice page.
7. SMTP is optional locally. Without SMTP configuration, the PDF is generated and email state is recorded as `not_configured`; no email delivery is claimed.

The browser return URL only shows a pending message. The backend never changes payment status based on browser navigation.

## Deployment preparation and known limits

`Dockerfile` provides a non-root Node container and a `/app/data` volume for a **single persistent instance**. Configure all secrets through the hosting provider, mount persistent storage, terminate HTTPS at the host, and set `CLIENT_URL` to the actual HTTPS portal origin. Register `https://<actual-backend-host>/api/webhooks/stripe` in Stripe test mode and subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`.

This scaffold is not verified for production deployment or multi-instance/high-availability use. SQLite and local receipt files require a single instance and durable volume; ephemeral disks lose database data and receipts. Before production or multiple replicas, migrate persistence to a managed transactional database, receipts to private object storage, and add operational alerting and recovery procedures. Node's built-in SQLite API is experimental in the supported runtime and should be replaced or re-evaluated for a production support commitment.

The client uses a short-lived JWT in `sessionStorage` to survive page navigation. Backend authorization is independently enforced on every protected API request. This is a minimal authentication foundation; production account recovery, password reset, MFA, audit retention, administrative account lifecycle controls, and security monitoring are not included.

Stripe and SMTP credentials, provider dashboard configuration, public hosting, real endpoint delivery, and actual test Checkout completion were unavailable during implementation and remain unverified. Never use live-mode Stripe credentials or real payment cards for demonstration.
