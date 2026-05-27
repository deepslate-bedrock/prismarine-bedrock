'use strict'

const assert = require('assert')
const BotState = require('../../src/state')
const { sendCommand } = require('../helpers/commands')
const {
  sleep,
  waitForSpawn,
  waitUntil
} = require('../helpers/live')
const {
  HOST,
  PORT,
  OFFLINE,
  VERSION
} = require('../helpers/test-env')

const TARGET = process.env.E2E_SERVER_TARGET || `port-${PORT}`
const SCOREBOARD_USERNAME = process.env.SCOREBOARD_USERNAME || scoreboardUsernameForTarget(TARGET)

function scoreboardUsernameForTarget (target) {
  const suffix = String(target).replace(/[^A-Za-z0-9]/g, '').slice(0, 10)
  return suffix ? `Score${suffix}` : 'ScoreBot'
}

function uniqueObjectiveName () {
  return `pb${Date.now().toString(36).slice(-8)}`
}

async function connectBot () {
  const botState = new BotState({
    host: HOST,
    port: PORT,
    username: SCOREBOARD_USERNAME,
    offline: OFFLINE,
    version: VERSION,
    worldDecodeEnabled: false
  })

  botState.start()
  await waitForSpawn(botState)
  return botState
}

function displayedEntry (botState, entryName) {
  return botState.getDisplayedScores('sidebar')
    .find(entry => entry.customName === entryName || entry.displayName === entryName)
}

describe('live scoreboard builtin', function () {
  this.timeout(90000)

  let botState
  let objectiveName

  before(async function () {
    botState = await connectBot()
  })

  after(async function () {
    if (!botState?.client) return
    if (objectiveName) {
      sendCommand(botState, `scoreboard objectives remove ${objectiveName}`)
      await sleep(250)
    }
    botState.disconnect('live scoreboard builtin test complete')
  })

  it('mirrors scoreboard creation, score updates, and objective deletion', async function () {
    assert(botState.scoreboards, 'scoreboard state is missing')
    assert.strictEqual(typeof botState.getScoreboardObjective, 'function')
    assert.strictEqual(typeof botState.getDisplayedScores, 'function')

    objectiveName = uniqueObjectiveName()
    const entryName = `line${objectiveName.slice(2)}`

    sendCommand(botState, `scoreboard objectives add ${objectiveName} dummy PBScore`)
    sendCommand(botState, `scoreboard objectives setdisplay sidebar ${objectiveName}`)

    const displayedObjective = await waitUntil(
      `scoreboard objective ${objectiveName} to display`,
      () => {
        const objective = botState.getScoreboardObjective('sidebar')
        return objective?.name === objectiveName ? objective : false
      },
      10000,
      100,
      botState
    )

    assert.strictEqual(displayedObjective.displayName, 'PBScore')
    assert.strictEqual(displayedObjective.displaySlots.has('sidebar'), true)

    sendCommand(botState, `scoreboard players set ${entryName} ${objectiveName} 3`)

    const firstScore = await waitUntil(
      `${entryName} score to become 3`,
      () => {
        const entry = displayedEntry(botState, entryName)
        return entry?.score === 3 ? entry : false
      },
      10000,
      100,
      botState
    )

    assert.strictEqual(firstScore.objectiveName, objectiveName)
    assert.strictEqual(firstScore.type, 'fake_player')
    assert.strictEqual(firstScore.customName, entryName)

    sendCommand(botState, `scoreboard players set ${entryName} ${objectiveName} 9`)

    const updatedScore = await waitUntil(
      `${entryName} score to become 9`,
      () => {
        const entry = displayedEntry(botState, entryName)
        return entry?.score === 9 ? entry : false
      },
      10000,
      100,
      botState
    )

    assert.strictEqual(updatedScore.scoreboardId, firstScore.scoreboardId)

    sendCommand(botState, `scoreboard objectives remove ${objectiveName}`)

    await waitUntil(
      `scoreboard objective ${objectiveName} removal`,
      () => {
        const objective = botState.getScoreboardObjective(objectiveName)
        const displayed = botState.getScoreboardObjective('sidebar')
        return !objective && (!displayed || displayed.name !== objectiveName)
      },
      10000,
      100,
      botState
    )

    assert.strictEqual(botState.getDisplayedScores('sidebar').some(entry => entry.objectiveName === objectiveName), false)
    objectiveName = null
  })
})
