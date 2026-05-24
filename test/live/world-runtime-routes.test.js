'use strict'

const assert = require('assert')
const { Vec3 } = require('vec3')
const BotState = require('../../src/state')
const { e2eTargetFamily } = require('../helpers/e2e-targets')
const {
  sendCommand,
  setPlayerGamemode,
  teleportPlayer
} = require('../helpers/commands')
const {
  captureQueuedPackets,
  sleep,
  waitForBlockName,
  waitForSpawn,
  waitUntil
} = require('../helpers/live')
const {
  HOST,
  PORT,
  USERNAME,
  OFFLINE,
  VERSION
} = require('../helpers/test-env')

const BASE = new Vec3(Number(process.env.LIVE_WORLD_ROUTE_X ?? 72), 65, Number(process.env.LIVE_WORLD_ROUTE_Z ?? 0))
const SETUP_DELAY_MS = Number(process.env.SETUP_DELAY_MS || 500)
const READER_USERNAME = process.env.LIVE_WORLD_READER_USERNAME || 'WorldRouteBot'

function routeExpectations () {
  const family = e2eTargetFamily()
  assert(family, `Unknown E2E_SERVER_TARGET=${process.env.E2E_SERVER_TARGET || ''}`)

  return {
    family,
    hashes: family === 'endstone',
    runtimeIdsAreStateIds: family === 'geyser',
    teleportSubchunkRequests: family === 'endstone'
  }
}

function observeWorldPackets (client) {
  const counts = {
    level_chunk: 0,
    subchunk: 0,
    update_block: 0,
    update_block_synced: 0,
    update_subchunk_blocks: 0
  }
  const listeners = {}

  for (const name of Object.keys(counts)) {
    listeners[name] = () => {
      counts[name]++
    }
    client.on(name, listeners[name])
  }

  return {
    counts,
    totalUpdates () {
      return counts.update_block + counts.update_block_synced + counts.update_subchunk_blocks
    },
    cleanup () {
      for (const [name, listener] of Object.entries(listeners)) {
        client.off(name, listener)
      }
    }
  }
}

async function connectBot (username, observerRef = null) {
  const botState = new BotState({
    host: HOST,
    port: PORT,
    username,
    offline: OFFLINE,
    version: VERSION
  })

  botState.start()
  if (observerRef) observerRef.current = observeWorldPackets(botState.client)
  await waitForSpawn(botState)
  return botState
}

async function waitForChunks (botState, center, label) {
  assert.strictEqual(typeof botState.waitForChunksToLoad, 'function')
  await botState.waitForChunksToLoad(16, center, 30000, 1)
  assert.strictEqual(
    botState.areChunksLoadedAround(16, center, 1),
    true,
    `Expected chunks loaded around ${label}`
  )
}

async function waitForUpdatePackets (observer, label) {
  await waitUntil(
    `${label} update packets`,
    () => observer.totalUpdates() > 0,
    8000,
    100
  )
}

