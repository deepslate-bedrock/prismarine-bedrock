'use strict'

// Replays the compact fishing fixtures under test/fixtures/fishing/ through
// the REAL builtins (auth-input, entities, held-item-use, fishing) using the
// shared scripted-client harness. Fixture steps drive only the public API
// (fish/stopFishing) and feed normalized clientbound packets; the runner
// intercepts the serverbound queue and auth-input output and never calls
// internal state transitions.
//
// Fixture contract ({ name, description, notes, steps[] }), shared with the
// session-recording exporter so recorded real-client sessions can generate
// fixtures that pass this runner unmodified:
//
//   ops     fish / stopFishing / awaitStop / clientbound / authTick / sleep /
//           expectPhase / expectPhases / expectState / expectServerbound /
//           expectNoServerbound / expectEvent / expectNoEvent /
//           expectResolved / expectRejected / expectEntity
//   markers $id:<IDS key>, $bigint:<n>, $rodNetworkId, $caughtNetworkId
//
// Required failure modes (TASK-32 Phase 0): unmatched hook ids, unmatched use
// acknowledgements, incorrect phase transitions, and incorrect catch
// classification. The verified negative space is enforced on every fixture:
// no take_item_entity, no fish_hook_bubble, and no bite sound/particle packet
// may be fed, and the replay must classify bites and catches without them.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { DEFAULT_BEDROCK_VERSION } = require('../../src/version')
const { findEntityByRuntimeId } = require('../../src/utils/entity')

const {
  IDS,
  authTick,
  caughtNetworkId,
  createFishingBot,
  recordFishingEvents,
  rodNetworkId,
  sleep,
  summarizeServerbound
} = require('../helpers/fishing')

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'fishing')

// Verified absent on BDS 1.26.10 fishing (three captured sessions): pickup
// emits no take_item_entity, fish_hook_bubble never fired, and no
// bite-correlated sound/particle packet exists. Fixtures feeding any of these
// are invalid; the implementation must never depend on them.
const FORBIDDEN_CLIENTBOUND = Object.freeze([
  'take_item_entity',
  'level_sound_event',
  'play_sound',
  'spawn_particle_effect'
])
const FORBIDDEN_ENTITY_EVENTS = Object.freeze(['fish_hook_bubble'])

const KNOWN_OPS = new Set([
  'fish',
  'stopFishing',
  'awaitStop',
  'clientbound',
  'authTick',
  'sleep',
  'expectPhase',
  'expectPhases',
  'expectState',
  'expectServerbound',
  'expectNoServerbound',
  'expectEvent',
  'expectNoEvent',
  'expectResolved',
  'expectRejected',
  'expectEntity'
])

// Outbound packet names that round-trip through the 1.26.10 serializer before
// comparison, so expectations run against wire-normalized values.
const SERIALIZABLE_SERVERBOUND = new Set(['inventory_transaction', 'animate'])

let cachedCodec = null
function getCodec () {
  cachedCodec ??= {
    serializer: createSerializer(DEFAULT_BEDROCK_VERSION),
    deserializer: createDeserializer(DEFAULT_BEDROCK_VERSION)
  }
  return cachedCodec
}

// ---- marker resolution -----------------------------------------------------

function resolveMarkers (value) {
  if (typeof value === 'string') {
    if (value.startsWith('$id:')) {
      const key = value.slice(4)
      assert(key in IDS, `unknown $id marker: ${value}`)
      return IDS[key]
    }
    if (value.startsWith('$bigint:')) return BigInt(value.slice(8))
    if (value === '$rodNetworkId') return rodNetworkId()
    if (value === '$caughtNetworkId') return caughtNetworkId()
    return value
  }
  if (Array.isArray(value)) return value.map(resolveMarkers)
  if (value && typeof value === 'object') {
    if (value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data)
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = resolveMarkers(child)
    return out
  }
  return value
}

// ---- deep partial matching -------------------------------------------------

