// @ts-check
// builtins/fishing.js
// Auto-loaded by plugin-loader. Cancellable, packet-accurate Bedrock fishing.
//
// Wire authority (verified against vanilla 1.26.10 clients on BDS):
// - Cast and reel are the same held-item-use sequence: optional
//   item_use/click_block (only when the crosshair hits a block), then
//   animate(swing_source: useitem), then item_use/click_air, then a one-tick
//   player_auth_input start_using_item pulse. The pulse and click_block step
//   are vanilla parity; BDS functionally accepts a bare animate + click_air,
//   but the parity form is the only one emitted so target rejections stay
//   diagnosable.
// - On BDS the only authoritative bite signal is
//   entity_event(fish_hook_hook) for the owned hook. Geyser does not
//   synthesize that event; Java bites surface as a sharp downward
//   set_entity_motion on the hook, handled by the guarded translated-motion
//   fallback below (fish_hook_hook always wins when both exist).
// - A catch is classified only by add_item_entity with is_from_fishing=true
//   arriving in the catch-correlation window within 1.5 blocks HORIZONTAL
//   distance of the removed hook. The item spawns 1-2 blocks below the water
//   surface, so 3D distance would reject real catches. XP orbs spawn at the
//   player (owner_eid -1) and are correlated by burst adjacency only.
// - A missed reel produces no add_item_entity at all; classification rests on
//   window expiry. Pickup on BDS 1.26.10 emits no take_item_entity packet
//   (plain remove_entity + inventory refresh) and is outside the session.
// - The clientbound acknowledgements (completed_using_item +
//   inventory_transaction item_release/consume) come from the server and are
//   never synthesized locally. The session consumes them through
//   waitForHeldItemUseAck: the cast acknowledgement doubles as an
//   ack-capability probe (BDS acknowledges every rod use; Geyser never
//   translates these packets), and on ack-speaking targets the reel outcome
//   resolves only after the reel acknowledgement pair arrived.

'use strict'

const utils = require('../utils')
const { sameRuntimeId, toBigIntSafe } = utils

// logAction's detail parameter is inferred as string from its default value;
// widen it here so structured log details type-check under @ts-check.
/** @type {(dir: string, action: string, detail?: unknown) => void} */
const logAction = /** @type {any} */ (utils.logAction)

/** @typedef {import('../../types/fishing').FishingOptions} FishingOptions */
/** @typedef {import('../../types/fishing').FishingPhase} FishingPhase */
/** @typedef {import('../../types/fishing').FishingState} FishingState */
/** @typedef {import('../../types/fishing').FishingResult} FishingResult */
/** @typedef {import('../../types/fishing').FishingHookMetadata} FishingHookMetadata */
/** @typedef {import('../../types/fishing').FishingBiteEvent} FishingBiteEvent */
/** @typedef {import('../../types/fishing').FishingStoppedEvent} FishingStoppedEvent */

const DEFAULT_OPTIONS = Object.freeze({
  hookSpawnTimeoutMs: 5000,
  biteTimeoutMs: 60000,
  reelAckTimeoutMs: 5000,
  catchCorrelationTimeoutMs: 2000,
  translatedBiteEnabled: true,
  translatedBiteMinAgeMs: 1000,
  translatedBiteVelocityThreshold: -0.15
})

// Verified: the caught item spawns at the hook's X/Z (same tick as the hook
// remove_entity) but 1-2 blocks below the surface. Horizontal distance only.
const CATCH_HOOK_MAX_XZ_DISTANCE = 1.5

// XP orbs land on the same or adjacent tick as the caught item; two Bedrock
// ticks (100ms) plus margin bounds the burst-adjacency collection window.
const XP_ORB_BURST_WINDOW_MS = 150

/**
 * The fishing operation was cancelled before reaching an authoritative
 * outcome. Every message begins with `Fishing cancelled` so downstream
 * Mineflayer plugins that match on message text keep working.
 */
class FishingCancelledError extends Error {
  /** @param {string} [message] */
  constructor (message = 'Fishing cancelled') {
    super(message)
    this.name = 'FishingCancelledError'
    /** @type {'ERR_FISHING_CANCELLED'} */
    this.code = 'ERR_FISHING_CANCELLED'
  }
}

/** A bounded fishing wait (hook spawn, bite, reel acknowledgement) expired. */
class FishingTimeoutError extends Error {
  /** @param {string} [message] */
  constructor (message = 'Fishing cancelled: timed out') {
    super(message)
    this.name = 'FishingTimeoutError'
    /** @type {'ERR_FISHING_TIMEOUT'} */
    this.code = 'ERR_FISHING_TIMEOUT'
  }
}

