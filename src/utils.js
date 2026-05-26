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

function isSignBlockName (name) {
  if (!name) return false
  const normalized = String(name).replace(/^minecraft:/, '')
  return normalized === 'standing_sign' ||
    normalized === 'wall_sign' ||
    normalized.endsWith('_standing_sign') ||
    normalized.endsWith('_wall_sign') ||
    normalized.endsWith('_hanging_sign')
}

function degreesToRadians (degrees) {
  return (degrees * Math.PI) / 180
}

function viewDirectionFromRotation (yaw, pitch) {
  const yawRad = degreesToRadians(yaw || 0)
  const pitchRad = degreesToRadians(pitch || 0)
  const cosPitch = Math.cos(pitchRad)

  return {
    x: -Math.sin(yawRad) * cosPitch,
    y: -Math.sin(pitchRad),
    z: Math.cos(yawRad) * cosPitch
  }
}

function blockProperties (block) {
  if (!block) return {}
  if (typeof block.getProperties === 'function') {
    try {
      return block.getProperties() || {}
    } catch {}
  }
  return block.properties || block.states || {}
}

function faceFromSignDirection (direction) {
  const value = Number(direction)
  if (value >= 2 && value <= 5) return value
  return null
}

function closestCardinalFaceFromGroundSignDirection (direction) {
  const value = Number(direction)
  if (!Number.isFinite(value)) return null

  // Bedrock standing signs expose 16 horizontal rotations. Convert to the
  // nearest cardinal face because raycast shapes are axis-aligned boxes.
  const cardinal = Math.round((((value % 16) + 16) % 16) / 4) % 4
  return [2, 5, 3, 4][cardinal]
}

function panelShapeForFace (face, minY = 0.28125, maxY = 0.78125) {
  const t = 1 / 16
  switch (face) {
    case 2: return [[0.0625, minY, 0, 0.9375, maxY, t]]
    case 3: return [[0.0625, minY, 1 - t, 0.9375, maxY, 1]]
    case 4: return [[0, minY, 0.0625, t, maxY, 0.9375]]
    case 5: return [[1 - t, minY, 0.0625, 1, maxY, 0.9375]]
    default: return null
  }
}

function signShapeOverride (block) {
  const name = String(block?.name || '').replace(/^minecraft:/, '')
  if (!isSignBlockName(name)) return null

  const properties = blockProperties(block)
  const wallFace = faceFromSignDirection(properties.facing_direction)
  if (name === 'wall_sign' || name.endsWith('_wall_sign') || name.endsWith('_wall_hanging_sign')) {
    return panelShapeForFace(wallFace ?? 3)
  }

  const groundFace = closestCardinalFaceFromGroundSignDirection(properties.ground_sign_direction)
  return panelShapeForFace(groundFace ?? 3)
}

function shapeOverrideForBlock (block) {
  return signShapeOverride(block)
}

function raycastShapesForBlock (block, shapeOverride) {
  if (Array.isArray(shapeOverride)) return shapeOverride
  if (typeof shapeOverride === 'function') return shapeOverride(block)
  if (Array.isArray(block?.shapes) && block.shapes.length > 0) return block.shapes
  return shapeOverrideForBlock(block) ?? [[0, 0, 0, 1, 1, 1]]
}

function normalizeBox (shape, blockMin) {
  if (!Array.isArray(shape) || shape.length < 6) return null
  const min = {
    x: blockMin.x + Math.min(Number(shape[0]), Number(shape[3])),
    y: blockMin.y + Math.min(Number(shape[1]), Number(shape[4])),
    z: blockMin.z + Math.min(Number(shape[2]), Number(shape[5]))
  }
  const max = {
    x: blockMin.x + Math.max(Number(shape[0]), Number(shape[3])),
    y: blockMin.y + Math.max(Number(shape[1]), Number(shape[4])),
    z: blockMin.z + Math.max(Number(shape[2]), Number(shape[5]))
  }
  if (!Number.isFinite(min.x) || !Number.isFinite(min.y) || !Number.isFinite(min.z)) return null
  if (!Number.isFinite(max.x) || !Number.isFinite(max.y) || !Number.isFinite(max.z)) return null
  return { min, max }
}

function raycastBox (eye, direction, box, epsilon) {
  const candidates = [
    { axis: 'y', value: box.min.y, face: 0 },
    { axis: 'y', value: box.max.y, face: 1 },
    { axis: 'z', value: box.min.z, face: 2 },
    { axis: 'z', value: box.max.z, face: 3 },
    { axis: 'x', value: box.min.x, face: 4 },
    { axis: 'x', value: box.max.x, face: 5 }
  ]
  let closest = null

  for (const plane of candidates) {
    if (Math.abs(direction[plane.axis]) < epsilon) continue

    const t = (plane.value - eye[plane.axis]) / direction[plane.axis]
    if (!Number.isFinite(t) || t < 0) continue

    const hit = {
      x: eye.x + direction.x * t,
      y: eye.y + direction.y * t,
      z: eye.z + direction.z * t
    }

    if (
      hit.x < box.min.x - epsilon || hit.x > box.max.x + epsilon ||
      hit.y < box.min.y - epsilon || hit.y > box.max.y + epsilon ||
      hit.z < box.min.z - epsilon || hit.z > box.max.z + epsilon
    ) continue

    if (!closest || t < closest.t) {
      closest = { face: plane.face, hit, t }
    }
  }

  return closest
}

function raycastBlock (eye, target, yaw, pitch, options = {}) {
  if (!eye || !target) return null

  const direction = viewDirectionFromRotation(yaw, pitch)
  const min = {
    x: Math.floor(target.x),
    y: Math.floor(target.y),
    z: Math.floor(target.z)
  }
  const epsilon = 1e-6
  const shapes = raycastShapesForBlock(options.block, options.shapeOverride)
  let closest = null

  for (const shape of shapes) {
    const box = normalizeBox(shape, min)
    if (!box) continue
    const hit = raycastBox(eye, direction, box, epsilon)
    if (!hit) continue

    if (!closest || hit.t < closest.t) {
      closest = {
        face: hit.face,
        hit: hit.hit,
        clickPosition: {
          x: Math.max(0, Math.min(1, hit.hit.x - min.x)),
          y: Math.max(0, Math.min(1, hit.hit.y - min.y)),
          z: Math.max(0, Math.min(1, hit.hit.z - min.z))
        },
        t: hit.t
      }
    }
  }

  return closest
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
  isSignBlockName,
  viewDirectionFromRotation,
  signShapeOverride,
  shapeOverrideForBlock,
  raycastBlock,
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
