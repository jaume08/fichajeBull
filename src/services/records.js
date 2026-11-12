'use strict';
/**
 * Registre de jornada: creació de fitxatges, correccions auditades i
 * càlcul dels esdeveniments "efectius" (base + correccions).
 */
const crypto = require('node:crypto');
const { insertChained } = require('./chain');
const geo = require('./geo');
const audit = require('./audit');
const dbm = require('../db');

const TYPES = ['IN', 'OUT', 'BREAK_START', 'BREAK_END'];
const LATE_REASONS = {
  ESPERA_RELLEU: 'Espera de relleu',
  INCIDENCIA_SERVEI: 'Incidència en el servei',
  ORDRE_SUPERIOR: 'Ordre del superior / CECOA',
  ALTRES: 'Altres (especificar)',
};
const MAX_OFFLINE_DAYS = 7;

class RuleError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.status = extra.status || 422;
    this.extra = extra;
  }
}

/** Aplica les correccions als esdeveniments base. Retorna només els vigents. */
function effectiveEvents(db, { userId, from, to, includeAnnulled = false }) {
  const params = [];
  let where = '1=1';
  if (userId) { where += ' AND e.user_id = ?'; params.push(userId); }
  const rows = db.prepare(`SELECT e.* FROM time_events e WHERE ${where} ORDER BY e.id`).all(...params);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const corr = db.prepare(
    `SELECT * FROM corrections WHERE event_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`
  ).all(...ids);
  const byEvent = new Map();
  for (const c of corr) {
    if (!byEvent.has(c.event_id)) byEvent.set(c.event_id, []);
    byEvent.get(c.event_id).push(c);
  }
  const out = [];
  for (const r of rows) {
    const ev = { ...r, corrected: false, annulled: false, corrections: [] };
    for (const c of byEvent.get(r.id) || []) {
      ev.corrections.push({ id: c.id, action: c.action, reason: c.reason, author_id: c.author_id, created_at: c.created_at });
      if (c.action === 'annul') ev.annulled = true;
      if (c.action === 'modify') { Object.assign(ev, JSON.parse(c.new_values)); ev.corrected = true; }
    }
    if (ev.annulled && !includeAnnulled) continue;
    if (from && ev.occurred_at < from) continue;
    if (to && ev.occurred_at >= to) continue;
    out.push(ev);
  }
  out.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.id - b.id));
  return out;
}

/** Estat del treballador (off/working/break) just abans d'un instant. */
function stateAt(events, atIso) {
  let state = 'off'; let openIn = null; let openBreak = null;
  for (const e of events) {
    if (e.occurred_at > atIso) break;
    if (e.type === 'IN') { state = 'working'; openIn = e; openBreak = null; }
    else if (e.type === 'BREAK_START' && state === 'working') { state = 'break'; openBreak = e; }
    else if (e.type === 'BREAK_END' && state === 'break') { state = 'working'; openBreak = null; }
    else if (e.type === 'OUT') { state = 'off'; openIn = null; openBreak = null; }
  }
  return { state, openIn, openBreak };
}

const ALLOWED = {
  IN: ['off'],
  BREAK_START: ['working'],
  BREAK_END: ['break'],
  OUT: ['working', 'break'],
};

function findShiftForIn(db, userId, atIso) {
  const at = new Date(atIso).getTime();
  const candidates = db.prepare(
    `SELECT * FROM shifts WHERE user_id = ? AND status = 'planned'
       AND planned_start <= ? AND planned_end >= ?`
  ).all(userId, new Date(at + 4 * 3600e3).toISOString(), atIso);
  if (!candidates.length) return null;
  candidates.sort((a, b) => Math.abs(new Date(a.planned_start) - at) - Math.abs(new Date(b.planned_start) - at));
  return candidates[0];
}

/**
 * Registra un fitxatge. `input`:
 *  uuid, type, offline(bool), device_time, sent_at, lat, lng, accuracy, location_status,
 *  justification, late_reason, late_reason_text, cannot_leave_post(bool), site_id
 */
