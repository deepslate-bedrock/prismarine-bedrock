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

function toBigIntSafe (value) {
  try {
    return toRuntimeId(value)
  } catch {
    return null
  }
}

module.exports = {
  sameRuntimeId,
  normalizeBedrockUuid,
  toPlainId,
  toRuntimeId,
  toBigIntSafe
}
