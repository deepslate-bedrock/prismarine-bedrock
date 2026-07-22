'use strict'

const assert = require('assert')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { DEFAULT_BEDROCK_VERSION } = require('../../src/version')
const injectHeldItemUse = require('../../src/builtins/held-item-use')
const injectFishing = require('../../src/builtins/fishing')

const {
  IDS,
  authTick,
  caughtItemPacket,
  completedUsingItemPacket,
  createFishingBot,
  entityEventPacket,
  hookDataPacket,
  hookSpawnPacket,
  itemReleaseAckPacket,
  makeRodItem,
  motionPacket,
  recordFishingEvents,
  removeEntityPacket,
  rodNetworkId,
  sleep,
  summarizeServerbound
} = require('../helpers/fishing')

const { FishingCancelledError, FishingTimeoutError, FishingPreconditionError } = injectFishing
const { toCancellationError } = injectFishing._fishingHelpers
const { makeHeldItemUsePacket, makeUseItemSwingPacket } = injectHeldItemUse._heldItemUseHelpers

function roundTrip (packet) {
  const serializer = createSerializer(DEFAULT_BEDROCK_VERSION)
  const deserializer = createDeserializer(DEFAULT_BEDROCK_VERSION)
  const buffer = serializer.createPacketBuffer(packet)
  return deserializer.parsePacketBuffer(buffer).data
}

function assertClose (actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-3, `${message}: ${actual} != ${expected}`)
}

const SAMPLE_BLOCK_HIT = Object.freeze({
  blockPosition: { x: 20, y: 0, z: 1 },
  face: 3,
  clickPosition: { x: 0.5, y: 1, z: 0.5 },
  blockRuntimeId: 4321
})

