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
