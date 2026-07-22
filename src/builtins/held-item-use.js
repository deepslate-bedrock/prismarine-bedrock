// builtins/held-item-use.js
// Auto-loaded by plugin-loader. Shared primitive for "instant" held-item uses
// (fishing-rod style cast/reel). One rod use on the wire is, within a single
// game tick:
//
//   inventory_transaction item_use/click_block   (only when the crosshair ray
//                                                 hits a block)
//   animate swing_arm (swing_source: useitem)
//   inventory_transaction item_use/click_air
//
// followed by player_auth_input.input_data.start_using_item held true for
// exactly one auth tick and cleared on the next. The click_block step and the
// one-tick pulse are vanilla-client parity: BDS functionally accepts a bare
// animate + click_air, but this primitive always emits the parity form so a
// target rejecting one component can be diagnosed instead of guessed at.
//
// The server acknowledges every accepted use with a clientbound
// completed_using_item followed by inventory_transaction item_release/consume;
// waitForHeldItemUseAck observes those packets and never synthesizes them.

const {
  getBlockRuntimeId,
  itemToRawWithoutStackId,
  logAction,
  raycastBlock,
  selfRuntimeEntityId,
  toVec3f,
  viewDirectionFromRotation
} = require('../utils')

const DEFAULT_USE_ACK_TIMEOUT_MS = 5000
const DEFAULT_CROSSHAIR_REACH = 5
const CROSSHAIR_STEP = 0.25

function makeUseItemSwingPacket (botState) {
  return {
    action_id: 'swing_arm',
    runtime_entity_id: selfRuntimeEntityId(botState),
    data: 0,
    has_swing_source: true,
    swing_source: 'useitem'
  }
}

function makeHeldItemUsePacket (botState, slot, rawItem, form, blockHit = null) {
  const playerPos = toVec3f(botState.self?.position ?? { x: 0, y: 0, z: 0 })

  const transactionData = form === 'click_block'
    ? {
        action_type: 'click_block',
        trigger_type: 'player_input',
        block_position: {
          x: Math.floor(blockHit.blockPosition.x),
          y: Math.floor(blockHit.blockPosition.y),
          z: Math.floor(blockHit.blockPosition.z)
        },
        face: blockHit.face,
        hotbar_slot: slot,
        held_item: rawItem,
        player_pos: playerPos,
        click_pos: toVec3f(blockHit.clickPosition ?? { x: 0.5, y: 0.5, z: 0.5 }),
        block_runtime_id: blockHit.blockRuntimeId ?? 0,
        client_prediction: 'failure',
        client_cooldown_state: 'off'
      }
    : {
        action_type: 'click_air',
        trigger_type: 'unknown',
        block_position: { x: 0, y: 0, z: 0 },
        face: 255,
        hotbar_slot: slot,
        held_item: rawItem,
        player_pos: playerPos,
        click_pos: { x: 0, y: 0, z: 0 },
        block_runtime_id: 0,
        client_prediction: 'failure',
        client_cooldown_state: 'off'
      }

  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use',
      actions: [],
      transaction_data: transactionData
    }
  }
}

// Walks the crosshair ray through the synchronous world view and returns the
// first solid block hit, or null when no block is hit (or the world is not
// decoded), in which case callers fall back to the air-only use variant.
function findCrosshairBlockHit (botState, options = {}) {
  const eye = botState.self?.position
  const world = botState.world?.sync || botState.world
  if (!eye || typeof world?.getBlock !== 'function') return null

  const yaw = botState.self?.yaw ?? 0
  const pitch = botState.self?.pitch ?? 0
  const direction = viewDirectionFromRotation(yaw, pitch)
  const reach = options.reach ?? DEFAULT_CROSSHAIR_REACH

  let lastKey = null
  for (let t = 0; t <= reach; t += CROSSHAIR_STEP) {
    const blockPos = {
      x: Math.floor(eye.x + direction.x * t),
      y: Math.floor(eye.y + direction.y * t),
      z: Math.floor(eye.z + direction.z * t)
    }
    const key = `${blockPos.x},${blockPos.y},${blockPos.z}`
    if (key === lastKey) continue
    lastKey = key

    let block
    try {
      block = world.getBlock(blockPos)
    } catch {
      return null
    }
    if (!block || typeof block.then === 'function') continue
    if (block.boundingBox === 'empty' || !Array.isArray(block.shapes) || block.shapes.length === 0) continue

    const hit = raycastBlock(eye, blockPos, yaw, pitch, { block })
    if (!hit) continue

    return {
      blockPosition: blockPos,
      face: hit.face,
      clickPosition: hit.clickPosition,
      blockRuntimeId: getBlockRuntimeId(botState, blockPos)
    }
  }

  return null
}

