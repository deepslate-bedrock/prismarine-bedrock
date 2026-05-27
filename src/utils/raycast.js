const { degreesToRadians } = require('./math')
const { shapeOverrideForBlock } = require('./block')

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

module.exports = {
  viewDirectionFromRotation,
  raycastBlock
}
