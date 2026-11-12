'use strict';
/** Estat en temps real dels serveis (cobertura, retards, absències). */
const dbm = require('../db');
const tz = require('./tz');
const { effectiveEvents, stateAt } = require('./records');

function serviceStatus(db, { date, now = new Date() } = {}) {
  const S = dbm.settings(db);
  const d = date || tz.parts(now, S.timezone).date;
  const range = tz.dayRange(d, S.timezone);
  const tol = Number(S.late_tolerance_min) * 60e3;
  const absAfter = Number(S.absence_after_min) * 60e3;
  const shifts = db.prepare(`SELECT sh.*, u.name AS user_name, u.tip, s.name AS site_name, s.critical, c.name AS client_name
      FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN sites s ON s.id = sh.site_id JOIN clients c ON c.id = s.client_id
      WHERE sh.status = 'planned' AND sh.planned_end > ? AND sh.planned_start < ? ORDER BY s.critical DESC, sh.planned_start`)
    .all(range.start.toISOString(), range.end.toISOString());
  const cache = new Map();
  const evs = uid => { if (!cache.has(uid)) cache.set(uid, effectiveEvents(db, { userId: uid })); return cache.get(uid); };
  const t = now.getTime();
  const rows = shifts.map(sh => {
    const ps = Date.parse(sh.planned_start); const pe = Date.parse(sh.planned_end);
    const all = evs(sh.user_id);
    const own = all.filter(e => e.shift_id === sh.id);
    const inEv = own.find(e => e.type === 'IN');
    const outEv = [...own].reverse().find(e => e.type === 'OUT');
    const cur = stateAt(all, now.toISOString());
    let status; let lateMin = null;
    if (inEv) lateMin = Math.max(0, Math.floor((Date.parse(inEv.occurred_at) - ps) / 60e3));
    if (outEv) status = 'FINALITZAT';
    else if (inEv) {
      if (cur.state === 'break' && cur.openIn && cur.openIn.shift_id === sh.id) status = 'PAUSA';
      else if (t > pe + tol) status = 'PROLONGACIO';
      else status = lateMin * 60e3 > tol ? 'EN_SERVEI_AMB_RETARD' : 'EN_SERVEI';
    } else if (t < ps) status = 'PENDENT';
    else if (t < ps + absAfter) status = 'RETARD';
    else status = 'ABSENT';
    const needsReview = own.some(e => e.needs_review);
    return {
      shift_id: sh.id, user_id: sh.user_id, user_name: sh.user_name, tip: sh.tip, site_id: sh.site_id, site_name: sh.site_name,
      client_name: sh.client_name, critical: !!sh.critical, planned_start: sh.planned_start, planned_end: sh.planned_end,
      status, late_minutes: lateMin, in_at: inEv ? inEv.occurred_at : null, out_at: outEv ? outEv.occurred_at : null,
      outside_geofence: own.some(e => e.within_geofence === 0), needs_review: needsReview,
    };
  });
  const count = s => rows.filter(r => r.status === s).length;
  return {
    date: d, generated_at: now.toISOString(),
    summary: {
      total: rows.length,
      covered: rows.filter(r => ['EN_SERVEI', 'EN_SERVEI_AMB_RETARD', 'PAUSA', 'PROLONGACIO'].includes(r.status)).length,
      late: count('RETARD') + count('EN_SERVEI_AMB_RETARD'), absent: count('ABSENT'), pending: count('PENDENT'),
      finished: count('FINALITZAT'), prolonging: count('PROLONGACIO'),
      critical_uncovered: rows.filter(r => r.critical && ['RETARD', 'ABSENT'].includes(r.status)).length,
    },
    shifts: rows,
  };
}

module.exports = { serviceStatus };
