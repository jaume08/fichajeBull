'use strict';
const express = require('express');
const dbm = require('../db');
const auth = require('../auth');
const records = require('../services/records');
const reports = require('../services/reports');
const hours = require('../services/hours');
const nfc = require('../services/nfc');
const tz = require('../services/tz');
const realtime = require('../realtime');
const { h, isMonth } = require('./util');

const r = express.Router();
r.use(auth.authenticate, auth.require('worker'));

function workerState(db, user, now = new Date()) {
  const events = records.effectiveEvents(db, { userId: user.id, from: new Date(now - 3 * 86400e3).toISOString() });
  const st = records.stateAt(events, now.toISOString());
  const shifts = db.prepare(`SELECT sh.*, s.name AS site_name, s.lat, s.lng, s.radius_m, s.solo_post, c.name AS client_name
      FROM shifts sh JOIN sites s ON s.id = sh.site_id JOIN clients c ON c.id = s.client_id
      WHERE sh.user_id = ? AND sh.status = 'planned' AND sh.planned_end > ? ORDER BY sh.planned_start LIMIT 10`)
    .all(user.id, new Date(now - 12 * 3600e3).toISOString());
  const currentShift = st.openIn && st.openIn.shift_id ? shifts.find(s => s.id === st.openIn.shift_id)
    || db.prepare('SELECT * FROM shifts WHERE id = ?').get(st.openIn.shift_id) : null;
  return {
    state: st.state,
    open_in: st.openIn ? { id: st.openIn.id, occurred_at: st.openIn.occurred_at, site_id: st.openIn.site_id, shift_id: st.openIn.shift_id } : null,
    open_break: st.openBreak ? { occurred_at: st.openBreak.occurred_at, paid: !!st.openBreak.break_paid } : null,
    current_shift: currentShift || null,
    upcoming_shifts: shifts,
    last_events: events.slice(-8).reverse().map(e => ({ type: e.type, occurred_at: e.occurred_at, origin: e.origin, needs_review: !!e.needs_review })),
  };
}

r.get('/me', h((req, res) => {
  const db = dbm.get(); const S = dbm.settings(db);
  res.json({
    user: auth.publicUser(req.user),
    ...workerState(db, req.user),
    sites: db.prepare('SELECT s.id, s.name, s.lat, s.lng, s.radius_m, s.solo_post, c.name AS client_name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.active = 1 ORDER BY s.name').all(),
    catalog: { late_reasons: records.LATE_REASONS, incident_types: reports.INCIDENT_TYPES },
    settings: { timezone: S.timezone, geofence_policy: S.geofence_policy, late_tolerance_min: Number(S.late_tolerance_min) },
    server_time: new Date().toISOString(),
  });
}));

function emit(db, user, ev) {
  realtime.publish('event', { user_id: user.id, user_name: user.name, type: ev.type, occurred_at: ev.occurred_at, site_id: ev.site_id, shift_id: ev.shift_id, needs_review: !!ev.needs_review });
}

r.post('/events', h((req, res) => {
  const db = dbm.get();
  const out = records.createEvent(db, req.user, { ...req.body, offline: false });
  if (!out.duplicate) emit(db, req.user, out.event);
  res.status(out.duplicate ? 200 : 201).json({ event: out.event, warnings: out.warnings, state: workerState(db, req.user) });
}));

/** Sincronització de la cua offline. Processa en ordre cronològic del dispositiu. */
r.post('/sync', h((req, res) => {
  const db = dbm.get();
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 500) : [];
  const sentAt = req.body.sent_at;
  const sorted = [...items].sort((a, b) => String(a.device_time).localeCompare(String(b.device_time)));
  const results = [];
  for (const it of sorted) {
    try {
      const input = { ...it.data, uuid: it.uuid, device_time: it.device_time, sent_at: sentAt, offline: true };
      if (it.kind === 'event') {
        const o = records.createEvent(db, req.user, input);
        if (!o.duplicate) emit(db, req.user, o.event);
        results.push({ uuid: it.uuid, ok: true, duplicate: o.duplicate, warnings: o.warnings });
      } else if (it.kind === 'report') {
        const o = reports.createReport(db, req.user, input);
        results.push({ uuid: it.uuid, ok: true, duplicate: o.duplicate, id: o.report.id });
      } else if (it.kind === 'nfc') {
        const o = nfc.recordRead(db, req.user, input);
        results.push({ uuid: it.uuid, ok: true, duplicate: o.duplicate });
      } else results.push({ uuid: it.uuid, ok: false, error: 'Tipus desconegut', permanent: true });
    } catch (e) {
      results.push({ uuid: it.uuid, ok: false, error: e.message, code: e.code, permanent: !!e.code });
    }
  }
  res.json({ results, state: workerState(db, req.user) });
}));

r.get('/events', h((req, res) => {
  const db = dbm.get(); const S = dbm.settings(db);
  const month = isMonth(req.query.month) ? req.query.month : tz.parts(new Date(), S.timezone).month;
  const range = tz.monthRange(month, S.timezone);
  res.json({ month, events: records.effectiveEvents(db, { userId: req.user.id, from: range.start.toISOString(), to: range.end.toISOString(), includeAnnulled: true })
    .map(({ prev_hash, ...e }) => e) });
}));

r.get('/hours', h((req, res) => {
  const db = dbm.get(); const S = dbm.settings(db);
  const month = isMonth(req.query.month) ? req.query.month : tz.parts(new Date(), S.timezone).month;
  res.json(hours.monthlyReport(db, req.user.id, month));
}));

r.post('/reports', h((req, res) => {
  const db = dbm.get();
  const o = reports.createReport(db, req.user, { ...req.body, offline: false });
  if (!o.duplicate) realtime.publish('report', { id: o.report.id, user_name: req.user.name, site_name: o.report.site_name, incidents: o.report.incidents.length });
  res.status(o.duplicate ? 200 : 201).json({ report: { ...o.report, signature_png: undefined } });
}));

r.get('/reports', h((req, res) => {
  res.json({ reports: reports.searchReports(dbm.get(), { userId: req.user.id, limit: 50 }) });
}));

r.post('/nfc/reads', h((req, res) => {
  const o = nfc.recordRead(dbm.get(), req.user, { ...req.body, offline: false });
  res.status(o.duplicate ? 200 : 201).json(o);
}));

module.exports = r;
