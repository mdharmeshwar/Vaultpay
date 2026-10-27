const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

function formatMoney(cents, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() })
    .format(cents / 100);
}

function createReceipt(invoice, client, paymentReference, outputPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const doc = new PDFDocument({ size: 'LETTER', margin: 56 });
    const file = fs.createWriteStream(outputPath, { flags: 'wx' });
    file.once('error', reject);
    doc.once('error', reject);
    file.once('finish', resolve);
    doc.pipe(file);

    doc.fillColor('#142b4a').fontSize(21).font('Helvetica-Bold')
      .text('NEXUS CORPORATE SERVICES');
    doc.moveDown(0.35).fillColor('#14836d').fontSize(12).text('PAYMENT RECEIPT  |  PAID');
    doc.moveDown(1.7).fillColor('#142b4a').fontSize(11).font('Helvetica')
      .text(`Receipt: R-${invoice.invoice_number}`)
      .text(`Invoice: ${invoice.invoice_number}`)
      .text(`Client: ${client.name}`)
      .text(`Description: ${invoice.description}`)
      .text(`Payment date: ${invoice.payment_confirmed_at}`)
      .text(`Payment reference: ${paymentReference ? `${paymentReference.slice(0, 10)}...` : 'Stripe Checkout'}`);
    doc.moveDown(1.5).font('Helvetica-Bold').fontSize(18)
      .text(`Amount paid: ${formatMoney(invoice.amount_cents, invoice.currency)}`);
    doc.moveDown(2).font('Helvetica').fontSize(9).fillColor('#536579')
      .text('This receipt confirms a payment recorded by VaultPay after verification of the Stripe payment notification.');
    if (process.env.SUPPORT_EMAIL) doc.moveDown(0.5).text(`Support: ${process.env.SUPPORT_EMAIL}`);
    doc.end();
  });
}

function writeInvoicePdf(invoice, client, response) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 56 });
  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number.replace(/[^A-Za-z0-9_-]/g, '')}.pdf"`);
  doc.pipe(response);
  doc.fillColor('#142b4a').fontSize(21).font('Helvetica-Bold').text('NEXUS CORPORATE SERVICES');
  doc.moveDown(0.35).fillColor('#14836d').fontSize(12).text(`INVOICE  |  ${invoice.invoice_number}`);
  doc.moveDown(1.7).fillColor('#142b4a').fontSize(11).font('Helvetica')
    .text(`Bill to: ${client.name}`)
    .text(`Description: ${invoice.description}`)
    .text(`Issue date: ${invoice.issue_date}`)
    .text(`Due date: ${invoice.due_date}`)
    .text(`Status: ${invoice.status}`);
  doc.moveDown(1.5).font('Helvetica-Bold').fontSize(18)
    .text(`Total: ${formatMoney(invoice.amount_cents, invoice.currency)}`);
  if (invoice.status === 'Paid') doc.moveDown(0.8).fillColor('#14836d').text('PAID');
  doc.end();
}

module.exports = { createReceipt, formatMoney, writeInvoicePdf };
