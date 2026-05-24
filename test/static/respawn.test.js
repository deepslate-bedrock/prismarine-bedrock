'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const respawnPlugin = require('../../src/builtins/respawn')

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createBot () {
  const client = new EventEmitter()
  client.entityId = 1n
  client.queued = []
  client.queue = (name, packet) => {
    client.queued.push({ name, packet })
  }

  const botState = {
    client,
    lifecycle: {},
    playerState: {}
  }

  respawnPlugin(botState)
  return { botState, client }
}

describe('respawn builtin', function () {
  it('keeps initial spawn respawn handshake independent from death-screen respawn', function () {
    const { botState, client } = createBot()

    client.emit('respawn', {
      state: 0,
      position: { x: 0, y: 32768, z: 0 },
      runtime_entity_id: 0n
    })
    client.emit('respawn', {
      state: 1,
      position: { x: 0.5, y: 65.62, z: 0.5 },
      runtime_entity_id: 0n
    })

    assert.strictEqual(botState.lifecycle.isDead, false)
    assert.deepStrictEqual(client.queued.map(packet => packet.name), [
      'respawn',
      'set_local_player_as_initialized'
    ])
    assert.strictEqual(client.queued[0].packet.state, 2)
    assert.deepStrictEqual(client.queued[0].packet.position, { x: 0.5, y: 65.62, z: 0.5 })
  })

  it('matches Bedrock death-screen respawn packet order', async function () {
    const { botState, client } = createBot()

    client.emit('death_info', {
      cause: 'death.attack.generic',
      messages: ['OpBot']
    })
    client.emit('respawn', {
      state: 0,
      position: { x: 0.5, y: 65.62, z: 0.5 },
      runtime_entity_id: 0n
    })

    await sleep(350)

    client.emit('respawn', {
      state: 0,
      position: { x: 0, y: 32767, z: 0 },
      runtime_entity_id: 0n
    })
    client.emit('respawn', {
      state: 1,
      position: { x: 3.5, y: -58.38, z: -7.5 },
      runtime_entity_id: 0n
    })

    assert.strictEqual(botState.lifecycle.isDead, true)
    assert.deepStrictEqual(client.queued.map(packet => packet.name), [
      'respawn',
      'player_action'
    ])
    assert.deepStrictEqual(client.queued[0].packet, {
      position: { x: 0, y: 0, z: 0 },
      state: 2,
      runtime_entity_id: 1n
    })
    assert.deepStrictEqual(client.queued[1].packet, {
      runtime_entity_id: 1n,
      action: 'respawn',
      position: { x: 0, y: 0, z: 0 },
      result_position: { x: 0, y: 0, z: 0 },
      face: -1
    })

    client.emit('set_health', { health: 20 })
    assert.strictEqual(botState.lifecycle.isDead, false)
    assert.strictEqual(botState.playerState.health, 20)
    assert.strictEqual(botState.lifecycle.respawnTimeout, null)
  })

  it('uses the fallback action when the server never sends ready state', async function () {
    const { client } = createBot()

    client.emit('death_info', {
      cause: 'death.attack.generic',
      messages: ['OpBot']
    })
    await sleep(350)

    assert.deepStrictEqual(client.queued.map(packet => packet.name), ['respawn'])

    await sleep(5100)

    assert.deepStrictEqual(client.queued.map(packet => packet.name), ['respawn', 'player_action'])
    assert.strictEqual(client.queued[1].packet.action, 'respawn')
  })

  it('treats Geyser respawn entity_event as completion', async function () {
    const { botState, client } = createBot()

    client.emit('death_info', {
      cause: 'death.attack.generic',
      messages: ['OpBot']
    })

    await sleep(350)

    client.emit('entity_event', {
      runtime_entity_id: 1n,
      event_id: 'respawn'
    })

    assert.strictEqual(botState.lifecycle.isDead, false)
    assert.strictEqual(botState.playerState.health, 20)
    assert.strictEqual(botState.lifecycle.respawnTimeout, null)
  })
})
