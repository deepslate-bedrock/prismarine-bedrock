const { sameRuntimeId, toRuntimeId } = require('./ids')

function entityRuntimeId (entity) {
  return entity?.runtimeId ?? entity?.runtime_id ?? entity?.runtimeEntityId
}

function entityUniqueId (entity) {
  return entity?.uniqueId ?? entity?.unique_id ?? entity?.id ?? entity?.entityId
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

function findEntityByUniqueId (botState, uniqueId) {
  const key = toRuntimeId(uniqueId)
  if (key === null) return null

  const seen = new Set()
  const stores = [botState.playerEntities, botState.players, botState.entities]
  for (const store of stores) {
    if (!store || seen.has(store)) continue
    seen.add(store)

    for (const entity of store.values()) {
      if (sameRuntimeId(entityUniqueId(entity), key)) return entity
    }
  }

  return null
}

module.exports = {
  entityRuntimeId,
  entityUniqueId,
  entityIds,
  findEntityByRuntimeId,
  findEntityByUniqueId
}
