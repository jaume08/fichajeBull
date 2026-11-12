'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dbm = require('../src/db');
const auth = require('../src/auth');
const records = require('../src/services/records');
const hours = require('../src/services/hours');
const reports = require('../src/services/reports');
const chain = require('../src/services/chain');
const tz = require('../src/services/tz');
const dashboard = require('../src/services/dashboard');

const T = 'Europe/Madrid';
const L = (y, m, d, h, min = 0) => tz.zonedToUtc(y, m, d, h, min, T);

function fixture() {
  const db = dbm.open(':memory:');
  const uid = n => Number(db.prepare('INSERT INTO users(tip,name,role,password_hash) VALUES (?,?,?,?)').run(n, n, n === 'RRHH' ? 'rrhh' : 'vigilant', auth.hashPassword('x')).lastInsertRowid);
  const u = { id: uid('111111') }; const hr = { id: uid('RRHH') };
  const c = Number(db.prepare("INSERT INTO clients(name) VALUES ('Client')").run().lastInsertRowid);
  const site = Number(db.prepare('INSERT INTO sites(client_id,name,lat,lng,radius_m,solo_post) VALUES (?,?,?,?,?,?)').run(c, 'Seu', 41.39, 2.17, 100, 0).lastInsertRowid);
  const solo = Number(db.prepare('INSERT INTO sites(client_id,name,lat,lng,radius_m,solo_post) VALUES (?,?,?,?,?,?)').run(c, 'Garita', 41.39, 2.17, 100, 1).lastInsertRowid);
  const shift = (s, e, siteId = site) => Number(db.prepare('INSERT INTO shifts(user_id,site_id,planned_start,planned_end,month) VALUES (?,?,?,?,?)')
    .run(u.id, siteId, s.toISOString(), e.toISOString(), tz.parts(s, T).month).lastInsertRowid);
  const here = { lat: 41.39, lng: 2.17, accuracy: 10 };
  const ev = (type, at, extra = {}) => records.createEvent(db, u, { type, ...here, ...extra }, { now: at });
  return { db, u, hr, site, solo, shift, ev, here };
}

test('timezone: conversió hora local ↔ UTC amb canvi d\'horari', () => {
  assert.equal(L(2026, 1, 15, 22).toISOString(), '2026-01-15T21:00:00.000Z');
  assert.equal(L(2026, 7, 15, 22).toISOString(), '2026-07-15T20:00:00.000Z');
});

test('els registres horaris són immutables (UPDATE/DELETE bloquejats)', () => {
  const { db, shift, ev } = fixture();
  shift(L(2026, 3, 2, 7), L(2026, 3, 2, 19));
  const { event } = ev('IN', L(2026, 3, 2, 7));
  assert.throws(() => db.prepare('UPDATE time_events SET occurred_at = ? WHERE id = ?').run('2026-01-01', event.id), /REGISTRE_IMMUTABLE/);
  assert.throws(() => db.prepare('DELETE FROM time_events WHERE id = ?').run(event.id), /REGISTRE_IMMUTABLE/);
  require('../src/services/audit').log(db, { action: 'prova' });
  assert.throws(() => db.prepare('UPDATE audit_log SET action = ?').run('x'), /REGISTRE_IMMUTABLE/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /REGISTRE_IMMUTABLE/);
});

test('la cadena de hash detecta manipulacions', () => {
  const { db, shift, ev } = fixture();
  shift(L(2026, 3, 2, 7), L(2026, 3, 2, 19));
  ev('IN', L(2026, 3, 2, 7)); ev('OUT', L(2026, 3, 2, 19));
  assert.equal(chain.verify(db, 'time_events').ok, true);
  db.exec('DROP TRIGGER trg_time_events_no_update');
  db.prepare("UPDATE time_events SET occurred_at = '2026-03-02T05:00:00.000Z' WHERE id = 1").run();
  const v = chain.verify(db, 'time_events');
  assert.equal(v.ok, false); assert.equal(v.brokenAt, 1);
});

test('geolocalització: fora de radi exigeix justificació', () => {
  const { shift, ev } = fixture();
  shift(L(2026, 3, 2, 7), L(2026, 3, 2, 19));
  assert.throws(() => ev('IN', L(2026, 3, 2, 7), { lat: 41.40, lng: 2.17 }), e => e.code === 'GEOFENCE_JUSTIFICATION_REQUIRED');
  const r = ev('IN', L(2026, 3, 2, 7), { lat: 41.40, lng: 2.17, justification: 'Accés per la porta de mercaderies' });
  assert.equal(r.event.within_geofence, 0); assert.equal(r.event.needs_review, 1);
});

test('sense GPS exigeix justificació; no es guarda ubicació en pauses si no n\'hi ha', () => {
  const { shift, ev } = fixture();
  shift(L(2026, 3, 2, 7), L(2026, 3, 2, 19));
  assert.throws(() => ev('IN', L(2026, 3, 2, 7), { lat: undefined, lng: undefined, location_status: 'denied' }), e => e.code === 'LOCATION_JUSTIFICATION_REQUIRED');
});

