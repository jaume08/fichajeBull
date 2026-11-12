'use strict';
/**
 * FASE 2 — Rondes NFC. Estructura preparada: es registra cada lectura de forma immutable
 * (marca temporal + geolocalització de suport) i es vincula al torn obert del vigilant.
 * La lògica completa de rondes (ordre, temps màxim, alertes de ronda incompleta) queda
 * per a la fase següent.
 */
const crypto = require('node:crypto');
const { insertChained } = require('./chain');
const { RuleError, effectiveEvents, stateAt } = require('./records');
const dbm = require('../db');

function recordRead(db, user, input, { now = new Date() } = {}) {
  const tag = String(input.tag_uid || '').trim().toUpperCase();
  if (!/^[0-9A-F:]{4,64}$/.test(tag)) throw new RuleError('INVALID_TAG', 'Identificador NFC no vàlid', { status: 400 });
  const uuid = input.uuid && /^[0-9a-f-]{16,64}$/i.test(input.uuid) ? input.uuid : crypto.randomUUID();
  const dup = db.prepare('SELECT * FROM nfc_reads WHERE uuid = ?').get(uuid);
  if (dup) return { read: dup, duplicate: true };
  let at = now;
  if (input.offline && input.device_time) {
    const skew = input.sent_at ? now - Date.parse(input.sent_at) : 0;
    at = new Date(Math.min(Date.parse(input.device_time) + (Number.isNaN(skew) ? 0 : skew), now.getTime()));
  }
  const st = stateAt(effectiveEvents(db, { userId: user.id }), at.toISOString());
  const cp = db.prepare('SELECT * FROM nfc_checkpoints WHERE tag_uid = ? AND active = 1').get(tag);
  const r = dbm.tx(db, () => insertChained(db, 'nfc_reads', {
    uuid, user_id: user.id, checkpoint_id: cp ? cp.id : null, tag_uid: tag,
    shift_id: st.openIn ? st.openIn.shift_id : null, report_id: null,
    occurred_at: at.toISOString(), received_at: now.toISOString(),
    lat: Number.isFinite(input.lat) ? input.lat : null, lng: Number.isFinite(input.lng) ? input.lng : null,
    accuracy_m: Number.isFinite(input.accuracy) ? input.accuracy : null,
  }));
  return { read: db.prepare('SELECT * FROM nfc_reads WHERE id = ?').get(r.id), duplicate: false, known_checkpoint: !!cp };
}

module.exports = { recordRead };
