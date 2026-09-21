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

// Un compte super-admin n'appartient à aucune entreprise (businessId: null).
function signToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      businessId: user.business_id ?? null,
      role: user.role,
    },
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

// requireRole('admin') → uniquement les admins de l'entreprise cliente.
// requireRole(['admin', 'super_admin']) → plusieurs rôles acceptés.
function requireRole(allowed) {
  const roles = Array.isArray(allowed) ? allowed : [allowed];
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Action non autorisée pour ce compte.' });
    }
    next();
  };
}

function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Réservé à l\'équipe WHATGO.' });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  requireRole,
  requireSuperAdmin,
};
