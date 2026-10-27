require('dotenv').config();
const { openDatabase } = require('./db');
const { hashPassword, newId } = require('./auth');

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const name = process.env.ADMIN_NAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !name || !password || password.length < 12) {
    throw new Error('Set ADMIN_EMAIL, ADMIN_NAME, and ADMIN_PASSWORD (at least 12 characters) before seeding');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL is invalid');
  const db = openDatabase();
  try {
    const id = newId();
    db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .run(id, email.toLowerCase(), name, await hashPassword(password), 'Admin');
    console.log(`Administrator created: ${email.toLowerCase()}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
