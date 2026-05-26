const Vec3 = require('vec3').Vec3

let seq = 0
let loggingEnabled = true

function jsonSafeReplacer (_, value) {
  if (typeof value === 'bigint') return value.toString()
  return value
}

function safeJson (value) {
  try {
    return JSON.stringify(value, jsonSafeReplacer)
  } catch (err) {
    return JSON.stringify({ error: 'failed_to_serialize_log_detail', message: err.message })
  }
}

function logAction (dir, packetName, detail = '') {
  if (!loggingEnabled) return

  const ts = new Date().toISOString().slice(11, 23)
  const renderedDetail = detail ? ' ' + safeJson(detail) : ''
  console.log(`[${ts}] [#${++seq}] ${dir} ${packetName}${renderedDetail}`)
}

function setLoggingEnabled (enabled) {
  loggingEnabled = enabled !== false
}

function isLoggingEnabled () {
  return loggingEnabled
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sameRuntimeId (a, b) {
  if (a == null || b == null) return false
  try {
    return BigInt(a) === BigInt(b)
  } catch {
    return false
  }
}

function formatUuidHex (hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function normalizeBedrockUuid (value) {
  if (typeof value !== 'string') return value

  const hex = value.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return value

  const raw = Buffer.from(hex, 'hex')
  const normalized = Buffer.concat([
    Buffer.from(raw.subarray(0, 8)).reverse(),
    Buffer.from(raw.subarray(8, 16)).reverse()
  ]).toString('hex')

  return formatUuidHex(normalized)
}

function toPlainId (value) {
  if (typeof value === 'bigint') return value.toString()
  return value
}

function toRuntimeId (value) {
  if (value === undefined || value === null) return null
  return typeof value === 'bigint' ? value : BigInt(value)
}

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

function toVec3f (pos) {
  return {
    x: Number(pos.x),
    y: Number(pos.y),
    z: Number(pos.z)
  }
}

function toVec3i (pos) {
  return {
    x: Math.floor(pos.x),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z)
  }
}

function floorVec3 (pos) {
  return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
}

function normalizeBlockPos (x, y, z) {
  if (x instanceof Vec3 || (x && x.x !== undefined)) return floorVec3(x)
  return new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
}

function withLayer (pos, layer = 0) {
  if (pos.l !== undefined) return pos
  return Object.assign(Object.create(pos), pos, { l: layer })
}

function getStateId (registry, runtimeId) {
  return registry.blocksByRuntimeId?.[runtimeId]?.stateId ??
    (registry.blocksByStateId?.[runtimeId] ? runtimeId : undefined)
}

function blockRuntimeIdByName (botState, name) {
  if (!name) return undefined
  const key = String(name).replace(/^minecraft:/, '')
  const direct = botState.blockRuntimeIdsByName?.[key]
  if (Number.isFinite(direct)) return direct

  const block = botState.registry?.blocksByName?.[key]
  const stateId = block?.defaultState ?? block?.minStateId
  if (stateId != null) {
    return botState.registry?.blockNetworkRuntimeIdsByStateId?.[stateId] ?? stateId
  }

  return undefined
}

function blockRuntimeIdPositionKey (pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
}

function getBlockRuntimeId (botState, pos, fallback = {}) {
  const direct = botState.blockRuntimeIdsByPosition?.get(blockRuntimeIdPositionKey(pos))
  if (Number.isFinite(direct)) return direct

  try {
    const world = botState.world?.sync || botState.world
    const block = world?.getBlock?.(pos)
    if (block?.stateId != null) {
      return botState.registry.blockNetworkRuntimeIdsByStateId?.[block.stateId] ?? block.stateId
    }
  } catch (err) {
    logAction('[utils]', 'getBlockRuntimeId error', { pos: pos.toString(), msg: err.message })
  }

  return fallback.blockRuntimeId ??
    blockRuntimeIdByName(botState, fallback.blockName) ??
    0
}

function clickPositionForFace (face) {
  switch (face) {
    case 0: return { x: 0.5, y: 0, z: 0.5 }
    case 1: return { x: 0.5, y: 1, z: 0.5 }
    case 2: return { x: 0.5, y: 0.5, z: 0 }
    case 3: return { x: 0.5, y: 0.5, z: 1 }
    case 4: return { x: 0, y: 0.5, z: 0.5 }
    case 5: return { x: 1, y: 0.5, z: 0.5 }
    default: return { x: 0.5, y: 0.5, z: 0.5 }
  }
}

function rawStackId (raw) {
  return raw?.stack_id ?? raw?.stackId ?? raw?.stack_network_id ?? raw?.network_stack_id
}

function itemStackId (item) {
  return item ? item.stackId ?? item.stack_id ?? 0 : 0
}

function itemStackResponseStatusOk (response) {
  return response?.status === 0 || response?.status === 'ok' || response?.status === 'success'
}

function sameItem (a, b) {
  return a && b && a.name === b.name && a.metadata === b.metadata
}

function maxStackSize (item) {
  return item?.stackSize || item?.maxStackSize || 64
}

function nbtValue (value) {
  if (value == null || Buffer.isBuffer(value) || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(nbtValue)

  if (
    Object.prototype.hasOwnProperty.call(value, 'type') &&
    Object.prototype.hasOwnProperty.call(value, 'value')
  ) {
    return nbtValue(value.value)
  }

  const out = {}
  for (const [key, child] of Object.entries(value)) out[key] = nbtValue(child)
  return out
}

function normalizeItemId (id) {
  if (id == null) return null
  const str = String(id)
  return str.startsWith('minecraft:') ? str : `minecraft:${str}`
}

function itemId (item) {
  item = nbtValue(item)
  return normalizeItemId(
    item?.id ??
    item?.name ??
    item?.Name ??
    item?.identifier ??
    item?.network_id ??
    item?.networkId
  )
}

function itemCount (item) {
  item = nbtValue(item)
  return Number(item?.count ?? item?.Count ?? item?.amount ?? item?.Amount ?? 0)
}

function itemToRaw (item, itemClass) {
  if (!item) return { network_id: 0 }
  if (item.raw) return item.raw
  try {
    if (typeof item.toNotch === 'function') return item.toNotch()
    if (itemClass && typeof itemClass.toNotch === 'function') return itemClass.toNotch(item)
  } catch (err) {
    logAction('[utils]', 'itemToRaw error', { msg: err.message })
  }

  return {
    network_id: item.type,
    count: item.count,
    metadata: item.metadata ?? 0,
    block_runtime_id: item.blockRuntimeId ?? item.block_runtime_id ?? 0,
    extra: { can_place_on: [], can_destroy: [] }
  }
}

function toBedrockItem (item) {
  if (!item) return null
  return {
    network_id: item.type,
    count: item.count,
    metadata: item.metadata ?? 0,
    stack_id: 0
  }
}

function selfRuntimeEntityId (botState) {
  return botState.client?.entityId
}

function fullContainerName (containerId = 'inventory', dynamicContainerId = 0) {
  return {
    container_id: containerId,
    dynamic_container_id: dynamicContainerId
  }
}

function requestSlotInfo (containerId, slot, stackId = 0, dynamicContainerId = 0) {
  return {
    slot_type: fullContainerName(containerId, dynamicContainerId),
    slot,
    stack_id: stackId || 0
  }
}

function inventoryRequestSlotInfo (slot, stackId = 0) {
  return slot < 9
    ? requestSlotInfo('hotbar', slot, stackId)
    : requestSlotInfo('inventory', slot - 9, stackId)
}

function playerInventorySlotInfo (slot, item = null) {
  return inventoryRequestSlotInfo(slot, itemStackId(item))
}

function stackRequestSlotInfo (slot, item, containerId = 'inventory') {
  return {
    slot_type: fullContainerName(containerId),
    slot,
    stack_id: itemStackId(item)
  }
}

function cloneItem (item, count = item?.count, options = {}) {
  if (!item || count <= 0) return null

  const clone = new item.constructor(item.type, count, item.metadata, item.nbt, item.stackId, true)
  if (options.preserveIdentity === false) return clone

  clone.stack_id = item.stack_id
  clone.networkId = item.networkId
  clone.network_id = item.network_id
  clone.blockRuntimeId = item.blockRuntimeId
  clone.block_runtime_id = item.block_runtime_id
  clone.raw = item.raw
  if (item.blocksCanPlaceOn) clone.blocksCanPlaceOn = item.blocksCanPlaceOn
  if (item.blocksCanDestroy) clone.blocksCanDestroy = item.blocksCanDestroy
  return clone
}

function mergePatch (target, patch) {
  if (!patch) return
  for (const [key, value] of Object.entries(patch)) {
    target[key] = value
  }
}

function normalizeInputData (inputData, flagByBit) {
  if (inputData && typeof inputData === 'object') return inputData

  const flags = {}
  const value = BigInt(inputData || 0)
  for (const [bit, name] of Object.entries(flagByBit)) {
    flags[name] = (value & (1n << BigInt(bit))) !== 0n
  }
  return flags
}

function numberOrZero (value) {
  return Number.isFinite(value) ? value : 0
}

function deltaDeg (y1, y2) {
  let d = (y1 - y2) % 360
  if (d < -180) d += 360
  else if (d > 180) d -= 360
  return d
}

module.exports = {
  logAction,
  setLoggingEnabled,
  isLoggingEnabled,
  sleep,
  sameRuntimeId,
  normalizeBedrockUuid,
  toPlainId,
  toRuntimeId,
  entityRuntimeId,
  entityIds,
  findEntityByRuntimeId,
  jsonSafeReplacer,
  toVec3f,
  toVec3i,
  floorVec3,
  normalizeBlockPos,
  withLayer,
  getStateId,
  blockRuntimeIdByName,
  blockRuntimeIdPositionKey,
  getBlockRuntimeId,
  clickPositionForFace,
  rawStackId,
  itemStackId,
  itemStackResponseStatusOk,
  sameItem,
  maxStackSize,
  nbtValue,
  normalizeItemId,
  itemId,
  itemCount,
  itemToRaw,
  toBedrockItem,
  selfRuntimeEntityId,
  fullContainerName,
  requestSlotInfo,
  inventoryRequestSlotInfo,
  playerInventorySlotInfo,
  stackRequestSlotInfo,
  cloneItem,
  mergePatch,
  normalizeInputData,
  numberOrZero,
  deltaDeg
}
