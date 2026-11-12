'use strict';
/** Dades de demostració: usuaris, client, instal·lacions, quadrant del mes i festius. */
const dbm = require('../src/db');
const auth = require('../src/auth');
const tz = require('../src/services/tz');

const db = dbm.get();
const T = dbm.settings(db).timezone;
const exists = db.prepare('SELECT COUNT(*) n FROM users').get().n;
if (exists) { console.log('La base de dades ja té usuaris; no es carreguen dades de demo.'); process.exit(0); }

const addUser = (tip, name, role, pw) => Number(db.prepare('INSERT INTO users(tip, name, role, password_hash) VALUES (?,?,?,?)').run(tip, name, role, auth.hashPassword(pw)).lastInsertRowid);
addUser('ADMIN', 'Administració', 'admin', 'admin1234');
addUser('RRHH01', 'Marta Recursos Humans', 'rrhh', 'rrhh12345');
addUser('CECOA1', 'Centre de Control', 'cecoa', 'cecoa1234');
const v1 = addUser('123456', 'Jordi Vigilant', 'vigilant', 'vigilant1');
const v2 = addUser('234567', 'Laura Vigilant', 'vigilant', 'vigilant2');

const c = Number(db.prepare('INSERT INTO clients(name, cif, report_email) VALUES (?,?,?)').run('Centre Comercial Diagonal', 'B00000000', null).lastInsertRowid);
const s1 = Number(db.prepare('INSERT INTO sites(client_id, name, address, lat, lng, radius_m, solo_post, critical) VALUES (?,?,?,?,?,?,?,?)')
  .run(c, 'Accés principal', 'Av. Diagonal 1, Barcelona', 41.3947, 2.1386, 200, 0, 1).lastInsertRowid);
const s2 = Number(db.prepare('INSERT INTO sites(client_id, name, address, lat, lng, radius_m, solo_post, critical) VALUES (?,?,?,?,?,?,?,?)')
  .run(c, 'Garita aparcament (lloc unipersonal)', 'Av. Diagonal 1, Barcelona', 41.3951, 2.1379, 150, 1, 0).lastInsertRowid);

const now = tz.parts(new Date(), T);
const ins = db.prepare('INSERT INTO shifts(user_id, site_id, planned_start, planned_end, month) VALUES (?,?,?,?,?)');
for (let d = 1; d <= 31; d++) {
  const n = tz.addDays(now.y, now.m, 1, d - 1);
  if (n.m !== now.m) break;
  const next = tz.addDays(n.y, n.m, n.d, 1);
  const month = `${n.y}-${String(n.m).padStart(2, '0')}`;
  // Patró 2x2: torns de 12 h (dia 07-19 / nit 19-07)
  const cycle = (d - 1) % 4;
  if (cycle < 2) ins.run(v1, s1, tz.zonedToUtc(n.y, n.m, n.d, 7, 0, T).toISOString(), tz.zonedToUtc(n.y, n.m, n.d, 19, 0, T).toISOString(), month);
  else ins.run(v1, s2, tz.zonedToUtc(n.y, n.m, n.d, 19, 0, T).toISOString(), tz.zonedToUtc(next.y, next.m, next.d, 7, 0, T).toISOString(), month);
  if (cycle >= 2) ins.run(v2, s1, tz.zonedToUtc(n.y, n.m, n.d, 7, 0, T).toISOString(), tz.zonedToUtc(n.y, n.m, n.d, 19, 0, T).toISOString(), month);
  else ins.run(v2, s2, tz.zonedToUtc(n.y, n.m, n.d, 19, 0, T).toISOString(), tz.zonedToUtc(next.y, next.m, next.d, 7, 0, T).toISOString(), month);
}
const hol = db.prepare('INSERT OR IGNORE INTO holidays(date, name, scope) VALUES (?,?,?)');
const y = now.y;
for (const [d, n] of [['01-01', 'Any Nou'], ['01-06', 'Reis'], ['05-01', 'Festa del Treball'], ['06-24', 'Sant Joan'], ['08-15', 'Assumpció'],
  ['09-11', 'Diada Nacional de Catalunya'], ['10-12', 'Festa Nacional d\'Espanya'], ['11-01', 'Tots Sants'], ['12-06', 'Constitució'],
  ['12-08', 'Immaculada'], ['12-25', 'Nadal'], ['12-26', 'Sant Esteve']]) hol.run(`${y}-${d}`, n, 'nacional');
console.log('Dades de demo creades.\n  Oficina: ADMIN / admin1234 · RRHH01 / rrhh12345 · CECOA1 / cecoa1234\n  Vigilants: 123456 / vigilant1 · 234567 / vigilant2');
