'use strict';
/**
 * Còmput d'hores segons el Conveni col·lectiu estatal d'empreses de seguretat privada:
 *  - Jornada de còmput mensual (per defecte 162 h/mes): les jornades diàries llargues
 *    (p. ex. torns de 12 h) no generen alarmes d'hores extraordinàries; l'excés es calcula
 *    al tancament de mes respecte a la jornada contractual.
 *  - Nocturnitat: hores treballades entre les 22:00 i les 06:00 (configurable).
 *  - Caps de setmana i festius desglossats per aplicar els plusos corresponents.
 *  - Pauses: es descompten només si el vigilant ha pogut abandonar el lloc; en cas contrari
 *    computen com a treball efectiu.
 */
const dbm = require('../db');
const tz = require('./tz');
const { effectiveEvents } = require('./records');

const MAX_OPEN_SESSION_H = 24;

function hm(str) { const [h, m] = str.split(':').map(Number); return h * 60 + (m || 0); }

/** Construeix els intervals de treball efectiu i les anomalies a partir dels esdeveniments. */
function buildSessions(events, now = new Date()) {
  const sessions = []; const anomalies = [];
  let cur = null;
  const close = (endIso, incomplete = false) => {
    if (cur.breakOpen) { cur.breaks.push({ start: cur.breakOpen.at, end: endIso, paid: cur.breakOpen.paid }); cur.breakOpen = null; }
    cur.end = endIso; cur.incomplete = incomplete; sessions.push(cur); cur = null;
  };
  for (const e of events) {
    if (e.type === 'IN') {
      if (cur) {
        anomalies.push({ type: 'SENSE_SORTIDA', at: cur.start, event_id: cur.inEvent.id, message: 'Entrada sense sortida registrada' });
        close(cur.start, true);
      }
      cur = { start: e.occurred_at, end: null, inEvent: e, outEvent: null, breaks: [], breakOpen: null, shift_id: e.shift_id, site_id: e.site_id };
    } else if (!cur) {
      anomalies.push({ type: 'SENSE_ENTRADA', at: e.occurred_at, event_id: e.id, message: `${e.type} sense entrada prèvia` });
    } else if (e.type === 'BREAK_START') {
      if (cur.breakOpen) anomalies.push({ type: 'PAUSA_DUPLICADA', at: e.occurred_at, event_id: e.id, message: 'Inici de pausa duplicat' });
      else cur.breakOpen = { at: e.occurred_at, paid: !!e.break_paid };
    } else if (e.type === 'BREAK_END') {
      if (!cur.breakOpen) anomalies.push({ type: 'FI_PAUSA_SENSE_INICI', at: e.occurred_at, event_id: e.id, message: 'Fi de pausa sense inici' });
      else { cur.breaks.push({ start: cur.breakOpen.at, end: e.occurred_at, paid: cur.breakOpen.paid }); cur.breakOpen = null; }
    } else if (e.type === 'OUT') {
      cur.outEvent = e; close(e.occurred_at);
    }
  }
  if (cur) {
    const ageH = (now - new Date(cur.start)) / 3600e3;
    if (ageH > MAX_OPEN_SESSION_H) {
      anomalies.push({ type: 'SENSE_SORTIDA', at: cur.start, event_id: cur.inEvent.id, message: 'Entrada sense sortida registrada' });
      close(cur.start, true);
    } else {
      cur.ongoing = true; close(now.toISOString());
    }
  }
  return { sessions, anomalies };
}

/** Intervals de treball efectiu (descomptant pauses no retribuïdes). */
function workIntervals(session) {
  let pieces = [[Date.parse(session.start), Date.parse(session.end)]];
  for (const b of session.breaks) {
    if (b.paid) continue;
    const bs = Date.parse(b.start); const be = Date.parse(b.end);
    pieces = pieces.flatMap(([s, e]) => {
      if (be <= s || bs >= e) return [[s, e]];
      const r = [];
      if (bs > s) r.push([s, bs]);
      if (be < e) r.push([be, e]);
      return r;
    });
  }
  return pieces.filter(([s, e]) => e > s);
}

