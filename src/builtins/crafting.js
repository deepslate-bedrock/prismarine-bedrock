// builtins/crafting.js
// Auto-loaded by plugin-loader.

const { buildStatic } = require('mineflayer-crafting-util')
const recipeLoader = require('prismarine-recipe')
const registryLoader = require('prismarine-registry')
const { logAction, sleep } = require('../utils')

const CONTAINER = {
  output: 'creative_output',
  cursor: 'cursor',
  craftingInput: 'crafting_input',
}

const INVENTORY_CRAFTING_GRID_SLOTS = [30, 31, 28, 29]
const ACTION = {
  take: 'take',
  place: 'place',
  consume: 'consume',
  create: 'create',
  craftRecipe: 'craft_recipe',
  craftRecipeAuto: 'craft_recipe_auto',
  resultsDeprecated: 'results_deprecated',
}

function nextRequestId (botState) {
  botState._craftRequestId = (botState._craftRequestId || 0) + 1
  return -(botState._craftRequestId * 2 + 23)
}

function recipeBody (entry) {
  return entry?.recipe || entry
}

function recipeNetworkId (entry) {
  const recipe = recipeBody(entry)
  return recipe?.network_id ?? entry?.network_id
}

function recipeOutputs (entry) {
  const recipe = recipeBody(entry)
  if (!recipe) return []
  if (Array.isArray(recipe.output)) return recipe.output
  return recipe.output ? [recipe.output] : []
}

function recipeResult (entry, itemId) {
  return recipeOutputs(entry).find(item => item?.network_id === itemId || item?.id === itemId)
}

function ingredientCount (ingredient) {
  return Math.max(1, Math.abs(ingredient?.count ?? 1))
}

function itemName (botState, item) {
  return botState.registry.items[item.type]?.name || item.name || ''
}

function normalizeTag (tag = '') {
  return tag.replace(/^minecraft:/, '')
}

function ingredientMetadataMatchesItem (ingredientMetadata, itemMetadata) {
  return ingredientMetadata == null ||
    ingredientMetadata === 0 ||
    ingredientMetadata === 32767 ||
    ingredientMetadata === itemMetadata
}

function ingredientMatchesItem (botState, ingredient, item) {
  if (!ingredient || !item) return false

  if (ingredient.type === 'int_id_meta' || ingredient.network_id != null) {
    if (ingredient.network_id !== item.type) return false
    return ingredientMetadataMatchesItem(ingredient.metadata, item.metadata)
  }

  if (ingredient.type === 'string_id_meta' || ingredient.name) {
    const wanted = String(ingredient.name).replace(/^minecraft:/, '')
    if (wanted !== itemName(botState, item)) return false
    return ingredientMetadataMatchesItem(ingredient.metadata, item.metadata)
  }

  if (ingredient.type === 'item_tag' || ingredient.tag) {
    const tag = normalizeTag(ingredient.tag)
    const name = itemName(botState, item)
    if (tag === 'logs') return /(^|_)log$|(^|_)stem$|hyphae$/.test(name)
    if (tag === 'planks') return name.endsWith('_planks')
  }

  return false
}

function flattenIngredients (entry) {
  return positionedIngredients(entry).map(position => position.ingredient)
}

function validRecipeIngredient (ingredient) {
  return ingredient && ingredient.type !== 'invalid'
}

function positionedIngredients (entry) {
  const recipe = recipeBody(entry)
  if (!recipe) return []

  if (Array.isArray(recipe.input)) {
    const positions = []
    let gridSlot = 0

    for (const part of recipe.input) {
      const row = Array.isArray(part) ? part : [part]
      for (const ingredient of row) {
        if (validRecipeIngredient(ingredient)) {
          positions.push({ gridSlot, ingredient })
        }
        gridSlot++
      }
    }

    return positions
  }

  return []
}

function isTableRecipe (entry) {
  if (entry?._craftingUtilRecipe) return !!entry._craftingUtilRecipe.requiresTable
  const recipe = recipeBody(entry)
  if (!recipe) return false
  return (entry.type === 'shaped' || entry.type === 1) && (recipe.width > 2 || recipe.height > 2)
}

