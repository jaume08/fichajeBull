'use strict';
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const dbm = require('./db');

const SECRET = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') throw new Error('Cal definir JWT_SECRET en producció');
  return crypto.randomBytes(32).toString('hex');
})();
const TTL = process.env.JWT_TTL || '14h';

const ROLES = {
  vigilant: ['worker'],
  cecoa: ['worker', 'dashboard', 'reports.read'],
  operacions: ['worker', 'dashboard', 'reports.read', 'reports.send', 'shifts.write', 'sites.write'],
  rrhh: ['worker', 'dashboard', 'reports.read', 'reports.send', 'shifts.write', 'records.correct', 'hours', 'export', 'users.write', 'audit'],
  admin: ['worker', 'dashboard', 'reports.read', 'reports.send', 'shifts.write', 'sites.write', 'records.correct', 'hours', 'export', 'users.write', 'audit', 'settings'],
};

function can(role, perm) { return (ROLES[role] || []).includes(perm); }

function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }

// Limitació d'intents d'accés (força bruta) per TIP + IP
const attempts = new Map();
function throttled(key) {
  const a = attempts.get(key);
  return a && a.count >= 5 && Date.now() - a.first < 15 * 60e3;
}
function fail(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > 15 * 60e3) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}

function login(tip, password, ip) {
  const key = `${String(tip).toUpperCase()}|${ip}`;
  if (throttled(key)) return { error: 'Massa intents. Torna-ho a provar d\'aquí a 15 minuts.', status: 429 };
  const user = dbm.get().prepare('SELECT * FROM users WHERE upper(tip) = upper(?) AND active = 1').get(String(tip || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    fail(key);
    return { error: 'TIP o contrasenya incorrectes', status: 401 };
  }
  attempts.delete(key);
  const token = jwt.sign({ sub: user.id, role: user.role, tip: user.tip }, SECRET, { expiresIn: TTL });
  return { token, user: publicUser(user) };
}

function publicUser(u) {
  return { id: u.id, tip: u.tip, name: u.name, role: u.role, permissions: ROLES[u.role] || [] };
}

function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.access_token || null);
  if (!token) return res.status(401).json({ error: 'No autenticat' });
  try {
    const p = jwt.verify(token, SECRET);
    const user = dbm.get().prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(p.sub);
    if (!user) return res.status(401).json({ error: 'Usuari inactiu' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Sessió caducada' });
  }
}

function require_(perm) {
  return (req, res, next) => (can(req.user.role, perm) ? next() : res.status(403).json({ error: 'Sense permisos' }));
}

module.exports = { login, authenticate, require: require_, can, hashPassword, publicUser, ROLES };