test('seqüència: no es pot sortir sense entrar', () => {
  const { ev } = fixture();
  assert.throws(() => ev('OUT', L(2026, 3, 2, 7)), e => e.code === 'INVALID_SEQUENCE');
});

test('demora de relleu: sortida tardana obliga a indicar motiu', () => {
  const { db, shift, ev } = fixture();
  const sh = shift(L(2026, 3, 2, 7), L(2026, 3, 2, 19));
  ev('IN', L(2026, 3, 2, 6, 55));
  assert.throws(() => ev('OUT', L(2026, 3, 2, 19, 40)), e => e.code === 'LATE_REASON_REQUIRED' && e.extra.late_minutes === 40);
  const { event } = ev('OUT', L(2026, 3, 2, 19, 40), { late_reason: 'ESPERA_RELLEU' });
  assert.equal(event.late_minutes, 40); assert.equal(event.shift_id, sh);
  const m = hours.monthlyReport(db, 1, '2026-03', { now: L(2026, 4, 2, 0) });
  assert.equal(m.totals.prolongation_by_reason_h.ESPERA_RELLEU, 0.67);
});

test('còmput mensual: torn de nit 19-07 en dissabte desglossa nocturnitat i cap de setmana', () => {
  const { db, shift, ev } = fixture();
  // Dissabte 7 de març de 2026, 19:00 → diumenge 8, 07:00
  shift(L(2026, 3, 7, 19), L(2026, 3, 8, 7));
  ev('IN', L(2026, 3, 7, 19)); ev('OUT', L(2026, 3, 8, 7));
  const m = hours.monthlyReport(db, 1, '2026-03', { now: L(2026, 4, 2, 0) });
  assert.equal(m.totals.worked_h, 12);
  assert.equal(m.totals.night_h, 8);       // 22:00–06:00
  assert.equal(m.totals.weekend_h, 12);
  assert.equal(m.totals.planned_h, 12);
  assert.equal(m.totals.overtime_h, 0);    // 12 h en un dia no és hora extra: còmput mensual
  assert.equal(m.anomalies.length, 0);
});

test('festius i torns que creuen el canvi de mes es reparteixen correctament', () => {
  const { db, shift, ev } = fixture();
  db.prepare("INSERT INTO holidays(date,name) VALUES ('2026-04-01','Festiu prova')").run();
  shift(L(2026, 3, 31, 19), L(2026, 4, 1, 7));
  ev('IN', L(2026, 3, 31, 19)); ev('OUT', L(2026, 4, 1, 7));
  const mar = hours.monthlyReport(db, 1, '2026-03', { now: L(2026, 5, 1, 0) });
  const apr = hours.monthlyReport(db, 1, '2026-04', { now: L(2026, 5, 1, 0) });
  assert.equal(mar.totals.worked_h, 5); assert.equal(apr.totals.worked_h, 7);
  assert.equal(apr.totals.holiday_h, 7); assert.equal(mar.totals.holiday_h, 0);
});

test('pausa: es descompta si pot abandonar el lloc; computa si no pot (o lloc unipersonal)', () => {
  const { db, shift, ev, solo } = fixture();
  shift(L(2026, 3, 2, 7), L(2026, 3, 2, 19));
  ev('IN', L(2026, 3, 2, 7)); ev('BREAK_START', L(2026, 3, 2, 13)); ev('BREAK_END', L(2026, 3, 2, 13, 30)); ev('OUT', L(2026, 3, 2, 19));
  shift(L(2026, 3, 3, 7), L(2026, 3, 3, 19));
  ev('IN', L(2026, 3, 3, 7)); ev('BREAK_START', L(2026, 3, 3, 13), { cannot_leave_post: true }); ev('BREAK_END', L(2026, 3, 3, 13, 30)); ev('OUT', L(2026, 3, 3, 19));
  shift(L(2026, 3, 4, 7), L(2026, 3, 4, 19), solo);
  ev('IN', L(2026, 3, 4, 7)); const b = ev('BREAK_START', L(2026, 3, 4, 13)); ev('BREAK_END', L(2026, 3, 4, 13, 30)); ev('OUT', L(2026, 3, 4, 19));
  assert.equal(b.event.break_paid, 1);
  const m = hours.monthlyReport(db, 1, '2026-03', { now: L(2026, 4, 2, 0) });
  assert.equal(m.totals.worked_h, 35.5);
  assert.equal(m.totals.paid_break_h, 1); assert.equal(m.totals.unpaid_break_h, 0.5);
});

