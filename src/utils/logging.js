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

function createLogger (enabled = true, prefix = '') {
  const noop = () => {}

  if (enabled === false) {
    return {
      log: noop,
      warn: noop,
      error: noop
    }
  }

  const formatArgs = (args) => (prefix ? [prefix, ...args] : args)

  return {
    log: (...args) => console.log(...formatArgs(args)),
    warn: (...args) => console.warn(...formatArgs(args)),
    error: (...args) => console.error(...formatArgs(args))
  }
}

function createActionLogger (enabled = true) {
  let seq = 0
  const logger = createLogger(enabled)

  return function logAction (dir, packetName, detail = '') {
    if (enabled === false) return

    const ts = new Date().toISOString().slice(11, 23)
    const renderedDetail = detail ? ' ' + safeJson(detail) : ''
    logger.log(`[${ts}] [#${++seq}] ${dir} ${packetName}${renderedDetail}`)
  }
}

module.exports = {
  jsonSafeReplacer,
  safeJson,
  createLogger,
  createActionLogger
}
