'use strict'

const assert = require('assert')
const BotState = require('../../src/state')
const {
  bedrockPlayerName,
  sendCommand,
  setPlayerGamemode,
  teleportPlayer
} = require('../helpers/commands')
const {
  captureQueuedPackets,
  sleep,
  waitForSpawn,
  waitUntil
} = require('../helpers/live')
const {
  HOST,
  PORT,
  USERNAME,
  OFFLINE,
  VERSION,
  SETUP_DELAY_MS
} = require('../helpers/test-env')

function observeRespawnSignals (botState) {
  const signals = {
    deaths: 0,
    reviveHealthPackets: 0,
    inboundRespawnStates: []
  }

  const onDeathInfo = () => {
    signals.deaths++
  }
  const onSetHealth = (packet) => {
    if (packet.health > 0) signals.reviveHealthPackets++
  }
  const onRespawn = (packet) => {
    signals.inboundRespawnStates.push(packet.state)
  }

  botState.client.on('death_info', onDeathInfo)
  botState.client.on('set_health', onSetHealth)
  botState.client.on('respawn', onRespawn)

  return {
    signals,
    cleanup () {
      botState.client.off('death_info', onDeathInfo)
      botState.client.off('set_health', onSetHealth)
      botState.client.off('respawn', onRespawn)
    }
  }
}

describe('live respawn handling', function () {
  this.timeout(120000)

  let botState

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
  })

  after(function () {
    if (!botState?.client) return
    sendCommand(botState, `gamerule keepinventory false`)
    botState.disconnect('live respawn handling test complete')
  })

  it('respawns after three consecutive deaths', async function () {
    const observer = observeRespawnSignals(botState)
    const capture = captureQueuedPackets(botState)

    try {
      sendCommand(botState, 'gamerule keepinventory true')
      setPlayerGamemode(botState, USERNAME, 'survival')
      sendCommand(botState, `effect ${bedrockPlayerName(USERNAME)} clear`)
      teleportPlayer(botState, USERNAME, 0, 65, 0)
      await sleep(SETUP_DELAY_MS)

      for (let cycle = 1; cycle <= 3; cycle++) {
        const beforeDeaths = observer.signals.deaths
        const beforeRevives = observer.signals.reviveHealthPackets
        const beforeQueuedRespawns = capture.queued.length

        sendCommand(botState, `kill ${bedrockPlayerName(USERNAME)}`)

        await waitUntil(
          `death_info for respawn cycle ${cycle}`,
          () => observer.signals.deaths > beforeDeaths,
          10000,
          100,
          botState
        )

        await waitUntil(
          `server-confirmed revive for respawn cycle ${cycle}`,
          () => observer.signals.reviveHealthPackets > beforeRevives && !botState.lifecycle.isDead,
          20000,
          100,
          botState
        )

        const queuedRespawnStates = capture.queued
          .slice(beforeQueuedRespawns)
          .filter(packet => packet.name === 'respawn')
          .map(packet => packet.packet.state)

        assert(
          queuedRespawnStates.length > 0,
          `cycle ${cycle} did not queue any respawn packet`
        )
        assert(
          queuedRespawnStates.some(state => state === 0 || state === 1 || state === 2),
          `cycle ${cycle} queued unexpected respawn states ${queuedRespawnStates.join(',')}`
        )

        await sleep(500)
      }

      assert.strictEqual(observer.signals.deaths, 3)
      assert(
        observer.signals.reviveHealthPackets >= 3,
        `expected at least 3 revive health packets, saw ${observer.signals.reviveHealthPackets}`
      )
    } finally {
      capture.restore()
      observer.cleanup()
    }
  })
})
