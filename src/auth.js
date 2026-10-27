const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { HttpError } = require('./errors');

const ISSUER = 'vaultpay';
const AUDIENCE = 'vaultpay-client';

function requireJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32 || secret === 'replace-with-a-random-secret-at-least-32-characters') {
    throw new Error('JWT_SECRET must be configured with a random value of at least 32 characters');
  }
  return secret;
}

function createToken(user) {
  return jwt.sign({ role: user.role }, requireJwtSecret(), {
    algorithm: 'HS256',
    subject: user.id,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: '1h'
  });
}

function authenticate(req, _res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  if (!match) return next(new HttpError(401, 'Authentication required'));

  try {
    const claims = jwt.verify(match[1], requireJwtSecret(), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE
    });
    const user = req.app.locals.db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(claims.sub);
    if (!user || user.role !== claims.role) throw new HttpError(401, 'Invalid authentication');
    req.user = user;
    return next();
  } catch (error) {
    if (error instanceof HttpError) return next(error);
    return next(new HttpError(401, 'Invalid or expired authentication'));
  }
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Forbidden'));
    return next();
  };
}

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function newId() {
  return crypto.randomUUID();
}

module.exports = {
  authenticate,
  createToken,
  hashPassword,
  newId,
  requireRole,
  requireJwtSecret,
  verifyPassword
};
