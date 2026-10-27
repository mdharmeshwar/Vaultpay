const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { authenticate, createToken, hashPassword, newId, requireJwtSecret, requireRole, verifyPassword } = require('./auth');
const { HttpError } = require('./errors');
const { finalizeReceipt, createCheckoutSession, processStripeEvent, readVerifiedEvent } = require('./payments');
const { writeInvoicePdf } = require('./receipts');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD']);

function parseAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(400, 'Amount is required');
  const text = String(value).trim();
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(text)) throw new HttpError(400, 'Amount must be a positive value with up to two decimals');
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 99999999999) {
    throw new HttpError(400, 'Amount is outside the supported range');
  }
  return cents;
}

function requireText(value, label, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new HttpError(400, `${label} is required and must be at most ${maxLength} characters`);
  }
  return value.trim();
}

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${label} must use YYYY-MM-DD format`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new HttpError(400, `${label} is invalid`);
  return value;
}

function safeInvoice(db, user, invoiceId) {
  const invoice = db.prepare(`
    SELECT i.*, u.name AS client_name, u.email AS client_email
    FROM invoices i JOIN users u ON u.id = i.client_id WHERE i.id = ?
  `).get(invoiceId);
  if (!invoice) throw new HttpError(404, 'Invoice not found');
  if (user.role !== 'Admin' && invoice.client_id !== user.id) throw new HttpError(403, 'Forbidden');
  return invoice;
}

function publicInvoice(invoice) {
  const {
    stripe_session_id, stripe_checkout_key, stripe_payment_intent_id, receipt_path, ...safe
  } = invoice;
  return {
    ...safe,
    canDownloadReceipt: safe.status === 'Paid' && safe.receipt_status === 'ready'
  };
}

function createApp({ db, stripeClient, stripeEventHandler = processStripeEvent, receiptFinalizer = finalizeReceipt } = {}) {
  if (!db) throw new Error('Database instance is required');
  requireJwtSecret();
  const app = express();
  app.locals.db = db;
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));

  app.post('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Expected raw JSON webhook body');
      const event = readVerifiedEvent(req);
      const outcome = stripeEventHandler(db, event);
      if (!outcome.duplicate && outcome.paidInvoiceId) await receiptFinalizer(db, outcome.paidInvoiceId);
      res.json({ received: true });
    } catch (error) {
      if (error.type === 'StripeSignatureVerificationError' || error instanceof SyntaxError) {
        return next(new HttpError(400, 'Invalid Stripe webhook signature or payload'));
      }
      return next(error);
    }
  });

  app.use(express.json({ limit: '32kb', type: 'application/json' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: 'index.html',
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
  }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many login attempts; try again later' }
  });

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
    try {
      const email = requireText(req.body?.email, 'Email', 254).toLowerCase();
      const password = req.body?.password;
      if (!EMAIL_PATTERN.test(email) || typeof password !== 'string' || password.length > 200) {
        throw new HttpError(400, 'Valid email and password are required');
      }
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        throw new HttpError(401, 'Invalid email or password');
      }
      res.json({
        token: createToken(user),
        user: { id: user.id, name: user.name, email: user.email, role: user.role }
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/me', authenticate, (req, res) => {
    res.json({ user: req.user });
  });

  app.get('/api/clients', authenticate, requireRole('Admin'), (_req, res) => {
    const clients = db.prepare("SELECT id, name, email FROM users WHERE role = 'Client' ORDER BY name").all();
    res.json({ clients });
  });

  app.post('/api/clients', authenticate, requireRole('Admin'), async (req, res, next) => {
    try {
      const name = requireText(req.body?.name, 'Name', 120);
      const email = requireText(req.body?.email, 'Email', 254).toLowerCase();
      const password = req.body?.password;
      if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'A valid email is required');
      if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
        throw new HttpError(400, 'Client password must be at least 12 characters');
      }
      const id = newId();
      try {
        db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)')
          .run(id, email, name, await hashPassword(password), 'Client');
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, 'A user with that email already exists');
        throw error;
      }
      res.status(201).json({ client: { id, email, name } });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/summary', authenticate, requireRole('Admin'), (_req, res) => {
    const rows = db.prepare(`
      SELECT currency,
        SUM(amount_cents) AS invoiced_cents,
        SUM(CASE WHEN status = 'Paid' THEN amount_cents ELSE 0 END) AS paid_cents,
        SUM(CASE WHEN status IN ('Open', 'Pending') THEN amount_cents ELSE 0 END) AS outstanding_cents,
        COUNT(*) AS invoice_count
      FROM invoices WHERE status != 'Void' GROUP BY currency ORDER BY currency
    `).all();
    res.json({ byCurrency: rows });
  });

  app.get('/api/invoices', authenticate, (req, res) => {
    const invoices = req.user.role === 'Admin'
      ? db.prepare(`
          SELECT i.*, u.name AS client_name, u.email AS client_email
          FROM invoices i JOIN users u ON u.id = i.client_id ORDER BY i.created_at DESC
        `).all()
      : db.prepare('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ invoices: invoices.map(publicInvoice) });
  });

  app.post('/api/invoices', authenticate, requireRole('Admin'), (req, res, next) => {
    try {
      const clientId = requireText(req.body?.clientId, 'Client', 80);
      const description = requireText(req.body?.description, 'Description', 500);
      const amountCents = parseAmount(req.body?.amount);
      const currency = typeof req.body?.currency === 'string' ? req.body.currency.toUpperCase() : 'USD';
      if (!CURRENCIES.has(currency)) throw new HttpError(400, 'Currency is not supported');
      const issueDate = validDate(req.body?.issueDate, 'Issue date');
      const dueDate = validDate(req.body?.dueDate, 'Due date');
      if (dueDate < issueDate) throw new HttpError(400, 'Due date cannot be before issue date');
      const client = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'Client'").get(clientId);
      if (!client) throw new HttpError(400, 'A registered client is required');

      const id = newId();
      const invoiceNumber = `VP-${new Date().getUTCFullYear()}-${id.slice(0, 8).toUpperCase()}`;
      db.prepare(`
        INSERT INTO invoices
          (id, invoice_number, client_id, description, amount_cents, currency, issue_date, due_date, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Open')
      `).run(id, invoiceNumber, clientId, description, amountCents, currency, issueDate, dueDate);
      res.status(201).json({ invoice: publicInvoice(safeInvoice(db, req.user, id)) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/invoices/:id', authenticate, (req, res, next) => {
    try {
      res.json({ invoice: publicInvoice(safeInvoice(db, req.user, req.params.id)) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/invoices/:id/pdf', authenticate, (req, res, next) => {
    try {
      const invoice = safeInvoice(db, req.user, req.params.id);
      writeInvoicePdf(invoice, { name: invoice.client_name }, res);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/invoices/:id/receipt', authenticate, (req, res, next) => {
    try {
      const invoice = safeInvoice(db, req.user, req.params.id);
      if (invoice.status !== 'Paid' || invoice.receipt_status !== 'ready' || !invoice.receipt_path) {
        throw new HttpError(404, 'Receipt is not available');
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="receipt-${invoice.invoice_number.replace(/[^A-Za-z0-9_-]/g, '')}.pdf"`);
      res.sendFile(path.resolve(invoice.receipt_path), (error) => {
        if (error && !res.headersSent) next(new HttpError(404, 'Receipt is not available'));
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/payments/create-checkout-session', authenticate, requireRole('Client'), async (req, res, next) => {
    try {
      const invoiceId = requireText(req.body?.invoiceId, 'Invoice ID', 80);
      const result = await createCheckoutSession(db, req.user, invoiceId, process.env.CLIENT_URL, stripeClient);
      res.json(result);
    } catch (error) {
      if (error.status) return next(new HttpError(error.status, error.message));
      if (typeof error.type === 'string' && error.type.startsWith('Stripe')) {
        const status = error.type === 'StripeConnectionError' ? 503 : 502;
        return next(new HttpError(status, 'Payment provider is temporarily unavailable'));
      }
      return next(error);
    }
  });

  app.post('/api/admin/invoices/:id/retry-delivery', authenticate, requireRole('Admin'), async (req, res, next) => {
    try {
      const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
      if (!invoice) throw new HttpError(404, 'Invoice not found');
      if (invoice.status !== 'Paid') throw new HttpError(409, 'Only paid invoices can have delivery retried');
      if (invoice.email_status === 'sending') throw new HttpError(409, 'Email delivery outcome is pending reconciliation');
      db.prepare(`
        UPDATE invoices SET
          receipt_status = CASE WHEN receipt_status = 'failed' THEN 'pending' ELSE receipt_status END,
          email_status = CASE WHEN email_status IN ('failed', 'not_configured') THEN 'pending' ELSE email_status END
        WHERE id = ?
      `).run(invoice.id);
      await receiptFinalizer(db, invoice.id);
      res.json({ invoice: publicInvoice(safeInvoice(db, req.user, invoice.id)) });
    } catch (error) {
      next(error);
    }
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next(new HttpError(404, 'Not found'));
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    if (status >= 500) console.error('request_failed', { name: err.name, code: err.code || 'INTERNAL_ERROR' });
    if (res.headersSent) return;
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return app;
}

module.exports = { createApp, parseAmount };
