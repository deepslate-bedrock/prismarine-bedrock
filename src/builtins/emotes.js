// builtins/emotes.js

const {
  findEntityByRuntimeId,
  selfRuntimeEntityId,
  toRuntimeId
} = require('../utils')

const DEFAULT_EMOTE_LENGTH_TICKS = 0

function asEmoteId (emoteId) {
  if (typeof emoteId !== 'string' || emoteId.trim() === '') {
    throw new TypeError('emoteId must be a non-empty string')
  }
  return emoteId.trim()
}

function normalizeFlags (flags) {
  if (typeof flags === 'number') return flags
  if (typeof flags === 'string') {
    let value = 0
    if (flags === 'server_side') value |= 1
    if (flags === 'mute_chat') value |= 2
    return value
  }
  if (!flags || typeof flags !== 'object') return 0

  let value = 0
  if (flags.server_side) value |= 1
  if (flags.mute_chat) value |= 2
  return value
}

module.exports = function emotesPlugin (botState, options = {}) {
  const client = botState.client

  botState.emotes = botState.emotes || {
    equipped: [],
    byPlayerRuntimeId: new Map()
  }

  function sendEmoteList (emoteIds = botState.emotes.equipped) {
    const playerId = toRuntimeId(selfRuntimeEntityId(botState))
    if (playerId === null) {
      throw new Error('Cannot send emote_list before local runtime entity id is known')
    }

    const emotePieces = Array.from(new Set((emoteIds || []).map(asEmoteId)))
    client.queue('emote_list', {
      player_id: playerId,
      emote_pieces: emotePieces
    })

    botState.logAction?.('[emote]', 'emote_list', { count: emotePieces.length })
    return emotePieces
  }

  function equipEmotes (emoteIds, equipOptions = {}) {
    if (!Array.isArray(emoteIds)) {
      throw new TypeError('emoteIds must be an array')
    }

    botState.emotes.equipped = Array.from(new Set(emoteIds.map(asEmoteId)))
    if (equipOptions.send === false || botState.emotes.equipped.length === 0) {
      return botState.emotes.equipped
    }

    return sendEmoteList(botState.emotes.equipped)
  }

  function playEmote (emoteId, emoteOptions = {}) {
    const entityId = toRuntimeId(emoteOptions.entityId ?? emoteOptions.entity_id ?? selfRuntimeEntityId(botState))
    if (entityId === null) {
      throw new Error('Cannot send emote before local runtime entity id is known')
    }

    const packet = {
      entity_id: entityId,
      emote_id: asEmoteId(emoteId),
      emote_length_ticks: emoteOptions.emoteLengthTicks ?? emoteOptions.lengthTicks ?? DEFAULT_EMOTE_LENGTH_TICKS,
      xuid: emoteOptions.xuid ?? '',
      platform_id: emoteOptions.platformId ?? emoteOptions.platform_id ?? '',
      flags: normalizeFlags(emoteOptions.flags)
    }

    client.queue('emote', packet)
    botState.emotes.lastSent = {
      ...packet,
      sentAt: Date.now()
    }

    botState.logAction?.('[emote]', 'send', {
      entity_id: String(packet.entity_id),
      emote_id: packet.emote_id,
      length: packet.emote_length_ticks
    })

    return packet
  }

  client.on('emote', (packet) => {
    const runtimeId = toRuntimeId(packet.entity_id)
    const entity = findEntityByRuntimeId(botState, runtimeId)
    const emote = {
      entity,
      entityId: runtimeId,
      emoteId: packet.emote_id,
      emoteLengthTicks: packet.emote_length_ticks,
      xuid: packet.xuid || '',
      platformId: packet.platform_id || '',
      flags: normalizeFlags(packet.flags),
      rawPacket: packet
    }

    botState.emotes.byPlayerRuntimeId.set(runtimeId, emote)
    if (entity) {
      entity.lastEmote = emote
      entity.emoting = true
      clearTimeout(entity._emoteEndTimer)
      if (emote.emoteLengthTicks > 0) {
        entity._emoteEndTimer = setTimeout(() => {
          if (entity.lastEmote === emote) entity.emoting = false
        }, emote.emoteLengthTicks * 50)
        entity._emoteEndTimer.unref?.()
      }
    }

    botState.emit('entityEmote', emote)
    if (entity?.type === 'player') botState.emit('playerEmote', entity, emote)
  })

  client.on('emote_list', (packet) => {
    const runtimeId = toRuntimeId(packet.player_id)
    const entity = findEntityByRuntimeId(botState, runtimeId)
    const emotePieces = [...(packet.emote_pieces || [])]

    if (entity) entity.emotePieces = emotePieces
    botState.emotes.byPlayerRuntimeId.set(runtimeId, {
      ...(botState.emotes.byPlayerRuntimeId.get(runtimeId) || {}),
      entity,
      entityId: runtimeId,
      emotePieces,
      rawPacket: packet
    })

    botState.emit('entityEmoteList', {
      entity,
      entityId: runtimeId,
      emotePieces,
      rawPacket: packet
    })
  })

  Object.assign(botState.emotes, {
    sendList: sendEmoteList,
    equip: equipEmotes,
    play: playEmote,
    send: playEmote,
    emote: playEmote
  })
}
