let seq = 0
let loggingEnabled = true

function jsonSafeReplacer (_, value) {
  if (typeof value === 'bigint') return value.toString()
  return value
}

function safeJson (value, fallback, space) {
  try {
    return JSON.stringify(value, jsonSafeReplacer, space)
  } catch (err) {
    if (fallback !== undefined) return fallback
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

module.exports = {
  jsonSafeReplacer,
  safeJson,
  logAction,
  setLoggingEnabled,
  isLoggingEnabled
}
