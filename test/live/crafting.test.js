'use strict'

const assert = require('assert')
const BotState = require('../../src/state')
const { Vec3 } = require('vec3')
const {
  bedrockPlayerName,
  clearPlayer,
  givePlayer,
  sendCommand,
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

const CRAFT_POS = {
  x: Number(process.env.CRAFT_TEST_X || 1),
  y: Number(process.env.CRAFT_TEST_Y || 64),
  z: Number(process.env.CRAFT_TEST_Z || 0)
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForSpawn (botState, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for spawn')), timeoutMs)

    botState.client.once('spawn', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function waitForInventoryPredicate (botState, predicate, label, timeoutMs = 4000) {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await sleep(100)
  }

  assert.fail([
    `Timed out waiting for inventory condition: ${label}`,
    'Inventory:',
    JSON.stringify(inventorySummary(botState), null, 2)
  ].join('\n'))
}

async function waitForBotPosition (botState, target, label, timeoutMs = 8000) {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const pos = botState.self?.position
    if (pos) {
      const feet = botState.authoritativeMovementFeetPosition || {
        x: pos.x,
        y: pos.y - (botState.self?.eyeHeight || 1.6200103759765625),
        z: pos.z
      }
      const candidates = [pos, feet]
      if (candidates.some(candidate =>
        Math.abs(candidate.x - target.x) < 0.75 &&
        Math.abs(candidate.y - target.y) < 0.75 &&
        Math.abs(candidate.z - target.z) < 0.75
      )) {
        return
      }
    }
    await sleep(100)
  }

  const pos = botState.self?.position
  const feet = pos && (botState.authoritativeMovementFeetPosition || {
    x: pos.x,
    y: pos.y - (botState.self?.eyeHeight || 1.6200103759765625),
    z: pos.z
  })
  assert.fail([
    `Timed out waiting for bot position: ${label}`,
    `Expected near: ${target.x} ${target.y} ${target.z}`,
    `Actual: ${pos ? `${pos.x} ${pos.y} ${pos.z}` : 'unknown'}`,
    `Actual feet: ${feet ? `${feet.x} ${feet.y} ${feet.z}` : 'unknown'}`
  ].join('\n'))
}

function inventorySummary (botState) {
  return botState.inventory.slots
    .map((item, slot) => item && {
      slot,
      name: item.name,
      count: item.count,
      type: item.type,
      metadata: item.metadata,
      stackId: item.stackId ?? item.stack_id
    })
    .filter(Boolean)
}

function countInventoryItem (botState, name) {
  return botState.inventory.slots.reduce((total, item) => {
    if (!item || item.name !== name) return total
    return total + item.count
  }, 0)
}

async function waitForInventoryCount (botState, name, count, timeoutMs = 4000) {
  await waitForInventoryPredicate(
    botState,
    () => countInventoryItem(botState, name) === count,
    `${name}=${count}`,
    timeoutMs
  )
}

async function waitForBlockName (botState, pos, expectedName, timeoutMs = 8000) {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const block = await botState.getBlock(pos)
    if (block?.name === expectedName) return block
    await sleep(150)
  }

  const block = await botState.getBlock(pos)
  assert.fail(`Timed out waiting for block ${expectedName} at ${pos}; actual=${block?.name || 'unknown'}`)
}

async function waitForInventoryCounts (botState, expected, timeoutMs = 4000) {
  await waitForInventoryPredicate(
    botState,
    () => Object.entries(expected).every(([name, count]) => countInventoryItem(botState, name) === count),
    JSON.stringify(expected),
    timeoutMs
  )
}

async function setupCraftingWorld (botState) {
  const { x, y, z } = CRAFT_POS
  const tablePos = new Vec3(x, y, z)
  const standPos = new Vec3(x - 1, y, z)

  setPlayerGamemode(botState, USERNAME, 'survival')
  await sleep(SETUP_DELAY_MS)

  clearPlayer(botState, USERNAME)
  await sleep(SETUP_DELAY_MS)

  sendCommand(botState, 'fill -2 64 -2 2 68 2 air')
  sendCommand(botState, 'fill -2 63 -2 2 63 2 grass_block')
  sendCommand(botState, `setblock ${tablePos.x} ${tablePos.y} ${tablePos.z} minecraft:crafting_table`)
  await sleep(SETUP_DELAY_MS)
  await waitForCraftingArea(botState, tablePos)

  sendCommand(
    botState,
    `tp ${bedrockPlayerName(USERNAME)} ${standPos.x.toFixed(1)} ${standPos.y.toFixed(1)} ${standPos.z.toFixed(1)}`
  )
  await waitForBotPosition(botState, standPos, 'next to crafting table')
}

async function waitForCraftingArea (botState, tablePos) {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      await waitForBlockName(botState, new Vec3(dx, tablePos.y - 1, dz), 'grass_block')
    }
  }
  await waitForBlockName(botState, tablePos, 'crafting_table')
}

