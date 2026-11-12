'use strict';
const { insertChained } = require('./chain');

function log(db, { actorId = null, action, entity = null, entityId = null, details = null, ip = null }) {
  return insertChained(db, 'audit_log', {
    at: new Date().toISOString(),
    actor_id: actorId,
    action,
    entity,
    entity_id: entityId == null ? null : String(entityId),
    details: details == null ? null : JSON.stringify(details),
    ip,
  });
}

module.exports = { log };
