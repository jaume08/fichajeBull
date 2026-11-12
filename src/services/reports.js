'use strict';
/** Parts de servei digitals amb signatura i segell de temps del servidor. */
const crypto = require('node:crypto');
const { insertChained } = require('./chain');
const { RuleError, effectiveEvents, stateAt } = require('./records');
const dbm = require('../db');

const INCIDENT_TYPES = {
  CONTROL_ACCES: 'Control d\'accés',
  ALARMA: 'Alarma',
  INCIDENCIA_TERCERS: 'Incidència amb tercers',
  RONDA: 'Ronda',
  AVARIA: 'Avaria / instal·lacions',
  EMERGENCIA: 'Emergència / evacuació',
  ALTRES: 'Altres',
};
const MAX_SIGNATURE = 300 * 1024;

function createReport(db, user, input, { now = new Date() } = {}) {
  const uuid = input.uuid && /^[0-9a-f-]{16,64}$/i.test(input.uuid) ? input.uuid : crypto.randomUUID();
  const dup = db.prepare('SELECT * FROM service_reports WHERE uuid = ?').get(uuid);
  if (dup) {
    if (dup.user_id !== user.id) throw new RuleError('UUID_CONFLICT', 'Identificador duplicat', { status: 409 });
    return { report: dup, duplicate: true };
  }
  const sig = String(input.signature_png || '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length < 200) throw new RuleError('SIGNATURE_REQUIRED', 'Cal signar el part de servei', { status: 400 });
  if (sig.length > MAX_SIGNATURE) throw new RuleError('SIGNATURE_TOO_LARGE', 'Signatura massa gran', { status: 400 });
  const incidents = Array.isArray(input.incidents) ? input.incidents : [];
  for (const i of incidents) {
    if (!INCIDENT_TYPES[i.type]) throw new RuleError('INVALID_INCIDENT', `Tipus d'incidència no vàlid: ${i.type}`, { status: 400 });
    if (!i.description || !String(i.description).trim()) throw new RuleError('INVALID_INCIDENT', 'Cada incidència necessita una descripció', { status: 400 });
  }
  if (!incidents.length && !input.no_incidents && !(input.summary || '').trim()) {
    throw new RuleError('EMPTY_REPORT', 'Indica les incidències o marca "Sense novetats"', { status: 400 });
  }

  // Instal·lació i torn: del fitxatge obert o del més recent
  const events = effectiveEvents(db, { userId: user.id });
  const at = input.offline && input.device_time ? new Date(input.device_time).toISOString() : now.toISOString();
  const st = stateAt(events, at);
  let ref = st.openIn;
  if (!ref) ref = [...events].reverse().find(e => e.type === 'IN' && e.occurred_at <= at);
  const siteId = input.site_id ? Number(input.site_id) : ref ? ref.site_id : null;
  if (!siteId) throw new RuleError('SITE_REQUIRED', 'No s\'ha pogut determinar la instal·lació', { status: 422 });
  const shiftId = ref && ref.site_id === siteId ? ref.shift_id : null;

  const r = dbm.tx(db, () => {
    const rep = insertChained(db, 'service_reports', {
      uuid, user_id: user.id, site_id: siteId, shift_id: shiftId,
      summary: (input.summary || '').trim() || null, no_incidents: input.no_incidents && !incidents.length ? 1 : 0,
      signature_png: sig, device_time: input.device_time || null, signed_at: now.toISOString(),
      origin: input.offline ? 'offline' : 'online',
    });
    const ins = db.prepare('INSERT INTO report_incidents(report_id, type, occurred_at, description) VALUES (?,?,?,?)');
    for (const i of incidents) {
      const t = i.occurred_at && !Number.isNaN(Date.parse(i.occurred_at)) ? new Date(i.occurred_at).toISOString() : null;
      ins.run(rep.id, i.type, t, String(i.description).trim().slice(0, 4000));
    }
    return rep;
  });
  return { report: getReport(db, r.id), duplicate: false };
}

function getReport(db, id) {
  const rep = db.prepare(`SELECT r.*, u.name AS user_name, u.tip, s.name AS site_name, c.name AS client_name, c.report_email
    FROM service_reports r JOIN users u ON u.id = r.user_id JOIN sites s ON s.id = r.site_id JOIN clients c ON c.id = s.client_id
    WHERE r.id = ?`).get(id);
  if (!rep) return null;
  rep.incidents = db.prepare('SELECT * FROM report_incidents WHERE report_id = ? ORDER BY occurred_at, id').all(id);
  // Prolongacions de jornada vinculades automàticament al part (mateix torn)
  rep.prolongations = rep.shift_id
    ? db.prepare(`SELECT id, occurred_at, late_minutes, late_reason, late_reason_text FROM time_events
                  WHERE shift_id = ? AND type = 'OUT' AND late_minutes IS NOT NULL`).all(rep.shift_id)
    : [];
  rep.shift = rep.shift_id ? db.prepare('SELECT planned_start, planned_end FROM shifts WHERE id = ?').get(rep.shift_id) : null;
  rep.nfc_reads = rep.shift_id ? db.prepare('SELECT * FROM nfc_reads WHERE shift_id = ? OR report_id = ? ORDER BY occurred_at').all(rep.shift_id, id) : [];
  return rep;
}

function searchReports(db, { from, to, clientId, siteId, userId, incidentType, limit = 200 }) {
  const w = ['1=1']; const p = [];
  if (from) { w.push('r.signed_at >= ?'); p.push(from); }
  if (to) { w.push('r.signed_at < ?'); p.push(to); }
  if (clientId) { w.push('s.client_id = ?'); p.push(Number(clientId)); }
  if (siteId) { w.push('r.site_id = ?'); p.push(Number(siteId)); }
  if (userId) { w.push('r.user_id = ?'); p.push(Number(userId)); }
  if (incidentType) { w.push('EXISTS (SELECT 1 FROM report_incidents i WHERE i.report_id = r.id AND i.type = ?)'); p.push(incidentType); }
  return db.prepare(`SELECT r.id, r.uuid, r.signed_at, r.no_incidents, r.summary, r.origin, u.name AS user_name, u.tip,
      s.name AS site_name, c.name AS client_name,
      (SELECT group_concat(type) FROM report_incidents i WHERE i.report_id = r.id) AS incident_types
    FROM service_reports r JOIN users u ON u.id = r.user_id JOIN sites s ON s.id = r.site_id JOIN clients c ON c.id = s.client_id
    WHERE ${w.join(' AND ')} ORDER BY r.signed_at DESC LIMIT ?`).all(...p, Math.min(Number(limit) || 200, 1000));
}

module.exports = { createReport, getReport, searchReports, INCIDENT_TYPES };
