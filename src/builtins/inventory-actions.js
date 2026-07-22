// builtins/inventory-actions.js
// Auto-loaded by plugin-loader.
//
// Active inventory behavior layer for server-authoritative Bedrock inventory.
// Keeps inventory.js as the passive mirror and sends real item_stack_request
// actions through player_auth_input via auth-input.js.
//
// Provides:
//   botState.inventory.actions.send(request)
//   botState.inventory.actions.sendStandalone(request)
//   botState.inventory.actions.wait(requestId)
//   botState.inventory.actions.waitRaw(requestId)
//   botState.setHeldItemSlot(slot)
//   botState.selectHotbarSlot(slot)
//   botState.equipItem(slot, [hotbarSlot])
//   botState.equipInventorySlot(slot, [hotbarSlot])
//   botState.swapInventorySlots(slotA, slotB)
//   botState.moveInventorySlot(fromSlot, toSlot)
//   botState.mergeInventorySlots(fromSlot, toSlot)
//   botState.inventory.move1(fromSlot, toSlot)
//   botState.splitInventorySlot(fromSlot, toSlot)
//   botState.dropInventorySlot(slot)
//   botState.inventory.drop1(slot)
//   botState.destroyInventorySlot(slot)
//   botState.inventory.destroy1(slot)

const {
  cloneItem,
  itemStackResponseStatusOk,
  itemToRaw,
  maxStackSize,
  parseItemStackResponsePacket,
  selfRuntimeEntityId,
  sameItem
} = require('../utils')
const {
  InventorySimulationState,
  cloneSlots,
  cloneStack,
  simulateStackRequest
} = require('./inventory-simulation')