function inject (botState) {
  const client = botState.client

  // Sets start_using_item on the next outbound player_auth_input packet only,
  // matching the verified vanilla pattern (transactions on tick N, flag true
  // on N+1, false on N+2). Returns a stop function that disarms the pulse if
  // no auth packet was sent yet.
  function pulseStartUsingItem () {
    let armed = true
    let unhook = null

    function stop () {
      if (!armed) return
      armed = false
      unhook?.()
    }

    unhook = botState.onPlayerAuthInputPreSend?.(packet => {
      if (!armed) return
      botState.setAuthInputFlag(packet, 'start_using_item', true)
      stop()
    })
    botState.flushPlayerAuthInput?.()

    return stop
  }

  function queueHeldItemUse (useOptions = {}) {
    const runtimeId = selfRuntimeEntityId(botState)
    if (runtimeId == null) throw new Error('Cannot use held item before self runtime id is known')

    const slots = botState.inventory?.slots
    if (!Array.isArray(slots)) throw new Error('Cannot use held item before inventory state is available')

    const slot = Number.isInteger(useOptions.hotbarSlot) ? useOptions.hotbarSlot : (botState.heldItemSlot ?? 0)
    const item = useOptions.heldItem ?? slots[slot] ?? null
    if (!item) throw new Error(`Cannot use held item: hotbar slot ${slot} is empty`)

    const raw = itemToRawWithoutStackId(item, botState.itemClass, { hasStackId: 'always' })

    let blockHit = useOptions.blockHit
    if (blockHit === undefined && useOptions.raycast !== false) {
      blockHit = findCrosshairBlockHit(botState, useOptions)
    }

    const packets = []
    const queueWire = (name, params) => {
      client.queue(name, params)
      packets.push({ name, params })
    }

    if (blockHit) queueWire('inventory_transaction', makeHeldItemUsePacket(botState, slot, raw, 'click_block', blockHit))
    queueWire('animate', makeUseItemSwingPacket(botState))
    queueWire('inventory_transaction', makeHeldItemUsePacket(botState, slot, raw, 'click_air'))

    const stopPulse = useOptions.pulse === false ? () => {} : pulseStartUsingItem()

    logAction('[held-item-use]', 'queued use sequence', {
      slot,
      block_hit: !!blockHit,
      network_id: raw?.network_id
    })

    return { slot, item, raw, blockHit: blockHit ?? null, packets, stopPulse }
  }

  // Waits for the server's use acknowledgement: completed_using_item plus the
  // clientbound inventory_transaction item_release/consume. Both packets come
  // from the server; this helper never generates them locally. ackOptions.onAck
  // is invoked synchronously from the completing packet listener (before the
  // promise resolution microtask) so consumers keep same-tick ordering with
  // packets that arrive in the same burst as the acknowledgement.
  function waitForHeldItemUseAck (ackOptions = {}) {
    const timeoutMs = ackOptions.timeoutMs ?? DEFAULT_USE_ACK_TIMEOUT_MS
    const expectedNetworkId = ackOptions.networkId
    const signal = ackOptions.signal

    return new Promise((resolve, reject) => {
      let completedUsingItem = null
      let itemRelease = null

      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for held-item use acknowledgement after ${timeoutMs}ms`))
      }, timeoutMs)
      timeout.unref?.()

      function check () {
        if (!completedUsingItem || !itemRelease) return
        cleanup()
        const ack = { completedUsingItem, itemRelease }
        ackOptions.onAck?.(ack)
        resolve(ack)
      }

      function onCompletedUsingItem (packet) {
        // The 1.26.10 wire field is used_item_id; item_id is accepted for
        // legacy scripted fixtures that predate the wire-accurate name.
        const usedItemId = packet?.used_item_id ?? packet?.item_id
        if (expectedNetworkId != null && usedItemId !== expectedNetworkId) return
        completedUsingItem = packet
        check()
      }

      function onInventoryTransaction (packet) {
        const transaction = packet?.transaction
        if (transaction?.transaction_type !== 'item_release') return
        if (transaction.transaction_data?.action_type !== 'consume') return
        itemRelease = packet
        check()
      }

      function onAbort () {
        cleanup()
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Held-item use acknowledgement wait aborted'))
      }

      function cleanup () {
        clearTimeout(timeout)
        client.off('completed_using_item', onCompletedUsingItem)
        client.off('inventory_transaction', onInventoryTransaction)
        signal?.removeEventListener?.('abort', onAbort)
      }

      if (signal?.aborted) {
        onAbort()
        return
      }

      client.on('completed_using_item', onCompletedUsingItem)
      client.on('inventory_transaction', onInventoryTransaction)
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  botState.queueHeldItemUse = queueHeldItemUse
  botState.waitForHeldItemUseAck = waitForHeldItemUseAck
  botState.pulseStartUsingItem = pulseStartUsingItem
  botState.findCrosshairBlockHit = options => findCrosshairBlockHit(botState, options)
}

inject._heldItemUseHelpers = {
  findCrosshairBlockHit,
  makeHeldItemUsePacket,
  makeUseItemSwingPacket
}

module.exports = inject
