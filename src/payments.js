const fs = require('node:fs');
const path = require('node:path');
const Stripe = require('stripe');
const { createReceipt } = require('./receipts');
const { sendReceiptEmail } = require('./mail');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !key.startsWith('sk_test_') || key === 'sk_test_replace_me') {
    const error = new Error('Stripe test-mode credentials are not configured');
    error.status = 503;
    throw error;
  }
  return new Stripe(key);
}

function checkoutUrl(value, label) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error();
    if (url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
}

function createCheckoutSession(db, user, invoiceId, clientUrl = process.env.CLIENT_URL, stripeClient) {
  const invoice = db.prepare(`
    SELECT i.*, u.email AS client_email
    FROM invoices i JOIN users u ON u.id = i.client_id
    WHERE i.id = ?
  `).get(invoiceId);
  if (!invoice) {
    const error = new Error('Invoice not found');
    error.status = 404;
    throw error;
  }
  if (user.role !== 'Admin' && invoice.client_id !== user.id) {
    const error = new Error('Forbidden');
    error.status = 403;
    throw error;
  }
  if (invoice.status === 'Paid' || invoice.status === 'Void') {
    const error = new Error('Invoice is not eligible for payment');
    error.status = 409;
    throw error;
  }

  const stripe = stripeClient || getStripe();
  const baseUrl = checkoutUrl(clientUrl, 'CLIENT_URL').replace(/\/$/, '');
  const updatePayment = db.transaction(() => {
    const latest = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!latest || latest.status === 'Paid' || latest.status === 'Void') {
      const error = new Error('Invoice is not eligible for payment');
      error.status = latest ? 409 : 404;
      throw error;
    }
    if (latest.status === 'Pending' && latest.stripe_session_id) return latest;
    if (latest.status === 'Pending' && latest.stripe_checkout_key) return latest;
    const key = require('node:crypto').randomUUID();
    db.prepare(`
      UPDATE invoices SET status = 'Pending', stripe_session_id = NULL,
        stripe_checkout_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status IN ('Open', 'Pending')
    `).run(key, invoiceId);
    return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  });
  let pending = updatePayment();

  if (pending.stripe_session_id) {
    return stripe.checkout.sessions.retrieve(pending.stripe_session_id)
      .then((existing) => {
        if (existing.status === 'open' && existing.url) return { id: existing.id, url: existing.url };
        if (existing.status !== 'expired') {
          const error = new Error('Existing payment attempt is still processing');
          error.status = 409;
          throw error;
        }
        db.prepare(`
          UPDATE invoices SET status = 'Open', stripe_session_id = NULL, stripe_checkout_key = NULL
          WHERE id = ? AND status = 'Pending' AND stripe_session_id = ?
        `).run(invoiceId, existing.id);
        return createCheckoutSession(db, user, invoiceId, clientUrl, stripeClient);
      });
  }

  const siteOrigin = new URL('/', baseUrl).origin;
  const successUrl = `${siteOrigin}/?checkout=success&invoice=${encodeURIComponent(invoiceId)}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${siteOrigin}/?checkout=cancel&invoice=${encodeURIComponent(invoiceId)}`;

  return stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: invoice.client_email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: invoice.currency.toLowerCase(),
        unit_amount: invoice.amount_cents,
        product_data: { name: `Invoice ${invoice.invoice_number}`, description: invoice.description }
      }
    }],
    metadata: { invoiceId, clientId: invoice.client_id },
    client_reference_id: invoiceId,
    success_url: successUrl,
    cancel_url: cancelUrl
  }, { idempotencyKey: `vaultpay-${invoiceId}-${pending.stripe_checkout_key}` })
    .then((session) => {
      const update = db.prepare(`
        UPDATE invoices SET stripe_session_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND status = 'Pending' AND stripe_checkout_key = ?
      `).run(session.id, invoiceId, pending.stripe_checkout_key);
      if (update.changes !== 1) {
        const error = new Error('Invoice payment state changed; request a fresh payment link');
        error.status = 409;
        throw error;
      }
      return { id: session.id, url: session.url };
    });
}

function readVerifiedEvent(req) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !secret.startsWith('whsec_') || secret === 'whsec_replace_me') {
    const error = new Error('Stripe webhook is not configured');
    error.status = 503;
    throw error;
  }
  return getStripe().webhooks.constructEvent(req.body, req.get('stripe-signature'), secret);
}

