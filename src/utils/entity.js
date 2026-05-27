const { toRuntimeId } = require('./ids')

function entityRuntimeId (entity) {
  return entity?.runtimeId ?? entity?.runtime_id ?? entity?.runtimeEntityId
}

function entityIds (entity) {
  return [
    entity?.runtimeId,
    entity?.runtime_id,
    entity?.runtimeEntityId,
    entity?.id,
    entity?.entityId,
    entity?.uniqueId,
    entity?.unique_id
  ].filter(v => v != null)
}

function findEntityByRuntimeId (botState, runtimeId) {
  const key = toRuntimeId(runtimeId)
  if (key === null) return null
  // Prefer live player entities over non-player actors. `players` is kept as
  // a compatibility alias for older callers and lightweight test fixtures.
  return botState.playerEntities?.get(key) || botState.players?.get(key) || botState.entities?.get(key) || null
}

module.exports = {
  entityRuntimeId,
  entityIds,
  findEntityByRuntimeId
}
