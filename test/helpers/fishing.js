'use strict'

// Shared scripted-client harness for the fishing static and replay tests.
// Feeds normalized clientbound packets into the REAL builtins (auth-input,
// entities, held-item-use, fishing) and intercepts the serverbound queue and
// auth-input output. Tests must not call internal state transitions directly.

const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const injectAuthInput = require('../../src/builtins/auth-input')
const injectEntities = require('../../src/builtins/entities')
const injectHeldItemUse = require('../../src/builtins/held-item-use')
const injectFishing = require('../../src/builtins/fishing')

// Deterministic symbolic ids. Runtime and unique ids are DISTINCT on purpose:
// the verified capture stored the hook as runtime 13 and removed it as unique
// -8589934583.
const IDS = Object.freeze({
  selfRuntimeId: 1n,
  selfUniqueId: -8589934591n,
  otherPlayerUniqueId: -8589934590n,
  hookRuntimeId: 13n,
  hookUniqueId: -8589934583n,
  otherHookRuntimeId: 21n,
  otherHookUniqueId: -8589934580n,
  caughtItemRuntimeId: 19n,
  caughtItemUniqueId: -8589934577n,
  xpOrb1RuntimeId: 20n,
  xpOrb1UniqueId: -8589934576n,
  xpOrb2RuntimeId: 22n,
  xpOrb2UniqueId: -8589934575n
})

const HOOK_POSITION = Object.freeze({ x: 20.496, y: 2.242, z: 1.65 })

let cachedRegistry = null
function getRegistry () {
  cachedRegistry ??= require('prismarine-registry')('bedrock_1.26.10')
  return cachedRegistry
}

// Network ids are session-assigned; resolve through the registry like the
// implementation does instead of hard-coding capture-session values.
function rodNetworkId () {
  return getRegistry().itemsByName?.fishing_rod?.id ?? 424
}

function caughtNetworkId () {
  return getRegistry().itemsByName?.cod?.id ?? 293
}

function makeRodItem () {
  const networkId = rodNetworkId()
  return {
    type: networkId,
    name: 'fishing_rod',
    displayName: 'Fishing Rod',
    count: 1,
    metadata: 0,
    toNotch () {
      return {
        network_id: networkId,
        count: 1,
        metadata: 0,
        has_stack_id: 0,
        block_runtime_id: 0,
        extra: {
          has_nbt: true,
          nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: 0 } } } },
          can_place_on: [],
          can_destroy: []
        }
      }
    }
  }
}

function createFishingBot (options = {}) {
  const registry = getRegistry()

  const client = new EventEmitter()
  client.entityId = IDS.selfRuntimeId
  client.status = 3
  client.queued = []
  client.queue = (name, params) => client.queued.push({ name, params })

  const botState = new EventEmitter()
  botState.client = client
  botState.registry = registry
  botState.entityClass = require('prismarine-entity')(registry)
  botState.itemClass = {
    fromNotch (raw) {
      if (!raw || !raw.network_id) return null
      const data = registry.items?.[raw.network_id]
      return {
        type: raw.network_id,
        name: data?.name ?? 'item',
        displayName: data?.displayName ?? 'Item',
        count: raw.count ?? 1,
        metadata: raw.metadata ?? 0
      }
    }
  }

  botState.self = {
    id: IDS.selfUniqueId,
    uniqueId: IDS.selfUniqueId,
    runtimeId: IDS.selfRuntimeId,
    position: new Vec3(20.5, 2.62, 1.5),
    yaw: 0,
    pitch: 0
  }
  botState.heldItemSlot = 0
  botState.inventory = { slots: [makeRodItem()] }

  injectAuthInput(botState)
  injectEntities(botState, {})
  injectHeldItemUse(botState)
  injectFishing(botState, options.injectOptions ?? {})

  if (options.heldItem !== undefined) botState.inventory.slots[0] = options.heldItem

  return botState
}

// Simulates one outbound player_auth_input tick and returns the packet the
// pre-send hooks produced, mirroring src/builtins/physics/movement-packets.js.
function authTick (botState) {
  const packet = { input_data: {} }
  botState._applyPlayerAuthInputHooks(packet, {})
  return packet
}

function recordFishingEvents (botState) {
  const events = []
  for (const name of [
    'fishingStateChanged',
    'fishingHookSpawned',
    'fishingHookUpdated',
    'fishingBite',
    'fishingCatch',
    'fishingStopped'
  ]) {
    botState.on(name, (...args) => events.push({ name, args }))
  }
  return events
}