function reserveIngredients (botState, ingredientPositions, times) {
  const used = new Map()
  const placements = []

  for (const position of ingredientPositions) {
    const { gridSlot, ingredient } = position
    let remaining = ingredientCount(ingredient) * times

    for (let slot = 0; slot < botState.inventory.slots.length && remaining > 0; slot++) {
      const item = botState.inventory.slots[slot]
      const available = (item?.count || 0) - (used.get(slot) || 0)
      if (available <= 0 || !ingredientMatchesItem(botState, ingredient, item)) continue

      const count = Math.min(available, remaining)
      used.set(slot, (used.get(slot) || 0) + count)
      placements.push({ gridSlot, slot, count, stackId: item.stackId || 0, item })
      remaining -= count
    }

    if (remaining > 0) return null
  }

  return placements
}

function outputSlot (botState, result, used) {
  for (let slot = 0; slot < botState.inventory.slots.length; slot++) {
    const item = botState.inventory.slots[slot]
    const countAfterCraft = (item?.count || 0) - (used.get(slot) || 0)
    const stackSize = item?.type === result.network_id
      ? inventoryItemStackSize(botState, item)
      : 0
    if (item?.type === result.network_id && countAfterCraft + result.count <= stackSize) return slot
  }

  for (let slot = 0; slot < botState.inventory.slots.length; slot++) {
    const item = botState.inventory.slots[slot]
    if (!item || (item.count || 0) <= (used.get(slot) || 0)) return slot
  }

  return null
}

function inventoryItemStackSize (botState, item) {
  if (Number.isInteger(item?.maxDurability) && item.maxDurability > 0) return 1
  if (Number.isInteger(item?.max_durability) && item.max_durability > 0) return 1

  const craftingByName = item?.name ? botState.craftingRecipeRegistry?.itemsByName?.[String(item.name).replace(/^minecraft:/, '')] : null
  if (Number.isInteger(craftingByName?.maxDurability) && craftingByName.maxDurability > 0) return 1
  if (Number.isInteger(craftingByName?.max_durability) && craftingByName.max_durability > 0) return 1
  if (Number.isInteger(craftingByName?.stackSize)) return craftingByName.stackSize

  const byName = item?.name ? botState.registry.itemsByName?.[String(item.name).replace(/^minecraft:/, '')] : null
  if (Number.isInteger(byName?.maxDurability) && byName.maxDurability > 0) return 1
  if (Number.isInteger(byName?.max_durability) && byName.max_durability > 0) return 1
  if (Number.isInteger(byName?.stackSize)) return byName.stackSize

  const byType = botState.registry.items[item?.type]
  if (Number.isInteger(byType?.maxDurability) && byType.maxDurability > 0) return 1
  if (Number.isInteger(byType?.max_durability) && byType.max_durability > 0) return 1
  return Number.isInteger(byType?.stackSize) ? byType.stackSize : 64
}

function nextCraftStackId (botState) {
  const maxInventoryStackId = Math.max(0, ...(botState.inventory?.slots || [])
    .map(item => item?.stackId ?? item?.stack_id ?? 0)
    .filter(Number.isFinite))

  let stackId = 0
  while (stackId <= maxInventoryStackId) stackId = botState.itemClass.nextStackId()
  return stackId
}

function itemStackId (item) {
  return item?.stackId ?? item?.stack_id ?? 0
}

function responseSlot (response, containerId, slot) {
  for (const container of response?.containers || []) {
    if (container.slot_type?.container_id !== containerId) continue
    const found = (container.slots || []).find(entry => entry.slot === slot)
    if (found) return found
  }

  return null
}

function responseStackId (response, containerId, slot, fallback = 0) {
  return responseSlot(response, containerId, slot)?.item_stack_id ?? fallback
}

function craftingGridProtocolSlot (craft, gridSlot) {
  const table = craft.usingCraftingTable || isTableRecipe(craft.entry)
  const gridWidth = table ? 3 : 2
  const recipe = recipeBody(craft.entry)
  const recipeWidth = Number.isInteger(recipe?.width) && recipe.width > 0
    ? recipe.width
    : Math.min(gridWidth, Math.max(1, flattenIngredients(craft.entry).length))
  const recipeHeight = Number.isInteger(recipe?.height) && recipe.height > 0
    ? recipe.height
    : Math.max(1, Math.ceil(flattenIngredients(craft.entry).length / recipeWidth))
  const x = gridSlot % recipeWidth
  const y = Math.floor(gridSlot / recipeWidth)
  const tableYOffset = table && recipeHeight < 3 ? 1 : 0
  const protocolGridSlot = (y + tableYOffset) * gridWidth + x

  return table
    ? 32 + protocolGridSlot
    : INVENTORY_CRAFTING_GRID_SLOTS[protocolGridSlot] ?? (30 + protocolGridSlot)
}

function craftRequestSlotInfo (containerId, slot, stackId = 0) {
  return {
    slot_type: { container_id: containerId },
    slot,
    stack_id: stackId || 0
  }
}

