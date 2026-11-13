'use strict';
/**
 * Importador dels quadrants mensuals en el format de l'empresa (Excel .xlsx o la seva
 * exportació .csv). Format per blocs de servei:
 *
 *   [nom del servei]
 *   [tarifa/nota] ... [MES] [ANY] ... DIRECCIÓN [adreça]
 *   ... 1 2 3 ... 31 TOTAL HORAS TOTAL BRUTO           ← fila de dies
 *   PERSONAL TELÉFONOS JORNADA OBSERVACIONES HORARIO ... ← capçalera
 *   [nom] [tel] [jornada] [obs] INICIO  8:30 ...        ┐
 *                               FIN    14:30 ...        ├ un "triplet" per franja
 *                                      6,00  ...  96,00 ┘ (hores del dia + total)
 *
 * Valors de la fila d'hores (segons les fórmules del full):
 *   6     hores normals
 *   -6    hores amb PLUS URGÈNCIA (en blau al full: format condicional < 0)
 *   8E    hores extra
 *   8T/8F hores a descomptar (T) / falta (F) — sense franja horària
 * Codis a INICIO/FIN: VAC (vacances), BAJA/IT (baixa IT), FI (falta injustificada).
 */
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const dbm = require('../db');
const tz = require('./tz');
const audit = require('./audit');
const { RuleError } = require('./records');

const MONTHS = {
  ENERO: 1, GENER: 1, FEBRERO: 2, FEBRER: 2, MARZO: 3, MARC: 3, ABRIL: 4, MAYO: 5, MAIG: 5, JUNIO: 6, JUNY: 6,
  JULIO: 7, JULIOL: 7, AGOSTO: 8, AGOST: 8, SEPTIEMBRE: 9, SETIEMBRE: 9, SETEMBRE: 9, OCTUBRE: 10,
  NOVIEMBRE: 11, NOVEMBRE: 11, DICIEMBRE: 12, DESEMBRE: 12,
};
const ABSENCE_TYPES = {
  VAC: 'Vacances', IT: 'Baixa (IT)', FI: 'Falta injustificada', F: 'Falta', T: 'Hores a descomptar', ALTRES: 'Altres',
};
const KIND_LABEL = { normal: 'Normal', urgencia: 'Plus urgència', extra: 'Hora extra' };

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
const digits = s => String(s ?? '').replace(/\D/g, '');
const colLetter = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const r2 = n => Math.round(n * 100) / 100;

/* ---------------- Lectura a graella de textos ---------------- */

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).slice(0, 15);
  const count = ch => lines.reduce((n, l) => { let q = false, c = 0; for (const x of l) { if (x === '"') q = !q; else if (x === ch && !q) c++; } return n + c; }, 0);
  const sep = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  // graella 1-indexada (com Excel): grid[r][c]
  return rows.map(r => [null, ...r.map(v => v.trim())]);
}

function cellText(v, numFmt) {
  if (v == null) return '';
  if (v instanceof Date) {
    const m = v.getUTCHours() * 60 + v.getUTCMinutes() + (v.getUTCSeconds() >= 30 ? 1 : 0);
    return `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, '0')}`;
  }
  if (typeof v === 'number') {
    if (numFmt && /h/i.test(numFmt) && !/0\.0/.test(numFmt) && v >= 0 && v < 1.0001) {
      const m = Math.round(v * 1440); return `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, '0')}`;
    }
    return String(v);
  }
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(t => t.text).join('').trim();
    if ('formula' in v || 'sharedFormula' in v) return cellText(v.result, numFmt);
    if (v.error) return '';
    if (v.text) return String(v.text).trim();
    return '';
  }
  return String(v).trim();
}

