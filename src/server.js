require('dotenv').config();
const { openDatabase } = require('./db');
const { createApp } = require('./app');

const db = openDatabase();
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port');
const app = createApp({ db });
const server = app.listen(port, () => {
  console.log(`VaultPay listening on port ${port}`);
});

function close() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