function craftInventoryRequestSlotInfo (slot, stackId = 0) {
  return slot < 9
    ? craftRequestSlotInfo('hotbar', slot, stackId)
    : craftRequestSlotInfo('inventory', slot - 9, stackId)
}

function craftingGridSlotInfo (craft, gridSlot, stackId = 0) {
  return craftRequestSlotInfo(CONTAINER.craftingInput, craftingGridProtocolSlot(craft, gridSlot), stackId)
}

function makeCraftFromEntry (botState, entry, itemId, count) {
  const result = recipeResult(entry, itemId)
  if (!result?.count) return null

  const times = Math.ceil(count / result.count)
  if (times > 255) return null

  const ingredientPositions = positionedIngredients(entry)
  const ingredients = ingredientPositions.map(position => position.ingredient)
  if (ingredients.length === 0) return null

  const placements = reserveIngredients(botState, ingredientPositions, times)
  if (!placements) return null

  const used = new Map()
  for (const placement of placements) {
    used.set(placement.slot, (used.get(placement.slot) || 0) + placement.count)
  }

  const outSlot = outputSlot(botState, { ...result, count: result.count * times }, used)
  if (outSlot == null) return null

  return {
    entry,
    baseResult: result,
    result: { ...result, count: result.count * times },
    ingredients,
    placements,
    outSlot,
    times,
    used,
  }
}

function findCraftInEntries (botState, entries, itemId, count) {
  for (const entry of entries || []) {
    if (recipeNetworkId(entry) == null) continue
    const craft = makeCraftFromEntry(botState, entry, itemId, count)
    if (craft) return craft
  }

  return null
}

function utilRecipeName (recipe) {
  return recipe?.name || recipe?.recipe_id || ''
}

function entryRecipeId (entry) {
  return recipeBody(entry)?.recipe_id || entry?.recipe_id || ''
}

function entryResultId (entry) {
  const output = recipeOutputs(entry)[0]
  return output?.network_id ?? output?.id
}

function staticItemIdByName (botState, name) {
  if (!name) return undefined
  return botState.craftingItemIdsByName?.[name.replace(/^minecraft:/, '')]
}

function runtimeItemIdByName (botState, name) {
  if (!name) return undefined
  return botState.registry.itemsByName?.[name.replace(/^minecraft:/, '')]?.id
}

function liveItemNameById (botState, id) {
  return botState.registry.items?.[id]?.name ??
    botState.craftingItemNamesById?.[id]
}

function normalizeWantedItem (botState, wantedItem) {
  const name = wantedItem?.name
    ? String(wantedItem.name).replace(/^minecraft:/, '')
    : liveItemNameById(botState, wantedItem?.id)

  return {
    ...wantedItem,
    id: staticItemIdByName(botState, name) ?? wantedItem.id
  }
}

function utilityOutputItemIds (botState, recipe) {
  const resultName = recipe?.result?.name?.replace(/^minecraft:/, '')
  const recipeName = utilRecipeName(recipe).replace(/^minecraft:/, '')
  const ids = [
    runtimeItemIdByName(botState, recipeName),
    runtimeItemIdByName(botState, resultName),
  ].filter(id => id != null)

  return [...new Set(ids)]
}

function resolveCraftStep (botState, step) {
  if (step?.entry) return step

  const recipe = step?._craftingUtilRecipe
  if (!recipe?.result?.id) return null

  const count = (recipe.result.count || 1) * (step.recipeApplications || 1)
  const recipeName = utilRecipeName(recipe)
  const itemIds = utilityOutputItemIds(botState, recipe)

  for (const itemId of itemIds) {
    const candidates = (botState.bedrockCraftingRecipes || [])
      .filter(entry => entryResultId(entry) === itemId)

    const named = recipeName
      ? candidates.filter(entry => entryRecipeId(entry) === recipeName)
      : []

    const craft = findCraftInEntries(botState, named.concat(candidates.filter(entry => !named.includes(entry))), itemId, count)
    if (craft) return craft
  }

  return null
}

function inventoryDebugSummary (botState) {
  return (botState.inventory?.slots || [])
    .map((item, slot) => item && {
      slot,
      name: item.name,
      type: item.type,
      count: item.count,
      stackId: item.stackId ?? item.stack_id
    })
    .filter(Boolean)
}

function inventorySignature (botState) {
  return JSON.stringify(inventoryDebugSummary(botState))
}

