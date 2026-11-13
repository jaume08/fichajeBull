'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const dbm = require('../src/db');
const auth = require('../src/auth');
const q = require('../src/services/quadrantImport');
const hours = require('../src/services/hours');

const T = 'Europe/Madrid';
const days = Array.from({ length: 31 }, (_, i) => String(i + 1));

/** CSV en el format de l'empresa (Windows-1252, separador coma, decimals amb coma). */
function companyCsv() {
  const pad = (row, n = 39) => { const r = [...row]; while (r.length < n) r.push(''); return r; };
  const cells = (map) => { const r = Array(31).fill(''); for (const [d, v] of Object.entries(map)) r[d - 1] = v; return r; };
  const rows = [
    pad([]), pad(['', 'CONSERJERÍA MARAGALL']),
    pad(['', '1520,30 BRUTOS/40H SEMANALES', '', '8 AZUL (PLUS URGENCIA), 8E (HORA EXTRA)', '', '', 'SETIEMBRE', '', '', '2026    ', '', 'DIRECCIÓN', '', '', 'Carrer de Joan Maragall, 29, 17002, Girona']),
    pad(['', '', '', '', '', '', ...days, 'TOTAL HORAS', 'TOTAL BRUTO']),
    pad(['', 'PERSONAL', 'TELÉFONOS', 'JORNADA (H/SEM)', 'OBSERVACIONES', 'HORARIO', 'M', 'X', 'J']),
    // Treballadora amb jornada partida (dues franges) i vacances
    pad(['', 'Anna Puig', '611 22 33 44', '30', '', 'INICIO', ...cells({ 1: '8:30', 2: '8:30', 3: 'VAC' })]),
    pad(['', '', '', '', '', 'FIN', ...cells({ 1: '14:30', 2: '14:30', 3: '26' })]),
    pad(['', '', '', '', '', '', ...cells({ 1: '6,00', 2: '6,00' }), '12,00', '1,00 €']),
    pad(['', 'Anna Puig', '611 22 33 44', '10', '', 'INICIO', ...cells({ 1: '15:30', 3: 'VAC' })]),
    pad(['', '', '', '', '', 'FIN', ...cells({ 1: '17:30', 3: '26' })]),
    pad(['', '', '', '', '', '', ...cells({ 1: '2,00' }), '2,00', '1,00 €']),
    // Torn de nit
    pad(['', 'Pere Nit', '622000000', 'COMPLETA', '', 'INICIO', ...cells({ 5: '23:00' })]),
    pad(['', '', '', '', '', 'FIN', ...cells({ 5: '7:00' })]),
    pad(['', '', '', '', '', '', ...cells({ 5: '8,00' }), '8,00', '1,00 €']),
    pad(['', '', '', '', '', 'INICIO']), pad(['', '', '', '', '', 'FIN']), pad(['', '', '', '', '', '', ...Array(31).fill(''), '0,00', '0,00 €']),
    pad(['', '', '', '', '', '', ...Array(31).fill(''), '22,00', '']),
  ];
  const text = rows.map(r => r.map(v => (/[,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\r\n');
  // codificació Windows-1252 (Latin-1 per a aquests caràcters)
  return Buffer.from(text, 'latin1');
}

/** Excel amb hores com a Date (format h:mm), negatives (plus urgència), E, T i baixa IT. */
async function companyXlsx() {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('BR BCN');
  const t = (h, m = 0) => new Date(Date.UTC(1899, 11, 30, h, m));
  ws.getCell('B3').value = 'CONSERJERIA SAGRERA';
  ws.getCell('B4').value = 9.36; ws.getCell('G4').value = 'SETIEMBRE'; ws.getCell('J4').value = 2026; ws.getCell('L4').value = 'DIRECCIÓN'; ws.mergeCells('L4:N4'); ws.getCell('O4').value = 'C/ Prova 1, Barcelona';
  days.forEach((d, i) => { ws.getCell(5, 7 + i).value = Number(d); });
  ws.getCell(5, 38).value = 'TOTAL HORAS';
  ['PERSONAL', 'TELÉFONOS', 'JORNADA', 'OBSERVACIONES', 'HORARIO'].forEach((v, i) => { ws.getCell(6, 2 + i).value = v; });
  const put = (r, name, startCells, endCells, hourCells, total) => {
    ws.getCell(r, 2).value = name; ws.getCell(r, 6).value = 'INICIO'; ws.getCell(r + 1, 6).value = 'FIN';
    for (const [d, v] of Object.entries(startCells)) { const c = ws.getCell(r, 6 + Number(d)); c.value = v; c.numFmt = 'h:mm'; }
    for (const [d, v] of Object.entries(endCells)) { const c = ws.getCell(r + 1, 6 + Number(d)); c.value = v; c.numFmt = 'h:mm'; }
    for (const [d, v] of Object.entries(hourCells)) ws.getCell(r + 2, 6 + Number(d)).value = v;
    ws.getCell(r + 2, 38).value = { formula: 'SUM(1)', result: total };
  };
  put(7, 'Laia Urgent', { 1: t(8), 2: t(16), 3: 'BAJA' }, { 1: t(16), 2: t(0), 3: 'IT' }, { 1: -8, 2: '8E' }, 16);
  put(10, 'Marc Descompte', { 4: t(8) }, { 4: t(16) }, { 4: 8, 5: '8T' }, 0);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function freshDb() {
  const db = dbm.open(':memory:');
  const admin = { id: auth.createUser(db, { tip: 'ADMIN', name: 'Admin', role: 'admin', password: 'x' }) };
  return { db, admin };
}

test('quadrant CSV (Windows-1252): blocs, jornada partida, vacances i torn de nit', async () => {
  const p = await q.parseFile(companyCsv(), 'CUADRANTES.csv', T);
  assert.equal(p.format, 'csv');
  assert.deepEqual(p.months, ['2026-09']);
  const b = p.blocks[0];
  assert.equal(b.service, 'CONSERJERÍA MARAGALL');
  assert.equal(b.address, 'Carrer de Joan Maragall, 29, 17002, Girona');
  assert.equal(b.shifts.length, 4);
  assert.equal(b.absences.filter(a => a.type === 'VAC').length, 2); // dues files, mateix dia
  const night = b.shifts.find(s => s.worker === 'Pere Nit');
  assert.equal(night.start, '2026-09-05T21:00:00.000Z'); // 23:00 local (CEST)
  assert.equal(night.end, '2026-09-06T05:00:00.000Z');   // 07:00 de l'endemà
  assert.equal(p.workers.length, 2);                      // Anna Puig agrupada (dues files)
  assert.equal(p.warnings.length, 0);
});

test('quadrant Excel: plus urgència (negatiu), hora extra (E), descompte (T), baixa IT, fi a mitjanit', async () => {
  const p = await q.parseFile(await companyXlsx(), 'q.xlsx', T);
  const b = p.blocks[0];
  assert.equal(b.address, 'C/ Prova 1, Barcelona');
  const laia = b.shifts.filter(s => s.worker === 'Laia Urgent');
  assert.equal(laia[0].kind, 'urgencia'); assert.equal(laia[0].hours, 8);
  assert.equal(laia[1].kind, 'extra'); assert.equal(laia[1].end, '2026-09-02T22:00:00.000Z'); // 16:00–00:00
  assert.deepEqual(b.absences.map(a => [a.worker, a.type, a.hours]), [['Laia Urgent', 'IT', 0], ['Marc Descompte', 'T', 8]]);
  assert.equal(p.warnings.length, 0, p.warnings.join('\n')); // totals del full quadren (16 i 8-8=0)
});

test('importació: crea usuaris i instal·lació, còmput per tipus i reimportació idempotent', async () => {
  const { db, admin } = freshDb();
  const buf = await companyXlsx();
  const parsed = await q.parseFile(buf, 'q.xlsx', T);
  const pv = q.preview(db, parsed);
  assert.ok(pv.workers.every(w => w.match === 'nou'));
  const decisions = { workers: Object.fromEntries(pv.workers.map(w => [w.key, { action: 'create' }])), sites: { 0: { action: 'create' } } };
  const r = q.commit(db, admin, parsed, 'q.xlsx', decisions);
  assert.equal(r.created, 3); assert.equal(r.absences, 2); assert.equal(r.users_created.length, 2); assert.equal(r.sites_created.length, 1);
  assert.ok(r.users_created.every(u => /^Q\d{4}$/.test(u.tip) && u.password.length >= 10));

  const laia = db.prepare("SELECT id FROM users WHERE name = 'Laia Urgent'").get().id;
  const m = hours.monthlyReport(db, laia, '2026-09', { now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(m.totals.planned_h, 16); assert.equal(m.totals.planned_urgencia_h, 8); assert.equal(m.totals.planned_extra_h, 8);
  assert.equal(m.totals.absence_days.IT, 1);
  const marc = db.prepare("SELECT id FROM users WHERE name = 'Marc Descompte'").get().id;
  assert.equal(hours.monthlyReport(db, marc, '2026-09').totals.deducted_h, 8);
  const sv = hours.serviceReport(db, '2026-09', { now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(sv.sites[0].site_name, 'CONSERJERIA SAGRERA'); assert.equal(sv.sites[0].planned_h, 24);

  // Reimportar el mateix fitxer: tot es manté, res de nou
  const pv2 = q.preview(db, parsed);
  assert.ok(pv2.workers.every(w => w.suggested_user_id));
  assert.ok(pv2.previous_import);
  const dec2 = { workers: Object.fromEntries(pv2.workers.map(w => [w.key, { action: 'map', user_id: w.suggested_user_id }])), sites: { 0: { action: 'map', site_id: pv2.blocks[0].suggested_site_id } } };
  const r2 = q.commit(db, admin, parsed, 'q.xlsx', dec2);
  assert.equal(r2.created, 0); assert.equal(r2.kept, 3); assert.equal(r2.cancelled, 0); assert.equal(r2.absences, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM shifts WHERE status = 'planned'").get().n, 3);
});

test('reimportació amb canvis: cancel·la torns que han desaparegut però conserva els que tenen fitxatges', async () => {
  const { db, admin } = freshDb();
  const parsed = await q.parseFile(companyCsv(), 'q.csv', T);
  const pv = q.preview(db, parsed);
  q.commit(db, admin, parsed, 'q.csv', { workers: Object.fromEntries(pv.workers.map(w => [w.key, { action: 'create' }])), sites: { 0: { action: 'create' } } });
  // Nova versió del quadrant: s'elimina el torn de nit
  const edited = companyCsv().toString('latin1').replace(/23:00/, '').replace(/,7:00,/, ',,').replace(/"8,00",,/, ',,');
  const parsed2 = await q.parseFile(Buffer.from(edited, 'latin1'), 'q2.csv', T);
  const pv2 = q.preview(db, parsed2);
  const r = q.commit(db, admin, parsed2, 'q2.csv', { workers: Object.fromEntries(pv2.workers.map(w => [w.key, { action: 'map', user_id: w.suggested_user_id }])), sites: { 0: { action: 'map', site_id: pv2.blocks[0].suggested_site_id } } });
  assert.equal(r.cancelled, 1); assert.equal(r.kept, 3);
});
