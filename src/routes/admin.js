'use strict';
const express = require('express');
const dbm = require('../db');
const auth = require('../auth');
const records = require('../services/records');
const reports = require('../services/reports');
const hours = require('../services/hours');
const dashboard = require('../services/dashboard');
const exporter = require('../services/exporter');
const audit = require('../services/audit');
const chain = require('../services/chain');
const retention = require('../services/retention');
const tz = require('../services/tz');
const realtime = require('../realtime');
const { h, ip, isMonth, isDate } = require('./util');

const r = express.Router();
r.use(auth.authenticate);
const need = auth.require;
const db = () => dbm.get();
const curMonth = () => tz.parts(new Date(), dbm.settings().timezone).month;

/* ---------- Dashboard en temps real ---------- */
r.get('/dashboard', need('dashboard'), h((req, res) => {
  res.json(dashboard.serviceStatus(db(), { date: isDate(req.query.date) ? req.query.date : undefined }));
}));
r.get('/stream', need('dashboard'), (req, res) => realtime.subscribe(req, res));

/* ---------- Usuaris ---------- */
r.get('/users', need('dashboard'), h((req, res) => {
  res.json({ users: db().prepare('SELECT id, tip, dni, name, email, role, monthly_hours, active, created_at FROM users ORDER BY name').all() });
}));
r.post('/users', need('users.write'), h((req, res) => {
  const { tip, name, role = 'vigilant', password, dni, email, monthly_hours } = req.body;
  if (!tip || !name || !password || password.length < 8) return res.status(400).json({ error: 'TIP, nom i contrasenya (mín. 8) obligatoris' });
  if (!auth.ROLES[role]) return res.status(400).json({ error: 'Rol no vàlid' });
  if (role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Només un administrador pot crear administradors' });
  const info = db().prepare('INSERT INTO users(tip, dni, name, email, role, password_hash, monthly_hours) VALUES (?,?,?,?,?,?,?)')
    .run(String(tip).trim().toUpperCase(), dni || null, name, email || null, role, auth.hashPassword(password), monthly_hours || null);
  audit.log(db(), { actorId: req.user.id, action: 'user.create', entity: 'users', entityId: info.lastInsertRowid, details: { tip, role }, ip: ip(req) });
  res.status(201).json({ id: Number(info.lastInsertRowid) });
}));
r.patch('/users/:id', need('users.write'), h((req, res) => {
  const allowed = ['name', 'dni', 'email', 'role', 'monthly_hours', 'active'];
  const sets = []; const vals = [];
  for (const k of allowed) if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k] === '' ? null : req.body[k]); }
  if (req.body.role && !auth.ROLES[req.body.role]) return res.status(400).json({ error: 'Rol no vàlid' });
  if (req.body.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Sense permisos' });
  if (req.body.password) {
    if (req.body.password.length < 8) return res.status(400).json({ error: 'Contrasenya massa curta' });
    sets.push('password_hash = ?'); vals.push(auth.hashPassword(req.body.password));
  }
  if (!sets.length) return res.status(400).json({ error: 'Sense canvis' });
  db().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, Number(req.params.id));
  audit.log(db(), { actorId: req.user.id, action: 'user.update', entity: 'users', entityId: req.params.id,
    details: { fields: Object.keys(req.body).map(k => (k === 'password' ? 'password(reset)' : k)) }, ip: ip(req) });
  res.json({ ok: true });
}));

