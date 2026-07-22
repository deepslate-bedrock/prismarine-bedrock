'use strict'

// Live fishing lifecycle. Commands are used only to arrange the scene
// (gamemode, teleport, water pool, rod, weather); the cast, reel, hook
// removal, and caught item must all come from the bot API and the server.
//
// Target differences pinned here:
// - Endstone/BDS: the bite is entity_event(fish_hook_hook) and hook
//   owner_eid is populated (ownerMatch 'metadata').
// - Paper/Geyser: Geyser does not synthesize fish_hook_hook; the bite must
//   arrive through the translated-motion fallback (observed live 2026-07-14:
//   velocityY -0.252, inside the vanilla Java impulse range). Geyser DOES
//   populate hook owner_eid (association is by metadata, never the
//   spawn-window fallback) and assigns the hook one geyserId for both
//   runtime and unique id. is_from_fishing is ANSWERED from source: Geyser
//   hard-codes AddItemEntity is_from_fishing=false for every item spawn
//   (core/.../entity/type/ItemEntity.java:64, setFromFishing(false)), so
//   catch classification on Geyser is 'missed'-only by design — never
//   reinterpreted from other signals. (Geyser also spawns the loot item
//   BEFORE the hook removal, the reverse of the BDS same-tick order.)
// - Geyser environment quirk (root cause of "no bites ever", diagnosed with
//   server-side /execute block probes): the Java-side bobber from a
//   Geyser-translated cast lands OUTSIDE the water server-side (dry land),
//   while the Bedrock client renders it frozen inside the pool. Java only
//   rolls bites for a bobber whose block position is in fluid, so without
//   help no bite ever fires. The scene hardening below teleports the
//   already-cast bobber into the pool (commands arrange the scene only;
//   cast/reel still go through the bot API).

const assert = require('assert')
const { Vec3 } = require('vec3')
const BotState = require('../../src/state')
const { skipUnlessE2ETarget } = require('../helpers/e2e-targets')
const {
  clearPlayer,
  currentCommandTargetFamily,
  givePlayer,
  sendCommand,
  setPlayerGamemode,
  teleportPlayer
} = require('../helpers/commands')
const {
  HOST,
  PORT,
  USERNAME,
  OFFLINE,
  VERSION,
  SETUP_DELAY_MS
} = require('../helpers/test-env')
const {
  findSlotByName,
  observeQueuedPackets,
  sleep,
  waitForSpawn,
  waitUntil
} = require('../helpers/live')

const MAX_ATTEMPTS = 3
const BITE_TIMEOUT_MS = 60000

function recordFishingEvents (botState) {
  const events = []
  const names = [
    'fishingStateChanged',
    'fishingHookSpawned',
    'fishingHookUpdated',
    'fishingBite',
    'fishingCatch',
    'fishingStopped'
  ]
  const listeners = names.map(name => {
    const listener = (...args) => events.push({ name, args })
    botState.on(name, listener)
    return { name, listener }
  })
  return {
    events,
    restore () {
      for (const { name, listener } of listeners) botState.off(name, listener)
    }
  }
}

