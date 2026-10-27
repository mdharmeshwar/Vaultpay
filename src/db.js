const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(databasePath = process.env.DATABASE_PATH || './data/vaultpay.sqlite') {
  const resolvedPath = databasePath === ':memory:' ? databasePath : path.resolve(databasePath);
  if (resolvedPath !== ':memory:') fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Admin', 'Client')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      invoice_number TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL REFERENCES users(id),
      description TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('Open', 'Pending', 'Paid', 'Void')),
      stripe_session_id TEXT UNIQUE,
      stripe_checkout_key TEXT,
      stripe_payment_intent_id TEXT,
      payment_confirmed_at TEXT,
      receipt_path TEXT,
      receipt_status TEXT NOT NULL DEFAULT 'pending' CHECK (receipt_status IN ('pending', 'ready', 'failed')),
      email_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'sending', 'sent', 'failed', 'not_configured')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS invoices_client_id_idx ON invoices(client_id);
    CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices(status);
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  db.transaction = (operation) => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(...args);
      if (result && typeof result.then === 'function') throw new Error('Database transactions must be synchronous');
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return db;
}

module.exports = { openDatabase };