module.exports = function inventoryActionsPlugin (botState, options = {}) {
  const client = botState.client

  let nextRequestId = options.inventoryRequestIdStart ?? -1001
  let responseTimeoutMs = options.inventoryResponseTimeoutMs ?? 5000
  let inventoryUpdateTimeoutMs = options.inventoryUpdateTimeoutMs ?? 3000

  const pendingResponses = new Map()
  const pendingSlotUpdates = new Set()
  const pendingTransactions = new Map()

  let predictedSlots = []
  let predictedCursor = null
  let virtualCursor = null
  let activeBatch = null
  const inventorySimulation = new InventorySimulationState(botState, { maxStackSize })
  botState.inventorySimulation = inventorySimulation

  function requestId () {
    const id = nextRequestId
    nextRequestId -= 2
    return id
  }

  function actualItemAt (slot) {
    return botState.inventory.slots[slot]
  }

  function itemAt (slot) {
    ensurePredictedSlots()
    if (activeBatch) return activeBatch.predictedSlots[slot] ?? null
    return predictedSlots[slot] ?? null
  }

  function assertInventorySlot (slot, name = 'slot') {
    if (!Number.isInteger(slot) || slot < 0 || slot >= botState.inventory.slots.length) {
      throw new RangeError(`${name} must be an inventory slot between 0 and ${botState.inventory.slots.length - 1}`)
    }
  }

  function assertHotbarSlot (slot, name = 'slot') {
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) {
      throw new RangeError(`${name} must be a hotbar slot between 0 and 8`)
    }
  }

  function isHotbarSlot (slot) {
    return slot >= 0 && slot <= 8
  }

  function setStackId (item, id) {
    if (!item) return item
    item.stackId = id
    item.stack_id = id
    return item
  }

  function syncPredictedSlotsFromActual (force = false) {
    if (!botState.inventory) return
    if (!force && (pendingTransactions.size > 0 || activeBatch || virtualCursor)) return
    inventorySimulation.syncFromBot(force)
    predictedSlots = cloneSlots(botState.inventory.slots)
    predictedCursor = cloneStack(inventorySimulation.cursor)
    virtualCursor = null
  }

  function ensurePredictedSlots () {
    if (!botState.inventory) return
    if (predictedSlots.length !== botState.inventory.slots.length) {
      syncPredictedSlotsFromActual(true)
    }
  }

  function predictionSnapshot () {
    ensurePredictedSlots()
    inventorySimulation.slots = cloneSlots(predictedSlots)
    inventorySimulation.cursor = cloneStack(predictedCursor)
    return inventorySimulation.snapshot()
  }

  function cursorSnapshot () {
    return cloneStack(predictedCursor)
  }

  function stackId (item) {
    return item ? (item.stackId ?? item.stack_id ?? 0) : 0
  }

  function stackSlotInfo (containerId, slot, item = null) {
    return {
      slot_type: { container_id: containerId },
      slot,
      stack_id: stackId(item)
    }
  }

  function cursorSlotInfo (item = predictedCursor) {
    return stackSlotInfo('cursor', 0, item)
  }

  function playerProtocolSlot (slot) {
    return slot
  }

  function playerSlotIndexForContainer (containerId, slot) {
    return slot
  }

  function playerStackRequestSlotInfo (slot, item, containerId = null) {
    if (containerId) return stackSlotInfo(containerId, slot, item)
    return stackSlotInfo(isHotbarSlot(slot) ? 'hotbar' : 'inventory', playerProtocolSlot(slot), item)
  }

  async function openPlayerInventoryForAction () {
    const activeWindow = typeof botState.getWindow === 'function'
      ? botState.getWindow(botState.activeWindowId)
      : null
    if (activeWindow?.windowType === 'inventory') return null

    const runtimeEntityId = selfRuntimeEntityId(botState)
    if (runtimeEntityId == null) {
      throw new Error('Cannot open player inventory before self entity is known')
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for player inventory container_open'))
      }, inventoryUpdateTimeoutMs)

      function onOpen (packet) {
        if (packet.window_type !== 'inventory') return
        cleanup()
        resolve(packet.window_id)
      }

      function cleanup () {
        clearTimeout(timeout)
        client.off('container_open', onOpen)
      }

      client.on('container_open', onOpen)
      client.queue('interact', {
        action_id: 'open_inventory',
        target_entity_id: runtimeEntityId,
        has_position: false
      })
    })
  }

  async function closePlayerInventoryAfterAction (windowId) {
    if (windowId == null) return

    await new Promise(resolve => {
      const timeout = setTimeout(cleanup, inventoryUpdateTimeoutMs)

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
  }

  async function withPlayerInventoryOpen (fn) {
    const openedWindowId = await openPlayerInventoryForAction()
    try {
      return await fn()
    } finally {
      await closePlayerInventoryAfterAction(openedWindowId)
    }
  }

  function requestUsesMainInventory (request) {
    return request.actions?.some(action =>
      action.source?.slot_type?.container_id === 'inventory' ||
      action.destination?.slot_type?.container_id === 'inventory'
    ) ?? false
  }

  function currentPredictionState () {
    ensurePredictedSlots()
    return activeBatch
      ? { slots: activeBatch.predictedSlots, cursor: activeBatch.predictedCursor }
      : { slots: predictedSlots, cursor: predictedCursor }
  }

  function predictRequest (request) {
    const base = currentPredictionState()
    const prediction = simulateStackRequest(base, request, {
      maxStackSize,
      provisionalStackId: request.request_id
    })

    return {
      ...prediction,
      beforeSlots: cloneSlots(base.slots),
      beforeCursor: cloneStack(base.cursor)
    }
  }

  function publishPrediction (prediction) {
    predictedSlots = cloneSlots(prediction.slots)
    predictedCursor = cloneStack(prediction.cursor)
    botState.emit('inventory_prediction_updated', {
      slots: predictionSnapshot(),
      cursor: cursorSnapshot(),
      changedSlots: prediction.changedSlots,
      cursorChanged: prediction.cursorChanged
    })
  }

  function recordBatchedPrediction (request, prediction) {
    const lastIndex = activeBatch.requests.length - 1
    const lastRequest = activeBatch.requests[lastIndex]
    const lastPrediction = activeBatch.predictions[lastIndex]
    if (canCoalesceTakeRequests(lastRequest, request)) {
      lastRequest.actions[0].count += request.actions[0].count
      const mergedPrediction = {
        ...prediction,
        beforeSlots: cloneSlots(lastPrediction.beforeSlots),
        beforeCursor: cloneStack(lastPrediction.beforeCursor),
        changedSlots: [...new Set([...(lastPrediction.changedSlots || []), ...(prediction.changedSlots || [])])],
        cursorChanged: lastPrediction.cursorChanged || prediction.cursorChanged
      }
      activeBatch.predictions[lastIndex] = mergedPrediction
      for (const slot of mergedPrediction.changedSlots) activeBatch.touchedSlots.add(slot)
      activeBatch.cursorTouched = activeBatch.cursorTouched || mergedPrediction.cursorChanged
      activeBatch.predictedSlots = cloneSlots(mergedPrediction.slots)
      activeBatch.predictedCursor = cloneStack(mergedPrediction.cursor)
      publishPrediction(mergedPrediction)

      return {
        batched: true,
        request: null,
        actions: request.actions,
        predicted: predictionSnapshot(),
        cursor: cursorSnapshot()
      }
    }

    activeBatch.requests.push(request)
    activeBatch.predictions.push(prediction)
    for (const slot of prediction.changedSlots) activeBatch.touchedSlots.add(slot)
    activeBatch.cursorTouched = activeBatch.cursorTouched || prediction.cursorChanged
    activeBatch.predictedSlots = cloneSlots(prediction.slots)
    activeBatch.predictedCursor = cloneStack(prediction.cursor)
    publishPrediction(prediction)

    return {
      batched: true,
      request: null,
      actions: request.actions,
      predicted: predictionSnapshot(),
      cursor: cursorSnapshot()
    }
  }

  function canCoalesceTakeRequests (previous, next) {
    if (!previous || !next) return false
    if (previous.actions?.length !== 1 || next.actions?.length !== 1) return false
    const first = previous.actions[0]
    const second = next.actions[0]
    if (first.type_id !== 'take' || second.type_id !== 'take') return false
    if (!sameSlotInfo(first.source, second.source, true)) return false
    if (!sameSlotInfo(first.destination, second.destination, false)) return false
    return first.destination.stack_id === 0 && second.destination.stack_id === previous.request_id
  }

  function sameSlotInfo (a, b, compareStackId) {
    if (!a || !b) return false
    if (a.slot_type?.container_id !== b.slot_type?.container_id) return false
    if (a.slot !== b.slot) return false
    return !compareStackId || a.stack_id === b.stack_id
  }

  function cloneVirtualCursor (cursor) {
    if (!cursor) return null
    return {
      sourceSlot: cursor.sourceSlot,
      sourceItem: cloneStack(cursor.sourceItem),
      item: cloneStack(cursor.item)
    }
  }

  function currentVirtualCursor () {
    return activeBatch ? activeBatch.virtualCursor : virtualCursor
  }

  function setCurrentVirtualCursor (cursor) {
    if (activeBatch) activeBatch.virtualCursor = cloneVirtualCursor(cursor)
    else virtualCursor = cloneVirtualCursor(cursor)
  }

  function responseContainers (response) {
    return response?.containers || []
  }

  function isPlayerPredictionContainer (containerId) {
    return containerId === 'inventory' || containerId === 'hotbar' || containerId === 'hotbar_and_inventory'
  }

  function responseSlotEntries (response) {
    const entries = []
    for (const container of responseContainers(response)) {
      const containerId = container.slot_type?.container_id
      for (const slot of container.slots || []) entries.push({ containerId, slot })
    }
    return entries
  }

  function responseCursorSlot (response) {
    return responseSlotEntries(response).find(entry =>
      entry.containerId === 'cursor' && entry.slot.slot === 0
    )?.slot ?? null
  }

  function applyServerSlotToPredictedItem (predictedItem, serverSlot, fallbackItem = null) {
    if (!serverSlot) return cloneStack(predictedItem)
    if (serverSlot.count === 0) return null

    const source = predictedItem || fallbackItem
    if (!source) return null

    return setStackId(cloneStack(source, serverSlot.count), serverSlot.item_stack_id)
  }

  function predictedCount (item) {
    return item?.count ?? 0
  }

  function compareServerSlot (mismatches, label, expectedItem, serverSlot) {
    const expectedCount = predictedCount(expectedItem)
    if (expectedCount !== serverSlot.count) {
      mismatches.push(`${label}: predicted ${expectedCount}, server ${serverSlot.count}`)
    }
  }

  function predictionFailure (transaction, response, reason, mismatches = []) {
    const error = new Error(`Inventory prediction failed for request ${transaction.request.request_id}: ${reason}`)
    error.request = transaction.request
    error.response = response
    error.mismatches = mismatches
    botState.emit('inventory_prediction_failed', {
      error,
      request: transaction.request,
      response,
      mismatches
    })
    return error
  }

  function applyPredictedSlotsToActual (slots) {
    for (const slot of slots) {
      botState.inventory.updateSlot(slot, cloneStack(predictedSlots[slot]))
    }
  }

  function reconcileAcceptedPrediction (transaction, response) {
    const finalSlots = cloneSlots(transaction.predictedSlots)
    let finalCursor = cloneStack(transaction.predictedCursor)
    const mismatches = []
    const slotsToApply = new Set(transaction.touchedSlots)

    for (const { containerId, slot: serverSlot } of responseSlotEntries(response)) {
      if (containerId === 'cursor') {
        if (serverSlot.slot !== 0) continue
        compareServerSlot(mismatches, 'cursor', finalCursor, serverSlot)
        finalCursor = applyServerSlotToPredictedItem(finalCursor, serverSlot, transaction.beforeCursor)
        continue
      }

      if (!isPlayerPredictionContainer(containerId)) continue
      const slot = playerSlotIndexForContainer(containerId, serverSlot.slot)
      slotsToApply.add(slot)
      compareServerSlot(mismatches, `slot ${slot}`, finalSlots[slot], serverSlot)
      finalSlots[slot] = applyServerSlotToPredictedItem(finalSlots[slot], serverSlot, actualItemAt(slot) || transaction.beforeSlots[slot])
    }

    predictedSlots = finalSlots
    if (transaction.cursorTouched || responseCursorSlot(response)) predictedCursor = finalCursor
    virtualCursor = cloneVirtualCursor(transaction.predictedVirtualCursor)
    applyPredictedSlotsToActual(slotsToApply)
    pendingTransactions.delete(transaction.request.request_id)

    botState.emit('inventory_prediction_reconciled', {
      request: transaction.request,
      response,
      changedSlots: [...slotsToApply],
      cursorChanged: transaction.cursorTouched || !!responseCursorSlot(response),
      mismatches
    })

    if (mismatches.length > 0) throw predictionFailure(transaction, response, 'server state differed from prediction', mismatches)
  }

  function rollbackPrediction (transaction, response, cause) {
    pendingTransactions.delete(transaction.request.request_id)
    syncPredictedSlotsFromActual(true)
    predictedCursor = cloneStack(transaction.beforeCursor)
    virtualCursor = cloneVirtualCursor(transaction.beforeVirtualCursor)

    const error = predictionFailure(
      transaction,
      response,
      cause?.message || 'server rejected request',
      cause?.mismatches || []
    )
    error.cause = cause
    return error
  }

  function startPendingTransaction (request, prediction) {
    const transaction = {
      request,
      beforeSlots: cloneSlots(prediction.beforeSlots),
      beforeCursor: cloneStack(prediction.beforeCursor),
      predictedSlots: cloneSlots(prediction.slots),
      predictedCursor: cloneStack(prediction.cursor),
      beforeVirtualCursor: cloneVirtualCursor(prediction.beforeVirtualCursor ?? currentVirtualCursor()),
      predictedVirtualCursor: cloneVirtualCursor(prediction.virtualCursor ?? currentVirtualCursor()),
      touchedSlots: new Set(prediction.changedSlots),
      cursorTouched: prediction.cursorChanged
    }

    pendingTransactions.set(request.request_id, transaction)
    publishPrediction(prediction)
    return transaction
  }

  function queueRequestInAuthInput (request) {
    botState.queuePlayerAuthInputEdit(packet => {
      botState.setAuthInputFlag(packet, 'item_stack_request', true)
      packet.item_stack_request = request
    })

    botState.flushPlayerAuthInput()
  }

  function sendItemStackRequest (request) {
    return sendItemStackRequests([request])[0]
  }

  function sendItemStackRequests (requests) {
    client.queue('item_stack_request', {
      requests
    })

    for (const request of requests) {
      botState.emit('inventory_action_request', request)

      botState.logAction?.('[inventory-actions]', 'item_stack_request', {
        requestId: request.request_id,
        actions: request.actions.map(action => action.type_id)
      })
    }

    return requests.map(request => request.request_id)
  }

  function sendStandaloneItemStackRequest (request) {
    client.queue('item_stack_request', {
      requests: [request]
    })
    botState.emit('inventory_action_request', request)

    botState.logAction?.('[inventory-actions]', 'standalone item_stack_request', {
      requestId: request.request_id,
      actions: request.actions.map(action => action.type_id)
    })

    return request.request_id
  }

  function selectHotbarSlot (slot) {
    assertHotbarSlot(slot)

    if (botState.heldItemSlot === slot) {
      return itemAt(slot)
    }

    const runtimeEntityId = selfRuntimeEntityId(botState)
    if (runtimeEntityId == null) {
      throw new Error('Cannot select hotbar slot before self entity is known')
    }

    const item = itemAt(slot)
    client.queue('mob_equipment', {
      runtime_entity_id: runtimeEntityId,
      item: itemToRaw(item, botState.itemClass, { logAction: botState.logAction }),
      slot,
      selected_slot: slot,
      window_id: 'inventory'
    })

    botState.heldItemSlot = slot
    botState.emit('held_item_slot_changed', slot, item)

    botState.logAction?.('[inventory-actions]', 'mob_equipment', {
      slot,
      item: item ? `${item.name} x${item.count}` : 'empty'
    })

    return item
  }

  function waitForItemStackResponse (id, timeoutMs = responseTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingResponses.delete(id)
        reject(new Error(`Timed out waiting for item_stack_response: ${id}`))
      }, timeoutMs)

      pendingResponses.set(id, {
        resolve,
        reject,
        timeout,
        raw: false
      })
    })
  }

  function waitForRawItemStackResponse (id, timeoutMs = responseTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingResponses.delete(id)
        reject(new Error(`Timed out waiting for item_stack_response: ${id}`))
      }, timeoutMs)

      pendingResponses.set(id, {
        resolve,
        reject,
        timeout,
        raw: true
      })
    })
  }

  client.on('item_stack_response', packet => {
    const responses = parseItemStackResponsePacket(packet)

    for (const response of responses) {
      const id = response.request_id
      botState.emit('item_stack_response', response)

      const waiter = pendingResponses.get(id)
      if (!waiter) continue

      clearTimeout(waiter.timeout)
      pendingResponses.delete(id)

      // Normal inventory actions should reject on item_stack_response error.
      // That catches real desyncs/malformed inventory operations early.
      //
      // However, villager trading through Geyser needs access to the raw response.
      // In Geyser's MerchantInventoryTranslator, the merchant recipe action can
      // send ServerboundSelectTradePacket(tradeChoice), then intentionally return
      // rejectRequest(request) while scheduling delayed merchant handling for
      // compatibility paths:
      //
      //   https://github.com/GeyserMC/Geyser/blob/master/core/src/main/java/org/geysermc/geyser/translator/inventory/MerchantInventoryTranslator.java
      //
      // The test log showed exactly this shape:
      //
      //   item_stack_request ["craft_recipe_auto","take"]
      //   item_stack_response { status: "error", request_id: ... }
      //
      // See the uploaded failing run:
      //
      //   /mnt/data/output(4).log
      //
      // Therefore waitForRawItemStackResponse() resolves even on status "error".
      // This does NOT weaken normal inventory behavior; waitForItemStackResponse()
      // still rejects on non-ok responses.
      if (waiter.raw) {
        waiter.resolve(response)
      } else if (itemStackResponseStatusOk(response)) {
        waiter.resolve(response)
      } else {
        const error = new Error(`item_stack_response rejected request ${id}: ${response.status}`)
        error.response = response
        waiter.reject(error)
      }
    }
  })

  function waitForInventorySlots (slots, timeoutMs = inventoryUpdateTimeoutMs) {
    const wanted = new Set(slots)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for inventory slot update: ${[...wanted].join(', ')}`))
      }, timeoutMs)

      function onInventorySlot (packet) {
        if (packet.window_id !== 0 && packet.window_id !== 'inventory') return
        wanted.delete(packet.slot)
        if (wanted.size === 0) {
          cleanup()
          resolve()
        }
      }

      function onInventoryContent (packet) {
        if (packet.window_id !== 0 && packet.window_id !== 'inventory') return
        cleanup()
        resolve()
      }

      function cleanup () {
        clearTimeout(timeout)
        client.off('inventory_slot', onInventorySlot)
        client.off('inventory_content', onInventoryContent)
      }

      client.on('inventory_slot', onInventorySlot)
      client.on('inventory_content', onInventoryContent)
    })
  }

  async function sendPredictedInventoryRequest (request, prediction) {
    if (activeBatch) return recordBatchedPrediction(request, prediction)

    const send = async () => {
      const transaction = startPendingTransaction(request, prediction)
      try {
        const id = sendItemStackRequest(request)
        const response = await waitForItemStackResponse(id)
        reconcileAcceptedPrediction(transaction, response)
        return response
      } catch (err) {
        if (pendingTransactions.has(request.request_id)) throw rollbackPrediction(transaction, err.response, err)
        throw err
      }
    }

    return requestUsesMainInventory(request) ? withPlayerInventoryOpen(send) : send()
  }

  async function sendPredictedInventoryRequests (requests, predictions) {
    const transactions = requests.map((request, index) => startPendingTransaction(request, predictions[index]))
    try {
      const waits = requests.map(request => waitForItemStackResponse(request.request_id))
      sendItemStackRequests(requests)
      const responses = await Promise.all(waits)
      for (let i = 0; i < responses.length; i++) reconcileAcceptedPrediction(transactions[i], responses[i])
      return responses
    } catch (err) {
      for (const transaction of transactions) {
        if (pendingTransactions.has(transaction.request.request_id)) rollbackPrediction(transaction, err.response, err)
      }
      throw err
    }
  }

  async function sendSequentialPredictedInventoryRequests (requests, predictions) {
    const responses = []
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i]
      const transaction = startPendingTransaction(request, predictions[i])
      try {
        const responsePromise = waitForItemStackResponse(request.request_id)
        sendItemStackRequest(request)
        const response = await responsePromise
        reconcileAcceptedPrediction(transaction, response)
        responses.push(response)
      } catch (err) {
        if (pendingTransactions.has(request.request_id)) throw rollbackPrediction(transaction, err.response, err)
        throw err
      }
    }
    return responses
  }

  async function transactInventory (request, changedSlots = []) {
    const prediction = predictRequest(request)
    for (const slot of changedSlots) {
      if (!prediction.changedSlots.includes(slot)) prediction.changedSlots.push(slot)
    }

    return sendPredictedInventoryRequest(request, prediction)
  }

  function makeRequest (actions) {
    return {
      request_id: requestId(),
      actions,
      custom_names: [],
      cause: -1
    }
  }

  function takeAction (count, source, destination) {
    return {
      type_id: 'take',
      count,
      source,
      destination
    }
  }

  function placeAction (count, source, destination) {
    return {
      type_id: 'place',
      count,
      source,
      destination
    }
  }

  function swapAction (source, destination) {
    return {
      type_id: 'swap',
      source,
      destination
    }
  }

  function dropAction (count, source, randomly = false) {
    return {
      type_id: 'drop',
      count,
      source,
      randomly
    }
  }

  function destroyAction (count, source) {
    return {
      type_id: 'destroy',
      count,
      source
    }
  }

  function swapInventorySlots (slotA, slotB) {
    assertInventorySlot(slotA, 'slotA')
    assertInventorySlot(slotB, 'slotB')

    if (slotA === slotB) return Promise.resolve(null)

    const itemA = itemAt(slotA)
    const itemB = itemAt(slotB)
    if (!itemA && !itemB) {
      return Promise.resolve({
        request: null,
        requests: [],
        response: null,
        responses: [],
        predicted: predictionSnapshot(),
        cursor: cursorSnapshot()
      })
    }
    if (!itemB) return moveInventorySlot(slotA, slotB)
    if (!itemA) return moveInventorySlot(slotB, slotA)

    if (activeBatch) return queueOccupiedSwap(slotA, slotB)
    return withPlayerInventoryOpen(() => performOccupiedSwap(slotA, slotB))
  }

  function queueOccupiedSwap (slotA, slotB) {
    const requests = []
    activeBatch.sequential = true

    const takeRequest = makeRequest([
      takeAction(itemAt(slotB).count, playerStackRequestSlotInfo(slotB, itemAt(slotB)), cursorSlotInfo(null))
    ])
    requests.push(transactInventory(takeRequest, [slotB]))

    const swapRequest = makeRequest([
      swapAction(cursorSlotInfo(), playerStackRequestSlotInfo(slotA, itemAt(slotA)))
    ])
    requests.push(transactInventory(swapRequest, [slotA]))

    const placeRequest = makeRequest([
      placeAction(currentPredictionState().cursor.count, cursorSlotInfo(), playerStackRequestSlotInfo(slotB, itemAt(slotB)))
    ])
    requests.push(transactInventory(placeRequest, [slotB]))

    return Promise.all(requests)
  }

  async function performOccupiedSwap (slotA, slotB) {
    const takeRequest = makeRequest([
      takeAction(itemAt(slotB).count, playerStackRequestSlotInfo(slotB, itemAt(slotB)), cursorSlotInfo(null))
    ])
    await transactInventory(takeRequest, [slotB])

    const swapRequest = makeRequest([
      swapAction(cursorSlotInfo(), playerStackRequestSlotInfo(slotA, itemAt(slotA)))
    ])
    await transactInventory(swapRequest, [slotA])

    const placeRequest = makeRequest([
      placeAction(currentPredictionState().cursor.count, cursorSlotInfo(), playerStackRequestSlotInfo(slotB, itemAt(slotB)))
    ])
    return transactInventory(placeRequest, [slotB])
  }

  async function equipItem (slot, hotbarSlot = 0) {
    assertInventorySlot(slot)
    assertHotbarSlot(hotbarSlot, 'hotbarSlot')

    const item = itemAt(slot)
    if (!item) throw new Error(`No item in slot ${slot}`)

    if (slot === botState.heldItemSlot) return item

    if (isHotbarSlot(slot)) {
      selectHotbarSlot(slot)
      return itemAt(slot)
    }

    await swapInventorySlots(slot, hotbarSlot)
    selectHotbarSlot(hotbarSlot)
    return itemAt(hotbarSlot)
  }

  function moveInventorySlot (fromSlot, toSlot) {
    const source = playerStackRequestSlotInfo(fromSlot, itemAt(fromSlot))
    const destination = playerStackRequestSlotInfo(toSlot, itemAt(toSlot))

    const request = makeRequest([
      takeAction(itemAt(fromSlot).count, source, destination)
    ])

    return transactInventory(request, [fromSlot, toSlot])
  }

  function mergeInventorySlots (fromSlot, toSlot) {
    const from = itemAt(fromSlot)
    const to = itemAt(toSlot)
    const count = Math.min(from.count, maxStackSize(to) - to.count)

    const request = makeRequest([
      takeAction(count, playerStackRequestSlotInfo(fromSlot, from), playerStackRequestSlotInfo(toSlot, to))
    ])

    return transactInventory(request, [fromSlot, toSlot])
  }

  function moveOneInventoryItem (fromSlot, toSlot) {
    const from = itemAt(fromSlot)
    const to = itemAt(toSlot)

    const source = playerStackRequestSlotInfo(fromSlot, from)
    const destination = playerStackRequestSlotInfo(toSlot, to)

    const request = makeRequest([
      takeAction(1, source, destination)
    ])

    return transactInventory(request, [fromSlot, toSlot])
  }

  function splitInventorySlot (fromSlot, toSlot) {
    const count = Math.ceil(itemAt(fromSlot).count / 2)

    const request = makeRequest([
      takeAction(count, playerStackRequestSlotInfo(fromSlot, itemAt(fromSlot)), playerStackRequestSlotInfo(toSlot, itemAt(toSlot)))
    ])

    return transactInventory(request, [fromSlot, toSlot])
  }

  function dropInventorySlot (slot, randomly = false) {
    const request = makeRequest([
      dropAction(itemAt(slot).count, playerStackRequestSlotInfo(slot, itemAt(slot)), randomly)
    ])

    return transactInventory(request, [slot])
  }

  function dropOneInventoryItem (slot, randomly = false) {
    const request = makeRequest([
      dropAction(1, playerStackRequestSlotInfo(slot, itemAt(slot)), randomly)
    ])

    return transactInventory(request, [slot])
  }

  function destroyInventorySlot (slot) {
    const request = makeRequest([
      destroyAction(itemAt(slot).count, playerStackRequestSlotInfo(slot, itemAt(slot)))
    ])

    return transactInventory(request, [slot])
  }

  function destroyOneInventoryItem (slot) {
    const request = makeRequest([
      destroyAction(1, playerStackRequestSlotInfo(slot, itemAt(slot)))
    ])

    return transactInventory(request, [slot])
  }

  function pickupInventorySlot (slot, count = null) {
    assertInventorySlot(slot)
    const item = itemAt(slot)
    if (!item) throw new Error(`No item in slot ${slot}`)

    const amount = count == null ? item.count : count
    if (!Number.isInteger(amount) || amount <= 0 || amount > item.count) {
      throw new RangeError(`count must be between 1 and ${item.count}`)
    }

    const beforeSlots = cloneSlots(currentPredictionState().slots)
    const beforeCursor = cloneStack(currentPredictionState().cursor)
    const slots = cloneSlots(beforeSlots)
    const cursor = cloneStack(item, amount)
    slots[slot] = item.count === amount ? null : cloneStack(item, item.count - amount)
    const prediction = {
      slots,
      cursor,
      beforeSlots,
      beforeCursor,
      changedSlots: [slot],
      cursorChanged: true
    }

    if (activeBatch) {
      activeBatch.predictedSlots = cloneSlots(slots)
      activeBatch.predictedCursor = cloneStack(cursor)
      activeBatch.touchedSlots.add(slot)
      activeBatch.cursorTouched = true
    } else {
      predictedSlots = cloneSlots(slots)
      predictedCursor = cloneStack(cursor)
    }
    setCurrentVirtualCursor({
      sourceSlot: slot,
      sourceItem: item,
      item: cursor
    })
    publishPrediction(prediction)

    return Promise.resolve({
      virtual: true,
      request: null,
      response: null,
      predicted: predictionSnapshot(),
      cursor: cursorSnapshot()
    })
  }

  function placeCursorItem (slot, count = null) {
    assertInventorySlot(slot)
    if (!predictedCursor) throw new Error('No item on inventory cursor')

    const amount = count == null ? predictedCursor.count : count
    const virtual = currentVirtualCursor()
    if (virtual) return placeVirtualCursorItem(slot, amount, virtual)

    const request = makeRequest([
      placeAction(amount, cursorSlotInfo(predictedCursor), playerStackRequestSlotInfo(slot, itemAt(slot)))
    ])
    return transactInventory(request, [slot])
  }

  function placeVirtualCursorItem (slot, amount, virtual) {
    if (!Number.isInteger(amount) || amount <= 0 || amount > predictedCursor.count) {
      throw new RangeError(`count must be between 1 and ${predictedCursor.count}`)
    }

    const destination = itemAt(slot)
    if (destination && !sameItem(destination, predictedCursor)) {
      throw new Error('Cannot place a virtual cursor onto an incompatible item')
    }

    const before = currentPredictionState()
    const beforeSlots = cloneSlots(before.slots)
    const beforeCursor = cloneStack(before.cursor)
    const slots = cloneSlots(beforeSlots)
    const moving = cloneStack(predictedCursor, amount)
    slots[slot] = destination ? cloneStack(destination, destination.count + amount) : moving
    const remainingCursor = predictedCursor.count === amount ? null : cloneStack(predictedCursor, predictedCursor.count - amount)
    const remainingVirtual = remainingCursor
      ? { sourceSlot: virtual.sourceSlot, sourceItem: virtual.sourceItem, item: remainingCursor }
      : null
    const request = makeRequest([
      takeAction(amount, playerStackRequestSlotInfo(virtual.sourceSlot, virtual.sourceItem), playerStackRequestSlotInfo(slot, destination))
    ])
    const prediction = {
      slots,
      cursor: remainingCursor,
      beforeSlots,
      beforeCursor,
      beforeVirtualCursor: virtual,
      virtualCursor: remainingVirtual,
      changedSlots: [...new Set([virtual.sourceSlot, slot])],
      cursorChanged: true
    }
    setCurrentVirtualCursor(remainingVirtual)

    return sendPredictedInventoryRequest(request, prediction)
  }

  async function batchInventoryActions (fn) {
    if (activeBatch) throw new Error('Nested inventory action batches are not supported')
    ensurePredictedSlots()

    const batch = {
      requests: [],
      predictions: [],
      beforeSlots: cloneSlots(predictedSlots),
      beforeCursor: cloneStack(predictedCursor),
      predictedSlots: cloneSlots(predictedSlots),
      predictedCursor: cloneStack(predictedCursor),
      virtualCursor: cloneVirtualCursor(virtualCursor),
      touchedSlots: new Set(),
      cursorTouched: false,
      sequential: false
    }

    activeBatch = batch
    let result
    try {
      result = await fn(botState.inventory)
    } catch (err) {
      predictedSlots = cloneSlots(batch.beforeSlots)
      predictedCursor = cloneStack(batch.beforeCursor)
      virtualCursor = cloneVirtualCursor(batch.virtualCursor)
      throw err
    } finally {
      if (activeBatch === batch) activeBatch = null
    }

    if (batch.requests.length === 0) {
      return {
        request: null,
        requests: [],
        response: null,
        responses: [],
        result,
        predicted: predictionSnapshot(),
        cursor: cursorSnapshot()
      }
    }

    const prediction = {
      slots: cloneSlots(batch.predictedSlots),
      cursor: cloneStack(batch.predictedCursor),
      beforeSlots: cloneSlots(batch.beforeSlots),
      beforeCursor: cloneStack(batch.beforeCursor),
      changedSlots: [...batch.touchedSlots],
      cursorChanged: batch.cursorTouched
    }
    const send = () => batch.sequential
      ? sendSequentialPredictedInventoryRequests(batch.requests, batch.predictions)
      : sendPredictedInventoryRequests(batch.requests, batch.predictions)
    const responses = batch.requests.some(requestUsesMainInventory)
      ? await withPlayerInventoryOpen(send)
      : await send()

    return {
      request: batch.requests[batch.requests.length - 1],
      requests: batch.requests,
      response: responses[responses.length - 1],
      responses,
      result,
      predicted: predictionSnapshot(),
      cursor: cursorSnapshot()
    }
  }

  function clearInventoryActionWaiters () {
    for (const waiter of pendingResponses.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error('Inventory action waiters cleared'))
    }

    pendingResponses.clear()
    pendingSlotUpdates.clear()
    pendingTransactions.clear()
    syncPredictedSlotsFromActual(true)
  }

  function attachInventoryActions () {
    if (!botState.inventory) return
    syncPredictedSlotsFromActual(true)

    if (!botState.inventory.__predictionSyncAttached) {
      Object.defineProperty(botState.inventory, '__predictionSyncAttached', {
        configurable: false,
        enumerable: false,
        value: true
      })
      botState.inventory.on('updateSlot', () => syncPredictedSlotsFromActual())
    }

    Object.defineProperty(botState.inventory, 'predicted', {
      configurable: true,
      enumerable: true,
      get: predictionSnapshot
    })

    Object.defineProperty(botState.inventory, 'cursor', {
      configurable: true,
      enumerable: true,
      get: cursorSnapshot
    })

    Object.assign(botState.inventory, {
      select: selectHotbarSlot,
      equip: equipItem,
      swap: swapInventorySlots,
      move: moveInventorySlot,
      merge: mergeInventorySlots,
      move1: moveOneInventoryItem,
      split: splitInventorySlot,
      pickup: pickupInventorySlot,
      placeCursor: placeCursorItem,
      drop: dropInventorySlot,
      drop1: dropOneInventoryItem,
      destroy: destroyInventorySlot,
      destroy1: destroyOneInventoryItem
    })

    botState.inventory.actions = {
      send: sendItemStackRequest,
      sendStandalone: sendStandaloneItemStackRequest,
      wait: waitForItemStackResponse,
      waitRaw: waitForRawItemStackResponse,
      setResponseTimeout: ms => {
        responseTimeoutMs = ms
      },
      setUpdateTimeout: ms => {
        inventoryUpdateTimeoutMs = ms
      },
      clearWaiters: clearInventoryActionWaiters,
      batch: batchInventoryActions,
      makeRequest,
      takeAction,
      placeAction,
      swapAction,
      dropAction,
      destroyAction,
      cursorSlotInfo,
      stackSlotInfo: playerStackRequestSlotInfo,
      cloneItem,
      setStackId,
      maxStackSize,
      sameItem,
      responseStatusOk: itemStackResponseStatusOk,
      parseItemStackResponsePacket
    }
  }

  botState.sendItemStackRequest = sendItemStackRequest
  botState.sendStandaloneItemStackRequest = sendStandaloneItemStackRequest

  botState.waitForItemStackResponse = waitForItemStackResponse

  // Use this only when the caller needs to inspect a rejected response.
  // The motivating case is villager trading through Geyser, where merchant
  // handling may intentionally return item_stack_response status "error" while
  // still scheduling Java-side trade selection/refresh handling.
  botState.waitForRawItemStackResponse = waitForRawItemStackResponse

  botState.setHeldItemSlot = selectHotbarSlot
  botState.selectHotbarSlot = selectHotbarSlot
  botState.equipItem = equipItem
  botState.equipInventorySlot = equipItem

  botState.swapInventorySlots = swapInventorySlots
  botState.moveInventorySlot = moveInventorySlot
  botState.mergeInventorySlots = mergeInventorySlots
  botState.moveOneInventoryItem = moveOneInventoryItem
  botState.splitInventorySlot = splitInventorySlot
  botState.pickupInventorySlot = pickupInventorySlot
  botState.placeCursorItem = placeCursorItem
  botState.batchInventoryActions = batchInventoryActions

  botState.dropInventorySlot = dropInventorySlot
  botState.dropOneInventoryItem = dropOneInventoryItem

  botState.destroyInventorySlot = destroyInventorySlot
  botState.destroyOneInventoryItem = destroyOneInventoryItem

  botState.inventoryActionHelpers = {
    send: sendItemStackRequest,
    sendStandalone: sendStandaloneItemStackRequest,
    wait: waitForItemStackResponse,
    waitRaw: waitForRawItemStackResponse,
    batch: batchInventoryActions,
    makeRequest,
    takeAction,
    placeAction,
    swapAction,
    dropAction,
    destroyAction,
    cursorSlotInfo,
    stackSlotInfo: playerStackRequestSlotInfo,
    cloneItem,
    setStackId,
    maxStackSize,
    sameItem,
    responseStatusOk: itemStackResponseStatusOk,
    parseItemStackResponsePacket
  }

  botState.setInventoryActionResponseTimeout = ms => {
    responseTimeoutMs = ms
  }

  botState.setInventoryActionUpdateTimeout = ms => {
    inventoryUpdateTimeoutMs = ms
  }

  botState.clearInventoryActionWaiters = clearInventoryActionWaiters
  botState.shouldDeferInventoryStackResponse = response => pendingTransactions.has(response?.request_id)
  botState._attachInventoryActions = attachInventoryActions
  attachInventoryActions()

  client.on('close', clearInventoryActionWaiters)
}