async function readGrids(buf, filename = '') {
  const isXlsx = buf[0] === 0x50 && buf[1] === 0x4b;
  if (!isXlsx) return { format: 'csv', sheets: [{ name: filename.replace(/\.[^.]+$/, '') || 'CSV', grid: parseCsv(decodeText(buf)), ref: (r, c) => `fila ${r}, col ${colLetter(c)}` }] };
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch { throw new RuleError('INVALID_FILE', 'No s\'ha pogut llegir el fitxer Excel', { status: 400 }); }
  const sheets = [];
  for (const ws of wb.worksheets) {
    if (ws.state && ws.state !== 'visible') continue;
    const grid = [];
    ws.eachRow({ includeEmpty: true }, (row, r) => {
      const out = [null];
      for (let c = 1; c <= Math.max(row.cellCount, 40); c++) { const cell = row.getCell(c); out[c] = cellText(cell.value, cell.numFmt); }
      grid[r] = out;
    });
    for (let r = 0; r < grid.length; r++) if (!grid[r]) grid[r] = [null];
    sheets.push({ name: ws.name, grid, ref: (r, c) => `${ws.name}!${colLetter(c)}${r}` });
  }
  return { format: 'xlsx', sheets };
}

/* ---------------- Interpretació de valors ---------------- */

function parseTime(s) {
  const m = /^(\d{1,2})[:.h](\d{2})(?::\d{2})?$/.exec(String(s).trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 24 || mi > 59 || (h === 24 && mi)) return null;
  return h * 60 + mi;
}