/* ---------- Clients i instal·lacions ---------- */
r.get('/clients', need('dashboard'), h((req, res) => res.json({ clients: db().prepare('SELECT * FROM clients ORDER BY name').all() })));
r.post('/clients', need('sites.write'), h((req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Nom obligatori' });
  const i = db().prepare('INSERT INTO clients(name, cif, report_email) VALUES (?,?,?)').run(req.body.name, req.body.cif || null, req.body.report_email || null);
  audit.log(db(), { actorId: req.user.id, action: 'client.create', entity: 'clients', entityId: i.lastInsertRowid, ip: ip(req) });
  res.status(201).json({ id: Number(i.lastInsertRowid) });
}));
r.get('/sites', need('dashboard'), h((req, res) => res.json({ sites: db().prepare('SELECT s.*, c.name AS client_name FROM sites s JOIN clients c ON c.id = s.client_id ORDER BY c.name, s.name').all() })));
r.post('/sites', need('sites.write'), h((req, res) => {
  const b = req.body;
  if (!b.name || !b.client_id) return res.status(400).json({ error: 'Nom i client obligatoris' });
  const i = db().prepare('INSERT INTO sites(client_id, name, address, lat, lng, radius_m, solo_post, critical) VALUES (?,?,?,?,?,?,?,?)')
    .run(Number(b.client_id), b.name, b.address || null, b.lat === '' || b.lat == null ? null : Number(b.lat), b.lng === '' || b.lng == null ? null : Number(b.lng),
      Number(b.radius_m) || 150, b.solo_post ? 1 : 0, b.critical ? 1 : 0);
  audit.log(db(), { actorId: req.user.id, action: 'site.create', entity: 'sites', entityId: i.lastInsertRowid, ip: ip(req) });
  res.status(201).json({ id: Number(i.lastInsertRowid) });
}));
r.patch('/sites/:id', need('sites.write'), h((req, res) => {
  const allowed = ['name', 'address', 'lat', 'lng', 'radius_m', 'solo_post', 'critical', 'active'];
  const sets = []; const vals = [];
  for (const k of allowed) if (k in req.body) { sets.push(`${k} = ?`); vals.push(typeof req.body[k] === 'boolean' ? (req.body[k] ? 1 : 0) : req.body[k]); }
  if (!sets.length) return res.status(400).json({ error: 'Sense canvis' });
  db().prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id = ?`).run(...vals, Number(req.params.id));
  audit.log(db(), { actorId: req.user.id, action: 'site.update', entity: 'sites', entityId: req.params.id, details: req.body, ip: ip(req) });
  res.json({ ok: true });
}));

/* ---------- Quadrants ---------- */
r.get('/shifts', need('dashboard'), h((req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : curMonth();
  const w = ['sh.month = ?']; const p = [month];
  if (req.query.user_id) { w.push('sh.user_id = ?'); p.push(Number(req.query.user_id)); }
  if (req.query.site_id) { w.push('sh.site_id = ?'); p.push(Number(req.query.site_id)); }
  res.json({ month, shifts: db().prepare(`SELECT sh.*, u.name AS user_name, u.tip, s.name AS site_name, c.name AS client_name
    FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN sites s ON s.id = sh.site_id JOIN clients c ON c.id = s.client_id
    WHERE ${w.join(' AND ')} ORDER BY sh.planned_start`).all(...p) });
}));

function insertShift(d, actorId, { user_id, site_id, planned_start, planned_end, notes }) {
  const s = Date.parse(planned_start); const e = Date.parse(planned_end);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) throw new records.RuleError('INVALID_SHIFT', 'Hores del torn no vàlides', { status: 400 });
  if (e - s > 24 * 3600e3) throw new records.RuleError('INVALID_SHIFT', 'Un torn no pot superar 24 h', { status: 400 });
  const overlap = d.prepare(`SELECT id FROM shifts WHERE user_id = ? AND status = 'planned' AND planned_start < ? AND planned_end > ?`)
    .get(Number(user_id), new Date(e).toISOString(), new Date(s).toISOString());
  if (overlap) throw new records.RuleError('SHIFT_OVERLAP', 'El treballador ja té un torn que se solapa', { status: 409 });
  const month = tz.parts(new Date(s), dbm.settings(d).timezone).month;
  const i = d.prepare('INSERT INTO shifts(user_id, site_id, planned_start, planned_end, month, notes, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(Number(user_id), Number(site_id), new Date(s).toISOString(), new Date(e).toISOString(), month, notes || null, actorId);
  return Number(i.lastInsertRowid);
}

r.post('/shifts', need('shifts.write'), h((req, res) => {
  const id = insertShift(db(), req.user.id, req.body);
  audit.log(db(), { actorId: req.user.id, action: 'shift.create', entity: 'shifts', entityId: id, ip: ip(req) });
  res.status(201).json({ id });
}));

/** Importació de quadrant CSV: tip;instal·lació(id o nom);data(YYYY-MM-DD);inici(HH:MM);fi(HH:MM)[;notes] */
r.post('/shifts/import', need('shifts.write'), express.text({ type: '*/*', limit: '2mb' }), h((req, res) => {
  const d = db(); const T = dbm.settings(d).timezone;
  const text = typeof req.body === 'string' ? req.body : String(req.body.csv || '');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const results = []; let created = 0;
  dbm.tx(d, () => {
    lines.forEach((line, idx) => {
      const cols = line.split(/[;,\t]/).map(c => c.trim());
      if (idx === 0 && /tip/i.test(cols[0])) return;
      try {
        const [tip, siteRef, date, start, end, notes] = cols;
        const u = d.prepare('SELECT id FROM users WHERE upper(tip) = upper(?)').get(tip);
        if (!u) throw new Error(`TIP desconegut: ${tip}`);
        const s = /^\d+$/.test(siteRef) ? d.prepare('SELECT id FROM sites WHERE id = ?').get(Number(siteRef)) : d.prepare('SELECT id FROM sites WHERE name = ?').get(siteRef);
        if (!s) throw new Error(`Instal·lació desconeguda: ${siteRef}`);
        if (!isDate(date) || !/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) throw new Error('Format de data/hora no vàlid');
        const [y, m, dd] = date.split('-').map(Number);
        const [sh, sm] = start.split(':').map(Number); const [eh, em] = end.split(':').map(Number);
        const ps = tz.zonedToUtc(y, m, dd, sh, sm, T);
        const nd = eh * 60 + em <= sh * 60 + sm ? tz.addDays(y, m, dd, 1) : { y, m, d: dd }; // torn que travessa mitjanit
        const pe = tz.zonedToUtc(nd.y, nd.m, nd.d, eh, em, T);
        insertShift(d, req.user.id, { user_id: u.id, site_id: s.id, planned_start: ps.toISOString(), planned_end: pe.toISOString(), notes });
        created++;
      } catch (e) { results.push({ line: idx + 1, error: e.message }); }
    });
  });
  audit.log(d, { actorId: req.user.id, action: 'shift.import', details: { created, errors: results.length }, ip: ip(req) });
  res.json({ created, errors: results });
}));

r.post('/shifts/:id/cancel', need('shifts.write'), h((req, res) => {
  const d = db();
  const used = d.prepare('SELECT 1 FROM time_events WHERE shift_id = ? LIMIT 1').get(Number(req.params.id));
  if (used) return res.status(409).json({ error: 'El torn ja té fitxatges; no es pot cancel·lar' });
  d.prepare("UPDATE shifts SET status = 'cancelled' WHERE id = ?").run(Number(req.params.id));
  audit.log(d, { actorId: req.user.id, action: 'shift.cancel', entity: 'shifts', entityId: req.params.id, details: { reason: req.body.reason || null }, ip: ip(req) });
  res.json({ ok: true });
}));

/** Comparativa quadrant vs. real per al mes */
r.get('/shifts/compare', need('dashboard'), h((req, res) => {
  const d = db(); const month = isMonth(req.query.month) ? req.query.month : curMonth();
  const users = d.prepare(`SELECT DISTINCT u.id FROM users u WHERE u.id IN (SELECT user_id FROM shifts WHERE month = ?) OR u.id IN (SELECT user_id FROM time_events) ORDER BY u.name`).all(month);
  res.json({ month, rows: users.map(u => { const m = hours.monthlyReport(d, u.id, month); return { user: m.user, totals: m.totals, anomalies: m.anomalies.length }; })
    .filter(x => x.totals.worked_h || x.totals.planned_h) });
}));

/* ---------- Registres i correccions ---------- */
r.get('/events', need('dashboard'), h((req, res) => {
  const d = db(); const T = dbm.settings(d).timezone;
  const month = isMonth(req.query.month) ? req.query.month : curMonth();
  const range = tz.monthRange(month, T);
  const users = new Map(d.prepare('SELECT id, name, tip FROM users').all().map(u => [u.id, u]));
  const sites = new Map(d.prepare('SELECT id, name FROM sites').all().map(s => [s.id, s.name]));
  let evs = records.effectiveEvents(d, { userId: req.query.user_id ? Number(req.query.user_id) : null, from: range.start.toISOString(), to: range.end.toISOString(), includeAnnulled: true });
  if (req.query.review === '1') evs = evs.filter(e => e.needs_review);
  res.json({ month, events: evs.slice(-2000).map(e => ({ ...e, user_name: users.get(e.user_id)?.name, tip: users.get(e.user_id)?.tip, site_name: sites.get(e.site_id) || null })) });
}));

r.post('/corrections', need('records.correct'), h((req, res) => {
  const { action, event_id, changes, reason, new_event } = req.body;
  const out = records.correctEvent(db(), req.user, { action, eventId: event_id, changes, reason, newEvent: new_event, ip: ip(req) });
  res.status(201).json(out);
}));

r.get('/corrections', need('audit'), h((req, res) => {
  res.json({ corrections: db().prepare(`SELECT c.*, u.name AS author_name, e.user_id, w.name AS worker_name FROM corrections c
    JOIN users u ON u.id = c.author_id JOIN time_events e ON e.id = c.event_id JOIN users w ON w.id = e.user_id ORDER BY c.id DESC LIMIT 500`).all() });
}));

/* ---------- Còmput d'hores ---------- */
r.get('/hours', need('hours'), h((req, res) => {
  const d = db(); const month = isMonth(req.query.month) ? req.query.month : curMonth();
  if (req.query.user_id) return res.json(hours.monthlyReport(d, Number(req.query.user_id), month));
  const users = d.prepare("SELECT id FROM users WHERE role = 'vigilant' OR id IN (SELECT user_id FROM time_events) ORDER BY name").all();
  res.json({ month, rows: users.map(u => { const m = hours.monthlyReport(d, u.id, month); return { user: m.user, totals: m.totals, anomalies: m.anomalies }; }) });
}));

/* ---------- Parts de servei ---------- */
r.get('/reports', need('reports.read'), h((req, res) => {
  const T = dbm.settings().timezone; const q = req.query;
  const from = isDate(q.from) ? tz.dayRange(q.from, T).start.toISOString() : null;
  const to = isDate(q.to) ? tz.dayRange(q.to, T).end.toISOString() : null;
  res.json({ reports: reports.searchReports(db(), { from, to, clientId: q.client_id, siteId: q.site_id, userId: q.user_id, incidentType: q.type }), types: reports.INCIDENT_TYPES });
}));
r.get('/reports/:id', need('reports.read'), h((req, res) => {
  const rep = reports.getReport(db(), Number(req.params.id));
  if (!rep) return res.status(404).json({ error: 'No trobat' });
  res.json({ report: rep });
}));
r.get('/reports/:id/pdf', need('reports.read'), h(async (req, res) => {
  const rep = reports.getReport(db(), Number(req.params.id));
  if (!rep) return res.status(404).json({ error: 'No trobat' });
  const buf = await exporter.reportPdf(rep, dbm.settings());
  audit.log(db(), { actorId: req.user.id, action: 'report.download', entity: 'service_reports', entityId: rep.id, ip: ip(req) });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="part-${rep.id}.pdf"` }).send(buf);
}));
/** Enviament al client: integració de correu configurable (veure README). Queda auditat. */
r.post('/reports/:id/send', need('reports.send'), h(async (req, res) => {
  const rep = reports.getReport(db(), Number(req.params.id));
  if (!rep) return res.status(404).json({ error: 'No trobat' });
  const to = req.body.to || rep.report_email;
  if (!to) return res.status(400).json({ error: 'El client no té correu de recepció configurat' });
  const mailer = req.app.get('mailer');
  if (!mailer) return res.status(501).json({ error: 'Enviament de correu no configurat al servidor. Descarrega el PDF i envia\'l manualment.' });
  const pdf = await exporter.reportPdf(rep, dbm.settings());
  await mailer({ to, subject: `Part de servei ${rep.site_name} – ${rep.signed_at.slice(0, 10)}`, attachments: [{ filename: `part-${rep.id}.pdf`, content: pdf }] });
  audit.log(db(), { actorId: req.user.id, action: 'report.send', entity: 'service_reports', entityId: rep.id, details: { to }, ip: ip(req) });
  res.json({ ok: true, to });
}));

