// test/place-block.test.js
'use strict'

const assert = require('assert')
const BotState = require('../../src/state')
const { Vec3 } = require('vec3')
const {
  clearPlayer,
  givePlayer,
  sendCommand,
  setBlockIfNeeded,
  setPlayerGamemode,
  teleportPlayer
} = require('../helpers/commands')
const {
  assertHasApi,
  captureQueuedPackets,
  findQueuedPacket,
  findSlotByName,
  sleep,
  waitForBlockName,
  waitForSpawn
} = require('../helpers/live')

const HOST = process.env.HOST || 'localhost'
const PORT = parseInt(process.env.PORT, 10) || 19132
const USERNAME = 'OpBot'
const OFFLINE = process.env.OFFLINE !== 'false'
const { VERSION } = require('../helpers/test-env')

const SETUP_DELAY_MS = Number(process.env.SETUP_DELAY_MS || 700)
const PLACE_DELAY_MS = Number(process.env.PLACE_DELAY_MS || 900)

async function setupFlatPlacementArea (botState) {
  // Keep this small and deterministic.
  // Places stone support blocks with air above them and gives the teleported
  // bot a floor so the test does not depend on flying.
  setPlayerGamemode(botState, USERNAME, 'creative')
  await sleep(SETUP_DELAY_MS)

  clearPlayer(botState, USERNAME)
  await sleep(SETUP_DELAY_MS)

  await setBlockIfNeeded(botState, new Vec3(0, 64, 0), 'minecraft:stone')
  await setBlockIfNeeded(botState, new Vec3(0, 65, 0), 'minecraft:air')
  await setBlockIfNeeded(botState, new Vec3(1, 64, 0), 'minecraft:stone')
  await setBlockIfNeeded(botState, new Vec3(1, 65, 0), 'minecraft:air')
  await setBlockIfNeeded(botState, new Vec3(0, 65, 3), 'minecraft:stone')
  await setBlockIfNeeded(botState, new Vec3(0, 66, 3), 'minecraft:air')
  await setBlockIfNeeded(botState, new Vec3(0, 67, 3), 'minecraft:air')
  teleportPlayer(botState, USERNAME, 0.5, 66, 3.5)
  await sleep(SETUP_DELAY_MS)
}

async function giveItem (botState, itemName, count = 1) {
  givePlayer(botState, USERNAME, itemName, count)
  await sleep(SETUP_DELAY_MS)
}

async function setPlayerItemSlot (botState, slot, itemName, count = 1) {
  sendCommand(botState, `item replace entity .${USERNAME} ${slot} with minecraft:${itemName} ${count}`)
  await sleep(SETUP_DELAY_MS)
}

