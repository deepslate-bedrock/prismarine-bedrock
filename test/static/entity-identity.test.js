'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const injectEntities = require('../../src/builtins/entities')

const SELF_UNIQUE_ID = -8589934591n
const HOOK_RUNTIME_ID = 13n
const HOOK_UNIQUE_ID = -8589934583n

function createEntityState () {
  const registry = require('prismarine-registry')('bedrock_1.26.10')
  const state = new EventEmitter()

  state.registry = registry
  state.entityClass = require('prismarine-entity')(registry)
  state.itemClass = {
    fromNotch (raw) {
      if (!raw) return null
      return { name: 'item', displayName: 'Item', count: raw.count ?? 1, raw }
    }
  }
  state.client = new EventEmitter()

  injectEntities(state, {})
  return state
}

function hookSpawnPacket (overrides = {}) {
  return {
    entity_type: 'minecraft:fishing_hook',
    unique_id: HOOK_UNIQUE_ID,
    runtime_id: HOOK_RUNTIME_ID,
    position: { x: 20.496, y: 2.242, z: 1.65 },
    velocity: { x: -0.024, y: -0.955, z: 0.881 },
    yaw: 0,
    pitch: 0,
    metadata: [
      { key: 'owner_eid', type: 'long', value: SELF_UNIQUE_ID },
      { key: 'target_eid', type: 'long', value: 0n },
      { key: 'fish_x', type: 'float', value: 0 },
      { key: 'fish_z', type: 'float', value: 0 },
      { key: 'fish_angle', type: 'float', value: 0 },
      { key: 'heartbeat_sound_event', type: 'int', value: 599 }
    ],
    attributes: [],
    ...overrides
  }
}