function waitForInventoryChange (botState, before, timeoutMs = 12000, quietMs = 3000) {
  return new Promise(resolve => {
    let changed = inventorySignature(botState) !== before
    let quietTimer = null

    const done = (changed) => {
      clearTimeout(timer)
      clearTimeout(quietTimer)
      botState.off('inventory_content_updated', onUpdate)
      botState.off('ui_slot_updated', onUpdate)
      botState.client?.off('inventory_slot', onUpdate)
      resolve(changed)
    }

    const onUpdate = () => {
      if (inventorySignature(botState) === before) return
      changed = true
      clearTimeout(quietTimer)
      quietTimer = setTimeout(() => done(true), quietMs)
    }

    const timer = setTimeout(() => done(false), timeoutMs)
    botState.on('inventory_content_updated', onUpdate)
    botState.on('ui_slot_updated', onUpdate)
    botState.client?.on('inventory_slot', onUpdate)
    if (changed) quietTimer = setTimeout(() => done(true), quietMs)
  })
}

function unresolvedCraftStepError (botState, step) {
  const recipe = step?._craftingUtilRecipe
  const resultName = recipe?.result?.name?.replace?.(/^minecraft:/, '')
  const recipeName = utilRecipeName(recipe)
  const itemIds = recipe ? utilityOutputItemIds(botState, recipe) : []
  const candidates = itemIds.flatMap(itemId => {
    return (botState.bedrockCraftingRecipes || [])
      .filter(entry => entryResultId(entry) === itemId)
      .map(entry => ({
        itemId,
        recipeId: entryRecipeId(entry),
        networkId: recipeNetworkId(entry),
        ingredientCount: flattenIngredients(entry).length
      }))
  })

  return new Error([
    'Could not resolve craft plan step against Bedrock crafting_data',
    `recipe=${recipeName || 'unknown'}`,
    `result=${resultName || 'unknown'}`,
    `candidateIds=${JSON.stringify(itemIds)}`,
    `candidates=${JSON.stringify(candidates)}`,
    `inventory=${JSON.stringify(inventoryDebugSummary(botState))}`
  ].join('\n'))
}

function normalizeCraftingPlanStatus (plan) {
  if (typeof plan?.status === 'string') return plan.status
  if (plan?.success === true) return 'complete'
  if (plan?.success === false) return 'failure'
  return 'unknown'
}

function isCompleteCraftingPlan (plan) {
  return normalizeCraftingPlanStatus(plan) === 'complete'
}

function unsuccessfulPlanError (plan) {
  const status = normalizeCraftingPlanStatus(plan)
  return new Error([
    `Cannot craft a plan with status "${status}"`,
    plan?.error ? `error=${plan.error}` : null,
    plan?.utilityError ? `utilityError=${plan.utilityError}` : null,
    Array.isArray(plan?.itemsRemaining) ? `itemsRemaining=${JSON.stringify(plan.itemsRemaining)}` : null,
    Array.isArray(plan?.itemsRequiredImmediate) ? `itemsRequiredImmediate=${JSON.stringify(plan.itemsRequiredImmediate)}` : null
  ].filter(Boolean).join('\n'))
}

async function openCraftingTable (botState, block) {
  if (!block?.position) throw new Error('Recipe requires a crafting table position')

  if (typeof botState.openBlockContainer !== 'function') {
    throw new Error('containers builtin is required to open a crafting table')
  }

  const emptyHotbarSlot = botState.inventory?.slots
    ?.slice(0, 9)
    .findIndex(item => !item)

  if (emptyHotbarSlot >= 0 && typeof botState.selectHotbarSlot === 'function') {
    botState.selectHotbarSlot(emptyHotbarSlot)
    await sleep(50)
  }

  const openOptions = {
    type: 'workbench',
    blockName: 'crafting_table',
    preserveHeldSlot: true
  }
  if (block.face != null) openOptions.face = block.face
  if (block.clickPosition != null) openOptions.clickPosition = block.clickPosition

  return botState.openBlockContainer(block.position, openOptions)
}

function openPlayerInventoryForCrafting (botState, timeoutMs = 5000) {
  const client = botState.client
  const runtimeId = client?.entityId ?? botState.self?.runtimeId ?? 0n
  const activeWindow = typeof botState.getWindow === 'function'
    ? botState.getWindow(botState.activeWindowId)
    : null

  if (activeWindow?.windowType === 'inventory') return Promise.resolve(activeWindow)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for inventory container_open'))
    }, timeoutMs)

    function onOpen (packet) {
      if (packet.window_type !== 'inventory') return
      cleanup()
      resolve(packet)
    }

    function cleanup () {
      clearTimeout(timeout)
      client.off('container_open', onOpen)
    }

    client.on('container_open', onOpen)
    client.queue('interact', {
      action_id: 'open_inventory',
      target_entity_id: runtimeId,
      has_position: false
    })
  })
}

