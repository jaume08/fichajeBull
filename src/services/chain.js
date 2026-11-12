'use strict';
/**
 * Cadena de hash per a taules immutables. Cada registre inclou el hash de l'anterior
 * de la mateixa taula; alterar qualsevol fila fora de l'aplicació trenca la cadena.
 */
const crypto = require('node:crypto');

const GENESIS = '0'.repeat(64);

function canonical(obj) {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(keys.map(k => [k, obj[k] === undefined ? null : obj[k]]));
}

function computeHash(prevHash, payload) {
  return crypto.createHash('sha256').update(prevHash + '|' + canonical(payload)).digest('hex');
}

function lastHash(db, table) {
  const row = db.prepare(`SELECT hash FROM ${table} ORDER BY id DESC LIMIT 1`).get();
  return row ? row.hash : GENESIS;
}

/** Insereix una fila calculant prev_hash i hash. S'ha de cridar dins d'una transacció. */
function insertChained(db, table, payload) {
  const prev_hash = lastHash(db, table);
  const hash = computeHash(prev_hash, payload);
  const cols = [...Object.keys(payload), 'prev_hash', 'hash'];
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const vals = [...Object.values(payload), prev_hash, hash].map(v => (v === undefined ? null : v));
  const info = db.prepare(sql).run(...vals);
  return { id: Number(info.lastInsertRowid), hash, prev_hash };
}

/** Verifica la integritat d'una taula encadenada. */
function verify(db, table) {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  let prev = rows.length ? rows[0].prev_hash : GENESIS; // tolera purga per retenció
  for (const row of rows) {
    const { id, prev_hash, hash, ...payload } = row;
    if (prev_hash !== prev) return { ok: false, table, brokenAt: id, reason: 'prev_hash no coincideix' };
    if (computeHash(prev_hash, payload) !== hash) return { ok: false, table, brokenAt: id, reason: 'contingut alterat' };
    prev = hash;
  }
  return { ok: true, table, count: rows.length };
}

module.exports = { GENESIS, computeHash, insertChained, verify, canonical };