function createEvent(db, user, input, { now = new Date() } = {}) {
  const S = dbm.settings(db);
  if (!TYPES.includes(input.type)) throw new RuleError('INVALID_TYPE', 'Tipus de fitxatge no vàlid', { status: 400 });
  const uuid = input.uuid && /^[0-9a-f-]{16,64}$/i.test(input.uuid) ? input.uuid : crypto.randomUUID();

  const existing = db.prepare('SELECT * FROM time_events WHERE uuid = ?').get(uuid);
  if (existing) {
    if (existing.user_id !== user.id) throw new RuleError('UUID_CONFLICT', 'Identificador duplicat', { status: 409 });
    return { event: existing, duplicate: true, warnings: [] };
  }

  const offline = !!input.offline;
  const review = [];
  const warnings = [];
  const receivedAt = now.toISOString();
  let occurredAt = receivedAt;

  // Hora real: en mode offline s'utilitza l'hora del dispositiu corregida pel desfasament
  // del seu rellotge (mesurat en el moment de l'enviament: sent_at vs. hora del servidor).
  if (offline) {
    const dev = Date.parse(input.device_time);
    const sent = Date.parse(input.sent_at);
    if (Number.isNaN(dev)) throw new RuleError('INVALID_TIME', 'Hora del dispositiu no vàlida', { status: 400 });
    const skew = Number.isNaN(sent) ? 0 : now.getTime() - sent;
    let t = dev + skew;
    if (t > now.getTime()) { t = now.getTime(); review.push('Hora futura ajustada a hora del servidor'); }
    if (now.getTime() - t > MAX_OFFLINE_DAYS * 86400e3) review.push(`Fitxatge offline sincronitzat amb més de ${MAX_OFFLINE_DAYS} dies de retard`);
    if (Math.abs(skew) > 5 * 60e3) review.push(`Rellotge del dispositiu desfasat ${Math.round(skew / 60e3)} min`);
    occurredAt = new Date(t).toISOString();
  }

  // Validació de seqüència
  const events = effectiveEvents(db, { userId: user.id });
  const st = stateAt(events, occurredAt);
  if (!ALLOWED[input.type].includes(st.state)) {
    const msg = `No es pot registrar ${input.type} en estat "${st.state}"`;
    if (!offline) throw new RuleError('INVALID_SEQUENCE', msg, { status: 409, state: st.state });
    review.push(msg + ' (sincronització offline)');
  }

  // Torn i instal·lació
  let shift = null; let siteId = null;
  if (input.type === 'IN') {
    shift = findShiftForIn(db, user.id, occurredAt);
    siteId = shift ? shift.site_id : (input.site_id ? Number(input.site_id) : null);
    if (!shift) review.push('Entrada sense torn planificat al quadrant');
  } else if (st.openIn) {
    siteId = st.openIn.site_id;
    shift = st.openIn.shift_id ? db.prepare('SELECT * FROM shifts WHERE id = ?').get(st.openIn.shift_id) : null;
  }
  const site = siteId ? db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId) : null;
  if (input.type === 'IN' && !site) throw new RuleError('SITE_REQUIRED', 'Cal indicar la instal·lació (no hi ha torn assignat)', { status: 422 });

  // Geolocalització puntual (només en aquest instant; mai rastreig continu)
  const hasCoords = Number.isFinite(input.lat) && Number.isFinite(input.lng);
  let locationStatus = hasCoords ? 'ok' : (['denied', 'unavailable'].includes(input.location_status) ? input.location_status : 'unavailable');
  let distance = null; let within = null;
  const justification = (input.justification || '').trim() || null;
  if (site && hasCoords) {
    const g = geo.evaluate(site, input.lat, input.lng, input.accuracy);
    distance = g.distance; within = g.within === null ? null : (g.within ? 1 : 0);
  }
  if (site && site.lat == null) locationStatus = hasCoords ? 'ok' : 'not_applicable';
  const outside = within === 0;
  const noLocation = locationStatus === 'unavailable' || locationStatus === 'denied';
  if ((outside || noLocation) && !justification) {
    if (S.geofence_policy === 'justify' && !offline) {
      throw new RuleError(outside ? 'GEOFENCE_JUSTIFICATION_REQUIRED' : 'LOCATION_JUSTIFICATION_REQUIRED',
        outside ? `Ets a ${distance} m de la instal·lació (radi ${site.radius_m} m). Cal justificar el fitxatge.`
                : 'No s\'ha pogut obtenir la ubicació. Cal justificar el fitxatge.',
        { distance, radius: site ? site.radius_m : null });
    }
    if (outside) warnings.push(`Fitxatge fora del radi (${distance} m)`);
  }
  if (outside) review.push(`Fora de radi: ${distance} m (radi ${site.radius_m} m)`);
  if (noLocation && site && site.lat != null) review.push('Fitxatge sense geolocalització');

  // Prolongació de jornada (demora de relleu)
  let lateMinutes = null; let lateReason = null; let lateReasonText = null;
  const lateTol = Number(S.late_tolerance_min);
  if (input.type === 'OUT' && shift) {
    const diffMin = Math.floor((Date.parse(occurredAt) - Date.parse(shift.planned_end)) / 60e3);
    if (diffMin > lateTol) {
      lateMinutes = diffMin;
      lateReason = LATE_REASONS[input.late_reason] ? input.late_reason : null;
      lateReasonText = (input.late_reason_text || '').trim() || null;
      if (!lateReason || (lateReason === 'ALTRES' && !lateReasonText)) {
        if (!offline) {
          throw new RuleError('LATE_REASON_REQUIRED',
            `Sortida ${diffMin} min després de l'hora prevista. Selecciona el motiu de la prolongació.`,
            { late_minutes: diffMin, reasons: LATE_REASONS });
        }
        review.push('Prolongació sense motiu (offline)');
      }
    } else if (diffMin < -lateTol) {
      review.push(`Sortida anticipada (${-diffMin} min abans)`);
    }
  }
  if (input.type === 'IN' && shift) {
    const diffMin = Math.floor((Date.parse(occurredAt) - Date.parse(shift.planned_start)) / 60e3);
    if (diffMin > lateTol) warnings.push(`Entrada amb ${diffMin} min de retard`);
  }

  // Pausa: computa com a treball efectiu si el vigilant no pot abandonar el lloc
  let breakPaid = null; let breakPaidReason = null;
  if (input.type === 'BREAK_START') {
    if (site && site.solo_post) { breakPaid = 1; breakPaidReason = 'Lloc unipersonal: no es pot abandonar el servei'; }
    else if (input.cannot_leave_post) { breakPaid = 1; breakPaidReason = 'El vigilant declara que no pot abandonar el lloc'; }
    else breakPaid = 0;
  }

  const payload = {
    uuid, user_id: user.id, site_id: siteId, shift_id: shift ? shift.id : null, type: input.type,
    occurred_at: occurredAt, device_time: input.device_time || null, received_at: receivedAt,
    origin: offline ? 'offline' : 'online',
    lat: hasCoords ? input.lat : null, lng: hasCoords ? input.lng : null,
    accuracy_m: Number.isFinite(input.accuracy) ? input.accuracy : null,
    location_status: locationStatus, distance_m: distance, within_geofence: within,
    justification, late_reason: lateReason, late_reason_text: lateReasonText, late_minutes: lateMinutes,
    break_paid: breakPaid, break_paid_reason: breakPaidReason,
    needs_review: review.length ? 1 : 0, review_reasons: review.length ? JSON.stringify(review) : null,
  };
  const r = dbm.tx(db, () => insertChained(db, 'time_events', payload));
  const event = db.prepare('SELECT * FROM time_events WHERE id = ?').get(r.id);
  return { event, duplicate: false, warnings: [...warnings, ...review] };
}

