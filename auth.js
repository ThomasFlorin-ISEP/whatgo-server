// ============================================================
// auth.js — Authentification : comptes, mots de passe, rôles
// ============================================================
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '7d';

if (!JWT_SECRET) {
  console.warn('⚠️  ATTENTION : JWT_SECRET n\'est pas défini.');
}

async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, 12);
}

async function verifyPassword(plainPassword, hash) {
  return bcrypt.compare(plainPassword, hash);
}

function signToken(user) {
  return jwt.sign(
    { userId: user.id, businessId: user.business_id, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function requireAuth(req, res, next) {
  const token = req.cookies?.whatgo_token;
  if (!token) return res.status(401).json({ error: 'Non connecté.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expirée, reconnecte-toi.' });
  }
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (minRole === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Action réservée aux administrateurs.' });
    }
    next();
  };
}

module.exports = { hashPassword, verifyPassword, signToken, requireAuth, requireRole };
