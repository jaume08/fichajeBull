'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dbm = require('../src/db');
const auth = require('../src/auth');

const db = dbm.open(':memory:');
dbm.setInstance(db);
const { createApp } = require('../src/app');

test('API: login, fitxatge, part, exportació i integritat', async t => {
  db.prepare('INSERT INTO users(tip,name,role,password_hash) VALUES (?,?,?,?)').run('ADMIN', 'Admin', 'admin', auth.hashPassword('admin1234'));
  db.prepare('INSERT INTO users(tip,name,role,password_hash) VALUES (?,?,?,?)').run('123456', 'Vigilant', 'vigilant', auth.hashPassword('vigilant1'));
  db.prepare("INSERT INTO clients(name) VALUES ('C')").run();
  db.prepare("INSERT INTO sites(client_id,name,lat,lng,radius_m) VALUES (1,'S',41.39,2.17,100)").run();
  const now = Date.now();
  db.prepare("INSERT INTO shifts(user_id,site_id,planned_start,planned_end,month) VALUES (2,1,?,?,?)")
    .run(new Date(now - 3600e3).toISOString(), new Date(now + 6 * 3600e3).toISOString(), new Date().toISOString().slice(0, 7));

  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { token, method = 'GET', body } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };

  assert.equal((await call('/api/login', { method: 'POST', body: { tip: '123456', password: 'x' } })).status, 401);
  const w = (await call('/api/login', { method: 'POST', body: { tip: '123456', password: 'vigilant1' } })).body.token;
  const a = (await call('/api/login', { method: 'POST', body: { tip: 'admin', password: 'admin1234' } })).body.token;
  assert.ok(w && a);

  assert.equal((await call('/api/admin/dashboard', { token: w })).status, 403);
  const me = await call('/api/worker/me', { token: w });
  assert.equal(me.body.state, 'off');

  const inn = await call('/api/worker/events', { token: w, method: 'POST', body: { type: 'IN', lat: 41.39, lng: 2.17, accuracy: 5 } });
  assert.equal(inn.status, 201); assert.equal(inn.body.state.state, 'working');

  const sync = await call('/api/worker/sync', { token: w, method: 'POST', body: { sent_at: new Date().toISOString(), items: [
    { kind: 'event', uuid: '00000000-0000-4000-8000-000000000001', device_time: new Date().toISOString(), data: { type: 'BREAK_START', lat: 41.39, lng: 2.17 } },
  ] } });
  assert.equal(sync.body.results[0].ok, true); assert.equal(sync.body.state.state, 'break');

  const rep = await call('/api/worker/reports', { token: w, method: 'POST', body: { signature_png: 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(40), no_incidents: true } });
  assert.equal(rep.status, 201);

  const dash = await call('/api/admin/dashboard', { token: a });
  assert.equal(dash.body.shifts[0].status, 'PAUSA');

  const month = new Date().toISOString().slice(0, 7);
  const xlsx = await call(`/api/admin/export?format=xlsx&from=${month}&to=${month}`, { token: a });
  assert.equal(xlsx.status, 200); assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
  const pdf = await call(`/api/admin/export?format=pdf&from=${month}&to=${month}`, { token: a });
  assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');

  const integ = await call('/api/admin/integrity', { token: a });
  assert.equal(integ.body.ok, true);
  const log = await call('/api/admin/audit', { token: a });
  assert.ok(log.body.log.some(l => l.action === 'export.inspection'));
});
