const Vec3 = require('vec3').Vec3

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

function getBlockRuntimeId (botState, pos, fallback = {}) {
  try {
    const world = botState.world?.sync || botState.world
    const block = world?.getBlock?.(pos)
    if (block?.stateId != null) {
      return botState.registry.blockNetworkRuntimeIdsByStateId?.[block.stateId] ?? block.stateId
    }
  } catch (err) {
    botState.logAction?.('[utils]', 'getBlockRuntimeId error', { pos: pos.toString(), msg: err.message })
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

function positionForFace (pos, face) {
  const target = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z)
  switch (face) {
    case 0: return target.offset(0, -1, 0)
    case 1: return target.offset(0, 1, 0)
    case 2: return target.offset(0, 0, -1)
    case 3: return target.offset(0, 0, 1)
    case 4: return target.offset(-1, 0, 0)
    case 5: return target.offset(1, 0, 0)
    default: return target.clone()
  }
}

function lookPositionForFace (pos, face) {
  const target = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z)
  const click = clickPositionForFace(face)
  return target.offset(click.x, click.y, click.z)
}

function sameBlockPos (a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.z === b.z
}

function blockFaceFromEye (eye, pos, options = {}) {
  if (!eye) return options.fallback ?? 3

  const center = {
    x: Math.floor(pos.x) + 0.5,
    y: Math.floor(pos.y) + 0.5,
    z: Math.floor(pos.z) + 0.5
  }
  const dx = eye.x - center.x
  const dy = eye.y - center.y
  const dz = eye.z - center.z

  if (options.verticalMode === 'centered') {
    const horizontalDistance = Math.hypot(dx, dz)
    if (horizontalDistance < (options.horizontalThreshold ?? 0.25) && Math.abs(dy) >= (options.verticalThreshold ?? 0.25)) {
      return dy > 0 ? 1 : 0
    }
  } else if (Math.abs(dy) >= Math.abs(dx) && Math.abs(dy) >= Math.abs(dz)) {
    return dy > 0 ? 1 : 0
  }

  if (Math.abs(dx) >= Math.abs(dz)) return dx > 0 ? 5 : 4
  return dz > 0 ? 3 : 2
}

function blockFaceFromVector (face, fallback = null) {
  if (Number.isInteger(face)) return face
  if (!face || face === 'auto' || face === 'raycast') return fallback

  const x = Number(face.x) || 0
  const y = Number(face.y) || 0
  const z = Number(face.z) || 0

  if (Math.abs(y) >= Math.abs(x) && Math.abs(y) >= Math.abs(z)) return y >= 0 ? 1 : 0
  if (Math.abs(x) >= Math.abs(z)) return x >= 0 ? 5 : 4
  return z >= 0 ? 3 : 2
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

module.exports = {
  getStateId,
  blockRuntimeIdByName,
  getBlockRuntimeId,
  clickPositionForFace,
  positionForFace,
  lookPositionForFace,
  sameBlockPos,
  blockFaceFromEye,
  blockFaceFromVector,
  isSignBlockName,
  signShapeOverride,
  shapeOverrideForBlock
}