// Compares actual against a marker-resolved expectation. Objects match
// partially (only listed keys), arrays match exactly by length and element,
// numbers use a small tolerance for float32 wire normalization, and BigInt
// ids require exact equality.
function matchValue (actual, expected, keyPath) {
  if (typeof expected === 'bigint') {
    const actualBig = typeof actual === 'bigint'
      ? actual
      : (typeof actual === 'number' && Number.isInteger(actual) ? BigInt(actual) : null)
    assert(actualBig === expected, `${keyPath}: expected ${expected}n, got ${String(actual)}`)
    return
  }
  if (typeof expected === 'number') {
    const actualNum = typeof actual === 'bigint' ? Number(actual) : actual
    assert(
      typeof actualNum === 'number' && Math.abs(actualNum - expected) < 1e-3,
      `${keyPath}: expected ${expected}, got ${String(actual)}`
    )
    return
  }
  if (expected === null) {
    assert(actual === null || actual === undefined, `${keyPath}: expected null, got ${String(actual)}`)
    return
  }
  if (Buffer.isBuffer(expected)) {
    assert(Buffer.isBuffer(actual) && actual.equals(expected), `${keyPath}: buffer mismatch`)
    return
  }
  if (Array.isArray(expected)) {
    assert(Array.isArray(actual), `${keyPath}: expected an array, got ${String(actual)}`)
    assert.strictEqual(actual.length, expected.length, `${keyPath}: array length`)
    expected.forEach((entry, index) => matchValue(actual[index], entry, `${keyPath}[${index}]`))
    return
  }
  if (expected && typeof expected === 'object') {
    assert(actual && typeof actual === 'object', `${keyPath}: expected an object, got ${String(actual)}`)
    for (const [key, child] of Object.entries(expected)) matchValue(actual[key], child, `${keyPath}.${key}`)
    return
  }
  assert.strictEqual(actual, expected, `${keyPath}: expected ${String(expected)}, got ${String(actual)}`)
}

// ---- fixture validation ----------------------------------------------------

// Structural validation plus the negative-space gate: a fixture that feeds a
// forbidden packet is itself invalid, independent of what the implementation
// would do with it.
function validateFixture (fixture, file) {
  assert(typeof fixture.name === 'string' && fixture.name.length > 0, `${file}: fixture needs a name`)
  assert(Array.isArray(fixture.steps) && fixture.steps.length > 0, `${file}: fixture needs steps`)

  let fishOps = 0
  for (const [index, step] of fixture.steps.entries()) {
    const where = `${file} step ${index}`
    assert(step && typeof step.op === 'string', `${where}: missing op`)
    assert(KNOWN_OPS.has(step.op), `${where}: unknown op '${step.op}'`)
    if (step.op === 'fish') fishOps += 1
    if (step.op !== 'clientbound') continue

    assert(typeof step.name === 'string', `${where}: clientbound step needs a packet name`)
    assert(
      !FORBIDDEN_CLIENTBOUND.includes(step.name),
      `${where}: forbidden clientbound packet '${step.name}' (verified absent on BDS 1.26.10 fishing)`
    )
    if (step.name === 'entity_event') {
      assert(
        !FORBIDDEN_ENTITY_EVENTS.includes(step.params?.event_id),
        `${where}: forbidden entity event '${step.params?.event_id}' (never fired in any capture)`
      )
    }
  }
  assert.strictEqual(fishOps, 1, `${file}: fixtures drive exactly one fish() session`)
}

// ---- replay ----------------------------------------------------------------

