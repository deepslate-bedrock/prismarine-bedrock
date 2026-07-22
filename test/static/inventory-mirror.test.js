'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')

const injectInventory = require('../../src/builtins/inventory')
const injectInventoryActions = require('../../src/builtins/inventory-actions')
const { bedrockRegistryName, DEFAULT_BEDROCK_VERSION } = require('../../src/version')

function createBotState () {
  const registry = require('prismarine-registry')(bedrockRegistryName(DEFAULT_BEDROCK_VERSION))
  const botState = new EventEmitter()

  botState.client = new EventEmitter()
  botState.itemClass = require('prismarine-item')(registry)
  botState.windowFactory = require('prismarine-windows')(registry)

  return botState
}

describe('inventory mirror', function () {
  it('groups inventory slot actions and low-level request helpers on bot.inventory', function () {
    const botState = createBotState()
    injectInventoryActions(botState, {})
    injectInventory(botState, {})

    assert.strictEqual(typeof botState.inventory.select, 'function')
    assert.strictEqual(typeof botState.inventory.equip, 'function')
    assert.strictEqual(typeof botState.inventory.move1, 'function')
    assert.strictEqual(typeof botState.inventory.drop1, 'function')
    assert.strictEqual(typeof botState.inventory.destroy1, 'function')
    assert.strictEqual(typeof botState.inventory.getItem, 'function')
    assert.strictEqual(typeof botState.inventory.findItem, 'function')
    assert.strictEqual(typeof botState.inventory.count, 'function')
    assert.strictEqual(typeof botState.inventory.actions.send, 'function')
    assert.strictEqual(typeof botState.inventory.actions.sendStandalone, 'function')
    assert.strictEqual(typeof botState.inventory.actions.wait, 'function')
    assert.strictEqual(typeof botState.inventory.actions.waitRaw, 'function')
    assert.strictEqual(typeof botState.inventory.actions.makeRequest, 'function')
  })

  it('swaps occupied hotbar and main-inventory slots through the recorded cursor sequence', async function () {
    const botState = createBotState()
    const requests = []
    const lifecycle = []
    botState.client.entityId = 1n

    botState.client.queue = (name, params) => {
      if (name === 'interact') {
        lifecycle.push(params.action_id)
        queueMicrotask(() => botState.client.emit('container_open', {
          window_id: 2,
          window_type: 'inventory'
        }))
        return
      }
      if (name === 'container_close') {
        lifecycle.push(name)
        queueMicrotask(() => botState.client.emit('container_close', params))
        return
      }

      assert.strictEqual(name, 'item_stack_request')
      const request = params.requests[0]
      requests.push(request)

      const responseContainers = request.actions[0].type_id === 'take'
        ? [
            { slot_type: { container_id: 'inventory' }, slots: [{ slot: 9, count: 0, item_stack_id: 0 }] },
            { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 5, item_stack_id: 22 }] }
          ]
        : request.actions[0].type_id === 'swap'
          ? [
              { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 3, item_stack_id: 11 }] },
              { slot_type: { container_id: 'hotbar' }, slots: [{ slot: 0, count: 5, item_stack_id: 22 }] }
            ]
          : [
              { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 0, item_stack_id: 0 }] },
              { slot_type: { container_id: 'inventory' }, slots: [{ slot: 9, count: 3, item_stack_id: 11 }] }
            ]

      queueMicrotask(() => botState.client.emit('item_stack_response', {
        responses: [{
          request_id: request.request_id,
          status: 'ok',
          containers: responseContainers
        }]
      }))
    }

    injectInventoryActions(botState, {})
    injectInventory(botState, {})

    const diamond = new botState.itemClass(1, 3, 0, null, 11)
    diamond.stackId = 11
    diamond.stack_id = 11
    const stick = new botState.itemClass(2, 5, 0, null, 22)
    stick.stackId = 22
    stick.stack_id = 22
    botState.inventory.updateSlot(0, diamond)
    botState.inventory.updateSlot(9, stick)

    await botState.inventory.swap(0, 9)

    assert.deepStrictEqual(lifecycle, ['open_inventory', 'container_close'])
    assert.deepStrictEqual(requests.map(request => ({
      request_id: request.request_id,
      action: request.actions[0]
    })), [
      {
        request_id: -1001,
        action: {
          type_id: 'take',
          count: 5,
          source: { slot_type: { container_id: 'inventory' }, slot: 9, stack_id: 22 },
          destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 }
        }
      },
      {
        request_id: -1003,
        action: {
          type_id: 'swap',
          source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 22 },
          destination: { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 11 }
        }
      },
      {
        request_id: -1005,
        action: {
          type_id: 'place',
          count: 3,
          source: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 11 },
          destination: { slot_type: { container_id: 'inventory' }, slot: 9, stack_id: 0 }
        }
      }
    ])
    assert(requests.every(request => request.cause === -1))
    assert.strictEqual(botState.inventory.slots[0].type, 2)
    assert.strictEqual(botState.inventory.slots[0].count, 5)
    assert.strictEqual(botState.inventory.slots[9].type, 1)
    assert.strictEqual(botState.inventory.slots[9].count, 3)
  })

  it('mirrors armor and offhand as persistent windows while keeping ui as a slot map', function () {
    const botState = createBotState()
    injectInventory(botState, {})

    assert.strictEqual(botState.getWindow('armor'), botState.armor)
    assert.strictEqual(botState.getWindow('offhand'), botState.offhand)
    assert.strictEqual(botState.getWindow('ui'), null)
    assert(botState.uiSlots instanceof Map)

    botState.client.emit('inventory_content', {
      window_id: 'armor',
      input: [
        { network_id: 0 },
        { network_id: 0 },
        { network_id: 0 },
        { network_id: 0 }
      ]
    })

    botState.client.emit('inventory_content', {
      window_id: 'offhand',
      input: [{ network_id: 0 }]
    })

    assert.strictEqual(botState.armor.lastContentAt > 0, true)
    assert.strictEqual(botState.offhand.lastContentAt > 0, true)

    botState.client.emit('inventory_slot', {
      window_id: 'ui',
      slot: 50,
      item: { network_id: 0 }
    })

    assert.strictEqual(botState.getUiSlot(50), null)
    assert.strictEqual(botState.getWindow('ui'), null)

    botState.client.emit('container_close', { window_id: 'armor' })
    botState.client.emit('container_close', { window_id: 'offhand' })

    assert.strictEqual(botState.getWindow('armor'), botState.armor)
    assert.strictEqual(botState.getWindow('offhand'), botState.offhand)
  })
})
