'use strict';
/**
 * Conservació: els registres es guarden com a mínim 4 anys (art. 34.9 ET; art. 21 LISOS).
 * Passat aquest termini, la purga (minimització, art. 5.1.e RGPD) només es pot executar
 * explícitament per un administrador i queda auditada. Els triggers de la BD impedeixen
 * esborrar qualsevol registre dins del termini.
 */
const dbm = require('../db');
const audit = require('./audit');

function purge(db, actor, ip) {
  const years = Math.max(4, Number(dbm.settings(db).retention_years) || 4);
  const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - years);
  const c = cutoff.toISOString();
  return dbm.tx(db, () => {
    const res = {};
    res.nfc_reads = Number(db.prepare('DELETE FROM nfc_reads WHERE occurred_at < ?').run(c).changes);
    res.corrections = Number(db.prepare('DELETE FROM corrections WHERE event_id IN (SELECT id FROM time_events WHERE occurred_at < ?) AND created_at < ?').run(c, c).changes);
    res.report_incidents = Number(db.prepare('DELETE FROM report_incidents WHERE report_id IN (SELECT id FROM service_reports WHERE signed_at < ?)').run(c).changes);
    res.service_reports = Number(db.prepare('DELETE FROM service_reports WHERE signed_at < ? AND id NOT IN (SELECT report_id FROM report_incidents)').run(c).changes);
    res.time_events = Number(db.prepare('DELETE FROM time_events WHERE occurred_at < ? AND id NOT IN (SELECT event_id FROM corrections)').run(c).changes);
    audit.log(db, { actorId: actor.id, action: 'retention.purge', details: { cutoff: c, ...res }, ip });
    return { cutoff: c, deleted: res };
  });
}

module.exports = { purge };
