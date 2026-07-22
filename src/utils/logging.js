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

function createActionLogger (enabled = true) {
  let seq = 0

  return function logAction (dir, packetName, detail = '') {
    if (enabled === false) return

    const ts = new Date().toISOString().slice(11, 23)
    const renderedDetail = detail ? ' ' + safeJson(detail) : ''
    console.log(`[${ts}] [#${++seq}] ${dir} ${packetName}${renderedDetail}`)
  }
}

module.exports = {
  jsonSafeReplacer,
  safeJson,
  createActionLogger
}