/* ---------- Exportació per a Inspecció ---------- */
r.get('/export', need('export'), h(async (req, res) => {
  const from = isMonth(req.query.from) ? req.query.from : curMonth();
  const to = isMonth(req.query.to) ? req.query.to : from;
  if (to < from) return res.status(400).json({ error: 'Període no vàlid' });
  const userIds = req.query.users ? String(req.query.users).split(',').filter(Boolean) : [];
  const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
  const buf = format === 'pdf' ? await exporter.toPdf(db(), { userIds, fromMonth: from, toMonth: to })
                               : Buffer.from(await exporter.toExcel(db(), { userIds, fromMonth: from, toMonth: to }));
  audit.log(db(), { actorId: req.user.id, action: 'export.inspection', details: { format, from, to, users: userIds }, ip: ip(req) });
  const ct = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  res.set({ 'Content-Type': ct, 'Content-Disposition': `attachment; filename="registre-jornada_${from}_${to}.${format}"` }).send(buf);
}));

/* ---------- Auditoria i integritat ---------- */
r.get('/audit', need('audit'), h((req, res) => {
  res.json({ log: db().prepare(`SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?`).all(Math.min(Number(req.query.limit) || 300, 2000)) });
}));
r.get('/integrity', need('audit'), h((req, res) => {
  const tables = ['time_events', 'corrections', 'service_reports', 'nfc_reads', 'audit_log'];
  const results = tables.map(t => chain.verify(db(), t));
  res.json({ ok: results.every(x => x.ok), results, checked_at: new Date().toISOString() });
}));
r.post('/retention/purge', need('settings'), h((req, res) => res.json(retention.purge(db(), req.user, ip(req)))));

