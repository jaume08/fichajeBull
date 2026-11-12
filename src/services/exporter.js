'use strict';
/**
 * Exportació per a la Inspecció de Treball: registre diari de jornada per treballador
 * (hora d'inici i de finalització, pauses, correccions) en Excel o PDF.
 */
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const dbm = require('../db');
const tz = require('./tz');
const { effectiveEvents } = require('./records');
const { monthlyReport } = require('./hours');
const { INCIDENT_TYPES } = require('./reports');
const { LATE_REASONS } = require('./records');

const TYPE_LABEL = { IN: 'Entrada', OUT: 'Sortida', BREAK_START: 'Inici pausa', BREAK_END: 'Fi pausa' };

function localStr(iso, timezone) {
  if (!iso) return '';
  const p = tz.parts(new Date(iso), timezone);
  const z = n => String(n).padStart(2, '0');
  return `${z(p.d)}/${z(p.m)}/${p.y} ${z(p.h)}:${z(p.min)}:${z(p.s)}`;
}

function monthsBetween(from, to) {
  const out = []; let [y, m] = from.split('-').map(Number); const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out.slice(0, 60);
}

/** Recull les dades d'exportació: per treballador, esdeveniments i resum mensual. */
function collect(db, { userIds, fromMonth, toMonth }) {
  const S = dbm.settings(db);
  const months = monthsBetween(fromMonth, toMonth);
  const start = tz.monthRange(months[0], S.timezone).start.toISOString();
  const end = tz.monthRange(months[months.length - 1], S.timezone).end.toISOString();
  const users = userIds && userIds.length
    ? db.prepare(`SELECT * FROM users WHERE id IN (${userIds.map(() => '?').join(',')}) ORDER BY name`).all(...userIds.map(Number))
    : db.prepare("SELECT * FROM users WHERE id IN (SELECT DISTINCT user_id FROM time_events) ORDER BY name").all();
  const sites = new Map(db.prepare('SELECT id, name FROM sites').all().map(s => [s.id, s.name]));
  const authors = new Map(db.prepare('SELECT id, name FROM users').all().map(u => [u.id, u.name]));
  return {
    settings: S, months, start, end,
    workers: users.map(u => ({
      user: u,
      events: effectiveEvents(db, { userId: u.id, from: start, to: end, includeAnnulled: true }).map(e => ({
        ...e, site_name: sites.get(e.site_id) || '',
        corrections: e.corrections.map(c => ({ ...c, author_name: authors.get(c.author_id) || c.author_id })),
      })),
      monthly: months.map(m => monthlyReport(db, u.id, m)),
    })),
  };
}