function withTimeout (promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

function listenerCounts (bot) {
  const counts = {}
  for (const [label, emitter] of [['client', bot.client], ['bot', bot]]) {
    for (const name of emitter.eventNames()) {
      counts[`${label}:${String(name)}`] = emitter.listenerCount(name)
    }
  }
  return counts
}

// Serializes and re-parses an intercepted serverbound packet with protocol
// 1.26.10 so field expectations compare wire-normalized values; packets the
// harness does not serialize (none today) pass through unchanged.
function normalizeServerbound (entry) {
  if (!SERIALIZABLE_SERVERBOUND.has(entry.name)) return entry
  const { serializer, deserializer } = getCodec()
  const buffer = serializer.createPacketBuffer({ name: entry.name, params: entry.params })
  const parsed = deserializer.parsePacketBuffer(buffer).data
  return { name: parsed.name, params: parsed.params }
}

function recordedPhases (context) {
  return context.events
    .filter(event => event.name === 'fishingStateChanged')
    .map(event => event.args[1].phase)
}

async function runStep (context, step, where) {
  const { bot } = context

  switch (step.op) {
    case 'fish': {
      const promise = bot.fish(step.options ? resolveMarkers(step.options) : {})
      context.session = { promise, status: 'pending' }
      promise.then(
        () => { context.session.status = 'resolved' },
        () => { context.session.status = 'rejected' }
      )
      break
    }

    case 'stopFishing': {
      // Not awaited here: the settle depends on clientbound packets fed by
      // later steps. awaitStop joins it after the rejection assertions.
      context.stopPromise = bot.stopFishing(step.reason)
      break
    }

    case 'awaitStop': {
      assert(context.stopPromise, `${where}: awaitStop without a prior stopFishing`)
      await withTimeout(context.stopPromise, 5000, `${where}: stopFishing() did not settle`)
      break
    }

    case 'clientbound': {
      if (step.name === 'completed_using_item') context.ackCount += 1
      const params = resolveMarkers(step.params)
      if (step.name === 'inventory_transaction' && params?.transaction?.transaction_type === 'item_release') {
        context.releaseCount += 1
      }
      bot.client.emit(step.name, params)
      break
    }

    case 'authTick': {
      const packet = authTick(bot)
      const flag = packet.input_data.start_using_item === true
      assert.strictEqual(
        flag,
        step.expectStartUsingItem === true,
        `${where}: start_using_item expected ${step.expectStartUsingItem === true}, got ${flag}`
      )
      break
    }

    case 'sleep': {
      await sleep(step.ms)
      break
    }

    case 'expectPhase': {
      assert.strictEqual(bot.fishingState.phase, step.phase, `${where}: phase`)
      break
    }

    case 'expectPhases': {
      assert.deepStrictEqual(recordedPhases(context), step.phases, `${where}: phase transition history`)
      break
    }

    case 'expectState': {
      for (const [key, value] of Object.entries(step.state)) {
        matchValue(bot.fishingState[key], resolveMarkers(value), `${where}: fishingState.${key}`)
      }
      break
    }

    case 'expectServerbound': {
      const queued = bot.client.queued
      const fresh = queued.slice(context.serverboundCursor)
      const expectedSummaries = step.packets.map(entry => (typeof entry === 'string' ? entry : entry.packet))
      assert.deepStrictEqual(
        fresh.map(summarizeServerbound),
        expectedSummaries,
        `${where}: serverbound packet order`
      )
      fresh.forEach((entry, index) => {
        const expected = step.packets[index]
        const normalized = normalizeServerbound(entry)
        assert.strictEqual(summarizeServerbound(normalized), expectedSummaries[index], `${where}: round-trip summary [${index}]`)
        if (typeof expected === 'object' && expected.params) {
          matchValue(normalized.params, resolveMarkers(expected.params), `${where}: ${expectedSummaries[index]}`)
        }
        if (summarizeServerbound(entry) === 'inventory_transaction:click_air') context.useCount += 1
      })
      context.serverboundCursor = queued.length
      break
    }

    case 'expectNoServerbound': {
      const fresh = bot.client.queued.slice(context.serverboundCursor)
      assert.deepStrictEqual(
        fresh.map(summarizeServerbound),
        [],
        `${where}: unexpected serverbound packets`
      )
      break
    }

    case 'expectEvent': {
      const matches = context.events.filter(event => event.name === step.event)
      assert.strictEqual(matches.length, step.count, `${where}: ${step.event} count`)
      const last = matches[matches.length - 1]
      if (step.source !== undefined) {
        assert.strictEqual(last.args[1]?.source, step.source, `${where}: ${step.event} source`)
      }
      if (step.status !== undefined) {
        assert.strictEqual(last.args[0]?.status, step.status, `${where}: ${step.event} status`)
      }
      break
    }

    case 'expectNoEvent': {
      const matches = context.events.filter(event => event.name === step.event)
      assert.strictEqual(matches.length, 0, `${where}: ${step.event} must not fire`)
      break
    }

    case 'expectResolved': {
      assert(context.session, `${where}: expectResolved before fish`)
      const result = await withTimeout(context.session.promise, 5000, `${where}: fish() never resolved`)
      assert.strictEqual(result.outcome, step.outcome, `${where}: outcome`)
      if (step.outcome === 'caught') {
        assert(result.itemEntity, `${where}: a caught result must expose the item entity`)
      }
      if (step.itemEntity === null) assert.strictEqual(result.itemEntity, null, `${where}: itemEntity`)
      if (step.itemName !== undefined) {
        assert.strictEqual(result.item?.name ?? null, step.itemName, `${where}: item name`)
      }
      if (step.xpOrbs !== undefined) {
        assert.strictEqual(result.experienceEntities.length, step.xpOrbs, `${where}: xp orb count`)
      }
      break
    }

    case 'expectRejected': {
      assert(context.session, `${where}: expectRejected before fish`)
      let error = null
      try {
        await withTimeout(context.session.promise, 5000, `${where}: fish() never settled`)
      } catch (err) {
        error = err
      }
      assert(error, `${where}: expected fish() to reject`)
      assert.strictEqual(error.message, step.message, `${where}: rejection message`)
      if (step.code !== undefined) assert.strictEqual(error.code, step.code, `${where}: rejection code`)
      break
    }

    case 'expectEntity': {
      const runtimeId = resolveMarkers(step.runtimeId)
      const entity = findEntityByRuntimeId(bot, runtimeId)
      assert(entity, `${where}: entity ${String(runtimeId)} missing from world state`)
      break
    }

    default:
      assert.fail(`${where}: unhandled op '${step.op}'`)
  }
}

async function replayFixture (fixture, file) {
  const bot = createFishingBot()
  const events = recordFishingEvents(bot)
  const baseline = listenerCounts(bot)

  const context = {
    bot,
    events,
    session: null,
    stopPromise: null,
    serverboundCursor: 0,
    useCount: 0,
    ackCount: 0,
    releaseCount: 0
  }

  for (const [index, step] of fixture.steps.entries()) {
    await runStep(context, step, `${file} step ${index} (${step.op})`)
  }

  // ---- implicit end-of-fixture invariants ----

  // Every serverbound packet the bot wrote must have been asserted.
  const trailing = bot.client.queued.slice(context.serverboundCursor)
  assert.deepStrictEqual(trailing.map(summarizeServerbound), [], `${file}: unasserted serverbound packets`)

  // Use acknowledgements pair 1:1 with bot uses on ack-speaking fixtures
  // (every fed completed_using_item needs its item_release, and together they
  // must match the click_air uses the bot actually wrote).
  if (context.ackCount > 0) {
    assert.strictEqual(context.releaseCount, context.ackCount, `${file}: completed_using_item without its item_release pair`)
    assert.strictEqual(context.ackCount, context.useCount, `${file}: unmatched use acknowledgements (${context.ackCount} acks vs ${context.useCount} uses)`)
  }

  // The session settled exactly once and cleaned up: no active session, no
  // leftover phase, no leaked transient auth flag, no leaked listeners.
  assert(context.session, `${file}: fixture never called fish`)
  assert.notStrictEqual(context.session.status, 'pending', `${file}: fish() promise never settled`)
  assert.strictEqual(bot.isFishing, false, `${file}: isFishing must be false after settle`)
  assert.strictEqual(bot.fishingState.phase, 'idle', `${file}: terminal phase must return to idle`)
  assert.notStrictEqual(authTick(bot).input_data.start_using_item, true, `${file}: transient start_using_item flag leaked`)
  assert.deepStrictEqual(listenerCounts(bot), baseline, `${file}: listeners leaked after settle`)
}

// ---- test surface ------------------------------------------------------------

const fixtureFiles = fs.existsSync(FIXTURES_DIR)
  ? fs.readdirSync(FIXTURES_DIR).filter(file => file.endsWith('.json')).sort()
  : []

describe('fishing replay fixtures', function () {
  this.timeout(20000)

  it('covers the four hand-authored TASK-32 scenarios', function () {
    for (const required of [
      'scenario-a-cast-bite-catch.json',
      'scenario-b-cast-cancel.json',
      'scenario-c-bite-missed-reel.json',
      'scenario-d-other-hooks-unrelated-drops.json'
    ]) {
      assert(fixtureFiles.includes(required), `missing fixture ${required}`)
    }
  })

  for (const file of fixtureFiles) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'))

    it(`${fixture.name} [${file}]`, async function () {
      validateFixture(fixture, file)
      await replayFixture(fixture, file)
    })
  }
})
