'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const containersPlugin = require('../../src/builtins/containers')
const { raycastBlock } = require('../../src/utils')

function createState () {
  const client = new EventEmitter()
  client.entityId = 1n
  client.queued = []
  client.queue = (name, params) => {
    client.queued.push({ name, params })
    if (name === 'inventory_transaction') {
      setImmediate(() => {
        client.emit('container_open', {
          window_id: 1,
          window_type: 'container',
          coordinates: { x: 0, y: 0, z: 0 }
        })
      })
    }
  }

  const state = new EventEmitter()
  state.client = client
  state.self = {
    runtimeId: 1n,
    position: new Vec3(0.5, 2.5, 3.5),
    yaw: 180,
    pitch: 26.565051177
  }
  state.inventory = { slots: [] }
  state.heldItemSlot = 0
  state.windows = new Map([
    [1, {
      inventoryStart: 27,
      slots: [],
      lastContentAt: Date.now()
    }]
  ])
  state.world = {
    sync: {
      getBlock () {
        return { name: 'chest', stateId: 0 }
      }
    }
  }
  state.registry = {
    blockNetworkRuntimeIdsByStateId: { 0: 0 }
  }

  containersPlugin(state, { containerOpenTimeoutMs: 100, containerContentTimeoutMs: 100 })
  return state
}

describe('container ray casting', function () {
  it('intersects the target block and reports the hit face', function () {
    const hit = raycastBlock(
      new Vec3(0.5, 2.5, 3.5),
      new Vec3(0, 0, 0),
      180,
      26.565051177
    )

    assert.strictEqual(hit.face, 1)
    assert(Math.abs(hit.clickPosition.x - 0.5) < 0.001)
    assert(Math.abs(hit.clickPosition.y - 1) < 0.001)
    assert(Math.abs(hit.clickPosition.z - 0.5) < 0.001)
  })

  it('accepts a custom shape override instead of raycasting the full block cell', function () {
    const hit = raycastBlock(
      new Vec3(0.5, 0.5, -1),
      new Vec3(0, 0, 0),
      0,
      0,
      { shapeOverride: [[0.25, 0.25, 0.75, 0.75, 0.75, 0.8125]] }
    )

    assert.strictEqual(hit.face, 2)
    assert(Math.abs(hit.clickPosition.x - 0.5) < 0.001)
    assert(Math.abs(hit.clickPosition.y - 0.5) < 0.001)
    assert(Math.abs(hit.clickPosition.z - 0.75) < 0.001)
  })

  it('uses ray casting to choose the open-container face when no face is supplied', async function () {
    const state = createState()

    await state.openContainer(new Vec3(0, 0, 0), {
      type: 'container',
      look: false
    })

    const startUse = state.client.queued.find(packet => packet.name === 'player_action')
    const transaction = state.client.queued.find(packet => packet.name === 'inventory_transaction')
      .params.transaction.transaction_data

    assert.strictEqual(startUse.params.face, 1)
    assert.strictEqual(transaction.face, 1)
    assert(Math.abs(transaction.click_pos.x - 0.5) < 0.001)
    assert(Math.abs(transaction.click_pos.y - 1) < 0.001)
    assert(Math.abs(transaction.click_pos.z - 0.5) < 0.001)
  })
})