/**
 * Divideix un interval en trams homogenis (mateix dia local, nocturn o no) i retorna
 * minuts classificats. Les fronteres són les 00:00, inici i fi de nocturnitat locals.
 */
function classify(startMs, endMs, opts) {
  const { timezone, nightStart, nightEnd, holidays } = opts;
  const cuts = new Set([startMs, endMs]);
  const p0 = tz.parts(new Date(startMs), timezone);
  for (let i = -1; ; i++) {
    const d = tz.addDays(p0.y, p0.m, p0.d, i);
    const mid = tz.zonedToUtc(d.y, d.m, d.d, 0, 0, timezone).getTime();
    if (mid > endMs) break;
    for (const minutes of [0, nightStart, nightEnd]) {
      const t = tz.zonedToUtc(d.y, d.m, d.d, Math.floor(minutes / 60), minutes % 60, timezone).getTime();
      if (t > startMs && t < endMs) cuts.add(t);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]; const b = sorted[i + 1];
    const p = tz.parts(new Date(a + (b - a) / 2), timezone);
    const mod = p.h * 60 + p.min;
    const night = nightStart > nightEnd ? (mod >= nightStart || mod < nightEnd) : (mod >= nightStart && mod < nightEnd);
    const minutes = (b - a) / 60e3;
    out.push({ date: p.date, minutes, night, weekend: p.weekday === 0 || p.weekday === 6, holiday: holidays.has(p.date) });
  }
  return out;
}

function clip([s, e], range) {
  const a = Math.max(s, range.start.getTime()); const b = Math.min(e, range.end.getTime());
  return b > a ? [a, b] : null;
}

const r2 = n => Math.round(n * 100) / 100;
const toH = m => r2(m / 60);