async function finalizeReceipt(
  db,
  invoiceId,
  receiptsDir = process.env.RECEIPTS_DIR || './data/receipts',
  mailer = sendReceiptEmail
) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND status = ?').get(invoiceId, 'Paid');
  if (!invoice) throw new Error('Paid invoice not found while finalizing receipt');
  const client = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(invoice.client_id);
  if (!client) throw new Error('Invoice client not found while finalizing receipt');
  const output = path.join(path.resolve(receiptsDir), `${invoice.id}.pdf`);

  try {
    if (invoice.receipt_status !== 'ready' || !invoice.receipt_path || !fs.existsSync(output)) {
      if (invoice.receipt_path && fs.existsSync(output)) {
        db.prepare("UPDATE invoices SET receipt_status = 'ready' WHERE id = ?").run(invoiceId);
      } else {
        const temporaryPath = `${output}.${require('node:crypto').randomUUID()}.tmp`;
        try {
          await createReceipt(invoice, client, invoice.stripe_payment_intent_id, temporaryPath);
          try {
            await fs.promises.rename(temporaryPath, output);
          } catch (error) {
            if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code) || !fs.existsSync(output)) throw error;
          }
        } finally {
          await fs.promises.rm(temporaryPath, { force: true });
        }
        db.prepare(`
          UPDATE invoices SET receipt_path = ?, receipt_status = 'ready',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?
        `).run(output, invoiceId);
      }
    }
  } catch (error) {
    db.prepare("UPDATE invoices SET receipt_status = 'failed' WHERE id = ?").run(invoiceId);
    console.error('receipt_generation_failed', { invoiceId, code: error.code || 'PDF_ERROR' });
    return;
  }

  const latest = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (latest.email_status === 'sent' || latest.email_status === 'sending' || latest.email_status === 'not_configured') return;
  const claim = db.prepare(`
    UPDATE invoices SET email_status = 'sending'
    WHERE id = ? AND email_status IN ('pending', 'failed')
  `).run(invoiceId);
  if (claim.changes !== 1) return;

  try {
    const status = await mailer(latest, client, output);
    db.prepare('UPDATE invoices SET email_status = ? WHERE id = ?').run(status, invoiceId);
  } catch (error) {
    db.prepare("UPDATE invoices SET email_status = 'failed' WHERE id = ?").run(invoiceId);
    console.error('receipt_email_failed', { invoiceId, code: error.code || 'SMTP_ERROR' });
  }
}

function processStripeEvent(db, event) {
  const eventType = event.type;
  const object = event.data && event.data.object;
  const transaction = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM stripe_events WHERE event_id = ?').get(event.id)) {
      return { duplicate: true, paidInvoiceId: null };
    }
    let paidInvoiceId = null;

    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(eventType)) {
      const invoiceId = object?.metadata?.invoiceId;
      const invoice = invoiceId && db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
      const paymentMatchesInvoice = invoice
        && object?.client_reference_id === invoice.id
        && object?.metadata?.clientId === invoice.client_id
        && object.amount_total === invoice.amount_cents
        && String(object.currency).toLowerCase() === invoice.currency.toLowerCase()
        && object.payment_status === 'paid';
      const matches = paymentMatchesInvoice && object.id === invoice.stripe_session_id;

      if (matches && invoice.status !== 'Paid') {
        const update = db.prepare(`
          UPDATE invoices SET status = 'Paid', stripe_payment_intent_id = ?,
            payment_confirmed_at = ?, receipt_status = 'pending', email_status = 'pending',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'Pending' AND stripe_session_id = ?
        `).run(
          typeof object.payment_intent === 'string' ? object.payment_intent : null,
          new Date(event.created * 1000).toISOString(),
          invoice.id,
          object.id
        );
        if (update.changes === 1) paidInvoiceId = invoice.id;
      } else if (paymentMatchesInvoice && invoice.status === 'Paid' && invoice.stripe_session_id !== object.id) {
        console.error('stripe_duplicate_successful_payment_requires_reconciliation', {
          eventId: event.id,
          invoiceId: invoice.id,
          sessionId: object.id
        });
      } else if (matches && invoice.status === 'Paid') {
        paidInvoiceId = invoice.id;
      } else if (!matches) {
        console.error('stripe_payment_verification_mismatch', {
          eventId: event.id,
          invoiceId: typeof invoiceId === 'string' ? invoiceId : null
        });
      }
    } else if (['checkout.session.async_payment_failed', 'checkout.session.expired'].includes(eventType)) {
      const invoiceId = object?.metadata?.invoiceId;
      const invoice = typeof invoiceId === 'string'
        ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId)
        : null;
      if (invoice && object?.client_reference_id === invoice.id && object?.metadata?.clientId === invoice.client_id) {
        db.prepare(`
          UPDATE invoices SET status = 'Open', stripe_session_id = NULL, stripe_checkout_key = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'Pending' AND stripe_session_id = ?
        `).run(invoiceId, object.id);
      }
    }

    db.prepare('INSERT INTO stripe_events (event_id) VALUES (?)').run(event.id);
    return { duplicate: false, paidInvoiceId };
  });
  return transaction();
}

module.exports = {
  createCheckoutSession,
  finalizeReceipt,
  getStripe,
  processStripeEvent,
  readVerifiedEvent
};