async function toExcel(db, opts) {
  const data = collect(db, opts); const T = data.settings.timezone;
  const wb = new ExcelJS.Workbook();
  wb.creator = data.settings.company_name; wb.created = new Date();
  const sum = wb.addWorksheet('Resum mensual');
  sum.columns = [
    { header: 'TIP', key: 'tip', width: 12 }, { header: 'Treballador', key: 'name', width: 28 }, { header: 'DNI', key: 'dni', width: 12 },
    { header: 'Mes', key: 'month', width: 9 }, { header: 'Hores treballades', key: 'worked', width: 12 },
    { header: 'Hores quadrant', key: 'planned', width: 12 }, { header: 'Jornada conveni', key: 'contract', width: 12 },
    { header: 'Hores extra', key: 'ot', width: 10 }, { header: 'Nocturnes', key: 'night', width: 10 },
    { header: 'Cap de setmana', key: 'we', width: 10 }, { header: 'Festius', key: 'hol', width: 10 },
    { header: 'Prolongacions', key: 'prol', width: 12 }, { header: 'Pauses retribuïdes', key: 'pb', width: 12 },
    { header: 'Anomalies', key: 'anom', width: 10 },
  ];
  for (const w of data.workers) for (const m of w.monthly) {
    sum.addRow({ tip: w.user.tip, name: w.user.name, dni: w.user.dni || '', month: m.month, worked: m.totals.worked_h,
      planned: m.totals.planned_h, contract: m.totals.contract_h, ot: m.totals.overtime_h, night: m.totals.night_h,
      we: m.totals.weekend_h, hol: m.totals.holiday_h, prol: m.totals.prolongation_h, pb: m.totals.paid_break_h, anom: m.anomalies.length });
  }
  sum.getRow(1).font = { bold: true };
  const reg = wb.addWorksheet('Registre de jornada');
  reg.columns = [
    { header: 'TIP', key: 'tip', width: 12 }, { header: 'Treballador', key: 'name', width: 26 }, { header: 'Data i hora', key: 'at', width: 20 },
    { header: 'Tipus', key: 'type', width: 12 }, { header: 'Instal·lació', key: 'site', width: 24 }, { header: 'Origen', key: 'origin', width: 9 },
    { header: 'Dins radi', key: 'geo', width: 9 }, { header: 'Distància (m)', key: 'dist', width: 11 }, { header: 'Justificació', key: 'just', width: 30 },
    { header: 'Motiu prolongació', key: 'late', width: 22 }, { header: 'Pausa retribuïda', key: 'bp', width: 12 },
    { header: 'Estat', key: 'state', width: 12 }, { header: 'Correccions (autor · data · motiu)', key: 'corr', width: 50 },
    { header: 'Hora recepció servidor', key: 'recv', width: 20 }, { header: 'Hash', key: 'hash', width: 20 },
  ];
  for (const w of data.workers) for (const e of w.events) {
    reg.addRow({ tip: w.user.tip, name: w.user.name, at: localStr(e.occurred_at, T), type: TYPE_LABEL[e.type], site: e.site_name,
      origin: e.origin, geo: e.within_geofence == null ? '' : e.within_geofence ? 'Sí' : 'No', dist: e.distance_m ?? '',
      just: e.justification || '', late: e.late_reason ? `${LATE_REASONS[e.late_reason] || e.late_reason}${e.late_minutes ? ` (${e.late_minutes} min)` : ''}` : '',
      bp: e.type === 'BREAK_START' ? (e.break_paid ? 'Sí' : 'No') : '', state: e.annulled ? 'ANUL·LAT' : e.corrected ? 'CORREGIT' : 'Original',
      corr: e.corrections.map(c => `${c.action} · ${c.author_name} · ${localStr(c.created_at, T)} · ${c.reason}`).join(' | '),
      recv: localStr(e.received_at, T), hash: e.hash });
  }
  reg.getRow(1).font = { bold: true };
  reg.views = [{ state: 'frozen', ySplit: 1 }];
  return wb.xlsx.writeBuffer();
}

function toPdf(db, opts) {
  const data = collect(db, opts); const T = data.settings.timezone;
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: 'Registre de jornada', Author: data.settings.company_name } });
  const chunks = []; doc.on('data', c => chunks.push(c));
  const done = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));
  data.workers.forEach((w, idx) => {
    if (idx) doc.addPage();
    doc.fontSize(14).text('Registre diari de jornada (art. 34.9 ET)', { align: 'center' });
    doc.moveDown(0.3).fontSize(9)
      .text(`Empresa: ${data.settings.company_name}  ${data.settings.company_cif ? 'CIF ' + data.settings.company_cif : ''}`)
      .text(`Treballador: ${w.user.name}   TIP: ${w.user.tip}   ${w.user.dni ? 'DNI: ' + w.user.dni : ''}`)
      .text(`Període: ${data.months[0]} a ${data.months[data.months.length - 1]}   ·   Generat: ${localStr(new Date().toISOString(), T)}`);
    for (const m of w.monthly) {
      doc.moveDown(0.6).fontSize(11).text(`Mes ${m.month}`, { underline: true }).fontSize(8.5);
      const t = m.totals;
      doc.text(`Treballades: ${t.worked_h} h · Quadrant: ${t.planned_h} h · Jornada: ${t.contract_h} h · Extra: ${t.overtime_h} h · ` +
        `Nocturnes: ${t.night_h} h · Cap de setmana: ${t.weekend_h} h · Festius: ${t.holiday_h} h · Prolongacions: ${t.prolongation_h} h`);
      doc.moveDown(0.3);
      for (const s of m.sessions) {
        const br = s.breaks.map(b => `${localStr(b.start, T).slice(11, 16)}-${localStr(b.end, T).slice(11, 16)}${b.paid ? '*' : ''}`).join(', ');
        doc.text(`${localStr(s.start, T)}  →  ${s.ongoing ? 'en curs' : localStr(s.end, T)}${s.incomplete ? '  [INCOMPLET]' : ''}` +
          `${br ? '   Pauses: ' + br : ''}${s.late_minutes ? `   Prolongació: ${s.late_minutes} min (${LATE_REASONS[s.late_reason] || 'sense motiu'})` : ''}`);
      }
      if (m.anomalies.length) doc.fillColor('#a00').text(`Anomalies: ${m.anomalies.map(a => `${localStr(a.at, T).slice(0, 10)} ${a.message}`).join('; ')}`).fillColor('black');
    }
    const corrected = w.events.filter(e => e.corrections.length);
    if (corrected.length) {
      doc.moveDown(0.6).fontSize(10).text('Correccions auditades').fontSize(8);
      for (const e of corrected) for (const c of e.corrections) {
        doc.text(`Registre #${e.id} (${TYPE_LABEL[e.type]} ${localStr(e.occurred_at, T)}): ${c.action} per ${c.author_name} el ${localStr(c.created_at, T)} — ${c.reason}`);
      }
    }
    doc.moveDown(0.5).fontSize(7).fillColor('#555').text('* Pausa computada com a treball efectiu (el vigilant no podia abandonar el lloc). ' +
      'Registres immutables amb cadena de hash SHA-256; les correccions consten com a anotacions sense alterar l\'original.').fillColor('black');
    doc.moveDown(1.5).fontSize(9).text('Signatura empresa: ______________________          Signatura treballador: ______________________');
  });
  if (!data.workers.length) doc.text('Sense registres per al període seleccionat.');
  doc.end();
  return done;
}