/** Informe mensual d'un treballador. */
function monthlyReport(db, userId, month, { now = new Date() } = {}) {
  const S = dbm.settings(db);
  const timezone = S.timezone;
  const range = tz.monthRange(month, timezone);
  const user = db.prepare('SELECT id, tip, name, monthly_hours FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const holidays = new Set(db.prepare('SELECT date FROM holidays WHERE date LIKE ?').all(month + '%').map(r => r.date));
  const opts = { timezone, nightStart: hm(S.night_start), nightEnd: hm(S.night_end), holidays };

  const margin = 2 * 86400e3;
  const events = effectiveEvents(db, {
    userId,
    from: new Date(range.start.getTime() - margin).toISOString(),
    to: new Date(Math.min(range.end.getTime() + margin, now.getTime() + 60e3)).toISOString(),
  });
  const { sessions, anomalies } = buildSessions(events, now);

  const days = new Map();
  const day = d => {
    if (!days.has(d)) days.set(d, { date: d, worked: 0, night: 0, weekend: 0, holiday: 0, planned: 0, paid_break: 0, unpaid_break: 0 });
    return days.get(d);
  };
  const tot = { worked: 0, night: 0, weekend: 0, holiday: 0, paid_break: 0, unpaid_break: 0, planned: 0, planned_night: 0 };

  for (const s of sessions) {
    for (const iv of workIntervals(s)) {
      const c = clip(iv, range); if (!c) continue;
      for (const seg of classify(c[0], c[1], opts)) {
        const d = day(seg.date);
        d.worked += seg.minutes; tot.worked += seg.minutes;
        if (seg.night) { d.night += seg.minutes; tot.night += seg.minutes; }
        if (seg.weekend) { d.weekend += seg.minutes; tot.weekend += seg.minutes; }
        if (seg.holiday) { d.holiday += seg.minutes; tot.holiday += seg.minutes; }
      }
    }
    for (const b of s.breaks) {
      const c = clip([Date.parse(b.start), Date.parse(b.end)], range); if (!c) continue;
      const m = (c[1] - c[0]) / 60e3;
      const d = day(tz.parts(new Date(c[0]), timezone).date);
      if (b.paid) { d.paid_break += m; tot.paid_break += m; } else { d.unpaid_break += m; tot.unpaid_break += m; }
    }
  }

  const shifts = db.prepare(
    `SELECT * FROM shifts WHERE user_id = ? AND status = 'planned' AND planned_end > ? AND planned_start < ? ORDER BY planned_start`
  ).all(userId, range.start.toISOString(), range.end.toISOString());
  for (const sh of shifts) {
    const c = clip([Date.parse(sh.planned_start), Date.parse(sh.planned_end)], range); if (!c) continue;
    for (const seg of classify(c[0], c[1], opts)) {
      day(seg.date).planned += seg.minutes; tot.planned += seg.minutes;
      if (seg.night) tot.planned_night += seg.minutes;
    }
  }

  // Prolongacions (sortides tardanes) dins del mes
  const prolongations = {};
  let prolongationMin = 0;
  for (const s of sessions) {
    const o = s.outEvent;
    if (!o || !o.late_minutes) continue;
    const t = Date.parse(o.occurred_at);
    if (t < range.start.getTime() || t >= range.end.getTime()) continue;
    const k = o.late_reason || 'SENSE_MOTIU';
    prolongations[k] = (prolongations[k] || 0) + o.late_minutes;
    prolongationMin += o.late_minutes;
  }

  // Torns sense cap fitxatge (absències potencials)
  for (const sh of shifts) {
    if (Date.parse(sh.planned_start) > now.getTime()) continue;
    const covered = sessions.some(s => s.shift_id === sh.id ||
      (Date.parse(s.start) < Date.parse(sh.planned_end) && Date.parse(s.end) > Date.parse(sh.planned_start)));
    if (!covered) anomalies.push({ type: 'TORN_SENSE_FITXATGE', at: sh.planned_start, shift_id: sh.id, message: 'Torn planificat sense cap fitxatge' });
  }

  const contractH = user.monthly_hours != null ? Number(user.monthly_hours) : Number(S.monthly_hours);
  const workedH = toH(tot.worked);
  const inRange = a => a.at >= range.start.toISOString() && a.at < range.end.toISOString();
  return {
    month,
    closed: now >= range.end,
    user: { id: user.id, tip: user.tip, name: user.name },
    totals: {
      worked_h: workedH,
      planned_h: toH(tot.planned),
      contract_h: contractH,
      diff_vs_planned_h: r2(workedH - toH(tot.planned)),
      overtime_h: r2(Math.max(0, workedH - contractH)),
      deficit_h: r2(Math.max(0, contractH - workedH)),
      night_h: toH(tot.night),
      weekend_h: toH(tot.weekend),
      holiday_h: toH(tot.holiday),
      paid_break_h: toH(tot.paid_break),
      unpaid_break_h: toH(tot.unpaid_break),
      prolongation_h: toH(prolongationMin),
      prolongation_by_reason_h: Object.fromEntries(Object.entries(prolongations).map(([k, v]) => [k, toH(v)])),
    },
    days: [...days.values()].filter(d => d.date.startsWith(month)).sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
      date: d.date, worked_h: toH(d.worked), planned_h: toH(d.planned), night_h: toH(d.night),
      weekend_h: toH(d.weekend), holiday_h: toH(d.holiday), paid_break_h: toH(d.paid_break), unpaid_break_h: toH(d.unpaid_break),
    })),
    sessions: sessions.filter(s => s.end >= range.start.toISOString() && s.start < range.end.toISOString()).map(s => ({
      start: s.start, end: s.end, ongoing: !!s.ongoing, incomplete: !!s.incomplete, shift_id: s.shift_id, site_id: s.site_id,
      breaks: s.breaks, late_minutes: s.outEvent ? s.outEvent.late_minutes : null, late_reason: s.outEvent ? s.outEvent.late_reason : null,
    })),
    anomalies: anomalies.filter(inRange),
  };
}

module.exports = { monthlyReport, buildSessions, workIntervals, classify };