/** Fishing could not start: missing self/inventory state or no held rod. */
class FishingPreconditionError extends Error {
  /** @param {string} [message] */
  constructor (message = 'Cannot fish') {
    super(message)
    this.name = 'FishingPreconditionError'
    /** @type {'ERR_FISHING_PRECONDITION'} */
    this.code = 'ERR_FISHING_PRECONDITION'
  }
}

/**
 * @param {unknown} reason
 * @returns {FishingCancelledError}
 */
function toCancellationError (reason) {
  if (reason instanceof FishingCancelledError) return reason
  if (reason instanceof Error) {
    const message = reason.message && reason.message.startsWith('Fishing cancelled')
      ? reason.message
      : `Fishing cancelled: ${reason.message || 'stopped'}`
    return new FishingCancelledError(message)
  }
  if (typeof reason === 'string' && reason.length > 0) {
    return new FishingCancelledError(
      reason.startsWith('Fishing cancelled') ? reason : `Fishing cancelled: ${reason}`
    )
  }
  return new FishingCancelledError('Fishing cancelled')
}

/**
 * @param {any} hook
 * @returns {Readonly<FishingHookMetadata>}
 */
function hookMetadataSnapshot (hook) {
  return Object.freeze({
    fishX: typeof hook?.fishX === 'number' ? hook.fishX : null,
    fishZ: typeof hook?.fishZ === 'number' ? hook.fishZ : null,
    fishAngle: typeof hook?.fishAngle === 'number' ? hook.fishAngle : null,
    targetEid: toBigIntSafe(hook?.targetEid)
  })
}

/**
 * @param {any} botState
 * @param {Record<string, any>} [injectOptions]
 */