async function setupInventoryCraftingPlayer (botState) {
  setPlayerGamemode(botState, USERNAME, 'survival')
  await sleep(SETUP_DELAY_MS)

  clearPlayer(botState, USERNAME)
  await sleep(SETUP_DELAY_MS)
}

function craftingTableRef () {
  const { x, y, z } = CRAFT_POS
  return { position: new Vec3(x, y, z) }
}

function requireRegistryItem (botState, name) {
  const item = botState.registry.itemsByName?.[name]
  assert(item, `Expected registry item ${name} to exist`)
  return item
}

function assertHasCraftingApi (botState) {
  assert.strictEqual(typeof botState.planCraftInventory, 'function', 'Expected botState.planCraftInventory')
  assert.strictEqual(typeof botState.craftItem, 'function', 'Expected botState.craftItem')
  assert.strictEqual(typeof botState.craftItemAuto, 'function', 'Expected botState.craftItemAuto')
  assert.strictEqual(typeof botState.craftItemNormal, 'function', 'Expected botState.craftItemNormal')
  assert.strictEqual(typeof botState.craftAuto, 'function', 'Expected botState.craftAuto')
  assert.strictEqual(typeof botState.craftNormal, 'function', 'Expected botState.craftNormal')
  assert.strictEqual(typeof botState.craftPlan, 'function', 'Expected botState.craftPlan')
  assert.strictEqual(typeof botState.craftPlanAuto, 'function', 'Expected botState.craftPlanAuto')
  assert.strictEqual(typeof botState.craftPlanNormal, 'function', 'Expected botState.craftPlanNormal')
  assert.strictEqual(typeof botState.craftRecipeBookAuto, 'function', 'Expected botState.craftRecipeBookAuto')
}