function parseNumber(s) {
  let t = String(s).replace(/[€\s]/g, '');
  if (t.includes('.') && t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

/** Valor de la fila d'hores → { hours, kind:'normal'|'urgencia'|'extra'|'T'|'F' } */
function parseHours(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const m = /^(-?\d+(?:[.,]\d+)?)\s*([ETF])?$/i.exec(t.replace(/\s/g, ''));
  if (!m) return { invalid: t };
  const n = parseNumber(m[1]);
  const suf = (m[2] || '').toUpperCase();
  if (suf === 'E') return { hours: Math.abs(n), kind: 'extra' };
  if (suf === 'T' || suf === 'F') return { hours: Math.abs(n), kind: suf };
  if (n < 0) return { hours: -n, kind: 'urgencia' };
  return { hours: n, kind: 'normal' };
}

function absenceCode(a, b) {
  const t = norm(`${a} ${b}`);
  if (/\bVAC/.test(t)) return 'VAC';
  if (/\bBAJA\b|\bBAIXA\b|\bIT\b/.test(t)) return 'IT';
  if (/^FI\b/.test(t)) return 'FI';
  return 'ALTRES';
}

/* ---------------- Anàlisi del fitxer ---------------- */

function findHeaderCols(row) {
  const cols = {};
  row.forEach((v, c) => {
    const n = norm(v);
    if (n === 'PERSONAL' && !cols.name) cols.name = c;
    else if (n.startsWith('TELEF') && !cols.phone) cols.phone = c;
    else if (n.startsWith('JORNADA') && !cols.jornada) cols.jornada = c;
    else if (n.startsWith('OBSERV') && !cols.obs) cols.obs = c;
    else if (n === 'HORARIO' || n === 'HORARI') cols.horario = c;
  });
  return cols.name && cols.horario ? cols : null;
}

function parseSheet(sheet, timezone, warn) {
  const { grid, ref } = sheet;
  const g = (r, c) => (grid[r] && grid[r][c]) || '';
  const blocks = [];
  for (let h = 1; h < grid.length; h++) {
    const cols = findHeaderCols(grid[h] || []);
    if (!cols) continue;
    const ctx = `${sheet.name} (fila ${h})`;
    // Fila de dies (just a sobre de la capçalera)
    const dayCols = new Map(); let totalCol = null;
    (grid[h - 1] || []).forEach((v, c) => {
      const n = parseNumber(v);
      if (c > cols.horario && n != null && Number.isInteger(n) && n >= 1 && n <= 31 && ![...dayCols.values()].includes(n)) dayCols.set(c, n);
      if (norm(v) === 'TOTAL HORAS' || norm(v) === 'TOTAL HORES') totalCol = c;
    });
    if (!dayCols.size) { warn(`${ctx}: no s'ha trobat la fila de dies (1…31); bloc ignorat`); continue; }
    // Fila d'informació (mes, any, adreça) i nom del servei
    let info = null; let month = null; let year = null; let address = null;
    for (let r = h - 2; r >= Math.max(1, h - 5) && !info; r--) {
      (grid[r] || []).forEach((v, c) => {
        if (month || !MONTHS[norm(v)]) return;
        info = r; month = MONTHS[norm(v)];
        for (let k = c + 1; k < c + 8; k++) { const y = String(g(r, k)).trim(); if (/^\d{4}$/.test(y)) { year = +y; break; } }
      });
    }
    if (!info || !year) { warn(`${ctx}: no s'ha trobat el mes i l'any del quadrant; bloc ignorat`); continue; }
    (grid[info] || []).forEach((v, c) => {
      // (a l'Excel l'etiqueta és una cel·la combinada que es repeteix a les cel·les veïnes)
      if (!address && /^DIRECCI(O|ON)$/.test(norm(v))) for (let k = c + 1; k < c + 12; k++) if (g(info, k) && !/^DIRECCI(O|ON)$/.test(norm(g(info, k)))) { address = g(info, k); break; }
    });
    let service = null;
    for (let r = info - 1; r >= Math.max(1, info - 3) && !service; r--) if (g(r, cols.name)) service = g(r, cols.name);
    if (!service) { warn(`${ctx}: bloc sense nom de servei; ignorat`); continue; }
    const rateNote = g(info, cols.name) || null;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const block = { sheet: sheet.name, header_row: h, service: service.trim(), address, rate_note: rateNote, month: monthStr, rows: [], shifts: [], absences: [] };

    let r = h + 1;
    while (norm(g(r, cols.horario)) === 'INICIO' && norm(g(r + 1, cols.horario)) === 'FIN') {
      const name = g(r, cols.name).trim();
      const row = { name, phone: cols.phone ? digits(g(r, cols.phone)) : '', jornada: cols.jornada ? g(r, cols.jornada) : '', obs: cols.obs ? g(r, cols.obs) : '',
        source_row: r, computed_total: 0, declared_total: totalCol ? parseNumber(g(r + 2, totalCol)) : null, shifts: 0 };
      let hasContent = false;
      for (const [c, day] of dayCols) {
        const a = g(r, c); const b = g(r + 1, c); const hv = g(r + 2, c);
        if (!a && !b && (!hv || parseNumber(hv) === 0)) continue;
        hasContent = true;
        if (day > daysInMonth) { warn(`${ref(r, c)}: el dia ${day} no existeix al mes ${monthStr}; ignorat`); continue; }
        const hp = parseHours(hv);
        if (hp && hp.invalid) warn(`${ref(r + 2, c)}: valor d'hores no reconegut "${hp.invalid}"`);
        const ta = parseTime(a); const tb = parseTime(b);
        const base = { worker: name, phone: row.phone, block: blocks.length, day, date: `${monthStr}-${String(day).padStart(2, '0')}`, ref: ref(r, c) };
        if (ta != null && tb != null) {
          const start = tz.zonedToUtc(year, month, day, Math.floor(ta / 60), ta % 60, timezone);
          // Si l'hora de fi és igual o anterior a la d'inici (o 24:00), el torn acaba l'endemà
          const nd = tb <= ta || tb === 1440 ? tz.addDays(year, month, day, 1) : { y: year, m: month, d: day };
          const endFix = tz.zonedToUtc(nd.y, nd.m, nd.d, Math.floor((tb % 1440) / 60), tb % 60, timezone);
          const dur = r2((endFix - start) / 3600e3);
          let kind = 'normal'; let hours = dur;
          if (hp && !hp.invalid) {
            if (hp.kind === 'T' || hp.kind === 'F') warn(`${ref(r + 2, c)}: "${hv}" amb franja horària; es tracta com a torn normal`);
            else { kind = hp.kind; hours = hp.hours; }
            if (Math.abs(dur - hp.hours) > 0.01) warn(`${ref(r, c)} (${name}): la franja ${a}–${b} dura ${dur} h però el quadrant indica ${hp.hours} h; es compten ${hours} h`);
          }
          block.shifts.push({ ...base, start: start.toISOString(), end: endFix.toISOString(), start_local: a, end_local: b, hours, kind });
          row.shifts++;
          row.computed_total += hours;
        } else if ((a && ta == null) || (b && tb == null)) {
          const type = absenceCode(a, b);
          const hours = hp && !hp.invalid && (hp.kind === 'T' || hp.kind === 'F') ? hp.hours : 0;
          block.absences.push({ ...base, type, hours, note: [a, b].filter(Boolean).join(' / ') });
          if (hours) row.computed_total -= hours;
        } else if (!a && !b && hp && !hp.invalid) {
          if (hp.kind === 'T' || hp.kind === 'F') { block.absences.push({ ...base, type: hp.kind, hours: hp.hours, note: hv }); row.computed_total -= hp.hours; }
          else warn(`${ref(r + 2, c)} (${name}): ${hv} h sense hora d'inici ni de fi; no es pot crear el torn`);
        } else {
          warn(`${ref(r, c)} (${name}): falta l'hora ${ta == null ? 'd\'inici' : 'de fi'}; ignorat`);
        }
      }
      row.computed_total = r2(row.computed_total);
      if (name) {
        if (row.declared_total != null && Math.abs(row.declared_total - row.computed_total) > 0.01) {
          warn(`${sheet.name} fila ${r} (${name}): TOTAL HORAS del full = ${row.declared_total} h, calculat = ${row.computed_total} h`);
        }
        block.rows.push(row);
      } else if (hasContent) warn(`${sheet.name} fila ${r}: hi ha horaris però no hi ha nom de treballador; ignorat`);
      r += 3;
    }
    // Les franges sense nom no s'importen
    block.shifts = block.shifts.filter(s => s.worker); block.absences = block.absences.filter(a => a.worker);
    blocks.push(block);
    h = r - 1;
  }
  return blocks;
}

/** Clau d'agrupació de treballadors dins del fitxer */
const workerKey = (name, phone) => `${norm(name)}|${phone || ''}`;

async function parseFile(buf, filename, timezone) {
  const { format, sheets } = await readGrids(buf, filename);
  const warnings = [];
  const blocks = [];
  for (const s of sheets) {
    const sheetWarnings = [];
    const b = parseSheet(s, timezone, w => sheetWarnings.push(w));
    if (b.length) { blocks.push(...b.map(x => ({ ...x }))); warnings.push(...sheetWarnings); }
  }
  blocks.forEach((b, i) => { b.index = i; b.shifts.forEach(s => { s.block = i; }); b.absences.forEach(a => { a.block = i; }); });
  if (!blocks.length) throw new RuleError('NO_BLOCKS', 'No s\'ha trobat cap bloc de quadrant (cal la capçalera PERSONAL … HORARIO amb INICIO/FIN)', { status: 422 });

  // Treballadors únics (un treballador pot sortir en diversos serveis i files)
  const workers = new Map();
  for (const b of blocks) for (const row of b.rows) {
    const k = workerKey(row.name, row.phone);
    if (!workers.has(k)) workers.set(k, { key: k, name: row.name, phone: row.phone, jornadas: [], observations: new Set(), services: new Set(), shifts: 0, hours: 0 });
    const w = workers.get(k);
    w.jornadas.push(row.jornada); if (row.obs) w.observations.add(row.obs); w.services.add(b.service);
  }
  for (const b of blocks) for (const s of b.shifts) { const w = workers.get(workerKey(s.worker, s.phone)); w.shifts++; w.hours = r2(w.hours + s.hours); }

  // Solapaments dins del mateix fitxer
  const byWorker = new Map();
  for (const b of blocks) for (const s of b.shifts) { const k = workerKey(s.worker, s.phone); if (!byWorker.has(k)) byWorker.set(k, []); byWorker.get(k).push({ ...s, service: b.service }); }
  for (const [, list] of byWorker) {
    list.sort((x, y) => x.start.localeCompare(y.start));
    for (let i = 1; i < list.length; i++) if (list[i].start < list[i - 1].end) {
      warnings.push(`${list[i].worker}: el torn ${list[i].date} ${list[i].start_local}–${list[i].end_local} (${list[i].service}) se solapa amb ${list[i - 1].date} ${list[i - 1].start_local}–${list[i - 1].end_local} (${list[i - 1].service})`);
    }
  }

  return {
    format, sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    months: [...new Set(blocks.map(b => b.month))].sort(),
    blocks, workers: [...workers.values()].map(w => ({ ...w, observations: [...w.observations], services: [...w.services] })),
    warnings,
  };
}

/** Jornada setmanal → hores mensuals del conveni (40 h/setmana = jornada mensual per defecte) */
function monthlyFromJornada(jornadas, defaultMonthly) {
  const nums = jornadas.map(parseNumber).filter(n => n != null && n > 0 && n <= 60);
  if (nums.length) return r2(nums.reduce((a, b) => a + b, 0) / 40 * defaultMonthly);
  if (jornadas.some(j => norm(j).startsWith('COMPLET'))) return null; // jornada completa = valor per defecte
  return undefined; // desconeguda (p. ex. PARCIAL sense hores)
}

/** Proposta d'emparellament amb usuaris i instal·lacions existents */
function preview(db, parsed) {
  const S = dbm.settings(db);
  const users = db.prepare('SELECT id, tip, name, phone, role, active FROM users').all();
  const sites = db.prepare('SELECT s.id, s.name, s.address, c.name AS client_name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.active = 1').all();
  const workers = parsed.workers.map(w => {
    const byPhone = w.phone ? users.filter(u => u.phone && digits(u.phone) === w.phone) : [];
    const byName = users.filter(u => norm(u.name) === norm(w.name));
    const both = byPhone.filter(u => byName.includes(u));
    const cand = both.length ? both : byName.length === 1 ? byName : byPhone.length === 1 && !byName.length ? byPhone : byName.length ? byName : byPhone;
    const monthly = monthlyFromJornada(w.jornadas, Number(S.monthly_hours));
    return { ...w, suggested_user_id: cand.length === 1 ? cand[0].id : null, candidates: cand.map(u => u.id),
      match: cand.length === 1 ? (both.length ? 'nom i telèfon' : byName.length ? 'nom' : 'telèfon') : cand.length > 1 ? 'ambigu' : 'nou',
      suggested_monthly_hours: monthly === undefined ? null : monthly, jornada_unknown: monthly === undefined };
  });
  const blocks = parsed.blocks.map(b => {
    const exact = sites.filter(s => norm(s.name) === norm(b.service));
    const totals = { normal: 0, urgencia: 0, extra: 0 };
    for (const s of b.shifts) totals[s.kind] = r2(totals[s.kind] + s.hours);
    const abs = {}; for (const a of b.absences) abs[a.type] = (abs[a.type] || 0) + 1;
    return { index: b.index, sheet: b.sheet, service: b.service, address: b.address, rate_note: b.rate_note, month: b.month,
      workers: [...new Set(b.rows.map(r => r.name))].length, shifts: b.shifts.length, hours: totals, absences: abs,
      suggested_site_id: exact.length === 1 ? exact[0].id : null,
      declared_total: r2(b.rows.reduce((a, r) => a + (r.declared_total || 0), 0)),
      computed_total: r2(b.rows.reduce((a, r) => a + r.computed_total, 0)) };
  });
  return { format: parsed.format, sha256: parsed.sha256, months: parsed.months, blocks, workers, warnings: parsed.warnings,
    users: users.filter(u => u.active).map(u => ({ id: u.id, tip: u.tip, name: u.name, phone: u.phone, role: u.role })),
    sites, absence_types: ABSENCE_TYPES, kinds: KIND_LABEL,
    previous_import: db.prepare('SELECT id, filename, created_at FROM shift_imports WHERE sha256 = ? ORDER BY id DESC LIMIT 1').get(parsed.sha256) || null };
}

/**
 * Aplica la importació. decisions = {
 *   workers: { [key]: { action:'map', user_id } | { action:'create', tip?, role? } | { action:'skip' } },
 *   sites:   { [blockIndex]: { action:'map', site_id } | { action:'create' } | { action:'skip' } } }
 * Mode substitució: per a cada instal·lació i mes importats, els torns planificats que ja no hi
 * són (i que no tenen fitxatges) es cancel·len; els idèntics es mantenen.
 */
function commit(db, actor, parsed, filename, decisions = {}, ip = null) {
  const S = dbm.settings(db);
  const wDec = decisions.workers || {}; const sDec = decisions.sites || {};
  const res = { created: 0, kept: 0, cancelled: 0, absences: 0, users_created: [], sites_created: [], errors: [], kept_with_events: 0 };
  const { createUser } = require('../auth');

  return dbm.tx(db, () => {
    const imp = db.prepare('INSERT INTO shift_imports(filename, format, sha256, months, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(String(filename || 'quadrant').slice(0, 200), parsed.format, parsed.sha256, parsed.months.join(','), actor.id, new Date().toISOString());
    const importId = Number(imp.lastInsertRowid);

    // Treballadors
    const userOf = new Map();
    let auto = db.prepare("SELECT COUNT(*) n FROM users WHERE tip LIKE 'Q%'").get().n;
    for (const w of parsed.workers) {
      const d = wDec[w.key] || { action: 'skip' };
      if (d.action === 'map') {
        const u = db.prepare('SELECT id, phone FROM users WHERE id = ?').get(Number(d.user_id));
        if (!u) { res.errors.push(`${w.name}: usuari inexistent`); continue; }
        if (w.phone && !u.phone) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(w.phone, u.id);
        userOf.set(w.key, u.id);
      } else if (d.action === 'create') {
        let tip = String(d.tip || '').trim().toUpperCase();
        if (!tip) { do { auto++; tip = `Q${String(auto).padStart(4, '0')}`; } while (db.prepare('SELECT 1 FROM users WHERE tip = ?').get(tip)); }
        if (db.prepare('SELECT 1 FROM users WHERE upper(tip) = ?').get(tip)) { res.errors.push(`${w.name}: el TIP ${tip} ja existeix`); continue; }
        const monthly = monthlyFromJornada(w.jornadas, Number(S.monthly_hours));
        const password = crypto.randomBytes(9).toString('base64url');
        const id = createUser(db, { tip, name: w.name, phone: w.phone || null, role: ['vigilant', 'cecoa', 'operacions'].includes(d.role) ? d.role : 'vigilant', password, monthly_hours: monthly ?? null });
        userOf.set(w.key, id);
        res.users_created.push({ id, tip, name: w.name, password });
      }
    }

    // Instal·lacions
    const siteOf = new Map();
    for (const b of parsed.blocks) {
      const d = sDec[b.index] || { action: 'create' };
      if (d.action === 'skip') continue;
      if (d.action === 'map') {
        if (!db.prepare('SELECT 1 FROM sites WHERE id = ?').get(Number(d.site_id))) { res.errors.push(`${b.service}: instal·lació inexistent`); continue; }
        siteOf.set(b.index, Number(d.site_id));
        if (b.rate_note) db.prepare('UPDATE sites SET notes = coalesce(notes, ?) WHERE id = ?').run(b.rate_note, Number(d.site_id));
      } else {
        const existing = db.prepare('SELECT id FROM sites WHERE upper(name) = upper(?)').get(b.service);
        if (existing) { siteOf.set(b.index, existing.id); continue; }
        let client = db.prepare('SELECT id FROM clients WHERE upper(name) = upper(?)').get(b.service);
        const clientId = client ? client.id : Number(db.prepare('INSERT INTO clients(name) VALUES (?)').run(b.service).lastInsertRowid);
        const id = Number(db.prepare('INSERT INTO sites(client_id, name, address, notes) VALUES (?,?,?,?)').run(clientId, b.service, b.address || null, b.rate_note || null).lastInsertRowid);
        siteOf.set(b.index, id);
        res.sites_created.push({ id, name: b.service });
      }
    }

    // Torns: substitució per (instal·lació, mes)
    const newShifts = [];
    for (const b of parsed.blocks) for (const s of b.shifts) {
      const userId = userOf.get(workerKey(s.worker, s.phone)); const siteId = siteOf.get(b.index);
      if (userId && siteId) newShifts.push({ ...s, user_id: userId, site_id: siteId, month: b.month });
    }
    const keyOf = s => `${s.user_id}|${s.site_id}|${s.start}|${s.end}`;
    const incoming = new Map(newShifts.map(s => [keyOf({ ...s, start: s.start, end: s.end }), s]));
    const scopes = new Set(parsed.blocks.filter(b => siteOf.has(b.index)).map(b => `${siteOf.get(b.index)}|${b.month}`));
    const keep = new Set();
    for (const sc of scopes) {
      const [siteId, month] = sc.split('|');
      const range = tz.monthRange(month, S.timezone);
      const existing = db.prepare(`SELECT * FROM shifts WHERE site_id = ? AND status = 'planned' AND planned_start >= ? AND planned_start < ?`)
        .all(Number(siteId), range.start.toISOString(), range.end.toISOString());
      for (const e of existing) {
        const k = `${e.user_id}|${e.site_id}|${e.planned_start}|${e.planned_end}`;
        const inc = incoming.get(k);
        if (inc) {
          keep.add(k); res.kept++;
          db.prepare('UPDATE shifts SET kind = ?, planned_hours = ?, import_id = ?, source_ref = ? WHERE id = ?').run(inc.kind, inc.hours, importId, inc.ref, e.id);
          continue;
        }
        const used = db.prepare('SELECT 1 FROM time_events WHERE shift_id = ? LIMIT 1').get(e.id);
        if (used) { res.kept_with_events++; continue; }
        db.prepare("UPDATE shifts SET status = 'cancelled' WHERE id = ?").run(e.id);
        res.cancelled++;
      }
    }
    const ins = db.prepare(`INSERT INTO shifts(user_id, site_id, planned_start, planned_end, month, notes, created_by, kind, planned_hours, import_id, source_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const s of newShifts) {
      const k = keyOf(s);
      if (keep.has(k)) continue;
      const overlap = db.prepare(`SELECT sh.id, si.name FROM shifts sh JOIN sites si ON si.id = sh.site_id WHERE sh.user_id = ? AND sh.status = 'planned' AND sh.planned_start < ? AND sh.planned_end > ?`)
        .get(s.user_id, s.end, s.start);
      if (overlap) { res.errors.push(`${s.ref} ${s.worker} ${s.date} ${s.start_local}–${s.end_local}: se solapa amb un altre torn (${overlap.name})`); continue; }
      const month = tz.parts(new Date(s.start), S.timezone).month;
      ins.run(s.user_id, s.site_id, s.start, s.end, month, null, actor.id, s.kind, s.hours, importId, s.ref);
      res.created++;
    }

    // Absències (vacances, IT, faltes): es reemplacen les importades abans per als mateixos treballadors i mesos
    const affectedUsers = [...new Set([...userOf.values()])];
    for (const month of parsed.months) for (const uid of affectedUsers) {
      db.prepare("DELETE FROM absences WHERE user_id = ? AND date LIKE ? AND import_id IS NOT NULL").run(uid, month + '%');
    }
    const insA = db.prepare('INSERT OR IGNORE INTO absences(user_id, site_id, date, type, hours, note, import_id) VALUES (?,?,?,?,?,?,?)');
    for (const b of parsed.blocks) for (const a of b.absences) {
      const uid = userOf.get(workerKey(a.worker, a.phone)); if (!uid) continue;
      insA.run(uid, siteOf.get(b.index) || null, a.date, a.type, a.hours, a.note, importId);
      res.absences++;
    }

    db.prepare('UPDATE shift_imports SET summary = ? WHERE id = ?').run(JSON.stringify({ ...res, users_created: res.users_created.map(u => u.tip) }), importId);
    audit.log(db, { actorId: actor.id, action: 'shift.import_quadrant', entity: 'shift_imports', entityId: importId,
      details: { filename, sha256: parsed.sha256, months: parsed.months, created: res.created, kept: res.kept, cancelled: res.cancelled, absences: res.absences, errors: res.errors.length }, ip });
    return { import_id: importId, ...res };
  });
}

module.exports = { parseFile, preview, commit, parseHours, parseTime, ABSENCE_TYPES, KIND_LABEL, workerKey };
