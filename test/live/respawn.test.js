'use strict'

const assert = require('assert')
const BotState = require('../../src/state')
const {
  bedrockPlayerName,
  clearPlayer,
  currentCommandTargetFamily,
  givePlayer,
  sendCommand,
  setPlayerGamemode,
  teleportPlayer
} = require('../helpers/commands')
const {
  captureQueuedPackets,
  countInventoryItem,
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
    respawnEntityEvents: 0,
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
  const onEntityEvent = (packet) => {
    if ((packet.event ?? packet.event_id) === 'respawn') signals.respawnEntityEvents++
  }

  botState.client.on('death_info', onDeathInfo)
  botState.client.on('set_health', onSetHealth)
  botState.client.on('respawn', onRespawn)
  botState.client.on('entity_event', onEntityEvent)

  return {
    signals,
    cleanup () {
      botState.client.off('death_info', onDeathInfo)
      botState.client.off('set_health', onSetHealth)
      botState.client.off('respawn', onRespawn)
      botState.client.off('entity_event', onEntityEvent)
    }
  }
}

function completedRespawns (signals) {
  return signals.reviveHealthPackets + signals.respawnEntityEvents
}

function gameRuleName (name) {
  if (currentCommandTargetFamily() !== 'geyser') return name
  if (name === 'keepinventory') return 'keepInventory'
  if (name === 'doimmediaterespawn') return 'doImmediateRespawn'
  return name
}

function setGameRule (botState, name, value) {
  sendCommand(botState, `gamerule ${gameRuleName(name)} ${value}`)
}

function shouldAssertInventoryPreserved () {
  return currentCommandTargetFamily() !== 'geyser'
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
    setGameRule(botState, 'keepinventory', false)
    botState.disconnect('live respawn handling test complete')
  })

  it('respawns after three consecutive deaths', async function () {
    const observer = observeRespawnSignals(botState)
    const capture = captureQueuedPackets(botState)

    try {
      setGameRule(botState, 'keepinventory', true)
      setPlayerGamemode(botState, USERNAME, 'survival')
      sendCommand(botState, `effect ${bedrockPlayerName(USERNAME)} clear`)
      clearPlayer(botState, USERNAME)
      await sleep(SETUP_DELAY_MS)
      givePlayer(botState, USERNAME, 'dirt', 3)
      teleportPlayer(botState, USERNAME, 0, 65, 0)
      await sleep(SETUP_DELAY_MS)
      await waitUntil(
        'dirt kept in inventory before respawn cycles',
        () => countInventoryItem(botState, 'dirt') === 3,
        10000,
        100,
        botState
      )
      botState.setControlState('forward', true)
      botState.setControlState('sprint', true)

      for (let cycle = 1; cycle <= 3; cycle++) {
        const beforeDeaths = observer.signals.deaths
        const beforeCompletedRespawns = completedRespawns(observer.signals)
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
          () => completedRespawns(observer.signals) > beforeCompletedRespawns && !botState.lifecycle.isDead,
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
        if (shouldAssertInventoryPreserved()) {
          assert.strictEqual(
            countInventoryItem(botState, 'dirt'),
            3,
            `cycle ${cycle} did not preserve dirt across respawn`
          )
        }

        await sleep(500)
      }

      assert.strictEqual(observer.signals.deaths, 3)
      assert(
        completedRespawns(observer.signals) >= 3,
        `expected at least 3 respawn completions, saw health=${observer.signals.reviveHealthPackets} entity_event=${observer.signals.respawnEntityEvents}`
      )
    } finally {
      botState.setControlState('forward', false)
      botState.setControlState('sprint', false)
      capture.restore()
      observer.cleanup()
    }
  })

  it('survives immediate respawn gamerule deaths', async function () {
    const observer = observeRespawnSignals(botState)

    try {
      setGameRule(botState, 'doimmediaterespawn', true)
      setGameRule(botState, 'keepinventory', true)
      setPlayerGamemode(botState, USERNAME, 'survival')
      teleportPlayer(botState, USERNAME, 0, 65, 0)
      await sleep(SETUP_DELAY_MS)

      const beforeDeaths = observer.signals.deaths
      const beforeCompletedRespawns = completedRespawns(observer.signals)
      sendCommand(botState, `kill ${bedrockPlayerName(USERNAME)}`)

      await waitUntil(
        'immediate-respawn death_info',
        () => observer.signals.deaths > beforeDeaths,
        10000,
        100,
        botState
      )
      await waitUntil(
        'immediate-respawn server-confirmed revive',
        () => completedRespawns(observer.signals) > beforeCompletedRespawns && !botState.lifecycle.isDead,
        20000,
        100,
        botState
      )
    } finally {
      setGameRule(botState, 'doimmediaterespawn', false)
      observer.cleanup()
    }
  })
})