function reportPdf(rep, settings) {
  const T = settings.timezone;
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Part de servei ${rep.id}` } });
  const chunks = []; doc.on('data', c => chunks.push(c));
  const done = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));
  doc.fontSize(15).text('PART DE SERVEI', { align: 'center' }).moveDown(0.5).fontSize(9);
  doc.text(`Empresa: ${settings.company_name}`).text(`Client: ${rep.client_name}   ·   Instal·lació: ${rep.site_name}`)
    .text(`Vigilant: ${rep.user_name}   ·   TIP: ${rep.tip}`)
    .text(rep.shift ? `Torn previst: ${localStr(rep.shift.planned_start, T)} – ${localStr(rep.shift.planned_end, T)}` : 'Torn: no vinculat')
    .text(`Segell de temps (servidor): ${localStr(rep.signed_at, T)}   ·   Origen: ${rep.origin}`);
  doc.moveDown();
  doc.fontSize(11).text('Incidències').fontSize(9);
  if (!rep.incidents.length) doc.text(rep.no_incidents ? 'Sense novetats.' : '—');
  for (const i of rep.incidents) doc.text(`• [${INCIDENT_TYPES[i.type]}] ${i.occurred_at ? localStr(i.occurred_at, T).slice(11, 16) + ' ' : ''}${i.description}`);
  if (rep.summary) doc.moveDown(0.5).fontSize(11).text('Observacions').fontSize(9).text(rep.summary);
  if (rep.prolongations.length) {
    doc.moveDown(0.5).fontSize(11).text('Prolongació de jornada').fontSize(9);
    for (const p of rep.prolongations) doc.text(`Sortida ${localStr(p.occurred_at, T)}: +${p.late_minutes} min · ${LATE_REASONS[p.late_reason] || 'Sense motiu'}${p.late_reason_text ? ' — ' + p.late_reason_text : ''}`);
  }
  if (rep.nfc_reads && rep.nfc_reads.length) {
    doc.moveDown(0.5).fontSize(11).text('Lectures de punts de control (NFC)').fontSize(9);
    for (const n of rep.nfc_reads) doc.text(`${localStr(n.occurred_at, T)} · ${n.tag_uid}`);
  }
  doc.moveDown().fontSize(9).text('Signatura del vigilant:');
  try { doc.image(Buffer.from(rep.signature_png.split(',')[1], 'base64'), { fit: [220, 90] }); } catch { doc.text('[signatura no disponible]'); }
  doc.moveDown(0.5).fontSize(7).fillColor('#555').text(`Hash d'integritat: ${rep.hash}`);
  doc.end();
  return done;
}

module.exports = { toExcel, toPdf, reportPdf, collect };