describe('live crafting integration', function () {
  this.timeout(180000)

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

    botState.setInventoryActionResponseTimeout?.(3000)
    botState.setInventoryActionUpdateTimeout?.(3000)
  })

  after(function () {
    if (botState?.client) {
      botState.disconnect('Crafting mocha test complete')
    }
  })

  it('auto-loads the crafting API', function () {
    assertHasCraftingApi(botState)
  })

  async function assertCraftsOakPlanks (craftMethodName) {
    await setupInventoryCraftingPlayer(botState)

    const oakPlanks = requireRegistryItem(botState, 'oak_planks')

    givePlayer(botState, USERNAME, 'oak_log', 2)
    await waitForInventoryCount(botState, 'oak_log', 2)

    const logsBefore = countInventoryItem(botState, 'oak_log')
    const planksBefore = countInventoryItem(botState, 'oak_planks')

    const plan = await botState.planCraftInventory({ id: oakPlanks.id, count: 8 })
    assert.strictEqual(plan.status, 'complete', `Expected complete craft plan, got ${plan.status || plan.error || 'unknown error'}`)
    assert(Array.isArray(plan.recipesToDo) && plan.recipesToDo.length >= 1, [
      'Expected at least one recipe step for oak planks',
      'Plan:',
      JSON.stringify(plan, null, 2),
      'Inventory:',
      JSON.stringify(inventorySummary(botState), null, 2)
    ].join('\n'))

    await botState[craftMethodName](oakPlanks.id, 8)

    await waitForInventoryCounts(botState, {
      oak_log: logsBefore - 2,
      oak_planks: planksBefore + 8
    })

    assert.strictEqual(countInventoryItem(botState, 'oak_log'), 0)
    assert.strictEqual(countInventoryItem(botState, 'oak_planks'), planksBefore + 8)
  }

  it('auto crafts oak planks from oak logs with the live server recipe data', async function () {
    await assertCraftsOakPlanks('craftItemAuto')
  })

  it('normal crafts oak planks from oak logs with the live server recipe data', async function () {
    await assertCraftsOakPlanks('craftItemNormal')
  })

  it('crafts a wooden pickaxe through recursive multi-step planning', async function () {
    await setupCraftingWorld(botState)

    const woodenPickaxe = requireRegistryItem(botState, 'wooden_pickaxe')

    givePlayer(botState, USERNAME, 'oak_log', 2)
    await waitForInventoryCount(botState, 'oak_log', 2)

    const pickaxesBefore = countInventoryItem(botState, 'wooden_pickaxe')
    const sticksBefore = countInventoryItem(botState, 'stick')
    const planksBefore = countInventoryItem(botState, 'oak_planks')

    const plan = await botState.planCraftInventory({ id: woodenPickaxe.id, count: 1 })
    assert.strictEqual(plan.status, 'complete', `Expected complete wooden pickaxe plan, got ${plan.status || plan.error || 'unknown error'}`)
    assert(Array.isArray(plan.recipesToDo) && plan.recipesToDo.length >= 2, [
      `Expected recursive recipe plan, got ${plan.recipesToDo?.length || 0} step(s)`,
      'Plan:',
      JSON.stringify(plan, null, 2),
      'Inventory:',
      JSON.stringify(inventorySummary(botState), null, 2)
    ].join('\n'))
    assert(plan.recipesToDo.some(step => step?._craftingUtilRecipe?.requiresTable), [
      'Expected at least one crafting-table recipe step',
      'Plan:',
      JSON.stringify(plan, null, 2)
    ].join('\n'))

    await botState.craftItem(woodenPickaxe.id, 1, craftingTableRef())

    await waitForInventoryCounts(botState, {
      oak_log: 0,
      wooden_pickaxe: pickaxesBefore + 1,
      stick: sticksBefore + 2,
      oak_planks: planksBefore + 3
    })

    assert.strictEqual(countInventoryItem(botState, 'oak_log'), 0)
    assert.strictEqual(countInventoryItem(botState, 'wooden_pickaxe'), pickaxesBefore + 1)
    assert.strictEqual(countInventoryItem(botState, 'stick'), sticksBefore + 2)
    assert.strictEqual(countInventoryItem(botState, 'oak_planks'), planksBefore + 3)
  })

  it('crafts ten wooden pickaxes through recursive multi-step planning', async function () {
    await setupCraftingWorld(botState)

    const woodenPickaxe = requireRegistryItem(botState, 'wooden_pickaxe')

    givePlayer(botState, USERNAME, 'oak_log', 10)
    await waitForInventoryCount(botState, 'oak_log', 10)

    const plan = await botState.planCraftInventory({ id: woodenPickaxe.id, count: 10 })
    assert.strictEqual(plan.status, 'complete', `Expected complete wooden pickaxe plan, got ${plan.status || plan.error || 'unknown error'}`)

    const pickaxeStep = plan.recipesToDo.find(step => step?._craftingUtilRecipe?.result?.name === 'wooden_pickaxe')
    assert(pickaxeStep, [
      'Expected a wooden_pickaxe recipe step',
      'Plan:',
      JSON.stringify(plan, null, 2)
    ].join('\n'))
    assert.strictEqual(pickaxeStep.recipeApplications, 10, [
      'Expected the final workbench craft to batch 10 recipe applications',
      'Plan:',
      JSON.stringify(plan, null, 2)
    ].join('\n'))

    await botState.craftItem(woodenPickaxe.id, 10, craftingTableRef())

    await waitForInventoryCounts(botState, {
      oak_log: 0,
      wooden_pickaxe: 10,
      stick: 0,
      oak_planks: 0
    }, 8000)

    assert.strictEqual(countInventoryItem(botState, 'oak_log'), 0)
    assert.strictEqual(countInventoryItem(botState, 'wooden_pickaxe'), 10)
    assert.strictEqual(countInventoryItem(botState, 'stick'), 0)
    assert.strictEqual(countInventoryItem(botState, 'oak_planks'), 0)
  })
})
