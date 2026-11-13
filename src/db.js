'use strict';
/**
 * Capa de dades (SQLite natiu de Node.js, mòdul node:sqlite).
 *
 * Principis legals aplicats a l'esquema:
 *  - Immutabilitat (ET art. 34.9 + criteri Inspecció de Treball): les taules de registre
 *    (time_events, service_reports, report_incidents, nfc_reads, corrections, audit_log)
 *    tenen triggers que impedeixen qualsevol UPDATE i qualsevol DELETE de registres amb
 *    menys de 4 anys d'antiguitat. Ni l'administrador pot alterar-les via SQL de l'aplicació.
 *  - Les correccions es fan per anotació en una taula paral·lela (corrections) amb autor,
 *    moment i motiu obligatori.
 *  - Cadena de hash (SHA-256) per detectar manipulacions fora de l'aplicació.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const RETENTION = "'-4 years'";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tip TEXT NOT NULL UNIQUE,              -- Targeta d'Identitat Professional
  dni TEXT,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('vigilant','cecoa','operacions','rrhh','admin')),
  password_hash TEXT NOT NULL,
  monthly_hours REAL,                    -- null = valor per defecte del conveni
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cif TEXT,
  report_email TEXT,                     -- destinatari dels parts si el contracte ho exigeix
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  radius_m INTEGER NOT NULL DEFAULT 150,
  solo_post INTEGER NOT NULL DEFAULT 0,  -- lloc unipersonal: la pausa computa com a treball efectiu
  critical INTEGER NOT NULL DEFAULT 0,   -- lloc crític (prioritat al dashboard)
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Quadrant teòric (torns planificats)
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  planned_start TEXT NOT NULL,           -- ISO 8601 UTC
  planned_end TEXT NOT NULL,
  month TEXT NOT NULL,                   -- YYYY-MM (mes local de l'inici)
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','cancelled')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_shifts_user_start ON shifts(user_id, planned_start);
CREATE INDEX IF NOT EXISTS idx_shifts_month ON shifts(month);

CREATE TABLE IF NOT EXISTS holidays (
  date TEXT NOT NULL,                    -- YYYY-MM-DD
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'nacional',
  PRIMARY KEY (date, scope)
);

-- Registre de jornada (IMMUTABLE)
CREATE TABLE IF NOT EXISTS time_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,             -- generat al dispositiu (idempotència offline)
  user_id INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER REFERENCES sites(id),
  shift_id INTEGER REFERENCES shifts(id),
  type TEXT NOT NULL CHECK (type IN ('IN','OUT','BREAK_START','BREAK_END')),
  occurred_at TEXT NOT NULL,             -- hora real de l'acció (corregida pel desfasament del rellotge)
  device_time TEXT,                      -- hora segons el dispositiu
  received_at TEXT NOT NULL,             -- hora de recepció al servidor
  origin TEXT NOT NULL DEFAULT 'online' CHECK (origin IN ('online','offline','admin')),
  lat REAL, lng REAL, accuracy_m REAL,   -- només en el moment de fitxar (AEPD)
  location_status TEXT NOT NULL DEFAULT 'ok' CHECK (location_status IN ('ok','unavailable','denied','not_applicable')),
  distance_m REAL,
  within_geofence INTEGER,
  justification TEXT,                    -- justificació (fora de radi / sense GPS)
  late_reason TEXT,                      -- motiu de prolongació (sortida tardana)
  late_reason_text TEXT,
  late_minutes INTEGER,
  break_paid INTEGER,                    -- pausa computable com a treball efectiu
  break_paid_reason TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  review_reasons TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON time_events(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_shift ON time_events(shift_id);

-- Correccions (anotacions, mai sobreescriptura). IMMUTABLE.
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK (action IN ('modify','annul','add')),
  event_id INTEGER NOT NULL REFERENCES time_events(id), -- per 'add', l'esdeveniment creat amb origin='admin'
  old_values TEXT,                       -- JSON
  new_values TEXT,                       -- JSON
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 10),
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_event ON corrections(event_id);

-- Parts de servei (IMMUTABLE un cop signats)
CREATE TABLE IF NOT EXISTS service_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  shift_id INTEGER REFERENCES shifts(id),
  summary TEXT,
  no_incidents INTEGER NOT NULL DEFAULT 0,
  signature_png TEXT NOT NULL,           -- signatura manuscrita digital (data URL PNG)
  device_time TEXT,
  signed_at TEXT NOT NULL,               -- segell de temps del servidor
  origin TEXT NOT NULL DEFAULT 'online',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_site_time ON service_reports(site_id, signed_at);

CREATE TABLE IF NOT EXISTS report_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES service_reports(id),
  type TEXT NOT NULL CHECK (type IN ('CONTROL_ACCES','ALARMA','INCIDENCIA_TERCERS','RONDA','AVARIA','EMERGENCIA','ALTRES')),
  occurred_at TEXT,
  description TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_type ON report_incidents(type);

-- Registre d'auditoria general (accessos, exportacions, correccions...). IMMUTABLE.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details TEXT,
  ip TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- Importacions de quadrants (format de l'empresa)
CREATE TABLE IF NOT EXISTS shift_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  format TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  months TEXT NOT NULL,
  summary TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Absències planificades al quadrant (vacances, baixes IT, faltes, hores a descomptar)
CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER REFERENCES sites(id),
  date TEXT NOT NULL,                    -- YYYY-MM-DD (local)
  type TEXT NOT NULL CHECK (type IN ('VAC','IT','FI','F','T','ALTRES')),
  hours REAL NOT NULL DEFAULT 0,
  note TEXT,
  import_id INTEGER REFERENCES shift_imports(id),
  UNIQUE (user_id, date, type)
);
CREATE INDEX IF NOT EXISTS idx_absences_user_date ON absences(user_id, date);

-- ===== Fase 2: Rondes NFC (estructures preparades) =====
CREATE TABLE IF NOT EXISTS nfc_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  tag_uid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  lat REAL, lng REAL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS patrol_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL,
  max_minutes INTEGER                    -- temps màxim per completar la ronda
);
CREATE TABLE IF NOT EXISTS patrol_route_points (
  route_id INTEGER NOT NULL REFERENCES patrol_routes(id),
  checkpoint_id INTEGER NOT NULL REFERENCES nfc_checkpoints(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (route_id, position)
);
CREATE TABLE IF NOT EXISTS shift_routes (
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  route_id INTEGER NOT NULL REFERENCES patrol_routes(id),
  PRIMARY KEY (shift_id, route_id)
);
CREATE TABLE IF NOT EXISTS nfc_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  checkpoint_id INTEGER REFERENCES nfc_checkpoints(id),
  tag_uid TEXT NOT NULL,
  shift_id INTEGER REFERENCES shifts(id),
  report_id INTEGER REFERENCES service_reports(id),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  lat REAL, lng REAL, accuracy_m REAL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
`;

const IMMUTABLE = [
  ['time_events', 'occurred_at'],
  ['corrections', 'created_at'],
  ['service_reports', 'signed_at'],
  ['report_incidents', '(SELECT signed_at FROM service_reports WHERE id = OLD.report_id)'],
  ['audit_log', 'at'],
  ['nfc_reads', 'occurred_at'],
];

function triggersSql() {
  return IMMUTABLE.map(([t, dateCol]) => {
    const col = dateCol.startsWith('(') ? dateCol : `OLD.${dateCol}`;
    const delWhen = `WHEN ${col} >= strftime('%Y-%m-%dT%H:%M:%fZ','now',${RETENTION})`;
    return `
CREATE TRIGGER IF NOT EXISTS trg_${t}_no_update BEFORE UPDATE ON ${t}
BEGIN SELECT RAISE(ABORT, 'REGISTRE_IMMUTABLE: ${t} no es pot modificar; utilitzeu una correcció auditada'); END;
CREATE TRIGGER IF NOT EXISTS trg_${t}_no_delete BEFORE DELETE ON ${t} ${delWhen}
BEGIN SELECT RAISE(ABORT, 'REGISTRE_IMMUTABLE: ${t} s''ha de conservar com a mínim 4 anys'); END;`;
  }).join('\n');
}

const DEFAULT_SETTINGS = {
  timezone: 'Europe/Madrid',
  monthly_hours: '162',          // Conveni estatal: 1.782 h/any ≈ 162 h/mes
  night_start: '22:00',
  night_end: '06:00',
  geofence_policy: 'justify',    // 'warn' | 'justify'
  late_tolerance_min: '5',
  early_tolerance_min: '15',     // marge per entrar abans de l'hora
  absence_after_min: '15',       // minuts sense fitxar per marcar absència al dashboard
  retention_years: '4',
  company_name: 'Empresa de Seguretat, S.L.',
  company_cif: '',
};

/** Migracions incrementals per a bases de dades creades amb versions anteriors. */
const COLUMNS = {
  users: { phone: 'TEXT' },
  sites: { notes: 'TEXT' },
  shifts: { kind: "TEXT NOT NULL DEFAULT 'normal'", planned_hours: 'REAL', import_id: 'INTEGER REFERENCES shift_imports(id)', source_ref: 'TEXT' },
};
function migrate(db) {
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const [col, def] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

let instance = null;

function open(file) {
  const dbFile = file || process.env.DB_FILE || path.join(process.cwd(), 'data', 'fichaje.sqlite');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(SCHEMA);
  migrate(db);
  db.exec(triggersSql());
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

function get() {
  if (!instance) instance = open();
  return instance;
}

function setInstance(db) { instance = db; }

function settings(db = get()) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { open, get, setInstance, settings, tx, DEFAULT_SETTINGS };