describe('block placing integration', function () {
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
    await setupFlatPlacementArea(botState)
  })

  after(async function () {
    if (!botState?.client) return

    try {
      await setBlockIfNeeded(botState, new Vec3(0, 65, 0), 'minecraft:air', 250)
      await setBlockIfNeeded(botState, new Vec3(1, 65, 0), 'minecraft:air', 250)
    } catch {}

    botState.disconnect('Block placing integration test complete')
  })

  it('auto-loads equip and place builtins', function () {
    assertHasApi(botState, 'equipItem')
    assertHasApi(botState, 'equipInventorySlot')
    assertHasApi(botState, 'selectHotbarSlot')
    assertHasApi(botState, 'setHeldItemSlot')
    assertHasApi(botState, 'placeBlock')
    assertHasApi(botState, 'placeEntity')
  })

  it('equips a hotbar block item and sends a placement transaction', async function () {
    await setupFlatPlacementArea(botState)
    await giveItem(botState, 'dirt', 4)
    setPlayerGamemode(botState, USERNAME, 'survival')
    await sleep(SETUP_DELAY_MS)

    const dirtSlot = findSlotByName(botState, 'dirt')
    assert(
      dirtSlot >= 0 && dirtSlot <= 8,
      `Expected /give dirt to land in hotbar for this test, got slot ${dirtSlot}`
    )

    const alreadySelected = botState.heldItemSlot === dirtSlot
    const capture = captureQueuedPackets(botState)

    try {
      await botState.equipItem(dirtSlot)
      assert.strictEqual(botState.heldItemSlot, dirtSlot)

      await botState.placeBlock(new Vec3(0, 64, 0), 1)
      await sleep(PLACE_DELAY_MS)

      const equipmentPacket = findQueuedPacket(capture.packets, 'mob_equipment')
      if (alreadySelected) {
        assert(!equipmentPacket, 'Expected already-selected hotbar equip to avoid mob_equipment')
      } else {
        assert(equipmentPacket, 'Expected equipItem to send mob_equipment')
        assert.strictEqual(equipmentPacket.packet.selected_slot, dirtSlot)
      }

      const placePacket = findQueuedPacket(capture.packets, 'inventory_transaction')
      assert(placePacket, 'Expected placeBlock to send inventory_transaction')

      const tx = placePacket.packet.transaction
      assert.strictEqual(tx.transaction_type, 'item_use')

      const data = tx.transaction_data
      assert.strictEqual(data.action_type, 'click_block')
      assert.deepStrictEqual(data.block_position, { x: 0, y: 64, z: 0 })
      assert.strictEqual(data.face, 1)
      assert.strictEqual(data.hotbar_slot, dirtSlot)
      assert.deepStrictEqual(data.click_pos, { x: 0.5, y: 1, z: 0.5 })
      assert(data.held_item, 'Expected placement packet to include held_item')
      assert.strictEqual(data.held_item.network_id !== 0, true)

      await waitForBlockName(botState, new Vec3(0, 65, 0), 'dirt')
    } finally {
      capture.restore()
    }
  })

  it('equips a non-hotbar block item into hand before placing', async function () {
    await setupFlatPlacementArea(botState)

    clearPlayer(botState, USERNAME)
    await sleep(SETUP_DELAY_MS)

    // Fill all nine hotbar slots first so the block item starts outside the hotbar.
    for (let slot = 0; slot <= 8; slot++) {
      sendCommand(botState, `item replace entity .${USERNAME} hotbar.${slot} with minecraft:stick 64`)
    }
    await sleep(SETUP_DELAY_MS)

    await setPlayerItemSlot(botState, 'inventory.0', 'oak_planks', 4)
    setPlayerGamemode(botState, USERNAME, 'survival')
    await sleep(SETUP_DELAY_MS)

    const planksSlot = findSlotByName(botState, 'oak_planks')
    assert(
      planksSlot > 8,
      `Expected oak_planks to be outside hotbar after filling hotbar, got slot ${planksSlot}`
    )

    const alreadySelected = botState.heldItemSlot === 0
    const capture = captureQueuedPackets(botState)

    try {
      await botState.equipItem(planksSlot, 0)
      assert.strictEqual(botState.heldItemSlot, 0)

      await botState.placeBlock(new Vec3(1, 64, 0), 1)
      await sleep(PLACE_DELAY_MS)

      const authPacket = findQueuedPacket(
        capture.packets,
        'player_auth_input',
        packet => packet.item_stack_request
      )
      assert(authPacket, 'Expected non-hotbar equip to send player_auth_input')
      assert(authPacket.packet.item_stack_request, 'Expected player_auth_input.item_stack_request')
      assert.strictEqual(authPacket.packet.item_stack_request.actions[0].type_id, 'swap')
      assert.strictEqual(authPacket.packet.item_stack_request.actions[0].source.slot, planksSlot)
      assert.strictEqual(authPacket.packet.item_stack_request.actions[0].destination.slot, 0)

      const equipmentPacket = findQueuedPacket(capture.packets, 'mob_equipment')
      if (alreadySelected) {
        assert(!equipmentPacket, 'Expected already-selected hotbar equip to avoid mob_equipment')
      } else {
        assert(equipmentPacket, 'Expected equipItem to select hotbar slot after swap')
        assert.strictEqual(equipmentPacket.packet.selected_slot, 0)
      }

      const placePacket = findQueuedPacket(capture.packets, 'inventory_transaction')
      assert(placePacket, 'Expected placeBlock to send inventory_transaction')

      const data = placePacket.packet.transaction.transaction_data
      assert.strictEqual(data.action_type, 'click_block')
      assert.deepStrictEqual(data.block_position, { x: 1, y: 64, z: 0 })
      assert.strictEqual(data.face, 1)
      assert.strictEqual(data.hotbar_slot, 0)
      assert(data.held_item, 'Expected held_item in place transaction')
    } finally {
      capture.restore()
    }
  })

  it('rejects placing when the selected hotbar slot is empty', async function () {
    await setupFlatPlacementArea(botState)

    clearPlayer(botState, USERNAME)
    await sleep(SETUP_DELAY_MS)
    setPlayerGamemode(botState, USERNAME, 'survival')
    await sleep(SETUP_DELAY_MS)

    botState.heldItemSlot = 0

    await assert.rejects(
      () => botState.placeBlock(new Vec3(0, 64, 0), 1),
      /No item in the active hotbar slot/
    )
  })
})
