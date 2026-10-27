const nodemailer = require('nodemailer');
const { formatMoney } = require('./receipts');

function createTransport() {
  if (!process.env.SMTP_HOST || !process.env.MAIL_FROM) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a valid port');
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

async function sendReceiptEmail(invoice, client, receiptPath) {
  const transport = createTransport();
  if (!transport) return 'not_configured';

  await transport.sendMail({
    from: process.env.MAIL_FROM,
    to: client.email,
    subject: `Payment receipt for invoice ${invoice.invoice_number}`,
    text: `Hello ${client.name},\n\nWe have confirmed your payment of ${formatMoney(invoice.amount_cents, invoice.currency)} for invoice ${invoice.invoice_number}.\n\nYour PDF receipt is attached.\n`,
    attachments: [{ filename: `receipt-${invoice.invoice_number}.pdf`, path: receiptPath, contentType: 'application/pdf' }]
  });
  return 'sent';
}

module.exports = { sendReceiptEmail };
