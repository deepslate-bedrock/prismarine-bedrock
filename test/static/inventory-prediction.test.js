'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')

const injectInventory = require('../../src/builtins/inventory')
const injectInventoryActions = require('../../src/builtins/inventory-actions')
const { simulateStackRequest } = require('../../src/builtins/inventory-simulation')
const { bedrockRegistryName, DEFAULT_BEDROCK_VERSION } = require('../../src/version')

function createBotState () {
  const registry = require('prismarine-registry')(bedrockRegistryName(DEFAULT_BEDROCK_VERSION))
  const botState = new EventEmitter()
  const queuedRequests = []

  botState.client = new EventEmitter()
  botState.client.queue = (name, payload) => {
    if (name === 'item_stack_request') queuedRequests.push(...payload.requests)
  }
  botState.itemClass = require('prismarine-item')(registry)
  botState.windowFactory = require('prismarine-windows')(registry)
  botState.registry = registry
  botState.queuedRequests = queuedRequests
  botState.queuePlayerAuthInputEdit = edit => {
    const packet = {}
    edit(packet)
    queuedRequests.push(packet.item_stack_request)
  }
  botState.setAuthInputFlag = (packet, flag, value) => {
    packet.input_data ??= {}
    packet.input_data[flag] = value
  }
  botState.flushPlayerAuthInput = () => {}

  injectInventoryActions(botState, { inventoryResponseTimeoutMs: 100 })
  injectInventory(botState, {})
  return botState
}

function makeItem (botState, name, count, stackId) {
  const id = botState.registry.itemsByName[name].id
  const item = new botState.itemClass(id, count, 0, null, stackId, true)
  item.stackId = stackId
  item.stack_id = stackId
  return item
}

function responseSlot (slot, count, itemStackId) {
  return {
    slot,
    hotbar_slot: slot,
    count,
    item_stack_id: itemStackId,
    custom_name: '',
    filtered_custom_name: '',
    durability_correction: 0
  }
}

function emitStackResponse (botState, request, slots, cursor = null) {
  const containers = []
  if (slots.length > 0) {
    containers.push({
      slot_type: { container_id: 'hotbar_and_inventory' },
      slots
    })
  }
  if (cursor) {
    containers.push({
      slot_type: { container_id: 'cursor' },
      slots: [cursor]
    })
  }

  botState.client.emit('item_stack_response', {
    responses: [{
      status: 'ok',
      request_id: request.request_id,
      containers
    }]
  })
}

function assertSlot (slots, slot, name, count, stackId = undefined) {
  const item = slots[slot]
  if (name == null) {
    assert.strictEqual(item, null)
    return
  }

  assert(item, `slot ${slot} expected ${name} x${count}`)
  assert.strictEqual(item.name, name)
  assert.strictEqual(item.count, count)
  if (stackId !== undefined) assert.strictEqual(item.stackId ?? item.stack_id, stackId)
}

