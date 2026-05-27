function degreesToRadians (degrees) {
  return (Number(degrees) || 0) * Math.PI / 180
}

function radiansToDegrees (radians) {
  return (Number(radians) || 0) * 180 / Math.PI
}

function javaYawRadiansToBedrockDegrees (yaw) {
  return radiansToDegrees(Math.PI - (Number(yaw) || 0))
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
  degreesToRadians,
  radiansToDegrees,
  javaYawRadiansToBedrockDegrees,
  numberOrZero,
  deltaDeg
}