const CORRECTABLE = ['occurred_at', 'type', 'break_paid', 'late_reason', 'late_reason_text', 'site_id', 'shift_id'];

/** Correcció auditada: no modifica el registre original, n'afegeix una anotació. */
function correctEvent(db, author, { action, eventId, changes = {}, reason, ip, newEvent }) {
  if (!reason || reason.trim().length < 10) throw new RuleError('REASON_REQUIRED', 'Cal un motiu justificat (mínim 10 caràcters)', { status: 400 });
  return dbm.tx(db, () => {
    let targetId = eventId; let oldValues = null; let newValues = null;
    if (action === 'add') {
      if (!newEvent || !TYPES.includes(newEvent.type) || Number.isNaN(Date.parse(newEvent.occurred_at)) || !newEvent.user_id) {
        throw new RuleError('INVALID_EVENT', 'Dades del fitxatge a afegir incompletes', { status: 400 });
      }
      const payload = {
        uuid: crypto.randomUUID(), user_id: Number(newEvent.user_id), site_id: newEvent.site_id ? Number(newEvent.site_id) : null,
        shift_id: newEvent.shift_id ? Number(newEvent.shift_id) : null, type: newEvent.type,
        occurred_at: new Date(newEvent.occurred_at).toISOString(), device_time: null, received_at: new Date().toISOString(),
        origin: 'admin', lat: null, lng: null, accuracy_m: null, location_status: 'not_applicable', distance_m: null,
        within_geofence: null, justification: reason.trim(), late_reason: newEvent.late_reason || null, late_reason_text: null,
        late_minutes: null, break_paid: newEvent.type === 'BREAK_START' ? (newEvent.break_paid ? 1 : 0) : null,
        break_paid_reason: null, needs_review: 0, review_reasons: null,
      };
      targetId = insertChained(db, 'time_events', payload).id;
      newValues = JSON.stringify(payload);
    } else {
      const base = db.prepare('SELECT user_id FROM time_events WHERE id = ?').get(Number(eventId));
      const ev = base && effectiveEvents(db, { userId: base.user_id, includeAnnulled: true }).find(e => e.id === Number(eventId));
      if (!ev) throw new RuleError('NOT_FOUND', 'Registre no trobat', { status: 404 });
      if (ev.annulled) throw new RuleError('ANNULLED', 'El registre ja està anul·lat', { status: 409 });
      if (action === 'modify') {
        const clean = {};
        for (const k of CORRECTABLE) if (k in changes) clean[k] = changes[k];
        if (clean.occurred_at) {
          if (Number.isNaN(Date.parse(clean.occurred_at))) throw new RuleError('INVALID_TIME', 'Hora no vàlida', { status: 400 });
          clean.occurred_at = new Date(clean.occurred_at).toISOString();
        }
        if (clean.type && !TYPES.includes(clean.type)) throw new RuleError('INVALID_TYPE', 'Tipus no vàlid', { status: 400 });
        if (!Object.keys(clean).length) throw new RuleError('NO_CHANGES', 'No hi ha canvis', { status: 400 });
        oldValues = JSON.stringify(Object.fromEntries(Object.keys(clean).map(k => [k, ev[k]])));
        newValues = JSON.stringify(clean);
      } else if (action !== 'annul') {
        throw new RuleError('INVALID_ACTION', 'Acció no vàlida', { status: 400 });
      }
    }
    const c = insertChained(db, 'corrections', {
      action, event_id: targetId, old_values: oldValues, new_values: newValues, reason: reason.trim(),
      author_id: author.id, created_at: new Date().toISOString(),
    });
    audit.log(db, { actorId: author.id, action: `correction.${action}`, entity: 'time_events', entityId: targetId, details: { correction_id: c.id }, ip });
    return { correctionId: c.id, eventId: targetId };
  });
}

module.exports = { createEvent, correctEvent, effectiveEvents, stateAt, RuleError, LATE_REASONS, TYPES };