test('hores extra es calculen al tancament de mes respecte a la jornada (162 h)', () => {
  const { db, shift, ev } = fixture();
  for (let d = 1; d <= 14; d++) { shift(L(2026, 3, d, 7), L(2026, 3, d, 19)); ev('IN', L(2026, 3, d, 7)); ev('OUT', L(2026, 3, d, 19)); }
  const m = hours.monthlyReport(db, 1, '2026-03', { now: L(2026, 4, 2, 0) });
  assert.equal(m.totals.worked_h, 168); assert.equal(m.totals.overtime_h, 6); assert.equal(m.totals.contract_h, 162);
});

test('mode offline: s\'utilitza l\'hora real corregint el desfasament del rellotge', () => {
  const { db, u, shift, here } = fixture();
  shift(L(2026, 3, 2, 7), L(2026, 3, 2, 19));
  const realPunch = L(2026, 3, 2, 7, 2);
  const syncAt = L(2026, 3, 2, 9);
  const skew = -3 * 60e3; // el mòbil va 3 minuts endarrerit
  const r = records.createEvent(db, u, {
    type: 'IN', offline: true, ...here,
    device_time: new Date(realPunch.getTime() + skew).toISOString(),
    sent_at: new Date(syncAt.getTime() + skew).toISOString(),
  }, { now: syncAt });
  assert.equal(r.event.occurred_at, realPunch.toISOString());
  assert.equal(r.event.origin, 'offline');
  // Idempotència: el mateix uuid no duplica
  const again = records.createEvent(db, u, { type: 'IN', uuid: r.event.uuid, offline: true, device_time: realPunch.toISOString(), sent_at: syncAt.toISOString() }, { now: syncAt });
  assert.equal(again.duplicate, true);
});

test('correccions: no alteren l\'original i queden auditades', () => {
  const { db, hr, shift, ev } = fixture();
  shift(L(2026, 3, 2, 7), L(2026, 3, 2, 19));
  const { event } = ev('IN', L(2026, 3, 2, 7, 30));
  ev('OUT', L(2026, 3, 2, 19));
  assert.throws(() => records.correctEvent(db, hr, { action: 'modify', eventId: event.id, changes: { occurred_at: L(2026, 3, 2, 7).toISOString() }, reason: 'curt' }), e => e.code === 'REASON_REQUIRED');
  records.correctEvent(db, hr, { action: 'modify', eventId: event.id, changes: { occurred_at: L(2026, 3, 2, 7).toISOString() }, reason: 'El vigilant va fitxar tard per error de l\'app, confirmat pel CECOA' });
  const raw = db.prepare('SELECT occurred_at FROM time_events WHERE id = ?').get(event.id);
  assert.equal(raw.occurred_at, L(2026, 3, 2, 7, 30).toISOString());
  const m = hours.monthlyReport(db, 1, '2026-03', { now: L(2026, 4, 2, 0) });
  assert.equal(m.totals.worked_h, 12);
  const corr = db.prepare('SELECT * FROM corrections').all();
  assert.equal(corr.length, 1); assert.equal(corr[0].author_id, hr.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'correction.modify'").get().n, 1);
  assert.equal(chain.verify(db, 'corrections').ok, true);
});

test('part de servei: signatura obligatòria, segell de servidor i vinculació de prolongació', () => {
  const { db, u, shift, ev } = fixture();
  shift(L(2026, 3, 2, 7), L(2026, 3, 2, 19));
  ev('IN', L(2026, 3, 2, 7));
  const sig = 'data:image/png;base64,' + 'A'.repeat(400);
  assert.throws(() => reports.createReport(db, u, { incidents: [], no_incidents: true }), e => e.code === 'SIGNATURE_REQUIRED');
  ev('OUT', L(2026, 3, 2, 19, 30), { late_reason: 'ESPERA_RELLEU' });
  const { report } = reports.createReport(db, u, { signature_png: sig, incidents: [{ type: 'ALARMA', description: 'Salta alarma zona 3, falsa alarma' }] }, { now: L(2026, 3, 2, 19, 31) });
  assert.equal(report.incidents.length, 1);
  assert.equal(report.prolongations.length, 1); assert.equal(report.prolongations[0].late_minutes, 30);
  assert.throws(() => db.prepare('UPDATE service_reports SET summary = ?').run('x'), /REGISTRE_IMMUTABLE/);
});

test('dashboard: detecta absències i retards', () => {
  const { db, shift, ev } = fixture();
  shift(L(2026, 3, 2, 7), L(2026, 3, 2, 19));
  let s = dashboard.serviceStatus(db, { date: '2026-03-02', now: L(2026, 3, 2, 7, 10) });
  assert.equal(s.shifts[0].status, 'RETARD');
  s = dashboard.serviceStatus(db, { date: '2026-03-02', now: L(2026, 3, 2, 8) });
  assert.equal(s.shifts[0].status, 'ABSENT');
  ev('IN', L(2026, 3, 2, 8, 1));
  s = dashboard.serviceStatus(db, { date: '2026-03-02', now: L(2026, 3, 2, 9) });
  assert.equal(s.shifts[0].status, 'EN_SERVEI_AMB_RETARD'); assert.equal(s.shifts[0].late_minutes, 61);
});
