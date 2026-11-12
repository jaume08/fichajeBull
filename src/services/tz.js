'use strict';
/** Utilitats de zona horària sense dependències (per defecte Europe/Madrid). */
const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return fmtCache.get(tz);
}

/** Components locals d'un instant. */
function parts(date, tz) {
  const p = Object.fromEntries(fmt(tz).formatToParts(date).map(x => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, weekday: wd,
    date: `${p.year}-${p.month}-${p.day}`, month: `${p.year}-${p.month}` };
}

/** Instant UTC corresponent a una hora de rellotge local (y, m 1-12, d, h, min). */
function zonedToUtc(y, m, d, h, min, tz) {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    const diff = Date.UTC(y, m - 1, d, h, min) - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

function addDays(y, m, d, n) {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Interval [inici, fi) d'un mes local (YYYY-MM). */
function monthRange(month, tz) {
  const [y, m] = month.split('-').map(Number);
  const start = zonedToUtc(y, m, 1, 0, 0, tz);
  const ny = m === 12 ? y + 1 : y; const nm = m === 12 ? 1 : m + 1;
  return { start, end: zonedToUtc(ny, nm, 1, 0, 0, tz) };
}

function dayRange(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const n = addDays(y, m, d, 1);
  return { start: zonedToUtc(y, m, d, 0, 0, tz), end: zonedToUtc(n.y, n.m, n.d, 0, 0, tz) };
}

module.exports = { parts, zonedToUtc, addDays, monthRange, dayRange };
