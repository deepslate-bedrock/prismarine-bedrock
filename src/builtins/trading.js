// src/builtins/trading.js
'use strict'

/**
 * Dedicated Geyser-compatible villager trading helper.
 *
 * Geyser merchant flow:
 * - Java merchant open is surfaced to Bedrock as update_trade, not necessarily
 *   a normal container_open.
 * - Merchant visible slots may sync through ContainerId.UI / 124.
 * - Trade execution must send one complete item_stack_request:
 *     1. craft_recipe_auto / craft_recipe first
 *     2. move ingredient(s) into TRADE2_INGREDIENT slots
 *     3. take generated output from CREATED_OUTPUT
 * - Geyser can intentionally return item_stack_response status "error" while
 *   scheduling delayed merchant replay/updateInventory. We therefore use
 *   waitForRawItemStackResponse() and wait briefly after a rejected response.
 *
 * Relevant Geyser file:
 * https://github.com/GeyserMC/Geyser/blob/master/core/src/main/java/org/geysermc/geyser/translator/inventory/MerchantInventoryTranslator.java
 */

const {
  entityIds,
  entityRuntimeId,
  itemCount,
  itemId,
  itemStackId,
  logAction,
  maxStackSize,
  nbtValue,
  normalizeItemId,
  playerInventorySlotInfo,
  requestSlotInfo,
  sameRuntimeId,
  sleep,
  itemStackResponseStatusOk
} = require('../utils')
const { normalizeWindowId, containerSlotInfoFor } = require('../container-metadata')

