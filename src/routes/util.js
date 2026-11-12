'use strict';
const { RuleError } = require('../services/records');

/** Embolcall per a handlers: converteix errors de regla de negoci en respostes JSON. */
const h = fn => async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) {
    if (e instanceof RuleError) return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra, status: undefined });
    if (String(e.message).includes('REGISTRE_IMMUTABLE')) return res.status(409).json({ error: e.message, code: 'IMMUTABLE' });
    next(e);
  }
};

const ip = req => req.ip || req.socket?.remoteAddress || null;
const isMonth = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '');
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

module.exports = { h, ip, isMonth, isDate };