describe('entity runtime/unique identity', function () {
  it('stores hooks by runtime id with both ids and fishing metadata fields', function () {
    const state = createEntityState()
    state.client.emit('add_entity', hookSpawnPacket())

    const hook = state.entities.get(HOOK_RUNTIME_ID)
    assert(hook, 'expected hook stored under runtime id')
    assert.strictEqual(hook.runtimeId, HOOK_RUNTIME_ID)
    assert.strictEqual(hook.uniqueId, HOOK_UNIQUE_ID)
    assert.strictEqual(hook.ownerEid, SELF_UNIQUE_ID)
    assert.strictEqual(hook.targetEid, 0n)
    assert.strictEqual(hook.fishX, 0)
    assert.strictEqual(hook.fishZ, 0)
    assert.strictEqual(hook.fishAngle, 0)
    assert.strictEqual(state.entitiesByUniqueId.get(HOOK_UNIQUE_ID), hook)
    // The generic metadata view is preserved alongside the derived fields.
    assert.strictEqual(hook.metadataByKey.owner_eid, SELF_UNIQUE_ID)
  })

  it('removes a runtime-id-stored entity through its unique id exactly once', function () {
    const state = createEntityState()
    state.client.emit('add_entity', hookSpawnPacket())

    const removed = []
    state.on('entityRemoved', entity => removed.push(entity))

    state.client.emit('remove_entity', { entity_id_self: HOOK_UNIQUE_ID })
    state.client.emit('remove_entity', { entity_id_self: HOOK_UNIQUE_ID })
    state.client.emit('remove_entity', { entity_id_self: HOOK_RUNTIME_ID })

    assert.strictEqual(removed.length, 1)
    assert.strictEqual(removed[0].isValid, false)
    assert.strictEqual(state.entities.has(HOOK_RUNTIME_ID), false)
    assert.strictEqual(state.entitiesByUniqueId.has(HOOK_UNIQUE_ID), false)
  })

  it('keeps unrelated entities when one is removed', function () {
    const state = createEntityState()
    state.client.emit('add_entity', hookSpawnPacket())
    state.client.emit('add_entity', hookSpawnPacket({
      entity_type: 'minecraft:xp_orb',
      unique_id: -8589934577n,
      runtime_id: 19n,
      metadata: [{ key: 'heartbeat_sound_event', type: 'int', value: 599 }]
    }))

    state.client.emit('remove_entity', { entity_id_self: HOOK_UNIQUE_ID })

    assert.strictEqual(state.entities.has(HOOK_RUNTIME_ID), false)
    assert(state.entities.get(19n), 'unrelated entity must survive')
    assert.strictEqual(state.entitiesByUniqueId.get(-8589934577n), state.entities.get(19n))
  })

  it('indexes item entities by both ids and keeps isFromFishing', function () {
    const state = createEntityState()
    state.client.emit('add_item_entity', {
      entity_id_self: -8589934577n,
      runtime_entity_id: 19n,
      item: { network_id: 293, count: 1, metadata: 0 },
      position: { x: 20.351, y: -0.876, z: 6.925 },
      velocity: { x: 0.015, y: 0.506, z: -0.543 },
      metadata: [],
      is_from_fishing: true
    })

    const item = state.entities.get(19n)
    assert(item, 'expected item entity stored under runtime id')
    assert.strictEqual(item.uniqueId, -8589934577n)
    assert.strictEqual(item.isFromFishing, true)

    state.client.emit('remove_entity', { entity_id_self: -8589934577n })
    assert.strictEqual(state.entities.has(19n), false)
  })

  it('updates fishing metadata and emits entityDataUpdated on set_entity_data', function () {
    const state = createEntityState()
    state.client.emit('add_entity', hookSpawnPacket())

    const updates = []
    state.on('entityDataUpdated', (entity, packet) => updates.push({ entity, packet }))

    state.client.emit('set_entity_data', {
      runtime_entity_id: HOOK_RUNTIME_ID,
      metadata: [
        { key: 'fish_x', type: 'float', value: 0.768 },
        { key: 'fish_z', type: 'float', value: 0.31 },
        { key: 'fish_angle', type: 'float', value: 13572.97 }
      ]
    })

    const hook = state.entities.get(HOOK_RUNTIME_ID)
    assert.strictEqual(updates.length, 1)
    assert.strictEqual(updates[0].entity, hook)
    assert.strictEqual(hook.fishX, 0.768)
    assert.strictEqual(hook.fishZ, 0.31)
    assert.strictEqual(hook.fishAngle, 13572.97)
  })

  it('keeps generic entityEvent behavior for the fishing entity events', function () {
    const state = createEntityState()
    state.client.emit('add_entity', hookSpawnPacket())

    const events = []
    state.on('entityEvent', (entity, eventId, data) => events.push({ entity, eventId, data }))

    for (const eventId of ['fish_hook_bubble', 'fish_hook_position', 'fish_hook_hook', 'fish_hook_tease']) {
      state.client.emit('entity_event', { runtime_entity_id: HOOK_RUNTIME_ID, event_id: eventId, data: 0 })
    }

    assert.deepStrictEqual(events.map(event => event.eventId), [
      'fish_hook_bubble', 'fish_hook_position', 'fish_hook_hook', 'fish_hook_tease'
    ])
    assert(events.every(event => event.entity === state.entities.get(HOOK_RUNTIME_ID)))
  })

  it('treats move_entity_delta axes as absolute coordinates, not deltas', function () {
    const state = createEntityState()
    state.client.emit('add_entity', hookSpawnPacket())

    // Since Bedrock 1.16.100 MoveActorDelta carries absolute per-axis values;
    // accumulating them drifts hook positions and breaks catch correlation.
    state.client.emit('move_entity_delta', {
      runtime_entity_id: HOOK_RUNTIME_ID,
      flags: { has_x: true, has_y: true, has_z: true },
      x: 1.5,
      y: 0.2,
      z: 7.54
    })
    state.client.emit('move_entity_delta', {
      runtime_entity_id: HOOK_RUNTIME_ID,
      flags: { has_x: false, has_y: true, has_z: false },
      y: 0.1
    })

    const hook = state.entities.get(HOOK_RUNTIME_ID)
    assert.strictEqual(hook.position.x, 1.5)
    assert.strictEqual(hook.position.y, 0.1)
    assert.strictEqual(hook.position.z, 7.54)
  })

  it('clears the unique-id index on close', function () {
    const state = createEntityState()
    state.client.emit('add_entity', hookSpawnPacket())
    state.client.emit('close')

    assert.strictEqual(state.entities.size, 0)
    assert.strictEqual(state.entitiesByUniqueId.size, 0)
  })
})