module.exports = function tradingPlugin (botState, options = {}) {
  const client = botState.client

  let tradeTimeoutMs = options.tradeTimeoutMs ?? 10000
  let lastTradeWindow = null

  function inventoryActions () {
    const actions = botState.inventory?.actions ?? botState.inventoryActionHelpers
    if (!actions) throw new Error('inventory-actions builtin is required before using trading helpers')
    return actions
  }

  function packetEntityIds (packet) {
    return [
      packet.trader_runtime_entity_id,
      packet.traderRuntimeEntityId,
      packet.villager_runtime_entity_id,
      packet.villagerRuntimeEntityId,
      packet.trader_unique_entity_id,
      packet.traderUniqueEntityId,
      packet.villager_unique_entity_id,
      packet.villagerUniqueEntityId,
      packet.villager_unique_id,
      packet.villagerUniqueId,
      packet.entity_unique_id,
      packet.entityUniqueId
    ].filter(v => v != null)
  }

  function packetMatchesEntity (packet, entity) {
    const packetIds = packetEntityIds(packet)
    const targetIds = entityIds(entity)

    if (packetIds.length === 0 || targetIds.length === 0) return true

    return packetIds.some(packetId => {
      return targetIds.some(targetId => {
        return sameRuntimeId(packetId, targetId) || String(packetId) === String(targetId)
      })
    })
  }

  function waitForPacket (packetName, timeoutMs, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for ${packetName}`))
      }, timeoutMs)

      function onPacket (packet) {
        if (!predicate(packet)) return
        cleanup()
        resolve(packet)
      }

      function cleanup () {
        clearTimeout(timeout)
        client.off(packetName, onPacket)
      }

      client.on(packetName, onPacket)
    })
  }

  function setCurrentTradeWindow (packet, entity = botState.currentTradingEntity) {
    lastTradeWindow = packet
    botState.currentTradeWindow = packet
    if (entity) botState.currentTradingEntity = entity
    botState.emit('trade_window_update', packet, entity)
  }

  function clearCurrentTradeWindow (packet = null) {
    lastTradeWindow = null
    botState.currentTradeWindow = null
    botState.currentTradingEntity = null
    botState.emit('trade_window_close', packet)
  }

  function waitForTradeWindow (opts = {}) {
    const timeoutMs = opts.timeoutMs ?? tradeTimeoutMs
    const target = opts.entity
    const strict = opts.strictEntityMatch === true

    return waitForPacket('update_trade', timeoutMs, packet => {
      return !target || !strict || packetMatchesEntity(packet, target)
    })
  }

  async function openTrade (entity, opts = {}) {
    const runtimeId = entityRuntimeId(entity)
    if (runtimeId == null) throw new Error('Cannot open trade: target entity has no runtimeId')

    const tradeWindowPromise = waitForTradeWindow({
      entity,
      timeoutMs: opts.timeoutMs ?? tradeTimeoutMs,
      strictEntityMatch: opts.strictEntityMatch
    })

    await botState.interactEntity(entity, {
      ...opts,
      mouseOver: opts.mouseOver ?? true,
      mouseOverDelayMs: opts.mouseOverDelayMs ?? 50
    })

    const packet = await tradeWindowPromise
    setCurrentTradeWindow(packet, entity)

    logAction('[trading]', 'update_trade received', {
      target: String(runtimeId),
      window_id: packet.window_id,
      window_type: packet.window_type,
      display_name: packet.display_name,
      trade_tier: packet.trade_tier,
      new_trading_ui: packet.new_trading_ui,
      economic_trades: packet.economic_trades
    })

    botState.emit('trade_window_open', packet, entity)
    return packet
  }

  function closeTradeWindow () {
    const packet = botState.currentTradeWindow ?? lastTradeWindow
    const windowId = packet?.window_id

    if (windowId != null) {
      client.queue('container_close', {
        window_id: windowId,
        server: false
      })

      logAction('[trading]', 'container_close trade', { window_id: windowId })
    }

    clearCurrentTradeWindow()
  }

  function recipeInputA (recipe) {
    recipe = nbtValue(recipe)
    return recipe?.buy ?? recipe?.buyA ?? recipe?.input ?? recipe?.inputA ?? recipe?.input_1
  }

  function recipeInputB (recipe) {
    recipe = nbtValue(recipe)
    return recipe?.buyB ?? recipe?.inputB ?? recipe?.input_2 ?? null
  }

  function recipeOutput (recipe) {
    recipe = nbtValue(recipe)
    return recipe?.sell ?? recipe?.output ?? recipe?.result
  }

  function recipeNetId (recipe) {
    recipe = nbtValue(recipe)

    const value =
      recipe?.netId ??
      recipe?.net_id ??
      recipe?.networkId ??
      recipe?.network_id ??
      recipe?.recipeNetId ??
      recipe?.recipe_net_id ??
      recipe?.recipeNetworkId ??
      recipe?.recipe_network_id

    if (value == null) return null

    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }

  function isRecipeLike (recipe) {
    const inputA = recipeInputA(recipe)
    const output = recipeOutput(recipe)
    return !!inputA && !!output && !!itemId(inputA) && !!itemId(output)
  }

  function recipesFromPacket (packet) {
    const normalized = nbtValue(packet)

    const candidates = [
      normalized?.offers?.Recipes,
      normalized?.offers?.recipes,
      normalized?.trades?.Recipes,
      normalized?.trades?.recipes,
      normalized?.serialized_offers?.Recipes,
      normalized?.serialized_offers?.recipes,
      normalized?.serializedOffers?.Recipes,
      normalized?.serializedOffers?.recipes,
      normalized?.Recipes,
      normalized?.recipes,
      normalized?.offers,
      normalized?.trades,
      normalized?.trade_offers,
      normalized?.tradeOffers
    ]

    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue
      const recipes = candidate.map(nbtValue).filter(isRecipeLike)
      if (recipes.length > 0) return recipes
    }

    return []
  }

  function currentTradeRecipes () {
    const packet = botState.currentTradeWindow ?? lastTradeWindow
    return packet ? recipesFromPacket(packet) : []
  }

  function currentTradeContainer () {
    const windowId = botState.currentTradeWindow?.window_id ?? lastTradeWindow?.window_id
    if (windowId == null) return null
    return botState.containers?.get?.(windowId) ?? botState.getContainer?.(windowId) ?? null
  }

  function summarizeRecipe (recipe, index = null) {
    const inputA = recipeInputA(recipe)
    const inputB = recipeInputB(recipe)
    const output = recipeOutput(recipe)

    return {
      index,
      netId: recipeNetId(recipe),
      inputA: inputA ? { id: itemId(inputA), count: itemCount(inputA) } : null,
      inputB: inputB ? { id: itemId(inputB), count: itemCount(inputB) } : null,
      output: output ? { id: itemId(output), count: itemCount(output) } : null,
      rawKeys: Object.keys(nbtValue(recipe) || {})
    }
  }

  function summarizeRecipes (recipes) {
    return recipes.map((recipe, index) => summarizeRecipe(recipe, index))
  }

  function expectedTradeFields (expected) {
    return {
      inputId: expected.inputId ?? expected.buyId ?? expected.buyAId,
      inputCount: expected.inputCount ?? expected.buyCount ?? expected.buyACount,
      inputBId: expected.inputBId ?? expected.buyBId,
      inputBCount: expected.inputBCount ?? expected.buyBCount,
      outputId: expected.outputId ?? expected.sellId ?? expected.resultId,
      outputCount: expected.outputCount ?? expected.sellCount ?? expected.resultCount
    }
  }

  function recipeMatchesExpected (recipe, expected) {
    expected = expectedTradeFields(expected)

    const inputA = recipeInputA(recipe)
    const inputB = recipeInputB(recipe)
    const output = recipeOutput(recipe)

    if (expected.inputId != null && itemId(inputA) !== normalizeItemId(expected.inputId)) return false
    if (expected.inputCount != null && itemCount(inputA) !== Number(expected.inputCount)) return false
    if (expected.inputBId != null && itemId(inputB) !== normalizeItemId(expected.inputBId)) return false
    if (expected.inputBCount != null && itemCount(inputB) !== Number(expected.inputBCount)) return false
    if (expected.outputId != null && itemId(output) !== normalizeItemId(expected.outputId)) return false
    if (expected.outputCount != null && itemCount(output) !== Number(expected.outputCount)) return false

    return true
  }

  function findTrade (filterOrExpected, opts = {}) {
    const recipes = opts.recipes ?? currentTradeRecipes()

    if (typeof filterOrExpected === 'function') {
      return recipes.find((recipe, index) => filterOrExpected(recipe, index)) ?? null
    }

    if (Number.isInteger(filterOrExpected)) {
      return recipes[filterOrExpected] ?? null
    }

    if (filterOrExpected && typeof filterOrExpected === 'object') {
      return recipes.find(recipe => recipeMatchesExpected(recipe, filterOrExpected)) ?? null
    }

    return null
  }

  function tradeSlotInfo (logicalSlot, stackId = 0) {
    const info = containerSlotInfoFor({ type: 'trading' }, logicalSlot)
    if (!info) throw new RangeError(`Unsupported trading slot: ${logicalSlot}`)
    return requestSlotInfo(info.containerId, info.protocolSlot, stackId)
  }

  function tradeIngredientSlotInfo (index, opts = {}) {
    if (index === 0 && opts.ingredientAContainerId) {
      return requestSlotInfo(
        opts.ingredientAContainerId,
        opts.ingredientASlot ?? 4,
        opts.ingredientAStackId ?? 0,
        opts.ingredientADynamicContainerId ?? 0
      )
    }

    if (index === 1 && opts.ingredientBContainerId) {
      return requestSlotInfo(
        opts.ingredientBContainerId,
        opts.ingredientBSlot ?? 5,
        opts.ingredientBStackId ?? 0,
        opts.ingredientBDynamicContainerId ?? 0
      )
    }

    return tradeSlotInfo(index, index === 0 ? opts.ingredientAStackId : opts.ingredientBStackId)
  }

  function tradeResultSlotInfo (recipe, opts = {}) {
    if (opts.resultContainerId) {
      return requestSlotInfo(
        opts.resultContainerId,
        opts.resultSlot ?? 50,
        opts.resultStackId ?? itemStackId(recipeOutput(recipe)),
        opts.resultDynamicContainerId ?? 0
      )
    }

    return requestSlotInfo(
      'created_output',
      50,
      opts.resultStackId ?? 0
    )
  }

  function findInventorySlotForItem (expectedItem, requiredCount, preferredSlots = []) {
    const expectedId = itemId(expectedItem)
    if (!expectedId) return -1

    const shortName = expectedId.startsWith('minecraft:')
      ? expectedId.slice('minecraft:'.length)
      : expectedId

    const slots = botState.inventory?.slots ?? []

    for (const slot of preferredSlots) {
      const item = slots[slot]
      if (item?.name === shortName && item.count >= requiredCount) return slot
    }

    for (let slot = 0; slot < slots.length; slot++) {
      const item = slots[slot]
      if (item?.name === shortName && item.count >= requiredCount) return slot
    }

    return -1
  }

  function resolveIngredientSourceSlot (input, requiredCount, ingredientIndex, opts = {}) {
    const explicit = ingredientIndex === 0
      ? opts.inputASlot ?? opts.sourceSlotA ?? opts.sourceSlot
      : opts.inputBSlot ?? opts.sourceSlotB

    if (Number.isInteger(explicit)) return explicit

    const preferredSlots = ingredientIndex === 0
      ? [opts.preferredInputASlot, opts.preferredSourceSlot, 0].filter(Number.isInteger)
      : [opts.preferredInputBSlot].filter(Number.isInteger)

    const slot = findInventorySlotForItem(input, requiredCount, preferredSlots)
    if (slot !== -1) return slot

    throw new Error([
      `Cannot execute trade: missing ingredient ${ingredientIndex + 1}.`,
      `Needed ${requiredCount} of ${itemId(input)}.`,
      'Inventory:',
      JSON.stringify(
        (botState.inventory?.slots ?? [])
          .map((item, slot) => item && {
            slot,
            name: item.name,
            count: item.count,
            stackId: item.stackId ?? item.stack_id
          })
          .filter(Boolean)
      )
    ].join('\n'))
  }

  function destinationSlotForOutput (output, opts = {}) {
    if (Number.isInteger(opts.destinationSlot)) return opts.destinationSlot

    const slots = botState.inventory?.slots ?? []
    const expectedId = itemId(output)
    const expectedCount = itemCount(output)
    const shortName = expectedId?.startsWith('minecraft:')
      ? expectedId.slice('minecraft:'.length)
      : expectedId

    if (shortName && expectedCount > 0) {
      for (let slot = 0; slot < slots.length; slot++) {
        const item = slots[slot]
        const max = maxStackSize(item)
        if (item?.name === shortName && item.count + expectedCount <= max) return slot
      }
    }

    for (let slot = 0; slot < slots.length; slot++) {
      if (!slots[slot]) return slot
    }

    throw new Error('Cannot execute trade: no inventory slot available for trade output')
  }

  function takeAction (count, source, destination) {
    return { type_id: 'take', count, source, destination }
  }

  function tradeSelectionAction (recipe, count = 1, opts = {}) {
    const netId = opts.recipeNetId ?? recipeNetId(recipe)
    if (netId == null) {
      throw new Error(`Cannot execute trade: recipe is missing netId. ${JSON.stringify(summarizeRecipe(recipe))}`)
    }

    const type = opts.selectionActionType ?? opts.tradeSelectionActionType ?? 'craft_recipe_auto'

    if (type === 'craft_recipe_auto') {
      return {
        type_id: 'craft_recipe_auto',
        recipe_network_id: netId,
        times_crafted: opts.timesCrafted ?? count,
        ingredients: opts.ingredients ?? []
      }
    }

    if (type === 'craft_recipe') {
      return {
        type_id: 'craft_recipe',
        recipe_network_id: netId,
        ingredients: opts.ingredients ?? []
      }
    }

    throw new Error(`Unsupported villager trade selection action: ${type}`)
  }

  function ingredientActions (recipe, count = 1, opts = {}) {
    const actions = []

    for (const [index, input] of [recipeInputA(recipe), recipeInputB(recipe)].entries()) {
      const requiredCount = itemCount(input) * count
      if (!input || !itemId(input) || requiredCount <= 0) continue

      const sourceSlot = resolveIngredientSourceSlot(input, requiredCount, index, opts)
      const sourceItem = botState.inventory?.slots?.[sourceSlot]
      const source = playerInventorySlotInfo(sourceSlot, sourceItem)
      const sourceStackId = index === 0 ? opts.ingredientASourceStackId : opts.ingredientBSourceStackId
      if (sourceStackId != null) source.stack_id = sourceStackId

      actions.push(takeAction(
        requiredCount,
        source,
        tradeIngredientSlotInfo(index, opts)
      ))
    }

    return actions
  }

  function ingredientSourceSlots (recipe, count = 1, opts = {}) {
    const slots = []

    for (const [index, input] of [recipeInputA(recipe), recipeInputB(recipe)].entries()) {
      const requiredCount = itemCount(input) * count
      if (!input || !itemId(input) || requiredCount <= 0) continue
      slots[index] = resolveIngredientSourceSlot(input, requiredCount, index, opts)
    }

    return slots
  }

  function takeTradeResultAction (recipe, count, destinationSlot, opts = {}) {
    const output = recipeOutput(recipe)
    const outputCount = itemCount(output)

    if (outputCount <= 0) {
      throw new Error(`Cannot execute trade: recipe output has no positive count. ${JSON.stringify(summarizeRecipe(recipe))}`)
    }

    const destinationItem = botState.inventory?.slots?.[destinationSlot] ?? null

    return takeAction(
      opts.takeCount ?? outputCount * count,
      tradeResultSlotInfo(recipe, opts),
      playerInventorySlotInfo(destinationSlot, destinationItem)
    )
  }

  function buildTradeRequest (recipe, count = 1, opts = {}) {
    const output = recipeOutput(recipe)
    const destinationSlot = destinationSlotForOutput(output, opts)

    const actions = [
      // Must be first. Geyser dispatches merchant handling from request.actions[0].
      tradeSelectionAction(recipe, count, opts),

      // Geyser's delayed merchant handling replays this same original request.
      ...ingredientActions(recipe, count, opts),
      takeTradeResultAction(recipe, count, destinationSlot, opts)
    ]

    return {
      request: inventoryActions().makeRequest(actions),
      destinationSlot,
      actions
    }
  }

  function buildTradeTransferRequest (recipe, count = 1, destinationSlot, opts = {}) {
    const resultOpts = opts.transferResultStackId == null
      ? opts
      : { ...opts, resultStackId: opts.transferResultStackId }

    const actions = [
      ...ingredientActions(recipe, count, opts),
      takeTradeResultAction(recipe, count, destinationSlot, resultOpts)
    ]

    return {
      request: inventoryActions().makeRequest(actions),
      destinationSlot,
      actions
    }
  }

  function buildTradeIngredientTransferRequest (recipe, count = 1, opts = {}) {
    const actions = ingredientActions(recipe, count, opts)

    return {
      request: inventoryActions().makeRequest(actions),
      actions
    }
  }

  function buildTradeResultTakeRequest (recipe, count = 1, destinationSlot, opts = {}) {
    const actions = [
      takeTradeResultAction(recipe, count, destinationSlot, opts)
    ]

    return {
      request: inventoryActions().makeRequest(actions),
      destinationSlot,
      actions
    }
  }

  function buildTradeSelectionRequest (recipe, count = 1, opts = {}) {
    const actions = [
      tradeSelectionAction(recipe, count, opts)
    ]

    return {
      request: inventoryActions().makeRequest(actions),
      actions
    }
  }

  function tradeOutputItem () {
    const tradeContainer = currentTradeContainer()
    const containerOutput = tradeContainer?.getItem(2)
    if (containerOutput) return containerOutput

    const uiOutput = botState.getUiSlot(50)
    if (uiOutput) return uiOutput

    const windowId = botState.currentTradeWindow?.window_id
    const win = botState.getWindow(windowId)
    return win?.slots?.[2] ?? null
  }

  function itemMatchesRecipeOutput (item, recipe) {
    const output = recipeOutput(recipe)
    const expectedId = itemId(output)
    const expectedCount = itemCount(output)

    if (!item || !expectedId) return false
    if (itemId(item) !== expectedId) return false
    return expectedCount <= 0 || itemCount(item) === expectedCount
  }

  async function waitForTradeOutput (recipe, timeoutMs = 3000) {
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      const output = tradeOutputItem()
      if (itemMatchesRecipeOutput(output, recipe)) return output
      await sleep(25)
    }

    return null
  }

  async function sendRawTradeRequest (request, timeoutMs) {
    const actions = inventoryActions()
    const responsePromise = actions.waitRaw(request.request_id, timeoutMs)
    actions.sendStandalone ? actions.sendStandalone(request) : actions.send(request)

    return responsePromise
  }

  async function containerTransferIngredients (tradeContainer, recipe, count, sourceSlots) {
    const inputs = [recipeInputA(recipe), recipeInputB(recipe)]
    const responses = []

    for (const [index, input] of inputs.entries()) {
      const requiredCount = itemCount(input) * count
      if (!input || !itemId(input) || requiredCount <= 0) continue

      const sourceSlot = sourceSlots[index]
      const response = index === 0
        ? await tradeContainer.putIngredient1(sourceSlot, requiredCount)
        : await tradeContainer.putIngredient2(sourceSlot, requiredCount)

      responses.push(response)
    }

    return responses
  }

  async function restoreExcessTradeInputs (recipe, count, sourceSlots, opts = {}) {
    const actions = []

    for (const [index, input] of [recipeInputA(recipe), recipeInputB(recipe)].entries()) {
      if (!input || !itemId(input)) continue

      const uiSlot = index === 0 ? 4 : 5
      const containerId = index === 0 ? 'trade2_ingredient1' : 'trade2_ingredient2'
      const sourceSlot = sourceSlots[index]
      const tradeItem = botState.getUiSlot(uiSlot)
      const countToRestore = itemCount(tradeItem)

      if (!Number.isInteger(sourceSlot) || countToRestore <= 0) continue
      if (itemId(tradeItem) !== itemId(input)) continue

      actions.push(takeAction(
        countToRestore,
        requestSlotInfo(containerId, uiSlot, itemStackId(tradeItem) || 1),
        playerInventorySlotInfo(sourceSlot, botState.inventory?.slots?.[sourceSlot] ?? null)
      ))
    }

    if (actions.length === 0) return null

    const request = inventoryActions().makeRequest(actions)

    logAction('[trading]', 'execute_trade restore inputs request full', {
      request_id: request.request_id,
      actions: request.actions
    })

    const response = await sendRawTradeRequest(
      request,
      opts.restoreTimeoutMs ?? opts.transferTimeoutMs ?? opts.timeoutMs ?? opts.responseTimeoutMs ?? tradeTimeoutMs
    )

    logAction('[trading]', 'execute_trade restore inputs response', {
      request_id: request.request_id,
      status: response.status,
      containers: Array.isArray(response.containers) ? response.containers.length : undefined
    })

    return { request, response }
  }

  function resolveTradeArgument (tradeOrIndex) {
    const recipes = currentTradeRecipes()

    if (Number.isInteger(tradeOrIndex)) {
      const recipe = recipes[tradeOrIndex]
      if (!recipe) throw new RangeError(`Trade index ${tradeOrIndex} is out of range; recipes=${recipes.length}`)
      return recipe
    }

    if (tradeOrIndex && typeof tradeOrIndex === 'object') {
      if (isRecipeLike(tradeOrIndex)) return tradeOrIndex

      const found = findTrade(tradeOrIndex, { recipes })
      if (found) return found

      throw new Error([
        'Cannot execute trade: no matching current trade found.',
        'Expected:',
        JSON.stringify(tradeOrIndex),
        'Current recipes:',
        JSON.stringify(summarizeRecipes(recipes))
      ].join('\n'))
    }

    throw new TypeError('executeTrade expects a recipe object, recipe index, or expected trade object')
  }

  async function executeTrade (tradeOrIndex, count = 1, opts = {}) {
    const tradeCount = Number(count)
    if (!Number.isInteger(tradeCount) || tradeCount <= 0) {
      throw new RangeError(`Trade count must be a positive integer, got ${count}`)
    }

    const recipe = resolveTradeArgument(tradeOrIndex)
    const sourceSlots = ingredientSourceSlots(recipe, tradeCount, opts)
    const { request, destinationSlot } = buildTradeRequest(recipe, tradeCount, opts)

    logAction('[trading]', 'execute_trade request full', {
      request_id: request.request_id,
      actions: request.actions
    })

    const actions = inventoryActions()
    const responsePromise = actions.waitRaw(
      request.request_id,
      opts.timeoutMs ?? opts.responseTimeoutMs ?? tradeTimeoutMs
    )

    actions.send(request)

    logAction('[trading]', 'execute_trade request', {
      request_id: request.request_id,
      recipe: summarizeRecipe(recipe),
      count: tradeCount,
      destinationSlot,
      actions: request.actions.map(action => action.type_id)
    })

    const response = await responsePromise

    if (!itemStackResponseStatusOk(response)) {
      logAction('[trading]', 'execute_trade response rejected; waiting for Geyser delayed merchant replay', {
        request_id: request.request_id,
        status: response.status,
        destinationSlot
      })

      if (opts.rejectOnErrorResponse === true) {
        throw new Error(`item_stack_response rejected trade request ${request.request_id}: ${response.status}`)
      }

      await sleep(opts.geyserTradeDelayMs ?? 250)

      if (opts.disableGeyserTransferFallback !== true) {
        const ingredientFallback = buildTradeIngredientTransferRequest(recipe, tradeCount, {
          ...opts,
          ingredientASourceStackId: opts.transferSourceStackId ?? opts.ingredientASourceStackId ?? 1,
          ingredientBSourceStackId: opts.transferSourceStackId ?? opts.ingredientBSourceStackId ?? 1
        })
        const tradeContainer = currentTradeContainer()

        const ingredientFallbackResponse = tradeContainer
          ? await containerTransferIngredients(tradeContainer, recipe, tradeCount, sourceSlots)
          : await (async () => {
              logAction('[trading]', 'execute_trade ingredient fallback request full', {
                request_id: ingredientFallback.request.request_id,
                actions: ingredientFallback.request.actions
              })

              const response = await sendRawTradeRequest(
                ingredientFallback.request,
                opts.transferTimeoutMs ?? opts.timeoutMs ?? opts.responseTimeoutMs ?? tradeTimeoutMs
              )

              logAction('[trading]', 'execute_trade ingredient fallback response', {
                request_id: ingredientFallback.request.request_id,
                status: response.status,
                destinationSlot,
                containers: Array.isArray(response.containers) ? response.containers.length : undefined
              })

              return response
            })()

        const ingredientFallbackOk = Array.isArray(ingredientFallbackResponse)
          ? ingredientFallbackResponse.every(itemStackResponseStatusOk)
          : itemStackResponseStatusOk(ingredientFallbackResponse)

        if (ingredientFallbackOk) {
          const selectionFallback = buildTradeSelectionRequest(recipe, tradeCount, opts)

          logAction('[trading]', 'execute_trade selection fallback request full', {
            request_id: selectionFallback.request.request_id,
            actions: selectionFallback.request.actions
          })

          const selectionFallbackResponse = await sendRawTradeRequest(
            selectionFallback.request,
            opts.selectionTimeoutMs ?? opts.transferTimeoutMs ?? opts.timeoutMs ?? opts.responseTimeoutMs ?? tradeTimeoutMs
          )

          logAction('[trading]', 'execute_trade selection fallback response', {
            request_id: selectionFallback.request.request_id,
            status: selectionFallbackResponse.status,
            destinationSlot,
            containers: Array.isArray(selectionFallbackResponse.containers) ? selectionFallbackResponse.containers.length : undefined
          })

          await sleep(opts.geyserTradeDelayMs ?? 250)

          const outputItem = await waitForTradeOutput(recipe, opts.tradeOutputTimeoutMs ?? 3000)
          const resultFallback = buildTradeResultTakeRequest(recipe, tradeCount, destinationSlot, {
            ...opts,
            resultContainerId: opts.transferResultContainerId ?? 'trade2_result',
            resultStackId: opts.transferResultStackId ?? (itemStackId(outputItem) || 1)
          })

          const resultFallbackResponse = tradeContainer
            ? await tradeContainer.takeResult(destinationSlot, itemCount(recipeOutput(recipe)) * tradeCount)
            : await (async () => {
                logAction('[trading]', 'execute_trade result fallback request full', {
                  request_id: resultFallback.request.request_id,
                  actions: resultFallback.request.actions
                })

                const response = await sendRawTradeRequest(
                  resultFallback.request,
                  opts.resultTimeoutMs ?? opts.transferTimeoutMs ?? opts.timeoutMs ?? opts.responseTimeoutMs ?? tradeTimeoutMs
                )

                logAction('[trading]', 'execute_trade result fallback response', {
                  request_id: resultFallback.request.request_id,
                  status: response.status,
                  destinationSlot,
                  containers: Array.isArray(response.containers) ? response.containers.length : undefined
                })

                return response
              })()

          if (itemStackResponseStatusOk(resultFallbackResponse)) {
            await sleep(opts.restoreTradeInputsDelayMs ?? 150)
            await restoreExcessTradeInputs(recipe, tradeCount, sourceSlots, opts)
          }

          botState.emit('trade_executed', {
            recipe,
            count: tradeCount,
            request: resultFallback.request,
            response: resultFallbackResponse,
            selectionRequest: request,
            selectionResponse: response,
            fallbackSelectionRequest: selectionFallback.request,
            fallbackSelectionResponse: selectionFallbackResponse,
            ingredientRequest: ingredientFallback.request,
            ingredientResponse: ingredientFallbackResponse,
            destinationSlot
          })

          return resultFallbackResponse
        }
      }
    }

    logAction('[trading]', 'execute_trade response', {
      request_id: request.request_id,
      status: response.status,
      destinationSlot,
      containers: Array.isArray(response.containers) ? response.containers.length : undefined
    })

    // Do not manually mutate inventory here. Geyser may reject the immediate
    // response and then apply/update inventory during its delayed merchant replay.
    // inventory.js should mirror the authoritative inventory_slot/content packets.
    botState.emit('trade_executed', {
      recipe,
      count: tradeCount,
      request,
      response,
      destinationSlot
    })

    return response
  }

  botState.openTrade = openTrade
  botState.tradeWith = openTrade
  botState.waitForTradeWindow = waitForTradeWindow
  botState.closeTradeWindow = closeTradeWindow
  botState.currentTradeRecipes = currentTradeRecipes
  botState.findTrade = findTrade
  botState.executeTrade = executeTrade

  botState.trading = {
    open: openTrade,
    waitForWindow: waitForTradeWindow,
    closeWindow: closeTradeWindow,
    currentRecipes: currentTradeRecipes,
    find: findTrade,
    execute: executeTrade,
    setTimeout: ms => {
      tradeTimeoutMs = ms
    }
  }
  Object.defineProperties(botState.trading, {
    currentWindow: {
      enumerable: true,
      get: () => botState.currentTradeWindow ?? null
    },
    currentEntity: {
      enumerable: true,
      get: () => botState.currentTradingEntity ?? null
    }
  })

  botState.tradeHelpers = {
    nbtValue,
    normalizeItemId,
    itemId,
    itemCount,
    recipeInputA,
    recipeInputB,
    recipeOutput,
    recipeNetId,
    isRecipeLike,
    summarizeRecipe,
    summarizeRecipes,
    findTrade,
    buildTradeRequest,
    buildTradeTransferRequest,
    buildTradeIngredientTransferRequest,
    buildTradeResultTakeRequest,
    buildTradeSelectionRequest,
    ingredientActions,
    tradeSelectionAction,
    takeTradeResultAction,
    playerInventorySlotInfo,
    tradeIngredientSlotInfo,
    tradeResultSlotInfo
  }
  botState.trading.helpers = botState.tradeHelpers

  botState.setTradeTimeout = ms => {
    tradeTimeoutMs = ms
  }

  botState.on('inventory_trade_window_updated', (_windowId, _win, packet) => {
    setCurrentTradeWindow(packet)
  })

  client.on('container_close', packet => {
    const currentWindowId = botState.currentTradeWindow?.window_id
    if (
      currentWindowId != null &&
      normalizeWindowId(packet.window_id) === normalizeWindowId(currentWindowId)
    ) {
      clearCurrentTradeWindow(packet)
    }
  })

  client.on('close', () => {
    clearCurrentTradeWindow()
  })
}
