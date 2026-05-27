const Vec3 = require('vec3').Vec3

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
  if (x && typeof x.floored === 'function') return x.floored()
  if (x instanceof Vec3 || (x && x.x !== undefined)) return floorVec3(x)
  return new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
}

function withLayer (pos, layer = 0) {
  if (pos.l !== undefined) return pos
  return Object.assign(Object.create(pos), pos, { l: layer })
}

module.exports = {
  toVec3f,
  toVec3i,
  floorVec3,
  normalizeBlockPos,
  withLayer
}
