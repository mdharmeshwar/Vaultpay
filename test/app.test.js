const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { createApp } = require('../src/app');
const { hashPassword, newId } = require('../src/auth');
const { openDatabase } = require('../src/db');
const { finalizeReceipt } = require('../src/payments');

process.env.JWT_SECRET = 'test-secret-value-that-is-at-least-thirty-two-characters';
process.env.STRIPE_SECRET_KEY = 'sk_test_vaultpay_test_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_vaultpay_test_secret';
process.env.CLIENT_URL = 'http://localhost:3000';

let db;
let app;
let admin;
let clientA;
let clientB;
let invoiceA;
let invoiceB;
let receiptDirectory;
let checkoutRequests;
let stripeClient;
const password = 'correct-horse-battery-staple';

function insertInvoice(clientId, status = 'Open') {
  const id = newId();
  const invoiceNumber = `VP-TEST-${id.slice(0, 8)}`;
  db.prepare(`
    INSERT INTO invoices
      (id, invoice_number, client_id, description, amount_cents, currency, issue_date, due_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, invoiceNumber, clientId, 'Test consulting services', 1540, 'USD', '2026-10-01', '2026-10-31', status);
  return id;
}

async function tokenFor(email) {
  const response = await request(app).post('/api/auth/login').send({ email, password });
  assert.equal(response.status, 200);
  return response.body.token;
}

function signedEvent(event) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  return { rawBody, signature: `t=${timestamp},v1=${digest}` };
}

async function postWebhook(event, signatureOverride) {
  const signed = signedEvent(event);
  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', signatureOverride || signed.signature)
    .send(signed.rawBody.toString('utf8'));
}

before(async () => {
  receiptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultpay-test-'));
  process.env.RECEIPTS_DIR = receiptDirectory;
  db = openDatabase(':memory:');
  const adminPassword = await hashPassword(password);
  const clientPassword = await hashPassword(password);
  admin = { id: newId(), email: 'admin@example.test', name: 'Test Admin' };
  clientA = { id: newId(), email: 'a@example.test', name: 'Client A' };
  clientB = { id: newId(), email: 'b@example.test', name: 'Client B' };
  const insertUser = db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  insertUser.run(admin.id, admin.email, admin.name, adminPassword, 'Admin');
  insertUser.run(clientA.id, clientA.email, clientA.name, clientPassword, 'Client');
  insertUser.run(clientB.id, clientB.email, clientB.name, clientPassword, 'Client');
  invoiceA = insertInvoice(clientA.id);
  invoiceB = insertInvoice(clientB.id);
  checkoutRequests = [];
  stripeClient = {
    checkout: {
      sessions: {
        create: async (params, options) => {
          checkoutRequests.push({ params, options });
          return { id: 'cs_test_mock_session', url: 'https://checkout.stripe.com/c/pay/cs_test_mock_session' };
        },
        retrieve: async (id) => ({
          id,
          status: 'open',
          url: 'https://checkout.stripe.com/c/pay/cs_test_mock_session'
        })
      }
    }
  };
  app = createApp({ db, stripeClient });
});

after(() => {
  db.close();
  fs.rmSync(receiptDirectory, { recursive: true, force: true });
});

test('requires authentication and enforces roles and invoice ownership', async () => {
  assert.equal((await request(app).get('/api/invoices')).status, 401);
  assert.equal((await request(app).get('/api/invoices').set('Authorization', 'Bearer invalid')).status, 401);
  const expiredToken = jwt.sign({ role: 'Client' }, process.env.JWT_SECRET, {
    subject: clientA.id, issuer: 'vaultpay', audience: 'vaultpay-client', expiresIn: '-1s'
  });
  assert.equal((await request(app).get('/api/invoices').set('Authorization', `Bearer ${expiredToken}`)).status, 401);
  const adminToken = await tokenFor(admin.email);
  const clientToken = await tokenFor(clientA.email);

  const ownList = await request(app).get('/api/invoices').set('Authorization', `Bearer ${clientToken}`);
  assert.equal(ownList.status, 200);
  assert.deepEqual(ownList.body.invoices.map((item) => item.id), [invoiceA]);

  for (const endpoint of [
    `/api/invoices/${invoiceB}`,
    `/api/invoices/${invoiceB}/pdf`,
    `/api/invoices/${invoiceB}/receipt`
  ]) {
    assert.equal((await request(app).get(endpoint).set('Authorization', `Bearer ${clientToken}`)).status, 403);
  }
  assert.equal((await request(app).get('/api/admin/summary').set('Authorization', `Bearer ${clientToken}`)).status, 403);
  assert.equal((await request(app).post('/api/invoices').set('Authorization', `Bearer ${clientToken}`).send({})).status, 403);
  assert.equal((await request(app).post('/api/payments/create-checkout-session')
    .set('Authorization', `Bearer ${clientToken}`).send({ invoiceId: invoiceB })).status, 403);

  const created = await request(app).post('/api/invoices')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      clientId: clientA.id, description: 'Validated invoice', amount: '15.40',
      currency: 'USD', issueDate: '2026-10-27', dueDate: '2026-11-27', status: 'Paid'
    });
  assert.equal(created.status, 201);
  assert.equal(created.body.invoice.amount_cents, 1540);
  assert.equal(created.body.invoice.status, 'Open');
});

test('rejects missing and invalid Stripe signatures without changing payment state', async () => {
  db.prepare("UPDATE invoices SET status = 'Pending', stripe_session_id = ?, stripe_checkout_key = ? WHERE id = ?")
    .run('cs_test_invalid_sig', 'attempt-invalid-sig', invoiceA);
  const event = {
    id: 'evt-invalid-signature',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'cs_test_invalid_sig', client_reference_id: invoiceA, payment_status: 'paid', currency: 'usd', amount_total: 1540, metadata: { invoiceId: invoiceA, clientId: clientA.id } } }
  };
  const missing = await request(app).post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
  .send(JSON.stringify(event));
  assert.equal(missing.status, 400);
  const bad = await request(app).post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', 't=1,v1=invalid')
    .send(JSON.stringify(event));
  assert.equal(bad.status, 400);
  const signed = signedEvent(event);
  const tampered = { ...event, data: { object: { ...event.data.object, amount_total: 1 } } };
  const tamperedResponse = await request(app).post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', signed.signature)
    .send(JSON.stringify(tampered));
  assert.equal(tamperedResponse.status, 400);
  const row = db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoiceA);
  assert.equal(row.status, 'Pending');
});

test('creates an idempotent Checkout session using only the persisted invoice amount', async () => {
  db.prepare("UPDATE invoices SET status = 'Open', stripe_session_id = NULL, stripe_checkout_key = NULL WHERE id = ?")
    .run(invoiceA);
  const clientToken = await tokenFor(clientA.email);
  const first = await request(app).post('/api/payments/create-checkout-session')
    .set('Authorization', `Bearer ${clientToken}`)
    .send({ invoiceId: invoiceA, amount: '0.01', amountCents: 1, clientId: clientB.id });
  assert.equal(first.status, 200);
  assert.equal(checkoutRequests.length, 1);
  assert.equal(checkoutRequests[0].params.line_items[0].price_data.unit_amount, 1540);
  assert.equal(checkoutRequests[0].params.line_items[0].price_data.currency, 'usd');
  assert.equal(checkoutRequests[0].params.customer_email, clientA.email);
  assert.match(checkoutRequests[0].options.idempotencyKey, new RegExp(invoiceA));
  assert.equal(checkoutRequests[0].params.metadata.invoiceId, invoiceA);
  assert.match(checkoutRequests[0].params.success_url, new RegExp(`invoice=${invoiceA}`));
  assert.match(checkoutRequests[0].params.success_url, /\{CHECKOUT_SESSION_ID\}/);

  const second = await request(app).post('/api/payments/create-checkout-session')
    .set('Authorization', `Bearer ${clientToken}`)
    .send({ invoiceId: invoiceA });
  assert.equal(second.status, 200);
  assert.equal(checkoutRequests.length, 1);
  assert.equal(second.body.id, first.body.id);

  const clientBToken = await tokenFor(clientB.email);
  for (const status of ['Paid', 'Void']) {
    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoiceB);
    const rejected = await request(app).post('/api/payments/create-checkout-session')
      .set('Authorization', `Bearer ${clientBToken}`).send({ invoiceId: invoiceB });
    assert.equal(rejected.status, 409);
  }
  assert.equal(checkoutRequests.length, 1);
});

test('only a matching verified paid event updates the invoice and creates one private receipt', async () => {
  const sessionId = 'cs_test_verified_payment';
  db.prepare("UPDATE invoices SET status = 'Pending', stripe_session_id = ?, stripe_checkout_key = ? WHERE id = ?")
    .run(sessionId, 'attempt-verified', invoiceA);
  const event = {
    id: 'evt-verified-payment',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        client_reference_id: invoiceA,
        payment_status: 'paid',
        currency: 'usd',
        amount_total: 9999,
        payment_intent: 'pi_test_verified',
        metadata: { invoiceId: invoiceA, clientId: clientA.id }
      }
    }
  };
  const mismatchedAmountResponse = await postWebhook(event);
  assert.equal(mismatchedAmountResponse.status, 200, JSON.stringify(mismatchedAmountResponse.body));
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoiceA).status, 'Pending');

  const mismatchedCurrencyEvent = {
    ...event,
    id: 'evt-verified-payment-wrong-currency',
    data: { object: { ...event.data.object, amount_total: 1540, currency: 'eur' } }
  };
  assert.equal((await postWebhook(mismatchedCurrencyEvent)).status, 200);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoiceA).status, 'Pending');

  const unrelatedEvent = { ...event, id: 'evt-unrelated-payment-event', type: 'payment_intent.succeeded' };
  assert.equal((await postWebhook(unrelatedEvent)).status, 200);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoiceA).status, 'Pending');

  const validEvent = {
    ...event,
    id: 'evt-verified-payment-correct-amount',
    data: { object: { ...event.data.object, amount_total: 1540 } }
  };
  const validPaymentResponse = await postWebhook(validEvent);
  assert.equal(validPaymentResponse.status, 200, JSON.stringify(validPaymentResponse.body));
  const paid = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceA);
  assert.equal(paid.status, 'Paid');
  assert.equal(paid.receipt_status, 'ready');
  assert.equal(paid.email_status, 'not_configured');
  assert.equal(fs.existsSync(paid.receipt_path), true);

  const clientToken = await tokenFor(clientA.email);
  const receipt = await request(app).get(`/api/invoices/${invoiceA}/receipt`)
    .set('Authorization', `Bearer ${clientToken}`);
  assert.equal(receipt.status, 200);
  assert.match(receipt.headers['content-type'], /application\/pdf/);
  assert.equal(receipt.body.subarray(0, 5).toString(), '%PDF-');

  const repeats = await postWebhook(validEvent);
  assert.equal(repeats.status, 200);
  assert.equal(db.prepare('SELECT count(*) AS count FROM stripe_events WHERE event_id = ?')
    .get(validEvent.id).count, 1);
});

test('email failures preserve paid status and controlled retries do not duplicate successful sends', async () => {
  db.prepare(`
    UPDATE invoices SET status = 'Paid', payment_confirmed_at = ?, stripe_payment_intent_id = ? WHERE id = ?
  `).run(new Date().toISOString(), 'pi_email_failure_test', invoiceB);
  let sendCount = 0;
  await finalizeReceipt(db, invoiceB, receiptDirectory, async () => {
    sendCount += 1;
    const error = new Error('test SMTP failure');
    error.code = 'ECONNECTION';
    throw error;
  });
  let invoice = db.prepare('SELECT status, receipt_status, email_status FROM invoices WHERE id = ?').get(invoiceB);
  assert.equal(invoice.status, 'Paid');
  assert.equal(invoice.receipt_status, 'ready');
  assert.equal(invoice.email_status, 'failed');

  await finalizeReceipt(db, invoiceB, receiptDirectory, async () => {
    sendCount += 1;
    return 'sent';
  });
  await finalizeReceipt(db, invoiceB, receiptDirectory, async () => {
    sendCount += 1;
    return 'sent';
  });
  invoice = db.prepare('SELECT status, email_status FROM invoices WHERE id = ?').get(invoiceB);
  assert.equal(invoice.status, 'Paid');
  assert.equal(invoice.email_status, 'sent');
  assert.equal(sendCount, 2);
});
