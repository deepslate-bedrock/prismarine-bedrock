'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const Vec3 = require('vec3')

const installEntities = require('../../src/builtins/entities')

class TestEntity {
  constructor (id) {
    this.id = id
    this.position = new Vec3(0, 0, 0)
    this.velocity = new Vec3(0, 0, 0)
    this.isValid = true
  }
}

function createEntityHarness () {
  const client = new EventEmitter()
  const botState = new EventEmitter()
  botState.client = client
  botState.registry = {
    entitiesArray: [{
      id: 105,
      name: 'tropicalfish',
      type: 'mob',
      displayName: 'Tropical Fish',
      category: 'mob',
      height: 0.6,
      width: 0.5
    }]
  }
  botState.entityClass = TestEntity
  botState.itemClass = { fromNotch: () => null }
  botState.entities = new Map()
  botState.playerEntities = new Map()

  installEntities(botState, {})
  return { botState, client }
}

function spawnTropicalFish (client, uniqueId, runtimeId) {
  client.emit('add_entity', {
    unique_id: uniqueId,
    runtime_id: runtimeId,
    entity_type: 'minecraft:tropicalfish',
    position: { x: 1, y: 2, z: 3 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    metadata: [],
    attributes: []
  })
}

function assertFishRemoved ({ uniqueId, runtimeId }) {
  const { botState, client } = createEntityHarness()
  const removed = []
  botState.on('entityRemoved', entity => removed.push(entity))

  spawnTropicalFish(client, uniqueId, runtimeId)
  const fish = botState.entities.get(runtimeId)

  assert(fish)
  assert.strictEqual(fish.id, uniqueId)
  assert.strictEqual(fish.runtimeId, runtimeId)
  assert.strictEqual(fish.isValid, true)

  client.emit('remove_entity', { entity_id_self: uniqueId })

  assert.strictEqual(botState.entities.has(runtimeId), false)
  assert.strictEqual(fish.isValid, false)
  assert.deepStrictEqual(removed, [fish])
}

describe('entity tracking', function () {
  it('removes an entity by unique ID when its runtime ID differs', function () {
    assertFishRemoved({ uniqueId: 100n, runtimeId: 5n })
  })

  it('continues to remove entities when servers use equal unique and runtime IDs', function () {
    assertFishRemoved({ uniqueId: 5n, runtimeId: 5n })
  })

  it('does not confuse another entity runtime ID with the removal unique ID', function () {
    const { botState, client } = createEntityHarness()

    spawnTropicalFish(client, 100n, 5n)
    spawnTropicalFish(client, 200n, 100n)
    const removedFish = botState.entities.get(5n)
    const remainingFish = botState.entities.get(100n)

    client.emit('remove_entity', { entity_id_self: 100n })

    assert.strictEqual(botState.entities.has(5n), false)
    assert.strictEqual(removedFish.isValid, false)
    assert.strictEqual(botState.entities.get(100n), remainingFish)
    assert.strictEqual(remainingFish.isValid, true)
  })
})