async function closePlayerInventoryForCrafting (botState, timeoutMs = 1000) {
  const client = botState.client
  const windowId = botState.activeWindowId
  const activeWindow = typeof botState.getWindow === 'function'
    ? botState.getWindow(windowId)
    : null

  if (!activeWindow || activeWindow.windowType !== 'inventory') return

  await new Promise(resolve => {
    const timeout = setTimeout(() => cleanup(), timeoutMs)

    function onClose (packet) {
      if (packet.window_id !== windowId) return
      cleanup()
    }

    function cleanup () {
      clearTimeout(timeout)
      client.off('container_close', onClose)
      resolve()
    }

    client.on('container_close', onClose)
    client.queue('container_close', {
      window_id: windowId,
      window_type: 'inventory',
      server: false
    })
  })

  await sleep(50)
}

function buildCraftActions (botState, craft, firstAction) {
  const actions = [firstAction]

  actions.push({
    type_id: ACTION.resultsDeprecated,
    result_items: [craft.baseResult],
    times_crafted: craft.times,
  })

  for (const placement of craft.placements) {
    actions.push({
      type_id: ACTION.consume,
      count: placement.count,
      source: craftInventoryRequestSlotInfo(placement.slot, placement.stackId),
    })
  }

  const existing = botState.inventory.slots[craft.outSlot]
  const outSlotCountAfterConsume = (existing?.count || 0) - (craft.used.get(craft.outSlot) || 0)
  const outputStackId = existing?.type === craft.result.network_id && outSlotCountAfterConsume > 0
    ? existing.stackId || 0
    : nextCraftStackId(botState)
  const destinationStackId = outSlotCountAfterConsume > 0 ? (existing?.stackId || 0) : 0

  actions.push({
    type_id: ACTION.take,
    count: craft.result.count,
    source: craftRequestSlotInfo(CONTAINER.output, 0, outputStackId),
    destination: craftInventoryRequestSlotInfo(craft.outSlot, destinationStackId),
  })

  actions._craftEntry = craft.entry
  return actions
}

function buildAutoActions (botState, craft) {
  return buildCraftActions(botState, craft, {
    type_id: ACTION.craftRecipeAuto,
    recipe_network_id: recipeNetworkId(craft.entry),
    times_crafted_2: craft.times,
    times_crafted: craft.times,
    ingredients: craft.ingredients,
  })
}

function buildNormalActions (botState, craft) {
  return buildNormalResultActions(botState, craft)
}

function buildActions (botState, craft, mode = 'auto') {
  switch (mode) {
    case 'auto':
      return buildAutoActions(botState, craft)
    case 'normal':
      return buildNormalActions(botState, craft)
    default:
      throw new Error(`Unknown crafting mode: ${mode}`)
  }
}

function buildGridTakeActions (botState, placement) {
  const item = botState.inventory.slots[placement.slot]
  if (!item || item.count < placement.count) {
    throw new Error(`Cannot normal craft: source slot ${placement.slot} no longer has ${placement.count} item(s)`)
  }

  return [{
    type_id: ACTION.take,
    count: placement.count,
    source: craftInventoryRequestSlotInfo(placement.slot, itemStackId(item)),
    destination: craftRequestSlotInfo(CONTAINER.cursor, 0, 0),
  }]
}

function buildGridPlaceActions (craft, placement, cursorStackId, gridStackId = 0) {
  return [{
    type_id: ACTION.place,
    count: placement.count,
    source: craftRequestSlotInfo(CONTAINER.cursor, 0, cursorStackId),
    destination: craftingGridSlotInfo(craft, placement.gridSlot, gridStackId),
  }]
}