describe('fishing builtin', function () {
  this.timeout(10000)

  describe('held-item-use packet shapes (protocol round trips)', function () {
    it('round-trips the click_block cast form with the verified field names', function () {
      const bot = createFishingBot()
      const raw = makeRodItem().toNotch()
      const parsed = roundTrip({
        name: 'inventory_transaction',
        params: makeHeldItemUsePacket(bot, 0, raw, 'click_block', SAMPLE_BLOCK_HIT)
      })

      const transaction = parsed.params.transaction
      assert.strictEqual(transaction.transaction_type, 'item_use')
      const data = transaction.transaction_data
      assert.strictEqual(data.action_type, 'click_block')
      assert.strictEqual(data.trigger_type, 'player_input')
      assert.deepStrictEqual(data.block_position, { x: 20, y: 0, z: 1 })
      assert.strictEqual(data.face, 3)
      assert.strictEqual(data.hotbar_slot, 0)
      assert.strictEqual(data.held_item.network_id, rodNetworkId())
      assertClose(data.player_pos.x, 20.5, 'player_pos.x')
      assertClose(data.player_pos.y, 2.62, 'player_pos.y')
      assertClose(data.click_pos.y, 1, 'click_pos.y')
      assert.strictEqual(data.block_runtime_id, 4321)
      assert.strictEqual(data.client_prediction, 'failure')
      assert.strictEqual(data.client_cooldown_state, 'off')
    })

    it('round-trips the click_air form and the useitem arm swing', function () {
      const bot = createFishingBot()
      const raw = makeRodItem().toNotch()

      const air = roundTrip({
        name: 'inventory_transaction',
        params: makeHeldItemUsePacket(bot, 0, raw, 'click_air')
      })
      const airData = air.params.transaction.transaction_data
      assert.strictEqual(airData.action_type, 'click_air')
      assert.strictEqual(airData.trigger_type, 'unknown')
      assert.strictEqual(airData.face, 255)
      assert.deepStrictEqual(airData.block_position, { x: 0, y: 0, z: 0 })
      assert.deepStrictEqual(airData.click_pos, { x: 0, y: 0, z: 0 })
      assert.strictEqual(airData.block_runtime_id, 0)
      assert.strictEqual(airData.client_prediction, 'failure')
      assert.strictEqual(airData.client_cooldown_state, 'off')

      const swing = roundTrip({ name: 'animate', params: makeUseItemSwingPacket(bot) })
      assert.strictEqual(swing.params.action_id, 'swing_arm')
      assert.strictEqual(swing.params.has_swing_source, true)
      assert.strictEqual(swing.params.swing_source, 'useitem')
    })
  })

  describe('cast sequence', function () {
    it('emits click_block -> animate -> click_air when the crosshair hits a block', async function () {
      const bot = createFishingBot()
      // Solid block directly under the eye ray: look straight down.
      bot.self.pitch = 90
      bot.world = {
        sync: {
          getBlock (pos) {
            if (pos.x === 20 && pos.y === 1 && pos.z === 1) {
              return { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], stateId: 4321 }
            }
            return { boundingBox: 'empty', shapes: [] }
          }
        }
      }

      const promise = bot.fish({ hookSpawnTimeoutMs: 40 })
      const summaries = bot.client.queued.map(summarizeServerbound)
      assert.deepStrictEqual(summaries, [
        'inventory_transaction:click_block',
        'animate:useitem',
        'inventory_transaction:click_air'
      ])

      const clickBlock = bot.client.queued[0].params.transaction.transaction_data
      assert.deepStrictEqual(clickBlock.block_position, { x: 20, y: 1, z: 1 })
      assert.strictEqual(clickBlock.face, 1)
      assert.deepStrictEqual(clickBlock.click_pos, { x: 0.5, y: 1, z: 0.5 })
      assert.strictEqual(clickBlock.block_runtime_id, 4321)

      await assert.rejects(promise, FishingTimeoutError)
    })

    it('pulses start_using_item for exactly one auth tick', async function () {
      const bot = createFishingBot()
      const promise = bot.fish({ hookSpawnTimeoutMs: 200 })

      assert.strictEqual(authTick(bot).input_data.start_using_item, true)
      assert.strictEqual(authTick(bot).input_data.start_using_item === true, false)

      await bot.stopFishing()
      await assert.rejects(promise, FishingCancelledError)
    })

    it('clears an unfired pulse when the session settles', async function () {
      const bot = createFishingBot()
      const promise = bot.fish({ hookSpawnTimeoutMs: 30 })
      await assert.rejects(promise, FishingTimeoutError)
      assert.strictEqual(authTick(bot).input_data.start_using_item === true, false)
    })
  })

  describe('preconditions', function () {
    it('rejects when the held item is not a fishing rod', async function () {
      const bot = createFishingBot({ heldItem: { type: 1, name: 'dirt', count: 1, metadata: 0 } })
      await assert.rejects(bot.fish(), error => {
        assert(error instanceof FishingPreconditionError)
        assert.strictEqual(error.code, 'ERR_FISHING_PRECONDITION')
        return true
      })
      assert.strictEqual(bot.client.queued.length, 0)
      assert.strictEqual(bot.isFishing, false)
    })

    it('rejects when the held slot is empty, self is missing, or inventory is missing', async function () {
      const empty = createFishingBot({ heldItem: null })
      await assert.rejects(empty.fish(), FishingPreconditionError)

      const noSelf = createFishingBot()
      noSelf.self = null
      await assert.rejects(noSelf.fish(), FishingPreconditionError)

      const noInventory = createFishingBot()
      noInventory.inventory = null
      await assert.rejects(noInventory.fish(), FishingPreconditionError)

      for (const bot of [empty, noSelf, noInventory]) {
        assert.strictEqual(bot.client.queued.length, 0)
      }
    })
  })

  describe('hook association', function () {
    it('never associates a hook whose present owner_eid mismatches self', async function () {
      const bot = createFishingBot()
      const promise = bot.fish({ hookSpawnTimeoutMs: 60 })

      bot.client.emit('add_entity', hookSpawnPacket({
        metadata: [
          { key: 'owner_eid', type: 'long', value: IDS.otherPlayerUniqueId },
          { key: 'target_eid', type: 'long', value: 0n }
        ]
      }))

      assert.strictEqual(bot.fishingState.phase, 'waiting_for_hook')
      assert.strictEqual(bot.fishingState.hookRuntimeId, null)
      await assert.rejects(promise, FishingTimeoutError)
    })

    it('falls back to the spawn window only when owner_eid is absent or zero', async function () {
      for (const metadata of [
        [{ key: 'target_eid', type: 'long', value: 0n }],
        [{ key: 'owner_eid', type: 'long', value: 0n }]
      ]) {
        const bot = createFishingBot()
        const promise = bot.fish()

        bot.client.emit('add_entity', hookSpawnPacket({ metadata }))
        assert.strictEqual(bot.fishingState.phase, 'waiting_for_bite')
        assert.strictEqual(bot.fishingState.ownerMatch, 'spawn_window')
        assert.strictEqual(bot.fishingState.hookRuntimeId, IDS.hookRuntimeId)

        bot.client.emit('remove_entity', removeEntityPacket())
        await assert.rejects(promise, error => error.message === 'Fishing cancelled')
      }
    })

    it('associates the own hook even when another hook spawned first', async function () {
      const bot = createFishingBot()
      const promise = bot.fish()

      bot.client.emit('add_entity', hookSpawnPacket({
        unique_id: IDS.otherHookUniqueId,
        runtime_id: IDS.otherHookRuntimeId,
        metadata: [{ key: 'owner_eid', type: 'long', value: IDS.otherPlayerUniqueId }]
      }))
      bot.client.emit('add_entity', hookSpawnPacket())

      assert.strictEqual(bot.fishingState.hookRuntimeId, IDS.hookRuntimeId)
      assert.strictEqual(bot.fishingState.ownerMatch, 'metadata')

      bot.client.emit('remove_entity', removeEntityPacket())
      await assert.rejects(promise, FishingCancelledError)
    })
  })

  describe('bites', function () {
    it('treats only the owned hook fish_hook_hook as authoritative', async function () {
      const bot = createFishingBot()
      const events = recordFishingEvents(bot)
      const promise = bot.fish()
      bot.client.emit('add_entity', hookSpawnPacket())

      bot.client.emit('entity_event', entityEventPacket('fish_hook_tease'))
      bot.client.emit('entity_event', entityEventPacket('fish_hook_position'))
      assert.strictEqual(bot.fishingState.phase, 'waiting_for_bite')

      bot.client.emit('entity_event', entityEventPacket('fish_hook_hook'))
      assert.strictEqual(bot.fishingState.phase, 'reeling')

      const bites = events.filter(event => event.name === 'fishingBite')
      assert.strictEqual(bites.length, 1)
      assert.strictEqual(bites[0].args[1].source, 'entity_event')
      assert.strictEqual(bites[0].args[1].runtimeEntityId, IDS.hookRuntimeId)
      assert.strictEqual(bites[0].args[1].velocityY, null)

      await bot.stopFishing()
      await promise.catch(() => {})
    })

    it('applies the translated-motion fallback with age and velocity guards', async function () {
      const bot = createFishingBot()
      const events = recordFishingEvents(bot)
      const promise = bot.fish({ translatedBiteMinAgeMs: 60 })
      bot.client.emit('add_entity', hookSpawnPacket())

      // Launch/collision noise inside the age guard is ignored.
      bot.client.emit('set_entity_motion', motionPacket(-0.9))
      assert.strictEqual(bot.fishingState.phase, 'waiting_for_bite')

      await sleep(80)

      // A gentle bob above the threshold is ignored.
      bot.client.emit('set_entity_motion', motionPacket(-0.1))
      assert.strictEqual(bot.fishingState.phase, 'waiting_for_bite')

      // The characteristic downward bite impulse fires the fallback.
      bot.client.emit('set_entity_motion', motionPacket(-0.3))
      assert.strictEqual(bot.fishingState.phase, 'reeling')

      const bites = events.filter(event => event.name === 'fishingBite')
      assert.strictEqual(bites.length, 1)
      assert.strictEqual(bites[0].args[1].source, 'translated_motion')
      assert.strictEqual(bites[0].args[1].velocityY, -0.3)

      await bot.stopFishing()
      await promise.catch(() => {})
    })

    it('lets fish_hook_hook win over translated motion and settles the bite once', async function () {
      const bot = createFishingBot()
      const events = recordFishingEvents(bot)
      const promise = bot.fish({ translatedBiteMinAgeMs: 0 })
      bot.client.emit('add_entity', hookSpawnPacket())

      bot.client.emit('entity_event', entityEventPacket('fish_hook_hook'))
      bot.client.emit('set_entity_motion', motionPacket(-0.4))

      const bites = events.filter(event => event.name === 'fishingBite')
      assert.strictEqual(bites.length, 1)
      assert.strictEqual(bites[0].args[1].source, 'entity_event')

      await bot.stopFishing()
      await promise.catch(() => {})
    })

    it('honors translatedBiteEnabled: false', async function () {
      const bot = createFishingBot()
      const promise = bot.fish({ translatedBiteEnabled: false, translatedBiteMinAgeMs: 0, reelAckTimeoutMs: 30 })
      bot.client.emit('add_entity', hookSpawnPacket())
      bot.client.emit('set_entity_motion', motionPacket(-0.4))
      assert.strictEqual(bot.fishingState.phase, 'waiting_for_bite')
      await bot.stopFishing()
      await promise.catch(() => {})
    })

    it('never bites while the hook is attached to an entity (target_eid set)', async function () {
      const bot = createFishingBot()
      const events = recordFishingEvents(bot)
      const promise = bot.fish({ translatedBiteMinAgeMs: 0 })
      bot.client.emit('add_entity', hookSpawnPacket())

      bot.client.emit('set_entity_data', hookDataPacket({ target_eid: 77n }))
      assert.strictEqual(bot.fishingState.targetEid, 77n)

      bot.client.emit('set_entity_motion', motionPacket(-0.4))
      assert.strictEqual(bot.fishingState.phase, 'waiting_for_bite')
      assert.strictEqual(events.filter(event => event.name === 'fishingBite').length, 0)

      // Resolution happens through stop/timeout paths and is never 'caught'.
      const stop = bot.stopFishing()
      bot.client.emit('remove_entity', removeEntityPacket())
      await assert.rejects(promise, error => error.message === 'Fishing cancelled')
      await stop
      assert.strictEqual(events.filter(event => event.name === 'fishingCatch').length, 0)
    })
  })

  describe('outcome classification', function () {
    async function reelToCatchWindow (bot, options = {}) {
      const promise = bot.fish({ catchCorrelationTimeoutMs: 120, ...options })
      bot.client.emit('add_entity', hookSpawnPacket())
      bot.client.emit('entity_event', entityEventPacket('fish_hook_hook'))
      bot.client.emit('remove_entity', removeEntityPacket())
      return promise
    }

    it('classifies a catch from is_from_fishing plus horizontal distance only', async function () {
      const bot = createFishingBot()
      const events = recordFishingEvents(bot)
      const promise = reelToCatchWindow(bot)

      // 1-2 blocks below the surface but within 1.5 blocks XZ: a real catch.
      bot.client.emit('add_item_entity', caughtItemPacket())

      const result = await promise
      assert.strictEqual(result.outcome, 'caught')
      assert.strictEqual(result.itemEntity.runtimeId, IDS.caughtItemRuntimeId)
      assert.strictEqual(result.item?.name, 'cod')
      assert.strictEqual(events.filter(event => event.name === 'fishingCatch').length, 1)
    })

    it('ignores fishing items outside the 1.5 block horizontal bound', async function () {
      const bot = createFishingBot()
      const promise = reelToCatchWindow(bot)

      bot.client.emit('add_item_entity', caughtItemPacket({
        position: { x: 22.4, y: -0.9, z: 1.6 }
      }))

      const result = await promise
      assert.strictEqual(result.outcome, 'missed')
      assert.strictEqual(result.itemEntity, null)
    })

    it('ignores non-fishing item entities inside the window', async function () {
      const bot = createFishingBot()
      const promise = reelToCatchWindow(bot)

      bot.client.emit('add_item_entity', caughtItemPacket({ is_from_fishing: false }))

      const result = await promise
      assert.strictEqual(result.outcome, 'missed')
      assert.strictEqual(result.item, null)
    })

    it('does not resolve when the reel packets are queued; only after the window', async function () {
      const bot = createFishingBot()
      let settled = false
      const promise = reelToCatchWindow(bot).then(result => {
        settled = true
        return result
      })

      // Reel + removal happened; the promise must still be pending.
      assert.strictEqual(settled, false)
      await sleep(10)
      assert.strictEqual(settled, false)

      const result = await promise
      assert.strictEqual(result.outcome, 'missed')
    })
  })

  describe('use acknowledgements', function () {
    function ackRodUse (bot) {
      bot.client.emit('completed_using_item', completedUsingItemPacket())
      bot.client.emit('inventory_transaction', itemReleaseAckPacket())
    }

    it('gates the outcome on the reel acknowledgement when the target acknowledged the cast', async function () {
      const bot = createFishingBot()
      const promise = bot.fish({ catchCorrelationTimeoutMs: 40, reelAckTimeoutMs: 400 })
      bot.client.emit('add_entity', hookSpawnPacket())
      ackRodUse(bot) // cast acknowledgement: this target speaks acks

      bot.client.emit('entity_event', entityEventPacket('fish_hook_hook'))
      bot.client.emit('remove_entity', removeEntityPacket())

      let settled = false
      promise.then(() => { settled = true }, () => { settled = true })
      await sleep(120) // the catch window (40ms) has long expired
      assert.strictEqual(settled, false, 'outcome must wait for the reel acknowledgement')

      ackRodUse(bot)
      const result = await promise
      assert.strictEqual(result.outcome, 'missed')
      assert.strictEqual(bot.fishingState.phase, 'idle')
    })

    it('fails the reel when an ack-speaking target never acknowledges it', async function () {
      const bot = createFishingBot()
      const promise = bot.fish({ catchCorrelationTimeoutMs: 30, reelAckTimeoutMs: 80 })
      bot.client.emit('add_entity', hookSpawnPacket())
      ackRodUse(bot)
      bot.client.emit('entity_event', entityEventPacket('fish_hook_hook'))
      bot.client.emit('remove_entity', removeEntityPacket())

      await assert.rejects(promise, error => {
        assert(error instanceof FishingTimeoutError)
        assert(error.message.includes('reel acknowledgement'))
        return true
      })
    })

    it('classifies without acknowledgements on targets that never send them', async function () {
      // Geyser never translates completed_using_item/item_release, so the
      // cast probe stays off and classification rests on removal + window.
      const bot = createFishingBot()
      const promise = bot.fish({ catchCorrelationTimeoutMs: 40 })
      bot.client.emit('add_entity', hookSpawnPacket())
      bot.client.emit('entity_event', entityEventPacket('fish_hook_hook'))
      bot.client.emit('remove_entity', removeEntityPacket())

      const result = await promise
      assert.strictEqual(result.outcome, 'missed')
    })
  })

  describe('timeouts', function () {
    it('times out waiting for the hook without sending a second use sequence', async function () {
      const bot = createFishingBot()
      const promise = bot.fish({ hookSpawnTimeoutMs: 30 })

      await assert.rejects(promise, error => {
        assert(error instanceof FishingTimeoutError)
        assert.strictEqual(error.code, 'ERR_FISHING_TIMEOUT')
        assert(error.message.startsWith('Fishing cancelled'))
        return true
      })

      const uses = bot.client.queued.map(summarizeServerbound)
        .filter(summary => summary === 'inventory_transaction:click_air')
      assert.strictEqual(uses.length, 1)
      assert.strictEqual(bot.fishingState.phase, 'idle')
    })

    it('times out waiting for a bite and reels the hook back in', async function () {
      const bot = createFishingBot()
      const promise = bot.fish({ biteTimeoutMs: 40, reelAckTimeoutMs: 40 })
      bot.client.emit('add_entity', hookSpawnPacket())

      await assert.rejects(promise, FishingTimeoutError)

      const uses = bot.client.queued.map(summarizeServerbound)
        .filter(summary => summary === 'inventory_transaction:click_air')
      assert.strictEqual(uses.length, 2, 'bite timeout must retract the bobber exactly once')
    })

    it('times out when the reel acknowledgement window closes', async function () {
      const bot = createFishingBot()
      const promise = bot.fish({ reelAckTimeoutMs: 40 })
      bot.client.emit('add_entity', hookSpawnPacket())
      bot.client.emit('entity_event', entityEventPacket('fish_hook_hook'))

      await assert.rejects(promise, error => {
        assert(error instanceof FishingTimeoutError)
        assert(error.message.includes('reel acknowledgement'))
        return true
      })
    })
  })

  describe('cancellation contract', function () {
    it('rejects a replaced session with the exact Mineflayer message', async function () {
      const bot = createFishingBot()
      const first = bot.fish()
      bot.client.emit('add_entity', hookSpawnPacket())

      const second = bot.fish({ hookSpawnTimeoutMs: 100 })
      bot.client.emit('remove_entity', removeEntityPacket())

      await assert.rejects(first, error => {
        assert(error instanceof FishingCancelledError)
        assert.strictEqual(error.message, 'Fishing cancelled due to calling bot.fish() again')
        return true
      })

      // The replacement owns a fresh session and casts again.
      await assert.rejects(second, FishingTimeoutError)
      const uses = bot.client.queued.map(summarizeServerbound)
        .filter(summary => summary === 'inventory_transaction:click_air')
      assert.strictEqual(uses.length, 3, 'cast + cancel reel + second cast')
    })

    it('maps stopFishing reasons onto the Fishing cancelled message contract', async function () {
      assert.strictEqual(toCancellationError(undefined).message, 'Fishing cancelled')
      assert.strictEqual(toCancellationError('leaving the area').message, 'Fishing cancelled: leaving the area')
      assert.strictEqual(toCancellationError(new Error('server restart')).message, 'Fishing cancelled: server restart')
      assert.strictEqual(
        toCancellationError(new Error('Fishing cancelled due to calling bot.fish() again')).message,
        'Fishing cancelled due to calling bot.fish() again'
      )
      const existing = new FishingCancelledError('Fishing cancelled')
      assert.strictEqual(toCancellationError(existing), existing)
    })

    it('cancels on connection close without writing more packets', async function () {
      const bot = createFishingBot()
      const promise = bot.fish()
      bot.client.emit('add_entity', hookSpawnPacket())

      const queuedBefore = bot.client.queued.length
      bot.client.status = 0
      bot.client.emit('close')

      await assert.rejects(promise, error => {
        assert.strictEqual(error.message, 'Fishing cancelled: connection closed')
        return true
      })
      assert.strictEqual(bot.client.queued.length, queuedBefore)
      assert.strictEqual(bot.fishingState.phase, 'idle')
    })

    it('supports AbortSignal cancellation', async function () {
      const bot = createFishingBot()
      const controller = new AbortController()
      const promise = bot.fish({ signal: controller.signal, reelAckTimeoutMs: 30 })
      bot.client.emit('add_entity', hookSpawnPacket())

      controller.abort()
      await assert.rejects(promise, error => {
        assert(error instanceof FishingCancelledError)
        assert(error.message.startsWith('Fishing cancelled'))
        return true
      })
    })

    it('cancels a pending wait when the held slot switches away from the rod', async function () {
      const bot = createFishingBot()
      const promise = bot.fish()
      bot.client.emit('add_entity', hookSpawnPacket())
      assert.strictEqual(bot.fishingState.phase, 'waiting_for_bite')

      const dirt = { type: 1, name: 'dirt', count: 1, metadata: 0 }
      bot.inventory.slots[1] = dirt
      bot.heldItemSlot = 1
      bot.emit('held_item_slot_changed', 1, dirt)

      await assert.rejects(promise, error => {
        assert(error instanceof FishingCancelledError)
        assert.strictEqual(error.message, 'Fishing cancelled: held item is no longer a fishing rod')
        return true
      })
      assert.strictEqual(bot.fishingState.phase, 'idle')

      // No retract reel is written without the rod: only the cast exists.
      const uses = bot.client.queued.map(summarizeServerbound)
        .filter(summary => summary === 'inventory_transaction:click_air')
      assert.strictEqual(uses.length, 1)
    })

    it('cancels when an inventory refresh replaces the held rod', async function () {
      const bot = createFishingBot()
      const promise = bot.fish()
      bot.client.emit('add_entity', hookSpawnPacket())

      bot.inventory.slots[0] = { type: 1, name: 'dirt', count: 1, metadata: 0 }
      bot.emit('inventory_content_updated', 0, bot.inventory)

      await assert.rejects(promise, error =>
        error.message === 'Fishing cancelled: held item is no longer a fishing rod')
    })

    it('does not cancel on refreshes that keep a rod in the held slot', async function () {
      const bot = createFishingBot()
      const promise = bot.fish()
      bot.client.emit('add_entity', hookSpawnPacket())

      // Durability refresh: the stack object changes, the rod remains.
      bot.inventory.slots[0] = makeRodItem()
      bot.emit('inventory_content_updated', 0, bot.inventory)
      bot.emit('held_item_slot_changed', 0, bot.inventory.slots[0])
      assert.strictEqual(bot.fishingState.phase, 'waiting_for_bite')

      const stop = bot.stopFishing()
      bot.client.emit('remove_entity', removeEntityPacket())
      await assert.rejects(promise, FishingCancelledError)
      await stop
    })

    it('ignores held-item changes after the reel was sent', async function () {
      const bot = createFishingBot()
      const promise = bot.fish({ catchCorrelationTimeoutMs: 60 })
      bot.client.emit('add_entity', hookSpawnPacket())
      bot.client.emit('entity_event', entityEventPacket('fish_hook_hook'))
      bot.client.emit('remove_entity', removeEntityPacket())

      // The outcome is already server-side; switching away must not cancel.
      bot.inventory.slots[0] = { type: 1, name: 'dirt', count: 1, metadata: 0 }
      bot.emit('inventory_content_updated', 0, bot.inventory)

      const result = await promise
      assert.strictEqual(result.outcome, 'missed')
    })

    it('keeps stopFishing idempotent with no active session', async function () {
      const bot = createFishingBot()
      await bot.stopFishing()
      await bot.stopFishing('again')
      assert.strictEqual(bot.client.queued.length, 0)
    })
  })

  describe('state and events surface', function () {
    it('exposes isFishing and a frozen fishingState snapshot', async function () {
      const bot = createFishingBot()
      assert.strictEqual(bot.isFishing, false)
      assert.strictEqual(bot.fishingState.phase, 'idle')

      const promise = bot.fish()
      assert.strictEqual(bot.isFishing, true)
      assert(Object.isFrozen(bot.fishingState))

      bot.client.emit('add_entity', hookSpawnPacket())
      assert.strictEqual(bot.fishingState.hookUniqueId, IDS.hookUniqueId)
      assert(typeof bot.fishingState.startedAt === 'number')

      bot.client.emit('remove_entity', removeEntityPacket())
      await assert.rejects(promise, FishingCancelledError)
      assert.strictEqual(bot.isFishing, false)
    })

    it('emits a discriminated fishingStopped event for both terminals', async function () {
      const bot = createFishingBot()
      const events = recordFishingEvents(bot)

      const caught = bot.fish({ catchCorrelationTimeoutMs: 120 })
      bot.client.emit('add_entity', hookSpawnPacket())
      bot.client.emit('entity_event', entityEventPacket('fish_hook_hook'))
      bot.client.emit('remove_entity', removeEntityPacket())
      bot.client.emit('add_item_entity', caughtItemPacket())
      await caught

      const cancelled = bot.fish()
      bot.client.emit('add_entity', hookSpawnPacket())
      const stop = bot.stopFishing()
      bot.client.emit('remove_entity', removeEntityPacket())
      await assert.rejects(cancelled, FishingCancelledError)
      await stop

      const stopped = events.filter(event => event.name === 'fishingStopped').map(event => event.args[0])
      assert.strictEqual(stopped.length, 2)
      assert.strictEqual(stopped[0].status, 'completed')
      assert.strictEqual(stopped[0].error, null)
      assert.strictEqual(stopped[0].result.outcome, 'caught')
      assert.strictEqual(stopped[1].status, 'cancelled')
      assert.strictEqual(stopped[1].result, null)
      assert(stopped[1].error instanceof FishingCancelledError)
    })
  })
})