describe('live world runtime mapping routes', function () {
  this.timeout(120000)

  let botState
  let observer

  afterEach(async function () {
    observer?.cleanup()
    observer = null

    if (botState?.client) {
      for (const pos of [BASE, BASE.offset(1, 0, 0), BASE.offset(2, 0, 0)]) {
        sendCommand(botState, `setblock ${pos.x} ${pos.y} ${pos.z} minecraft:air`)
        sendCommand(botState, `setblock ${pos.x} ${pos.y - 1} ${pos.z} minecraft:air`)
      }
      await sleep(SETUP_DELAY_MS)
      botState.disconnect('live world runtime routes test complete')
    }

    botState = null
  })

  it('uses the live server-specific teleport chunk reporting pattern', async function () {
    const expected = routeExpectations()
    const observerRef = {}
    botState = await connectBot(USERNAME, observerRef)
    observer = observerRef.current

    assert.strictEqual(botState.protocolState.blockNetworkIdsAreHashes, expected.hashes)
    assert.strictEqual(!!botState.protocolState.blockNetworkRuntimeIdsAreStateIds, expected.runtimeIdsAreStateIds)

    const capture = captureQueuedPackets(botState)
    try {
      setPlayerGamemode(botState, USERNAME, 'creative')
      await sleep(SETUP_DELAY_MS)
      teleportPlayer(botState, USERNAME, BASE.x + 0.5, BASE.y + 2, BASE.z + 0.5)

      await waitUntil(
        'teleport chunk radius request',
        () => capture.packets.some(packet => packet.name === 'request_chunk_radius'),
        8000,
        100,
        botState
      )
      await sleep(500)

      const subchunkRequests = capture.packets.filter(packet => packet.name === 'subchunk_request')
      assert.strictEqual(
        subchunkRequests.length > 0,
        expected.teleportSubchunkRequests,
        `${expected.family} subchunk_request packets=${subchunkRequests.length}`
      )
    } finally {
      capture.restore()
    }
  })

  it('maps live block update routes without turning air into bed', async function () {
    const observerRef = {}
    botState = await connectBot(USERNAME, observerRef)
    observer = observerRef.current

    setPlayerGamemode(botState, USERNAME, 'creative')
    await sleep(SETUP_DELAY_MS)
    await waitForChunks(botState, BASE, 'block update area')

    sendCommand(botState, `setblock ${BASE.x} ${BASE.y} ${BASE.z} minecraft:stone`)
    await waitForBlockName(botState, BASE, 'stone', 10000)

    sendCommand(botState, `setblock ${BASE.x} ${BASE.y} ${BASE.z} minecraft:air`)
    const block = await waitForBlockName(botState, BASE, 'air', 10000)
    assert.notStrictEqual(block.name, 'bed')

    await waitForUpdatePackets(observer, 'server-authored setblock')
  })

  it('decodes live chunk data after reconnect using the server reporting route', async function () {
    const writerObserverRef = {}
    botState = await connectBot(USERNAME, writerObserverRef)
    observer = writerObserverRef.current

    setPlayerGamemode(botState, USERNAME, 'creative')
    await sleep(SETUP_DELAY_MS)

    const support = BASE.offset(1, -1, 0)
    const airProbe = BASE.offset(1, 0, 0)
    const marker = BASE.offset(2, 0, 0)
    sendCommand(botState, `setblock ${support.x} ${support.y} ${support.z} minecraft:stone`)
    sendCommand(botState, `setblock ${airProbe.x} ${airProbe.y} ${airProbe.z} minecraft:air`)
    sendCommand(botState, `setblock ${marker.x} ${marker.y} ${marker.z} minecraft:emerald_block`)
    await waitForBlockName(botState, support, 'stone', 10000)
    await waitForBlockName(botState, airProbe, 'air', 10000)
    await waitForBlockName(botState, marker, 'emerald_block', 10000)

    observer.cleanup()
    observer = null
    botState.disconnect('live world runtime writer complete')
    botState = null
    await sleep(1500)

    const readerObserverRef = {}
    botState = await connectBot(READER_USERNAME, readerObserverRef)
    observer = readerObserverRef.current

    teleportPlayer(botState, READER_USERNAME, BASE.x + 1.5, BASE.y + 2, BASE.z + 0.5)
    await waitForChunks(botState, BASE, 'chunk decode area')

    await waitForBlockName(botState, support, 'stone', 10000)
    const decodedAir = await waitForBlockName(botState, airProbe, 'air', 10000)
    assert.notStrictEqual(decodedAir.name, 'bed')
    await waitForBlockName(botState, marker, 'emerald_block', 10000)

    const expected = routeExpectations()
    if (expected.teleportSubchunkRequests) {
      assert(observer.counts.subchunk > 0, `Expected Endstone live reader to receive subchunk packets; counts=${JSON.stringify(observer.counts)}`)
    } else {
      assert(
        observer.counts.level_chunk > 0 || observer.counts.subchunk > 0,
        `Expected Geyser live reader to receive chunk data packets; counts=${JSON.stringify(observer.counts)}`
      )
    }
  })
})