function buildNormalResultActions (botState, craft, gridStackIds = new Map()) {
  const actions = [{
    type_id: ACTION.craftRecipe,
    recipe_network_id: recipeNetworkId(craft.entry),
    times_crafted: craft.times,
  }, {
    type_id: ACTION.resultsDeprecated,
    result_items: [craft.baseResult],
    times_crafted: craft.times,
  }]

  const consumedGridSlots = new Map()
  for (const placement of craft.placements) {
    const key = placement.gridSlot
    consumedGridSlots.set(key, (consumedGridSlots.get(key) || 0) + placement.count)
  }

  for (const [gridSlot, count] of consumedGridSlots) {
    actions.push({
      type_id: ACTION.consume,
      count,
      source: craftingGridSlotInfo(craft, gridSlot, gridStackIds.get(gridSlot) || 0),
    })
  }

  const existing = botState.inventory.slots[craft.outSlot]
  const outputStackId = existing?.type === craft.result.network_id && existing.count > 0
    ? itemStackId(existing)
    : nextCraftStackId(botState)
  const destinationStackId = existing?.type === craft.result.network_id && existing.count > 0
    ? itemStackId(existing)
    : 0

  actions.push({
    type_id: ACTION.place,
    count: craft.result.count,
    source: craftRequestSlotInfo(CONTAINER.output, 50, outputStackId),
    destination: craftRequestSlotInfo('hotbar_and_inventory', craft.outSlot, destinationStackId),
  })

  actions._craftEntry = craft.entry
  return actions
}

function actionDebugSummary (actions) {
  return actions.map(action => {
    const summary = { type_id: action.type_id }
    if (action.recipe_network_id != null) summary.recipe_network_id = action.recipe_network_id
    if (action.times_crafted != null) summary.times_crafted = action.times_crafted
    if (action.times_crafted_2 != null) summary.times_crafted_2 = action.times_crafted_2
    if (action.count != null) summary.count = action.count
    if (action.source) summary.source = action.source
    if (action.destination) summary.destination = action.destination
    if (action.result_items) summary.result_items = action.result_items
    return summary
  })
}

function inventorySlotForCraftDestination (slotInfo) {
  const containerId = slotInfo?.slot_type?.container_id
  if (containerId === 'hotbar_and_inventory' || containerId === 'hotbar') return slotInfo.slot
  if (containerId === 'inventory') return slotInfo.slot + 9
  return null
}

function itemFromCraftResult (botState, rawItem, serverSlot) {
  if (!rawItem || !serverSlot || serverSlot.count === 0) return null

  const stackId = serverSlot.item_stack_id ?? rawItem.stack_id ?? rawItem.stackId ?? 0
  const raw = {
    ...rawItem,
    count: serverSlot.count,
    stack_id: stackId,
  }
  const item = botState.itemClass.fromNotch(raw, stackId)
  item.stackId = stackId
  item.stack_id = stackId
  item.networkId = raw.network_id
  item.network_id = raw.network_id
  item.blockRuntimeId = raw.block_runtime_id
  item.block_runtime_id = raw.block_runtime_id
  item.raw = raw
  return item
}

function applyCraftResultResponseToInventory (botState, actions, response) {
  const resultAction = actions.find(action => action.type_id === ACTION.resultsDeprecated)
  const resultItem = resultAction?.result_items?.[0]
  if (!resultItem) return

  for (const action of actions) {
    const source = action.source
    if (
      action.type_id !== ACTION.place ||
      source?.slot_type?.container_id !== CONTAINER.output ||
      source.slot !== 50
    ) continue

    const inventorySlot = inventorySlotForCraftDestination(action.destination)
    if (inventorySlot == null) continue

    const containerId = action.destination.slot_type?.container_id
    const serverSlot = responseSlot(response, containerId, action.destination.slot)
    if (!serverSlot) continue

    const item = itemFromCraftResult(botState, resultItem, serverSlot)
    botState.inventory.updateSlot(inventorySlot, item)
  }
}

function sendRequest (botState, actions, options = {}) {
  const requestId = nextRequestId(botState)
  const requestActions = actions.map(action => {
    const source = action.source
    if (
      source?.slot_type?.container_id === CONTAINER.output &&
      (action.type_id === ACTION.place || action.type_id === ACTION.take)
    ) {
      return {
        ...action,
        source: {
          ...source,
          stack_id: requestId
        }
      }
    }

    return action
  })
  const request = { request_id: requestId, actions: requestActions, custom_names: [], cause: -1 }

  logAction('[craft]', 'item_stack_request', {
    requestId,
    actions: requestActions.map(action => action.type_id),
    actionDetails: actionDebugSummary(requestActions),
  })
  botState.emit('craft_item_stack_request', request)

  return new Promise((resolve, reject) => {
    const done = (err, value) => {
      clearTimeout(timer)
      botState.client.removeListener('item_stack_response', onResponse)
      err ? reject(err) : resolve(value)
    }

    const timer = setTimeout(() => done(new Error(`Craft request ${requestId} timed out`)), 5000)
    const onResponse = packet => {
      const response = packet?.responses?.find(resp => resp.request_id === requestId)
      if (!response) return
      if (response.status !== 0 && response.status !== 'ok') {
        done(new Error([
          `Craft rejected: status=${response.status}`,
          `response=${JSON.stringify(response)}`,
          `actions=${JSON.stringify(actionDebugSummary(requestActions))}`,
          `inventory=${JSON.stringify(inventoryDebugSummary(botState))}`
        ].join('\n')))
        return
      }
      applyCraftResultResponseToInventory(botState, requestActions, response)
      done(null, response)
    }

    botState.client.on('item_stack_response', onResponse)

    if (options.standalone) {
      botState.client.queue('item_stack_request', { requests: [request] })
      return
    }

    botState.queuePlayerAuthInputEdit(packet => {
      botState.setAuthInputFlag(packet, 'item_stack_request')
      packet.item_stack_request = request
    })
    botState.flushPlayerAuthInput?.()
  })
}