async function setupFishingScene (botState) {
  setPlayerGamemode(botState, USERNAME, 'survival')
  clearPlayer(botState, USERNAME)
  sendCommand(botState, 'weather clear')
  // Hostile mobs kill the bot mid-session on shared worlds; a dead player
  // makes the server discard the bobber and ignore further rod uses.
  sendCommand(botState, 'difficulty peaceful')
  sendCommand(botState, 'time set day')
  await sleep(SETUP_DELAY_MS)

  // Some targets spawn the player high above the surface, and on a freshly
  // generated world the first chunks may still be streaming in. Build the
  // scene only after the world is decoded and the bot has landed: a bobber
  // cast mid-fall ends up more than 32 blocks from the player and the Java
  // server discards it immediately.
  try {
    await botState.waitForChunksToLoad?.(2, undefined, 30000)
  } catch {
    // Ground detection below is the authoritative gate.
  }
  try {
    await waitUntil('bot on ground', () => botState.self?.onGround === true, 15000, 250, botState)
  } catch {
    // Spawn chunks can be undecodable (e.g. structure blocks newer than the
    // client protocol's palette data) which starves physics of ground data.
    // Relocate to plain superflat terrain and land there instead.
    teleportPlayer(botState, USERNAME, 500, -59, 500)
    await sleep(SETUP_DELAY_MS)
    try {
      await botState.waitForChunksToLoad?.(2, undefined, 30000)
    } catch {}
    await waitUntil('bot on ground after relocation', () => botState.self?.onGround === true, 45000, 250, botState)
  }
  await sleep(SETUP_DELAY_MS)

  // Dig a contained 5x5 pool one block deep in front of the bot by replacing
  // the top ground layer with water; the surrounding ground holds it.
  const eye = botState.self.position
  const feetY = Math.floor(eye.y - 1.62)
  const groundY = feetY - 1
  const x = Math.floor(eye.x)
  const z = Math.floor(eye.z)
  console.log(`[fishing-scene] eye=${eye} feetY=${feetY} groundY=${groundY} pool=(${x - 3}..${x + 3}, ${groundY - 1}..${groundY}, ${z + 1}..${z + 8})`)
  // Two blocks deep: a bobber on a one-deep rim can sit fractionally out of
  // the fluid on some servers and never registers as fishing-capable.
  const fillPool = () => sendCommand(botState, `fill ${x - 3} ${groundY - 1} ${z + 1} ${x + 3} ${groundY} ${z + 8} water`)
  fillPool()
  // Clear mobs around the pool so the bobber cannot hook a passing entity.
  // Selector syntax differs per family: Java uses distance=, Bedrock uses r=.
  sendCommand(botState, currentCommandTargetFamily() === 'geyser'
    ? 'kill @e[type=!player,distance=..24]'
    : 'kill @e[type=!player,r=24]')
  await sleep(SETUP_DELAY_MS)

  // A bobber on dry land never bites: verify against the decoded world that
  // the pool really is water before casting, retrying the fill if needed.
  const poolProbe = new Vec3(x, groundY, z + 3)
  await waitUntil('water pool present', async () => {
    const block = await botState.getBlock(poolProbe)
    if (block?.name === 'water' || block?.name === 'flowing_water') return true
    console.log(`[fishing-scene] pool probe at ${poolProbe} is ${block?.name ?? 'unknown'}; refilling`)
    fillPool()
    return false
  }, 20000, 1500, botState)

  givePlayer(botState, USERNAME, 'fishing_rod', 1)
  await waitUntil(
    'fishing rod in inventory',
    () => botState.inventory?.slots?.some(item => item?.name === 'fishing_rod'),
    10000,
    250,
    botState
  )

  const slot = findSlotByName(botState, 'fishing_rod')
  await botState.equipItem(slot, 0)
  await waitUntil(
    'fishing rod held',
    () => botState.inventory.slots[botState.heldItemSlot]?.name === 'fishing_rod',
    5000,
    100,
    botState
  )

  // Aim at the pool center so the bobber lands in water.
  if (typeof botState.lookAt === 'function') {
    await botState.lookAt(new Vec3(x + 0.5, groundY + 1, z + 3.5))
    await sleep(250)
  }

  return { x, groundY, z }
}

// Geyser-only scene hardening: the Java bobber from a Geyser-translated cast
// lands on dry land server-side (verified with /execute block probes), so
// Java never rolls a bite. Nudge the already-cast bobber into the pool a few
// times during the wait; the tp is scene arrangement — the cast itself came
// from the bot API. Flaky by nature (the bobber sometimes pops back out),
// which is why fishWithRetries keeps its bounded retry loop.
function armGeyserBobberRescue (botState, pool) {
  const onHookSpawned = () => {
    for (const delayMs of [1500, 4000, 8000]) {
      setTimeout(() => {
        if (botState.fishingState.phase !== 'waiting_for_bite') return
        sendCommand(botState,
          `execute as @e[type=fishing_bobber,limit=1] run teleport @s ${pool.x + 0.5} ${pool.groundY - 0.5} ${pool.z + 4.5}`)
      }, delayMs).unref?.()
    }
  }
  botState.on('fishingHookSpawned', onHookSpawned)
  return () => botState.off('fishingHookSpawned', onHookSpawned)
}

