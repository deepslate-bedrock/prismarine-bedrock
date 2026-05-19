'use strict'

const assert = require('assert')
const BotState = require('../../src/state')
const {
  clearPlayer,
  givePlayer,
  setPlayerGamemode
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

async function waitForPredicate (predicate, label, timeoutMs = 10000, intervalMs = 100) {
  return waitUntil(label, predicate, timeoutMs, intervalMs)
}

async function setupFood (botState) {
  setPlayerGamemode(botState, USERNAME, 'survival')
  clearPlayer(botState, USERNAME)
  await sleep(SETUP_DELAY_MS)

  givePlayer(botState, USERNAME, 'golden_apple', 2)
  await waitForPredicate(
    () => botState.inventory?.slots?.find(item => item?.name === 'golden_apple'),
    'golden apple in inventory',
    10000
  )
}

describe('live food builtin', function () {
  this.timeout(90000)

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

  beforeEach(async function () {
    await setupFood(botState)
  })

  after(function () {
    if (!botState?.client) return
    clearPlayer(botState, USERNAME)
    botState.disconnect('live food builtin test complete')
  })

  it('eats a golden apple with botState.eat(slot)', async function () {
    const slot = findSlotByName(botState, 'golden_apple')
    const beforeCount = botState.inventory.slots[slot].count
    const observer = observeQueuedPackets(botState.client)

    try {
      const result = await botState.eat(slot, {
        force: true,
        completionTimeoutMs: 15000
      })

      await waitForPredicate(
        () => {
          const item = botState.inventory.slots[botState.heldItemSlot]
          return !item || item.name !== 'golden_apple' || item.count < beforeCount
        },
        'golden apple count decrease',
        10000
      )

      const transactions = observer.queued
        .filter(packet => packet.name === 'inventory_transaction')
        .map(packet => packet.params.transaction.transaction_type)

      assert(transactions.includes('item_use'), 'eat did not send item_use transaction')
      assert(transactions.includes('item_release'), 'eat did not send item_release transaction')
      assert(
        ['completed_using_item', 'inventory_slot', 'inventory_content', 'food_status'].includes(result.reason),
        `unexpected eat completion reason: ${result.reason}`
      )
    } finally {
      observer.restore()
    }
  })
})