function inject (botState, injectOptions = {}) {
  const client = botState.client
  const baseOptions = { ...DEFAULT_OPTIONS, ...(injectOptions.fishing ?? {}) }

  /** @type {any} */
  let activeSession = null

  /**
   * @param {Partial<FishingState> & { phase: FishingPhase }} patch
   * @param {FishingState | null} previous
   * @returns {Readonly<FishingState>}
   */
  function createStateSnapshot (patch, previous) {
    return Object.freeze({
      phase: patch.phase,
      hookRuntimeId: patch.hookRuntimeId !== undefined ? patch.hookRuntimeId : (previous?.hookRuntimeId ?? null),
      hookUniqueId: patch.hookUniqueId !== undefined ? patch.hookUniqueId : (previous?.hookUniqueId ?? null),
      ownerMatch: patch.ownerMatch !== undefined ? patch.ownerMatch : (previous?.ownerMatch ?? null),
      fishX: patch.fishX !== undefined ? patch.fishX : (previous?.fishX ?? null),
      fishZ: patch.fishZ !== undefined ? patch.fishZ : (previous?.fishZ ?? null),
      fishAngle: patch.fishAngle !== undefined ? patch.fishAngle : (previous?.fishAngle ?? null),
      targetEid: patch.targetEid !== undefined ? patch.targetEid : (previous?.targetEid ?? null),
      startedAt: patch.startedAt !== undefined ? patch.startedAt : (previous?.startedAt ?? null),
      updatedAt: Date.now()
    })
  }

  /** @type {Readonly<FishingState>} */
  let currentState = createStateSnapshot({ phase: 'idle' }, null)

  /**
   * Silent state update: refreshes the snapshot without a phase transition.
   * @param {Partial<FishingState>} patch
   */
  function updateState (patch) {
    currentState = createStateSnapshot({ ...patch, phase: currentState.phase }, currentState)
  }

  /**
   * Phase transition: refreshes the snapshot and emits fishingStateChanged.
   * @param {FishingPhase} phase
   * @param {Partial<FishingState>} [patch]
   */
  function transition (phase, patch = {}) {
    const previous = currentState
    currentState = createStateSnapshot({ ...patch, phase }, previous)
    botState.emit('fishingStateChanged', previous, currentState)
  }

  const RESET_HOOK_FIELDS = Object.freeze({
    hookRuntimeId: null,
    hookUniqueId: null,
    ownerMatch: null,
    fishX: null,
    fishZ: null,
    fishAngle: null,
    targetEid: null,
    startedAt: null
  })

  function rodNetworkId () {
    const entry = botState.registry?.itemsByName?.fishing_rod
    return Number.isFinite(entry?.id) ? Number(entry.id) : null
  }

  /**
   * @param {any} item
   * @returns {boolean}
   */
  function isFishingRod (item) {
    if (!item) return false
    const name = String(item.name ?? '').replace(/^minecraft:/, '')
    if (name === 'fishing_rod') return true

    const networkId = rodNetworkId()
    const rawId = item.raw?.network_id ?? item.networkId ?? item.network_id
    return networkId != null && rawId != null && Number(rawId) === networkId
  }

  /**
   * @returns {{ slot: number, item: any } | null}
   */
  function heldFishingRod () {
    const slots = botState.inventory?.slots
    if (!Array.isArray(slots)) return null
    const slot = Number.isInteger(botState.heldItemSlot) ? botState.heldItemSlot : 0
    const item = slots[slot] ?? null
    return isFishingRod(item) ? { slot, item } : null
  }

  /** @returns {boolean} */
  function clientConnected () {
    return !!client && client.status !== 0
  }

  /**
   * Wires and runs one fishing session. All exits funnel through settle().
   * @param {any} session
   * @param {AbortSignal | undefined} signal
   */
  function beginSession (session, signal) {
    const config = session.config

    /**
     * @param {any} emitter
     * @param {string} event
     * @param {(...args: any[]) => void} handler
     */
    function listen (emitter, event, handler) {
      emitter.on(event, handler)
      session.cleanups.add(() => emitter.off(event, handler))
    }

    /**
     * @param {string} name
     * @param {number} ms
     * @param {() => void} fn
     */
    function armTimer (name, ms, fn) {
      clearTimer(name)
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      session.timers.set(name, timer)
    }

    /** @param {string} name */
    function clearTimer (name) {
      const timer = session.timers.get(name)
      if (timer) clearTimeout(timer)
      session.timers.delete(name)
    }

    // Aborting this controller detaches any in-flight use-acknowledgement
    // listeners when the session settles through another path.
    const ackAborter = new AbortController()
    session.cleanups.add(() => ackAborter.abort())

    /**
     * Consumes one server use acknowledgement (completed_using_item plus the
     * clientbound inventory_transaction item_release/consume) for the rod.
     * onAck runs synchronously with the completing packet; onMissing runs if
     * the pair never arrives inside timeoutMs.
     * @param {number} timeoutMs
     * @param {(ack: unknown) => void} onAck
     * @param {(() => void) | null} [onMissing]
     */
    function watchUseAck (timeoutMs, onAck, onMissing = null) {
      if (typeof botState.waitForHeldItemUseAck !== 'function') return
      botState.waitForHeldItemUseAck({
        networkId: rodNetworkId() ?? undefined,
        timeoutMs,
        signal: ackAborter.signal,
        onAck: (/** @type {unknown} */ ack) => {
          if (!session.settled) onAck(ack)
        }
      }).catch(() => {
        if (!session.settled && onMissing) onMissing()
      })
    }

    /**
     * @param {FishingStoppedEvent} stopped
     * @param {FishingPhase} terminalPhase
     */
    function finishSession (stopped, terminalPhase) {
      session.settled = true

      for (const timer of session.timers.values()) clearTimeout(timer)
      session.timers.clear()

      for (const cleanup of session.cleanups) {
        try { cleanup() } catch { /* cleanup must never mask the outcome */ }
      }
      session.cleanups.clear()

      for (const stopPulse of session.stopPulses) {
        try { stopPulse() } catch { /* transient auth flag cleanup */ }
      }
      session.stopPulses.clear()

      if (activeSession === session) activeSession = null

      transition(terminalPhase)
      botState.emit('fishingStopped', Object.freeze(stopped))
      transition('idle', RESET_HOOK_FIELDS)
    }

    /** @param {FishingResult['outcome']} outcome */
    function settleCompleted (outcome) {
      if (session.settled) return
      if (session.reeled && session.useAcksAvailable && !session.reelAckReceived) {
        // This target acknowledges rod uses, so the outcome must not resolve
        // before the reel acknowledgement pair is consumed; the reel watcher
        // settles the stashed outcome or times the session out.
        session.pendingOutcome = outcome
        return
      }

      /** @type {FishingResult} */
      const result = Object.freeze({
        outcome,
        hook: session.hook,
        itemEntity: outcome === 'caught' ? session.catchEntity : null,
        item: outcome === 'caught' ? (session.catchEntity?.item ?? null) : null,
        experienceEntities: Object.freeze(session.xpOrbs.slice()),
        startedAt: session.startedAt,
        completedAt: Date.now()
      })

      if (outcome === 'caught') {
        botState.emit('fishingCatch', Object.freeze({
          hook: result.hook,
          itemEntity: result.itemEntity,
          item: result.item,
          experienceEntities: result.experienceEntities
        }))
      }

      logAction('[fishing]', 'completed', { outcome })
      finishSession({ status: 'completed', result, error: null }, 'completed')
      session.resolve(result)
    }

    /** @param {Error} error */
    function settleError (error) {
      if (session.settled) return
      const status = error instanceof FishingCancelledError ? 'cancelled' : 'failed'
      logAction('[fishing]', status, { message: error.message })
      finishSession({ status, result: null, error: /** @type {any} */ (error) }, status)
      session.reject(error)
    }

    /**
     * Queues one held-item-use (cast or reel/cancel) sequence.
     * @param {{ slot: number, item: any }} rod
     */
    function queueRodUse (rod) {
      const use = botState.queueHeldItemUse({ heldItem: rod.item, hotbarSlot: rod.slot })
      session.stopPulses.add(use.stopPulse)
      return use
    }

    /** @param {any} entity */
    function isOwnedHookEntity (entity) {
      if (!entity || session.hookRuntimeId == null) return false
      if (entity === session.hook) return true
      if (sameRuntimeId(entity.runtimeId, session.hookRuntimeId)) return true
      const uniqueId = entity.uniqueId ?? entity.id
      return session.hookUniqueId != null && sameRuntimeId(uniqueId, session.hookUniqueId)
    }

    /**
     * @param {any} entity
     * @param {'metadata' | 'spawn_window'} ownerMatch
     */
    function associateHook (entity, ownerMatch) {
      clearTimer('hookSpawn')
      session.hook = entity
      session.hookRuntimeId = toBigIntSafe(entity.runtimeId)
      session.hookUniqueId = toBigIntSafe(entity.uniqueId ?? entity.id)
      session.hookSpawnedAt = Date.now()
      session.ownerMatch = ownerMatch

      const metadata = hookMetadataSnapshot(entity)
      transition('waiting_for_bite', {
        hookRuntimeId: session.hookRuntimeId,
        hookUniqueId: session.hookUniqueId,
        ownerMatch,
        ...metadata
      })
      logAction('[fishing]', 'hook associated', {
        runtimeId: String(session.hookRuntimeId),
        uniqueId: String(session.hookUniqueId),
        ownerMatch
      })
      botState.emit('fishingHookSpawned', entity)

      armTimer('bite', config.biteTimeoutMs, () => {
        session.cancel(
          new FishingTimeoutError(`Fishing cancelled: timed out waiting for a bite after ${config.biteTimeoutMs}ms`),
          { reel: true }
        )
      })
    }

    /** @param {Readonly<FishingBiteEvent>} biteEvent */
    function handleBite (biteEvent) {
      // The first bite signal wins and the session settles exactly once, so
      // on BDS the earlier fish_hook_hook always beats the motion fallback.
      if (session.settled || session.biteEvent) return
      clearTimer('bite')
      session.biteEvent = Object.freeze(biteEvent)
      transition('reeling')
      botState.emit('fishingBite', session.hook, session.biteEvent)
      reel()
    }

    function reel () {
      const rod = heldFishingRod()
      if (!rod) {
        settleError(new FishingCancelledError('Fishing cancelled: held item is no longer a fishing rod'))
        return
      }

      try {
        queueRodUse(rod)
      } catch (err) {
        settleError(new FishingPreconditionError(`Cannot reel: ${err instanceof Error ? err.message : String(err)}`))
        return
      }

      session.reeled = true
      if (session.useAcksAvailable) {
        // The server acknowledged the cast, so it must acknowledge the reel:
        // the completed_using_item + item_release/consume pair gates the
        // outcome (settleCompleted stashes a pending outcome until it lands).
        watchUseAck(config.reelAckTimeoutMs, ack => {
          session.reelAck = ack
          session.reelAckReceived = true
          if (session.pendingOutcome != null) settleCompleted(session.pendingOutcome)
        }, () => {
          settleError(new FishingTimeoutError(`Fishing cancelled: timed out waiting for the reel acknowledgement after ${config.reelAckTimeoutMs}ms`))
        })
      }
      // Do not resolve now; wait for hook removal and the outcome window.
      armTimer('reelAck', config.reelAckTimeoutMs, () => {
        settleError(new FishingTimeoutError(`Fishing cancelled: timed out waiting for the reel acknowledgement after ${config.reelAckTimeoutMs}ms`))
      })
    }

    function beginCatchWindow () {
      session.hookRemovedAt = Date.now()
      logAction('[fishing]', 'catch window opened', { hook: session.hookPosition })
      armTimer('catch', config.catchCorrelationTimeoutMs, () => settleCompleted('missed'))
    }

    /** @param {any} entity */
    function maybeClassifyCatch (entity) {
      if (!session.reeled || session.hookRemovedAt == null || session.catchEntity) return
      // is_from_fishing is a required AddItemActor field on BDS and the only
      // authoritative catch discriminator; unrelated drops are ignored.
      if (entity?.isFromFishing !== true) {
        logAction('[fishing]', 'item in catch window without is_from_fishing', {
          runtimeId: String(entity?.runtimeId),
          isFromFishing: entity?.isFromFishing
        })
        return
      }

      if (session.hookPosition && entity.position) {
        const dx = Number(entity.position.x) - session.hookPosition.x
        const dz = Number(entity.position.z) - session.hookPosition.z
        if (Math.hypot(dx, dz) > CATCH_HOOK_MAX_XZ_DISTANCE) {
          logAction('[fishing]', 'fishing item rejected by horizontal distance', {
            item: { x: Number(entity.position.x), z: Number(entity.position.z) },
            hook: session.hookPosition,
            distance: Math.hypot(dx, dz)
          })
          return
        }
      }

      clearTimer('catch')
      session.catchEntity = entity
      session.catchAt = Date.now()
      // Same-burst XP orbs arrive immediately after the caught item; hold the
      // settle briefly so they attach to the result (never required evidence).
      armTimer('xpBurst', XP_ORB_BURST_WINDOW_MS, () => settleCompleted('caught'))
    }

    /** @param {any} entity */
    function maybeCollectXpOrb (entity) {
      if (session.catchAt == null) return
      if (Date.now() - session.catchAt > XP_ORB_BURST_WINDOW_MS + 100) return
      session.xpOrbs.push(entity)
    }

    /** @param {any} entity */
    function onEntitySpawned (entity) {
      if (session.settled) return

      if (entity?.name === 'xp_orb') {
        maybeCollectXpOrb(entity)
        return
      }

      if (entity?.isFromFishing !== undefined) {
        maybeClassifyCatch(entity)
        return
      }

      if (session.hookRuntimeId != null) return
      if (entity?.name !== 'fishing_hook') return
      if (currentState.phase !== 'waiting_for_hook') return

      const owner = toBigIntSafe(entity.ownerEid)
      if (owner != null && owner !== 0n) {
        // Ownership matching is primary: never associate a hook whose present
        // owner_eid does not equal the bot's unique entity id.
        if (session.selfUniqueId == null || owner !== session.selfUniqueId) return
        associateHook(entity, 'metadata')
        return
      }

      // Missing-owner fallback: some translation layers/servers omit
      // owner_eid. Associate the first hook spawned inside the hook-spawn
      // window after our cast; never applied when metadata is present.
      associateHook(entity, 'spawn_window')
    }

    /** @param {any} entity */
    function onEntityDataUpdated (entity) {
      if (session.settled || !isOwnedHookEntity(entity)) return
      const metadata = hookMetadataSnapshot(entity)
      updateState(metadata)
      botState.emit('fishingHookUpdated', entity, metadata)
    }

    /**
     * @param {any} entity
     * @param {unknown} eventId
     */
    function onEntityEvent (entity, eventId) {
      if (session.settled || !isOwnedHookEntity(entity)) return
      // Events are matched by the protocol library's string names only; the
      // raw uint8 ids shift between game versions (11-14 on 1.26.10/20,
      // 10-13 on 1.26.50) and must never be hard-coded.
      if (eventId === 'fish_hook_hook') {
        handleBite(Object.freeze({
          source: /** @type {'entity_event'} */ ('entity_event'),
          runtimeEntityId: session.hookRuntimeId,
          velocityY: null
        }))
      }
      // fish_hook_tease / fish_hook_position / fish_hook_bubble are progress
      // only; their metadata re-emits through set_entity_data ->
      // fishingHookUpdated. fish_hook_bubble never fired in any capture and
      // is never required.
    }

    /** @param {any} packet */
    function onSetEntityMotion (packet) {
      if (session.settled || session.hookRuntimeId == null) return
      if (!sameRuntimeId(packet?.runtime_entity_id, session.hookRuntimeId)) return
      if (!config.translatedBiteEnabled || session.biteEvent) return
      if (currentState.phase !== 'waiting_for_bite') return

      // A hook attached to an entity (target_eid set) can never bite.
      const targetEid = currentState.targetEid
      if (targetEid != null && targetEid !== 0n) return

      // Translated-bite fallback (Geyser): Java signals a bite by forcing the
      // bobber sharply downward; Geyser forwards it as set_entity_motion and
      // never synthesizes fish_hook_hook. Ignore young-hook launch/collision
      // noise, then accept the characteristic downward impulse.
      if (session.hookSpawnedAt == null) return
      if (Date.now() - session.hookSpawnedAt < config.translatedBiteMinAgeMs) return

      const velocityY = Number(packet?.velocity?.y)
      if (!Number.isFinite(velocityY) || velocityY > config.translatedBiteVelocityThreshold) return

      handleBite(Object.freeze({
        source: /** @type {'translated_motion'} */ ('translated_motion'),
        runtimeEntityId: session.hookRuntimeId,
        velocityY
      }))
    }

    /** @param {any} entity */
    function onEntityRemoved (entity) {
      if (session.settled || !isOwnedHookEntity(entity)) return

      session.hookRemoved = true
      const position = entity?.position ?? session.hook?.position
      if (position) {
        session.hookPosition = { x: Number(position.x), z: Number(position.z) }
      }
      clearTimer('reelAck')

      if (session.reeled) {
        beginCatchWindow()
        return
      }

      // Removed before a successful reel: explicit stop/replacement supplies
      // its reason; a spontaneous removal is exactly `Fishing cancelled`.
      settleError(session.stopReason ?? new FishingCancelledError('Fishing cancelled'))
    }

    function onConnectionLost () {
      if (session.settled) return
      settleError(session.stopReason ?? new FishingCancelledError('Fishing cancelled: connection closed'))
    }

    // Cancellation contract: the held item/slot becoming invalid mid-session
    // cancels the pending fish(). After the reel was sent the rod no longer
    // matters (the outcome is already server-side); before it, no retract
    // reel is possible without the rod, so cancel without reeling — the
    // server discards the bobber on its own when the held item changes.
    function onHeldItemMaybeChanged () {
      if (session.settled || session.reeled) return
      if (heldFishingRod()) return
      cancel(
        new FishingCancelledError('Fishing cancelled: held item is no longer a fishing rod'),
        { reel: false }
      )
    }

    /**
     * Cancellation funnel shared by stopFishing, replacement fish() calls,
     * abort signals, and the bite timeout. Sends at most one reel/cancel use
     * sequence, waits briefly for hook removal, then settles once.
     * @param {Error} error
     * @param {{ reel?: boolean }} [cancelOptions]
     * @returns {Promise<void>}
     */
    function cancel (error, cancelOptions = {}) {
      if (session.settled) return Promise.resolve()
      if (!session.cancelPromise) {
        session.cancelPromise = performCancel(error, cancelOptions.reel !== false)
      }
      return session.cancelPromise
    }

    /**
     * @param {Error} error
     * @param {boolean} reelRequested
     */
    async function performCancel (error, reelRequested) {
      session.stopReason = error

      const shouldReel = reelRequested &&
        session.hookRuntimeId != null &&
        !session.reeled &&
        !session.hookRemoved &&
        clientConnected()

      if (shouldReel) {
        const rod = heldFishingRod()
        if (rod) {
          try {
            queueRodUse(rod)
            await waitForHookRemovalOrTimeout(config.reelAckTimeoutMs)
          } catch {
            // The cancellation reason wins over any reel write failure.
          }
        }
      }

      settleError(error)
    }

    /** @param {number} ms */
    function waitForHookRemovalOrTimeout (ms) {
      return new Promise(resolve => {
        if (session.settled || session.hookRemoved) {
          resolve(undefined)
          return
        }

        let done = false
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          botState.off('entityRemoved', check)
          resolve(undefined)
        }
        /** @param {any} entity */
        const check = entity => {
          if (isOwnedHookEntity(entity)) finish()
        }

        const timer = setTimeout(finish, ms)
        timer.unref?.()
        botState.on('entityRemoved', check)
        session.cleanups.add(finish)
      })
    }

    session.cancel = cancel

    // ---- wire the session ----

    listen(botState, 'entitySpawned', onEntitySpawned)
    listen(botState, 'entityDataUpdated', onEntityDataUpdated)
    listen(botState, 'entityEvent', onEntityEvent)
    listen(botState, 'entityRemoved', onEntityRemoved)
    listen(client, 'set_entity_motion', onSetEntityMotion)
    listen(client, 'close', onConnectionLost)
    listen(client, 'end', onConnectionLost)
    listen(client, 'kick', onConnectionLost)

    // Held item/slot observation: local hotbar selection, server-driven
    // equipment updates, and full/slot inventory refreshes all funnel into
    // the same cheap held-rod check.
    listen(botState, 'held_item_slot_changed', onHeldItemMaybeChanged)
    listen(botState, 'inventory_content_updated', onHeldItemMaybeChanged)
    listen(client, 'mob_equipment', onHeldItemMaybeChanged)
    if (typeof botState.inventory?.on === 'function' && typeof botState.inventory?.off === 'function') {
      listen(botState.inventory, 'updateSlot', onHeldItemMaybeChanged)
    }

    if (signal) {
      const onAbort = () => {
        cancel(toCancellationError(signal.reason ?? 'aborted'), { reel: true })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      session.cleanups.add(() => signal.removeEventListener('abort', onAbort))
    }

    // ---- cast ----

    transition('casting', { ...RESET_HOOK_FIELDS, startedAt: session.startedAt })

    const rod = heldFishingRod()
    if (!rod) {
      settleError(new FishingPreconditionError('Cannot fish: the held item is not a fishing rod'))
      return
    }

    try {
      queueRodUse(rod)
    } catch (err) {
      settleError(new FishingPreconditionError(`Cannot fish: ${err instanceof Error ? err.message : String(err)}`))
      return
    }

    // Ack-capability probe: BDS acknowledges every rod use, Geyser never
    // translates the acknowledgement packets. A cast acknowledgement inside
    // the hook-spawn window arms the strict reel-ack gate; a missing cast
    // ack never fails the cast itself (the hook spawn is the authoritative
    // cast evidence, per the verified timing table).
    watchUseAck(config.hookSpawnTimeoutMs, ack => {
      session.castAck = ack
      session.useAcksAvailable = true
    })

    transition('waiting_for_hook')
    armTimer('hookSpawn', config.hookSpawnTimeoutMs, () => {
      // Stopping before hook spawn never writes a second use sequence.
      settleError(new FishingTimeoutError(`Fishing cancelled: timed out waiting for the fishing hook to spawn after ${config.hookSpawnTimeoutMs}ms`))
    })
  }

  /**
   * @param {FishingOptions} fishOptions
   */
  function createSession (fishOptions) {
    const config = {
      hookSpawnTimeoutMs: fishOptions.hookSpawnTimeoutMs ?? baseOptions.hookSpawnTimeoutMs,
      biteTimeoutMs: fishOptions.biteTimeoutMs ?? baseOptions.biteTimeoutMs,
      reelAckTimeoutMs: fishOptions.reelAckTimeoutMs ?? baseOptions.reelAckTimeoutMs,
      catchCorrelationTimeoutMs: fishOptions.catchCorrelationTimeoutMs ?? baseOptions.catchCorrelationTimeoutMs,
      translatedBiteEnabled: fishOptions.translatedBiteEnabled ?? baseOptions.translatedBiteEnabled,
      translatedBiteMinAgeMs: fishOptions.translatedBiteMinAgeMs ?? baseOptions.translatedBiteMinAgeMs,
      translatedBiteVelocityThreshold: fishOptions.translatedBiteVelocityThreshold ?? baseOptions.translatedBiteVelocityThreshold
    }

    /** @type {(result: FishingResult) => void} */
    let resolve = () => {}
    /** @type {(error: Error) => void} */
    let reject = () => {}
    /** @type {Promise<FishingResult>} */
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })

    /** @type {any} */
    const session = {
      config,
      promise,
      resolve,
      reject,
      settled: false,
      /** @type {Set<() => void>} */
      cleanups: new Set(),
      /** @type {Map<string, any>} */
      timers: new Map(),
      /** @type {Set<() => void>} */
      stopPulses: new Set(),
      selfUniqueId: toBigIntSafe(botState.self?.uniqueId ?? botState.self?.id),
      hook: null,
      hookRuntimeId: null,
      hookUniqueId: null,
      hookSpawnedAt: null,
      hookPosition: null,
      hookRemoved: false,
      hookRemovedAt: null,
      ownerMatch: null,
      biteEvent: null,
      reeled: false,
      // Ack-speaking targets (BDS) gate the reel outcome on the server's use
      // acknowledgement pair; Geyser never sends one, so the probe stays off.
      useAcksAvailable: false,
      castAck: null,
      reelAck: null,
      reelAckReceived: false,
      pendingOutcome: null,
      catchEntity: null,
      catchAt: null,
      /** @type {any[]} */
      xpOrbs: [],
      startedAt: Date.now(),
      stopReason: null,
      cancelPromise: null,
      cancel: /** @type {(error: Error, options?: { reel?: boolean }) => Promise<void>} */ (() => Promise.resolve())
    }

    return session
  }

  /** @throws {FishingPreconditionError} */
  function assertPreconditions () {
    if (!clientConnected()) {
      throw new FishingPreconditionError('Cannot fish: the client is not connected')
    }
    if (typeof botState.queueHeldItemUse !== 'function') {
      throw new FishingPreconditionError('Cannot fish: held-item-use builtin is unavailable')
    }
    if (botState.client?.entityId == null) {
      throw new FishingPreconditionError('Cannot fish: self runtime entity id is not known yet')
    }
    if (!botState.self) {
      throw new FishingPreconditionError('Cannot fish: self entity is not spawned yet')
    }
    if (!Array.isArray(botState.inventory?.slots)) {
      throw new FishingPreconditionError('Cannot fish: inventory state is not available yet')
    }
    if (!heldFishingRod()) {
      throw new FishingPreconditionError('Cannot fish: the held item is not a fishing rod')
    }
  }

  /**
   * Casts the held fishing rod, associates the player-owned hook, waits for a
   * bite, reels, and resolves only after the authoritative server outcome is
   * known. A `missed` reel resolves successfully with `outcome: 'missed'`; a
   * bite alone is never reported as a caught item. Calling `fish()` while a
   * session is active cancels and settles the previous session first (its
   * promise rejects with message `Fishing cancelled due to calling bot.fish()
   * again`) before the new cast is sent.
   *
   * @param {FishingOptions} [options] Timeouts, abort signal, and the
   *   Geyser translated-bite fallback tuning. See `FishingOptions`.
   * @returns {Promise<FishingResult>} Resolves after outcome classification
   *   with `{ outcome: 'caught' | 'missed', hook, itemEntity, item,
   *   experienceEntities, startedAt, completedAt }`.
   * @throws {FishingPreconditionError} When the client, self entity,
   *   inventory, or held fishing rod is unavailable before the cast.
   * @throws {FishingCancelledError} When the session is cancelled (explicit
   *   `stopFishing()`, replacement `fish()` call, hook removal before a
   *   successful reel, the held item/slot no longer holding a fishing rod
   *   before the reel, disconnect, or abort signal).
   * @throws {FishingTimeoutError} When the hook-spawn, bite, or reel
   *   acknowledgement window expires. On targets that acknowledge rod uses
   *   (BDS sends `completed_using_item` + `item_release/consume` after every
   *   use) the outcome also waits for the reel acknowledgement pair; targets
   *   that never send acknowledgements (Geyser) classify on hook removal
   *   plus the correlation window alone.
   * @fires fishingStateChanged
   * @fires fishingHookSpawned
   * @fires fishingHookUpdated
   * @fires fishingBite
   * @fires fishingCatch
   * @fires fishingStopped
   * @example
   * const result = await bot.fish()
   * if (result.outcome === 'caught') {
   *   console.log('caught', result.item?.name)
   * }
   */
  async function fish (options = {}) {
    if (activeSession) {
      await activeSession.cancel(
        new FishingCancelledError('Fishing cancelled due to calling bot.fish() again'),
        { reel: true }
      )
    }

    if (options.signal?.aborted) {
      throw toCancellationError(options.signal.reason ?? 'aborted before cast')
    }

    assertPreconditions()

    const session = createSession(options)
    activeSession = session
    beginSession(session, options.signal)
    return session.promise
  }

  /**
   * Idempotent stop for the active fishing session. While a hook exists and
   * no reel was sent yet, sends exactly one reel/cancel use sequence, waits
   * briefly for the hook removal acknowledgement, then settles the pending
   * `fish()` promise with a `FishingCancelledError`. Stopping before hook
   * spawn only clears pending listeners. Repeated calls (and calls with no
   * active session) resolve without reeling twice.
   *
   * @param {string | Error} [reason] Optional cancellation reason. Strings
   *   and non-fishing errors are wrapped so the rejection message always
   *   begins with `Fishing cancelled`; omitted reasons produce the exact
   *   message `Fishing cancelled`.
   * @returns {Promise<void>} Resolves after the session settled and every
   *   listener, timer, and transient auth flag was removed.
   * @throws {FishingPreconditionError} Never; kept for signature parity.
   * @fires fishingStateChanged
   * @fires fishingStopped
   * @example
   * const pending = bot.fish().catch(() => 'cancelled')
   * await bot.stopFishing()
   * console.log(await pending) // 'cancelled'
   */
  async function stopFishing (reason) {
    const session = activeSession
    if (!session) return
    await session.cancel(toCancellationError(reason), { reel: true })
  }

  botState.fish = fish
  botState.stopFishing = stopFishing

  /**
   * Read-only snapshot of the fishing session state: `phase`, owned hook ids,
   * `ownerMatch`, live `fishX`/`fishZ`/`fishAngle`/`targetEid` metadata, and
   * timestamps. During the pre-bite approach `fishX`/`fishZ` decay toward 0,
   * which consumers can use as a "bite imminent" signal.
   *
   * @returns {Readonly<FishingState>} Frozen snapshot; a new object per update.
   * @example
   * if (bot.fishingState.phase === 'waiting_for_bite') {
   *   console.log('approach', bot.fishingState.fishX, bot.fishingState.fishZ)
   * }
   */
  Object.defineProperty(botState, 'fishingState', {
    configurable: true,
    enumerable: true,
    get () {
      return currentState
    }
  })

  /**
   * True while a fishing session is active (outside idle/terminal cleanup).
   *
   * @returns {boolean} Whether a session currently owns the rod.
   * @example
   * if (!bot.isFishing) await bot.fish()
   */
  Object.defineProperty(botState, 'isFishing', {
    configurable: true,
    enumerable: true,
    get () {
      return activeSession != null && !activeSession.settled
    }
  })
}

inject.FishingCancelledError = FishingCancelledError
inject.FishingTimeoutError = FishingTimeoutError
inject.FishingPreconditionError = FishingPreconditionError

inject._fishingHelpers = {
  hookMetadataSnapshot,
  toCancellationError
}

module.exports = inject