// Runs bounded fishing attempts and returns the first attempt that reaches a
// bite. Each attempt's lifecycle is asserted; only a bite timeout retries.
async function fishWithRetries (botState) {
  let lastError = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const recorder = recordFishingEvents(botState)
    const observer = observeQueuedPackets(botState.client)

    // Landing diagnostic: report where the bobber settled a few seconds in,
    // so a cast that misses the water is visible in the test output.
    const onHookSpawned = hook => {
      setTimeout(() => {
        console.log(`[fishing-landing] attempt ${attempt} hook at ${hook.position}`)
      }, 3000).unref?.()
    }
    botState.once('fishingHookSpawned', onHookSpawned)

    try {
      const result = await botState.fish({ biteTimeoutMs: BITE_TIMEOUT_MS })
      return { result, events: recorder.events, packets: observer.queued }
    } catch (error) {
      lastError = error
      const hookSpawned = recorder.events.some(event => event.name === 'fishingHookSpawned')
      assert(hookSpawned, `attempt ${attempt}: owned hook never spawned (${error.message})`)
      assert.strictEqual(botState.isFishing, false, `attempt ${attempt}: session must settle on failure`)
      // Retry only failures a fair cast can produce: a bite that never came,
      // or the server discarding the bobber (bad landing spot) before a bite.
      assert(
        error.code === 'ERR_FISHING_TIMEOUT' || error.code === 'ERR_FISHING_CANCELLED',
        `attempt ${attempt}: unexpected failure ${error.code}: ${error.message}`
      )
    } finally {
      botState.off('fishingHookSpawned', onHookSpawned)
      observer.restore()
      recorder.restore()
    }
  }

  assert.fail(`no bite was ever observed in ${MAX_ATTEMPTS} attempts: ${lastError?.message}`)
}

function useSequences (packets) {
  const summaries = packets
    .filter(entry => entry.name === 'inventory_transaction' || entry.name === 'animate')
    .map(entry => {
      if (entry.name === 'animate') return `animate:${entry.packet.swing_source}`
      return `inventory_transaction:${entry.packet.transaction?.transaction_data?.action_type}`
    })
  return summaries
}

function assertCommonLifecycle (botState, { result, events, packets }) {
  // Owned hook spawned and was removed by the server before settle.
  const hookSpawns = events.filter(event => event.name === 'fishingHookSpawned')
  assert.strictEqual(hookSpawns.length, 1, 'exactly one owned hook per session')
  assert(result.hook, 'result exposes the terminal hook snapshot')
  assert.strictEqual(botState.entities.has(result.hook.runtimeId), false, 'hook entity removed after reel')

  // Cast and reel each sent one useitem swing + click_air use sequence.
  const summaries = useSequences(packets)
  const airUses = summaries.filter(summary => summary === 'inventory_transaction:click_air')
  const swings = summaries.filter(summary => summary === 'animate:useitem')
  assert.strictEqual(airUses.length, 2, `expected cast + reel click_air, got ${summaries.join(', ')}`)
  assert.strictEqual(swings.length, 2, 'each use sequence swings with the useitem source')

  // Outcome classification is authoritative: caught exposes the item, missed
  // exposes nulls; a bite alone is never reported as caught.
  assert(['caught', 'missed'].includes(result.outcome))
  if (result.outcome === 'caught') {
    assert(result.itemEntity, 'caught outcome must expose the item entity')
    assert.strictEqual(result.itemEntity.isFromFishing, true)
    const catches = events.filter(event => event.name === 'fishingCatch')
    assert.strictEqual(catches.length, 1)
  } else {
    assert.strictEqual(result.itemEntity, null)
    assert.strictEqual(result.item, null)
    assert.strictEqual(events.filter(event => event.name === 'fishingCatch').length, 0)
  }

  const stopped = events.filter(event => event.name === 'fishingStopped')
  assert.strictEqual(stopped.length, 1)
  assert.strictEqual(stopped[0].args[0].status, 'completed')
  assert.strictEqual(botState.isFishing, false)
  assert.strictEqual(botState.fishingState.phase, 'idle')
}