function inventorySummary (botState) {
  return botState.inventory.slots
    .filter(item => item != null && item.count > 0)
    .map(item => ({
      id: staticItemIdByName(botState, item.name) ?? item.type,
      count: item.count
    }))
}

function simplifyUtilityStep (step) {
  const recipe = step.recipe
  return {
    _craftingUtilRecipe: {
      name: recipe.name,
      result: recipe.result,
      delta: recipe.delta,
      requiresTable: recipe.requiresTable,
    },
    recipeApplications: step.recipeApplications,
  }
}

async function craftingUtilPlanner (botState) {
  if (!botState._craftingUtilPlannerPromise) {
    botState._craftingUtilPlannerPromise = buildStatic(botState.craftingRecipe)
  }
  return botState._craftingUtilPlannerPromise
}

async function planWithCraftingUtil (botState, wantedItem) {
  try {
    const planner = await craftingUtilPlanner(botState)
    return planner(normalizeWantedItem(botState, wantedItem), {
      availableItems: inventorySummary(botState),
      careAboutExisting: false,
      includeRecursion: true,
      multipleRecipes: true,
    })
  } catch (err) {
    return { status: 'failure', error: err.message }
  }
}

async function injectCrafting (botState, options = {}) {
  const craftingRegistry = options.craftingRecipeRegistry ??
    options.craftingRegistry ??
    registryLoader(`bedrock_${options.version ?? botState.options?.version}`)
  const craftingRecipe = options.craftingRecipe ?? recipeLoader(craftingRegistry).Recipe

  botState.craftingRecipeRegistry = craftingRegistry
  botState.craftingRecipe = craftingRecipe
  botState.craftingItemIdsByName = Object.fromEntries(
    Object.entries(craftingRegistry.itemsByName || {}).map(([name, item]) => [name, item.id])
  )
  botState.craftingItemNamesById = Object.fromEntries(
    Object.entries(craftingRegistry.items || {}).map(([id, item]) => [Number(id), item.name])
  )

  botState.planCraftInventory = async (wantedItem) => {
    const utilPlan = await planWithCraftingUtil(botState, wantedItem)
    const status = normalizeCraftingPlanStatus(utilPlan)
    if (status === 'complete' && Array.isArray(utilPlan.recipesToDo)) {
      return {
        ...utilPlan,
        status,
        source: 'mineflayer-crafting-util',
        recipesToDo: utilPlan.recipesToDo.map(simplifyUtilityStep),
      }
    }

    return {
      ...utilPlan,
      status,
      source: 'mineflayer-crafting-util',
      utilityError: utilPlan.error,
    }
  }

  botState.planCraftInventoryWithUtil = botState.planCraftInventory
  botState.planCraft = botState.planCraftInventory

  async function craftPlanWithMode (plan, craftingTableBlock, mode) {
    if (!isCompleteCraftingPlan(plan)) throw unsuccessfulPlanError(plan)

    let openedCraftingContainer = null
    let openedPlayerInventory = false
    const preferCraftingTable = mode === 'normal' && !!craftingTableBlock?.position

    try {
      for (const step of plan.recipesToDo) {
        const applications = mode === 'normal' ? Math.max(1, step.recipeApplications || 1) : 1

        for (let application = 0; application < applications; application++) {
          const stepToResolve = applications > 1 ? { ...step, recipeApplications: 1 } : step
          const craft = resolveCraftStep(botState, stepToResolve)
          if (!craft) throw unresolvedCraftStepError(botState, stepToResolve)
          const requiresCraftingTable = isTableRecipe(craft.entry)
          const useStandaloneRequest = options.craftingStandaloneRequests !== false
          if ((requiresCraftingTable || preferCraftingTable) && !openedCraftingContainer) {
            await closePlayerInventoryForCrafting(botState)
            openedPlayerInventory = false
            openedCraftingContainer = await openCraftingTable(botState, craftingTableBlock)
          }
          craft.usingCraftingTable = !!openedCraftingContainer

          if (!craft.usingCraftingTable && !openedPlayerInventory) {
            await openPlayerInventoryForCrafting(botState)
            openedPlayerInventory = true
          }

          if (mode === 'normal') {
            await executeNormalCraft(craft, useStandaloneRequest)
          } else {
            await executeAutoCraft(craft, useStandaloneRequest)
          }
        }
      }
    } finally {
      openedCraftingContainer?.close?.()
    }

    return plan
  }

  async function executeNormalCraft (craft, useStandaloneRequest) {
    const gridStackIds = new Map()

    for (const placement of craft.placements) {
      const takeResponse = await sendRequest(
        botState,
        buildGridTakeActions(botState, placement),
        { standalone: useStandaloneRequest }
      )
      const cursorStackId = responseStackId(takeResponse, CONTAINER.cursor, 0)
      if (!cursorStackId) {
        throw new Error(`Normal craft did not receive a cursor stack id after taking from slot ${placement.slot}`)
      }

      await sleep(50)

      const gridProtocolSlot = craftingGridProtocolSlot(craft, placement.gridSlot)
      const placeResponse = await sendRequest(
        botState,
        buildGridPlaceActions(craft, placement, cursorStackId, gridStackIds.get(placement.gridSlot) || 0),
        { standalone: useStandaloneRequest }
      )
      const gridStackId = responseStackId(
        placeResponse,
        CONTAINER.craftingInput,
        gridProtocolSlot,
        gridStackIds.get(placement.gridSlot) || cursorStackId
      )
      gridStackIds.set(placement.gridSlot, gridStackId)

      await sleep(50)
    }

    const beforeInventory = inventorySignature(botState)
    await sendRequest(botState, buildNormalResultActions(botState, craft, gridStackIds), { standalone: useStandaloneRequest })
    await waitForInventoryChange(botState, beforeInventory)
  }

  async function executeAutoCraft (craft, useStandaloneRequest) {
    const beforeInventory = inventorySignature(botState)
    await sendRequest(botState, buildAutoActions(botState, craft), { standalone: useStandaloneRequest })
    await waitForInventoryChange(botState, beforeInventory)
  }

  botState.craftPlanRecipeBookAuto = (plan, craftingTableBlock) => craftPlanWithMode(plan, craftingTableBlock, 'auto')
  botState.craftPlanAuto = (plan, craftingTableBlock) => {
    const mode = options.craftingRecipeBookAuto === true ? 'auto' : 'normal'
    return craftPlanWithMode(plan, craftingTableBlock, mode)
  }
  botState.craftPlanNormal = (plan, craftingTableBlock) => craftPlanWithMode(plan, craftingTableBlock, 'normal')
  botState.craftPlan = botState.craftPlanNormal

  botState.craftItemAuto = async (itemId, count, craftingTableBlock) => {
    const plan = await botState.planCraftInventory({ id: itemId, count })
    await botState.craftPlanAuto(plan, craftingTableBlock)
    return plan
  }

  botState.craftItemRecipeBookAuto = async (itemId, count, craftingTableBlock) => {
    const plan = await botState.planCraftInventory({ id: itemId, count })
    await botState.craftPlanRecipeBookAuto(plan, craftingTableBlock)
    return plan
  }

  botState.craftItemNormal = async (itemId, count, craftingTableBlock) => {
    const plan = await botState.planCraftInventory({ id: itemId, count })
    await botState.craftPlanNormal(plan, craftingTableBlock)
    return plan
  }

  botState.craftItem = botState.craftItemNormal
  botState.craftAuto = botState.craftItemAuto
  botState.craftRecipeBookAuto = botState.craftItemRecipeBookAuto
  botState.craftNormal = botState.craftItemNormal

  logAction('[craft]', 'crafting plugin loaded')
}

module.exports = injectCrafting
module.exports._craftingHelpers = {
  ingredientMatchesItem,
  ingredientMetadataMatchesItem,
  buildAutoActions,
  buildNormalActions,
  buildGridTakeActions,
  buildGridPlaceActions,
  buildNormalResultActions,
  buildActions,
  craftRequestSlotInfo,
  craftInventoryRequestSlotInfo,
  normalizeCraftingPlanStatus,
  isCompleteCraftingPlan,
}