describe('predictive inventory actions', function () {
  it('keeps predicted inventory synced with actual inventory while idle', function () {
    const botState = createBotState()
    botState.inventory.updateSlot(0, makeItem(botState, 'dirt', 7, 10))

    assertSlot(botState.inventory.predicted, 0, 'dirt', 7, 10)

    botState.inventory.updateSlot(0, null)
    assertSlot(botState.inventory.predicted, 0, null, 0)
  })

  it('batches chained player inventory actions into one packet with ordered predicted requests', async function () {
    const botState = createBotState()
    botState.inventory.updateSlot(0, makeItem(botState, 'dirt', 7, 10))
    botState.inventory.updateSlot(1, null)

    const batchPromise = botState.inventory.actions.batch(inv => {
      inv.split(0, 1)
      inv.merge(0, 1)
    })
    await Promise.resolve()

    assert.strictEqual(botState.queuedRequests.length, 1)
    const request = botState.queuedRequests[0]
    assert.deepStrictEqual(request.actions.map(action => action.type_id), ['take'])
    assert.strictEqual(request.actions[0].count, 7)
    assertSlot(botState.inventory.slots, 0, 'dirt', 7, 10)
    assertSlot(botState.inventory.predicted, 0, null, 0)
    assertSlot(botState.inventory.predicted, 1, 'dirt', 7)

    emitStackResponse(botState, request, [
      responseSlot(0, 0, 0),
      responseSlot(1, 7, 31)
    ])
    const result = await batchPromise

    assert.strictEqual(result.requests.length, 1)
    assert.strictEqual(result.request.request_id, request.request_id)
    assertSlot(botState.inventory.slots, 0, null, 0)
    assertSlot(botState.inventory.slots, 1, 'dirt', 7, 31)
    assertSlot(botState.inventory.predicted, 1, 'dirt', 7, 31)
  })

  it('simulates vanilla provisional stack ids within packet-level batches', async function () {
    const botState = createBotState()
    botState.inventory.updateSlot(0, makeItem(botState, 'dirt', 7, 45))
    botState.inventory.updateSlot(1, null)
    botState.inventory.updateSlot(9, null)

    const batchPromise = botState.inventory.actions.batch(inv => {
      inv.split(0, 1)
      inv.move(1, 9)
    })
    await Promise.resolve()

    assert.strictEqual(botState.queuedRequests.length, 2)
    const [split, move] = botState.queuedRequests
    assert.strictEqual(move.actions[0].source.stack_id, split.request_id)
    assertSlot(botState.inventory.predicted, 0, 'dirt', 3)
    assertSlot(botState.inventory.predicted, 1, null, 0)
    assertSlot(botState.inventory.predicted, 9, 'dirt', 4)

    emitStackResponse(botState, split, [
      responseSlot(0, 3, 45),
      responseSlot(1, 4, 46)
    ])
    emitStackResponse(botState, move, [
      responseSlot(1, 0, 0),
      responseSlot(9, 4, 46)
    ])
    await batchPromise

    assertSlot(botState.inventory.predicted, 9, 'dirt', 4, 46)
  })

  it('predicts cursor pickup and placement without mutating actual slots before response', async function () {
    const botState = createBotState()
    botState.inventory.updateSlot(0, makeItem(botState, 'stick', 5, 12))
    botState.inventory.updateSlot(1, null)

    const pickupPromise = botState.inventory.pickup(0)
    await Promise.resolve()

    assert.strictEqual(botState.queuedRequests.length, 0)
    assert.strictEqual(botState.inventory.cursor.name, 'stick')
    assert.strictEqual(botState.inventory.cursor.count, 5)
    assertSlot(botState.inventory.slots, 0, 'stick', 5, 12)
    assertSlot(botState.inventory.predicted, 0, null, 0)

    await pickupPromise

    assert.strictEqual(botState.inventory.cursor.stackId, 12)
    assertSlot(botState.inventory.slots, 0, 'stick', 5, 12)

    const placePromise = botState.inventory.placeCursor(1)
    await Promise.resolve()

    assert.strictEqual(botState.queuedRequests.length, 1)
    const placeRequest = botState.queuedRequests[0]
    assert.deepStrictEqual(placeRequest.actions.map(action => action.type_id), ['take'])
    assert.strictEqual(placeRequest.actions[0].source.stack_id, 12)
    assert.strictEqual(botState.inventory.cursor, null)
    assertSlot(botState.inventory.slots, 1, null, 0)
    assertSlot(botState.inventory.predicted, 1, 'stick', 5)

    emitStackResponse(botState, placeRequest, [
      responseSlot(0, 0, 0),
      responseSlot(1, 5, 41)
    ])
    await placePromise

    assert.strictEqual(botState.inventory.cursor, null)
    assertSlot(botState.inventory.slots, 0, null, 0)
    assertSlot(botState.inventory.slots, 1, 'stick', 5, 41)
  })

  it('fails prediction and resyncs to server-authoritative response mismatches', async function () {
    const botState = createBotState()
    botState.inventory.updateSlot(0, makeItem(botState, 'dirt', 7, 10))
    botState.inventory.updateSlot(1, null)

    let failure = null
    botState.on('inventory_prediction_failed', payload => {
      failure = payload
    })

    const movePromise = botState.moveOneInventoryItem(0, 1)
    await Promise.resolve()
    const request = botState.queuedRequests[0]

    emitStackResponse(botState, request, [
      responseSlot(0, 6, 10),
      responseSlot(1, 2, 32)
    ])

    await assert.rejects(movePromise, /Inventory prediction failed/)
    assert(failure, 'expected inventory_prediction_failed event')
    assert.deepStrictEqual(failure.mismatches, ['slot 1: predicted 1, server 2'])
    assertSlot(botState.inventory.slots, 0, 'dirt', 6, 10)
    assertSlot(botState.inventory.slots, 1, 'dirt', 2, 32)
    assertSlot(botState.inventory.predicted, 1, 'dirt', 2, 32)
  })

  it('simulates container moves and accepts crafting metadata actions', function () {
    const botState = createBotState()
    const diamond = makeItem(botState, 'diamond', 3, 70)
    const state = {
      slots: [diamond],
      cursor: null,
      activeWindowId: 16,
      activeWindow: { slots: [null, null] },
      windows: new Map([[16, { slots: [null, null] }]])
    }

    const result = simulateStackRequest(state, {
      request_id: -77,
      actions: [
        { type_id: 'craft_recipe', recipe_network_id: 272, times_crafted: 1 },
        { type_id: 'results_deprecated', result_items: [], times_crafted: 1 },
        {
          type_id: 'place',
          count: 3,
          source: { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 70 },
          destination: { slot_type: { container_id: 'container' }, slot: 0, stack_id: 0 }
        }
      ]
    }, { provisionalStackId: -77 })

    assertSlot(result.slots, 0, null, 0)
    assert.strictEqual(result.activeWindow.slots[0].name, 'diamond')
    assert.strictEqual(result.activeWindow.slots[0].count, 3)
    assert.strictEqual(result.activeWindow.slots[0].stack_id, -77)
    assert.deepStrictEqual(result.metadataActions.map(action => action.type_id), ['craft_recipe', 'results_deprecated'])
  })

  it('distinguishes destroy from drop in generated requests', async function () {
    const botState = createBotState()
    botState.inventory.updateSlot(0, makeItem(botState, 'dirt', 7, 10))

    const destroyPromise = botState.inventory.destroy(0)
    await Promise.resolve()

    const request = botState.queuedRequests[0]
    assert.deepStrictEqual(request.actions.map(action => action.type_id), ['destroy'])
    emitStackResponse(botState, request, [
      responseSlot(0, 0, 0)
    ])
    await destroyPromise
    assertSlot(botState.inventory.predicted, 0, null, 0)
  })
})