describe('live fishing builtin', function () {
  this.timeout(300000)

  let botState
  let sceneInfo

  before(async function () {
    botState = new BotState({
      host: HOST,
      port: PORT,
      username: USERNAME,
      offline: OFFLINE,
      version: VERSION
    })

    botState.start()
    await waitForSpawn(botState)
    await sleep(SETUP_DELAY_MS)
    sceneInfo = await setupFishingScene(botState)
  })

  after(function () {
    if (!botState?.client) return
    clearPlayer(botState, USERNAME)
    botState.disconnect('live fishing test complete')
  })

  describe('Endstone/BDS', function () {
    it('casts, receives fish_hook_hook, reels, and classifies the outcome', async function () {
      skipUnlessE2ETarget(this, 'endstone')

      const attempt = await fishWithRetries(botState)
      assertCommonLifecycle(botState, attempt)

      // BDS populates hook owner_eid: association must be by metadata, and
      // the authoritative bite signal is entity_event(fish_hook_hook).
      const bites = attempt.events.filter(event => event.name === 'fishingBite')
      assert.strictEqual(bites.length, 1)
      assert.strictEqual(bites[0].args[1].source, 'entity_event')

      const associated = attempt.events
        .filter(event => event.name === 'fishingStateChanged')
        .map(event => event.args[1])
        .find(state => state.phase === 'waiting_for_bite')
      assert(associated, 'hook association transition must be recorded')
      assert.strictEqual(associated.ownerMatch, 'metadata',
        'BDS populates owner_eid; the spawn-window fallback must not fire')

      const stopped = attempt.events.find(event => event.name === 'fishingStopped')
      assert.strictEqual(stopped.args[0].result.outcome, attempt.result.outcome)
    })

    it('stopFishing cancels a fresh cast with the exact Mineflayer message', async function () {
      skipUnlessE2ETarget(this, 'endstone')

      const pending = botState.fish()
      const rejection = assert.rejects(pending, error => {
        assert.strictEqual(error.message, 'Fishing cancelled')
        assert.strictEqual(error.code, 'ERR_FISHING_CANCELLED')
        return true
      })

      await waitUntil('hook spawn before stop', () => botState.fishingState.hookRuntimeId != null, 10000, 100, botState)
      await botState.stopFishing()
      await rejection
      assert.strictEqual(botState.isFishing, false)
    })
  })

  describe('Paper/Geyser', function () {
    it('casts, detects the translated-motion bite, reels, and classifies the outcome', async function () {
      skipUnlessE2ETarget(this, 'geyser')

      const disarmRescue = armGeyserBobberRescue(botState, sceneInfo)
      let attempt
      try {
        attempt = await fishWithRetries(botState)
      } finally {
        disarmRescue()
      }
      assertCommonLifecycle(botState, attempt)

      // Pinned: Geyser never synthesizes fish_hook_hook, so the bite MUST
      // come from the translated-motion fallback.
      const bites = attempt.events.filter(event => event.name === 'fishingBite')
      assert.strictEqual(bites.length, 1)
      assert.strictEqual(bites[0].args[1].source, 'translated_motion')
      assert(typeof bites[0].args[1].velocityY === 'number')

      // Pinned from the observed live Geyser runs (2026-07-14): Geyser
      // populates hook owner_eid, so association is by metadata — the
      // spawn-window fallback must not fire on this target — and the hook
      // carries one geyserId as both its runtime and unique id.
      const associated = attempt.events
        .filter(event => event.name === 'fishingStateChanged')
        .map(event => event.args[1])
        .find(state => state.phase === 'waiting_for_bite')
      assert(associated, 'hook association transition must be recorded')
      assert.strictEqual(associated.ownerMatch, 'metadata',
        'Geyser populates owner_eid; the spawn-window fallback must not fire')
      assert(attempt.result.hook.ownerEid != null, 'Geyser hook must carry owner_eid')
      assert.strictEqual(attempt.result.hook.uniqueId, attempt.result.hook.runtimeId,
        'Geyser assigns the hook one geyserId for both ids')

      // Pinned from Geyser source (core/.../entity/type/ItemEntity.java:64,
      // setFromFishing(false) unconditionally) and observed live: Geyser
      // never sets add_item_entity.is_from_fishing, so the authoritative
      // catch discriminator can never fire — Geyser catch classification is
      // 'missed'-only by design. The Java server does spawn the loot item
      // (observed at the hook position, arriving just BEFORE hook removal —
      // the reverse of the BDS same-tick order), but per the spec it must
      // not be reinterpreted from non-authoritative signals. If this
      // assertion ever fails with 'caught', Geyser started populating the
      // flag — revisit the degradation note in docs/API.md.
      assert.strictEqual(attempt.result.outcome, 'missed',
        'Geyser hard-codes is_from_fishing=false; classification is missed-only')
    })
  })
})