/* ---------- Configuració i festius ---------- */
r.get('/settings', need('dashboard'), h((req, res) => res.json({ settings: dbm.settings(), holidays: db().prepare('SELECT * FROM holidays ORDER BY date').all() })));
r.put('/settings', need('settings'), h((req, res) => {
  const keys = Object.keys(dbm.DEFAULT_SETTINGS).filter(k => k in req.body);
  const up = db().prepare('UPDATE settings SET value = ? WHERE key = ?');
  for (const k of keys) up.run(String(req.body[k]), k);
  audit.log(db(), { actorId: req.user.id, action: 'settings.update', details: Object.fromEntries(keys.map(k => [k, req.body[k]])), ip: ip(req) });
  res.json({ settings: dbm.settings() });
}));
r.post('/holidays', need('shifts.write'), h((req, res) => {
  if (!isDate(req.body.date) || !req.body.name) return res.status(400).json({ error: 'Data i nom obligatoris' });
  db().prepare('INSERT OR REPLACE INTO holidays(date, name, scope) VALUES (?,?,?)').run(req.body.date, req.body.name, req.body.scope || 'nacional');
  audit.log(db(), { actorId: req.user.id, action: 'holiday.upsert', details: req.body, ip: ip(req) });
  res.status(201).json({ ok: true });
}));
r.delete('/holidays/:date', need('shifts.write'), h((req, res) => {
  db().prepare('DELETE FROM holidays WHERE date = ?').run(req.params.date);
  audit.log(db(), { actorId: req.user.id, action: 'holiday.delete', details: { date: req.params.date }, ip: ip(req) });
  res.json({ ok: true });
}));

/* ---------- Fase 2: punts de control NFC ---------- */
r.get('/nfc/checkpoints', need('dashboard'), h((req, res) => res.json({ checkpoints: db().prepare('SELECT * FROM nfc_checkpoints ORDER BY site_id, name').all() })));
r.post('/nfc/checkpoints', need('sites.write'), h((req, res) => {
  const b = req.body;
  if (!b.site_id || !b.tag_uid || !b.name) return res.status(400).json({ error: 'Instal·lació, UID i nom obligatoris' });
  const i = db().prepare('INSERT INTO nfc_checkpoints(site_id, tag_uid, name, lat, lng) VALUES (?,?,?,?,?)')
    .run(Number(b.site_id), String(b.tag_uid).toUpperCase(), b.name, b.lat ?? null, b.lng ?? null);
  res.status(201).json({ id: Number(i.lastInsertRowid) });
}));

module.exports = r;