// ---- clientbound packet factories (shapes from the verified wire reference) ----

function hookSpawnPacket (overrides = {}) {
  const metadata = overrides.metadata ?? [
    { key: 'owner_eid', type: 'long', value: IDS.selfUniqueId },
    { key: 'target_eid', type: 'long', value: 0n },
    { key: 'fish_x', type: 'float', value: 0 },
    { key: 'fish_z', type: 'float', value: 0 },
    { key: 'fish_angle', type: 'float', value: 0 },
    { key: 'heartbeat_sound_event', type: 'int', value: 599 }
  ]

  return {
    entity_type: 'minecraft:fishing_hook',
    unique_id: IDS.hookUniqueId,
    runtime_id: IDS.hookRuntimeId,
    position: { ...HOOK_POSITION },
    velocity: { x: -0.024, y: -0.955, z: 0.881 },
    yaw: 0,
    pitch: 0,
    attributes: [],
    ...overrides,
    metadata
  }
}

function hookDataPacket (fields, runtimeId = IDS.hookRuntimeId) {
  const metadata = []
  for (const [key, value] of Object.entries(fields)) {
    metadata.push({ key, type: key.endsWith('_eid') ? 'long' : 'float', value })
  }
  return { runtime_entity_id: runtimeId, metadata }
}

function entityEventPacket (eventId, runtimeId = IDS.hookRuntimeId) {
  return { runtime_entity_id: runtimeId, event_id: eventId, data: 0 }
}

function removeEntityPacket (uniqueId = IDS.hookUniqueId) {
  return { entity_id_self: uniqueId }
}

function caughtItemPacket (overrides = {}) {
  return {
    entity_id_self: IDS.caughtItemUniqueId,
    runtime_entity_id: IDS.caughtItemRuntimeId,
    item: { network_id: caughtNetworkId(), count: 1, metadata: 0 },
    // Same X/Z as the hook but 1-2 blocks BELOW the surface (verified).
    position: { x: 20.351, y: -0.876, z: 1.55 },
    velocity: { x: 0.015, y: 0.506, z: -0.543 },
    metadata: [],
    is_from_fishing: true,
    ...overrides
  }
}

function xpOrbPacket (runtimeId = IDS.xpOrb1RuntimeId, uniqueId = IDS.xpOrb1UniqueId) {
  return {
    entity_type: 'minecraft:xp_orb',
    unique_id: uniqueId,
    runtime_id: runtimeId,
    // XP orbs spawn at the PLAYER's position with owner_eid -1 (verified);
    // hook-distance matching would fail for them.
    position: { x: 20.5, y: 2.62, z: 1.5 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    attributes: [],
    metadata: [
      { key: 'owner_eid', type: 'long', value: -1n },
      { key: 'heartbeat_sound_event', type: 'int', value: 599 },
      { key: 'experience_value', type: 'int', value: 1 }
    ]
  }
}

function motionPacket (velocityY, runtimeId = IDS.hookRuntimeId) {
  return { runtime_entity_id: runtimeId, velocity: { x: 0, y: velocityY, z: 0 } }
}

function completedUsingItemPacket () {
  return { item_id: rodNetworkId(), use_method: -1 }
}

function itemReleaseAckPacket () {
  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_release',
      actions: [],
      transaction_data: {
        action_type: 'consume',
        hotbar_slot: 0,
        held_item: { network_id: rodNetworkId(), count: 1, metadata: 0 },
        head_pos: { x: 20.5, y: 2.62, z: 1.5 }
      }
    }
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Summarizes a serverbound queue entry as "name" or "name:action_type" so
// fixtures can assert exact packet order compactly.
function summarizeServerbound (entry) {
  if (entry.name === 'inventory_transaction') {
    const data = entry.params?.transaction?.transaction_data
    return `inventory_transaction:${data?.action_type ?? 'unknown'}`
  }
  if (entry.name === 'animate') {
    return `animate:${entry.params?.swing_source ?? entry.params?.action_id}`
  }
  return entry.name
}

module.exports = {
  IDS,
  HOOK_POSITION,
  authTick,
  caughtItemPacket,
  caughtNetworkId,
  completedUsingItemPacket,
  createFishingBot,
  entityEventPacket,
  getRegistry,
  hookDataPacket,
  hookSpawnPacket,
  itemReleaseAckPacket,
  makeRodItem,
  motionPacket,
  recordFishingEvents,
  removeEntityPacket,
  rodNetworkId,
  sleep,
  summarizeServerbound,
  xpOrbPacket
}
