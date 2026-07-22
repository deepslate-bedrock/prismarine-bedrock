// builtins/chat.js
// Auto-loaded by plugin-loader. Parses incoming bedrock 'text' packets using
// prismarine-chat and emits structured events on the botState EventEmitter.
//
// Also attaches say() and whisper() methods to botState for sending chat.
//
// Events (all receive { sourceName, message, chatMessage, rawPacket }):
//   'chat'           – every parsed chat message (generic fallback)
//   'chat'           – type=chat
//   'whisper'        – type=whisper
//   'system'         – type=system
//   'raw'            – type=raw
//   'announcement'   – type=announcement
//   'tip'            – type=tip
//   'translation'    – type=translation
//   'popup'          – type=popup
//   'jukebox_popup'  – type=jukebox_popup
//   'json_whisper'   – type=json_whisper
//   'json'           – type=json
//   'json_announcement' – type=json_announcement
//
// prismarine-chat is used as the primary parser. A server-specific fallback is kept for
// non-standard servers that do not set packet.source_name.

// Mapping from numeric packet type to event name (see proto.yml packet_text)
const TYPE_EVENT = {
  0: 'raw',
  1: 'chat',
  2: 'translation',
  3: 'popup',
  4: 'jukebox_popup',
  5: 'tip',
  6: 'system',
  7: 'whisper',
  8: 'announcement',
  9: 'json_whisper',
  10: 'json',
  11: 'json_announcement',
}

/**
 * @param {import('../state')} botState
 * @param {object} options
 */
function inject (botState, options) {
  const client = botState.client
  const ChatMessage = botState.chatMessageClass  // prismarine-chat

  // -----------------------------------------------------------------------
  // Helper: parse a raw 'text' packet into structured chat info
  // -----------------------------------------------------------------------
  /**
   * @param {object} packet – raw 'text' packet from bedrock-protocol
   * @returns {{ sourceName: string, message: string, chatMessage: object } | null}
   */
  function parseChatMessage (packet) {
    if (!packet || typeof packet.message !== 'string') return null

    // Build a prismarine-chat ChatMessage from the raw message string.
    // Bedrock text messages are plain strings (no JSON formatting), so
    // simple construction works. If a server ever sends JSON, we'd use
    // ChatMessage.fromNotch() instead.
    const chatMessage = new ChatMessage(packet.message)

    // Extract source name – standard bedrock servers set source_name for chat/whisper/announcement.
    let sourceName = packet.source_name || ''
    if (!sourceName) {
      // Fallback: try to parse '<name> message' (non-standard servers)
      const raw = packet.message
      const prefixEnd = raw.indexOf('> ')
      if (prefixEnd !== -1 && raw[0] === '<') {
        sourceName = raw.slice(1, prefixEnd).trim()
        return { sourceName, message: raw.slice(prefixEnd + 1).trim(), chatMessage, sourceIsFallback: true }
      }
      // Last resort
      sourceName = packet.xuid || 'unknown'
    }

    return { sourceName, message: packet.message.trim(), chatMessage }
  }

  // -----------------------------------------------------------------------
  // Chat message handler
  // -----------------------------------------------------------------------
  client.on('text', (packet) => {
    const parsed = parseChatMessage(packet)
    if (!parsed) return

    const { sourceName, message, chatMessage } = parsed
    const eventPayload = { sourceName, message, chatMessage, rawPacket: packet }

    // Always emit the generic chat event
    botState.emit('chat', eventPayload)

    // Also emit a type-specific event if we have a mapping for this packet type
    const eventName = TYPE_EVENT[packet.type]
    if (eventName) {
      botState.emit(eventName, eventPayload)
    }
  })

  // -----------------------------------------------------------------------
  // Outgoing chat methods (attached directly to botState)
  // -----------------------------------------------------------------------

  /**
   * Send a public chat message.
   * @param {string} message
   */
  botState.chat = function (message) {
    if (!client || client.status === 0) {
      botState.logAction?.('[!]', 'cannot say – client not connected')
      return
    }
    const chatMessage = new ChatMessage(message)
    client.queue('text', {
      needs_translation: false,
      category: 'authored',
      type: 'chat',
      source_name: client.username || options.username || 'Bot',
      message: chatMessage.toString(),
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false
    })
  }

  /**
   * Send a whisper to a specific player.
   * @param {string} target – player name
   * @param {string} message – message text
   */
  botState.whisper = function (target, message) {
    if (!client || client.status === 0) {
      botState.logAction?.('[!]', 'cannot whisper – client not connected')
      return
    }
    if (!target || !target.trim()) {
      botState.logAction?.('[!]', 'whisper target must be a non-empty player name')
      return
    }
    const chatMessage = new ChatMessage(message)
    client.queue('text', {
      type: 'whisper',
      needs_translation: false,
      source_name: options.username || 'Bot',
      xuid: '',
      platform_chat_id: '',
      filtered_message: '',
      // Bedrock protocol expects the message field to contain "<target> <message>"
      // when sending a whisper. The server extracts the recipient.
      message: `${target} ${chatMessage.toString()}`
    })
  }
}

module.exports = inject
