// builtins/commands.js
// Auto-loaded by plugin-loader.
// Provides command helpers for Bedrock command_request and slash-chat commands.

const crypto = require('crypto')
const fs = require('fs')
const { logAction } = require('../utils')

module.exports = function commandsPlugin (botState, options = {}) {
  const client = botState.client

  let commandVersion = options.commandVersion ?? 'latest'
  let commandTimeoutMs = options.commandTimeoutMs ?? 5000
  let commandPacket = options.commandPacket ?? process.env.E2E_BEDROCK_COMMAND_PACKET ?? 'command_request'
  let seq = 0

  const pending = new Map()

  function slash (command) {
    const value = command.trim()
    return value.startsWith('/') ? value : `/${value}`
  }

  function requestId () {
    seq++
    return `cmd:${Date.now()}:${seq}:${crypto.randomUUID()}`
  }

  function commandOrigin (requestId = '', type = 'player') {
    return {
      type,
      uuid: client.profile?.uuid ?? '',
      request_id: requestId,
      player_entity_id: client.entityId ?? 0n
    }
  }

  function command (value, opts = {}) {
    const id = opts.requestId ?? requestId()
    const packet = opts.packet ?? commandPacket

    if (packet === 'settings_command') {
      client.queue('settings_command', {
        command_line: slash(value),
        suppress_output: opts.suppressOutput ?? false
      })

      logAction('[command]', 'settings', {
        command: slash(value),
        requestId: id
      })

      return id
    }

    if (packet === 'server_command_file') {
      const commandFile = opts.commandFile ?? process.env.E2E_SERVER_COMMAND_FILE
      if (!commandFile) throw new Error('E2E_SERVER_COMMAND_FILE is required for server_command_file commands')
      const command = slash(value)
      fs.appendFileSync(commandFile, `${JSON.stringify({
        ts: new Date().toISOString(),
        requestId: id,
        command: command.replace(/^\//, '')
      })}\n`)

      logAction('[command]', 'server_file', {
        command,
        requestId: id
      })

      return id
    }

    client.queue('command_request', {
      command: slash(value),
      origin: opts.origin ?? commandOrigin(opts.originRequestId ?? '', opts.originType ?? 'player'),
      internal: opts.internal ?? false,
      version: opts.version ?? commandVersion
    })

    logAction('[command]', 'request', {
      command: slash(value),
      requestId: id
    })

    return id
  }

  function chatCommand (value) {
    client.queue('text', {
      needs_translation: false,
      category: 'authored',
      type: 'chat',
      source_name: client.username,
      message: slash(value),
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false
    })

    logAction('[command]', 'chat', {
      command: slash(value)
    })
  }

  function rawCommand (value) {
    client.queue('text', {
      needs_translation: false,
      category: 'message_only',
      type: 'raw',
      message: slash(value),
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false
    })

    logAction('[command]', 'raw', {
      command: slash(value)
    })
  }

  function waitForCommandOutput (id, timeoutMs = commandTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Timed out waiting for command output: ${id}`))
      }, timeoutMs)

      pending.set(id, { resolve, reject, timeout })
    })
  }

  async function commandWithOutput (value, opts = {}) {
    const id = opts.requestId ?? requestId()
    command(value, { ...opts, requestId: id, originRequestId: opts.originRequestId ?? id })
    return waitForCommandOutput(id, opts.timeoutMs ?? commandTimeoutMs)
  }

  function outputRequestId (packet) {
    return packet.origin?.request_id
  }

  function parseOutputMessage (message) {
    const text = message.message ?? message.id ?? ''
    const params = message.parameters ?? []
    return params.length ? `${text} ${params.join(' ')}` : text
  }

  function parseCommandOutput (packet) {
    const messages = packet.output_messages ?? []

    return {
      requestId: outputRequestId(packet),
      successCount: packet.success_count,
      outputType: packet.output_type,
      messages,
      lines: messages.map(parseOutputMessage),
      raw: packet
    }
  }

  client.on('command_output', (packet) => {
    const output = parseCommandOutput(packet)
    botState.emit('command_output', output)

    const id = output.requestId
    const waiter = pending.get(id)
    if (!waiter) return

    clearTimeout(waiter.timeout)
    pending.delete(id)
    waiter.resolve(output)
  })

  function clearCommandWaiters () {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error('Command waiters cleared'))
    }

    pending.clear()
  }

  botState.command = command

  botState.commandWithOutput = commandWithOutput
  botState.chatCommand = chatCommand
  
  botState.rawCommand = rawCommand

  botState.setCommandVersion = (version) => {
    commandVersion = version
  }

  botState.setCommandTimeout = (ms) => {
    commandTimeoutMs = ms
  }

  botState.setCommandPacket = (packet) => {
    commandPacket = packet
  }

  botState.clearCommandWaiters = clearCommandWaiters

  client.on('close', clearCommandWaiters)
}
