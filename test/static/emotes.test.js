const assert = require('assert')
const { EventEmitter } = require('events')
const injectEmotes = require('../../src/builtins/emotes')

function createBotState () {
  const client = new EventEmitter()
  client.sent = []
  client.queue = (name, params) => client.sent.push({ name, params })
  client.entityId = 7n

  return {
    client,
    self: { runtimeId: 99n, type: 'player' },
    playerEntities: new Map(),
    entities: new Map(),
    emit: EventEmitter.prototype.emit,
    on: EventEmitter.prototype.on,
    once: EventEmitter.prototype.once,
    removeListener: EventEmitter.prototype.removeListener,
    _events: Object.create(null)
  }
}

describe('emotes builtin', () => {
  it('sends emote packets with the local runtime entity id', () => {
    const botState = createBotState()
    injectEmotes(botState)

    const packet = botState.emotes.play('00000000-0000-0000-0000-000000000000', {
      lengthTicks: 60,
      flags: { mute_chat: true }
    })

    assert.strictEqual(botState.client.sent.length, 1)
    assert.strictEqual(botState.client.sent[0].name, 'emote')
    assert.deepStrictEqual(botState.client.sent[0].params, {
      entity_id: 7n,
      emote_id: '00000000-0000-0000-0000-000000000000',
      emote_length_ticks: 60,
      xuid: '',
      platform_id: '',
      flags: 2
    })
    assert.strictEqual(packet, botState.client.sent[0].params)
  })

  it('sends equipped emote list packets', () => {
    const botState = createBotState()
    injectEmotes(botState)

    const equipped = botState.emotes.equip([
      '11111111-1111-1111-1111-111111111111',
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222'
    ])

    assert.deepStrictEqual(equipped, [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222'
    ])
    assert.deepStrictEqual(botState.client.sent[0], {
      name: 'emote_list',
      params: {
        player_id: 7n,
        emote_pieces: equipped
      }
    })
  })

  it('tracks incoming player emotes', () => {
    const botState = createBotState()
    const player = { runtimeId: 9n, type: 'player' }
    botState.playerEntities.set(9n, player)
    injectEmotes(botState)

    let playerEmote = null
    botState.on('playerEmote', (entity, emote) => {
      playerEmote = { entity, emote }
    })

    botState.client.emit('emote', {
      entity_id: 9n,
      emote_id: '33333333-3333-3333-3333-333333333333',
      emote_length_ticks: 40,
      xuid: '',
      platform_id: '',
      flags: 'server_side'
    })

    assert.strictEqual(player.emoting, true)
    assert.strictEqual(player.lastEmote.emoteId, '33333333-3333-3333-3333-333333333333')
    assert.strictEqual(player.lastEmote.flags, 1)
    assert.strictEqual(playerEmote.entity, player)
    assert.strictEqual(playerEmote.emote, player.lastEmote)
  })
})
