// builtins/inventory-actions.js
// Auto-loaded by plugin-loader.
//
// Active inventory behavior layer for server-authoritative Bedrock inventory.
// Keeps inventory.js as the passive mirror and sends real item_stack_request
// actions through player_auth_input via auth-input.js.
//
// Provides:
//   botState.sendItemStackRequest(request)
//   botState.sendStandaloneItemStackRequest(request)
//   botState.waitForItemStackResponse(requestId)
//   botState.waitForRawItemStackResponse(requestId)
//   botState.setHeldItemSlot(slot)
//   botState.selectHotbarSlot(slot)
//   botState.equipItem(slot, [hotbarSlot])
//   botState.equipInventorySlot(slot, [hotbarSlot])
//   botState.swapInventorySlots(slotA, slotB)
//   botState.moveInventorySlot(fromSlot, toSlot)
//   botState.mergeInventorySlots(fromSlot, toSlot)
//   botState.moveOneInventoryItem(fromSlot, toSlot)
//   botState.splitInventorySlot(fromSlot, toSlot)
//   botState.dropInventorySlot(slot)
//   botState.dropOneInventoryItem(slot)
//   botState.destroyInventorySlot(slot)
//   botState.destroyOneInventoryItem(slot)

const {
  cloneItem,
  itemStackResponseStatusOk,
  itemToRaw,
  logAction,
  maxStackSize,
  parseItemStackResponsePacket,
  responseInventorySlots,
  selfRuntimeEntityId,
  sameItem,
  stackRequestSlotInfo
} = require('../utils')

module.exports = function inventoryActionsPlugin (botState, options = {}) {
  const client = botState.client

  let nextRequestId = options.inventoryRequestIdStart ?? 1
  let responseTimeoutMs = options.inventoryResponseTimeoutMs ?? 5000
  let inventoryUpdateTimeoutMs = options.inventoryUpdateTimeoutMs ?? 3000

  const pendingResponses = new Map()
  const pendingSlotUpdates = new Set()

  function requestId () {
    return nextRequestId++
  }

  function itemAt (slot) {
    return botState.inventory.slots[slot]
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

  function queueRequestInAuthInput (request) {
    botState.queuePlayerAuthInputEdit(packet => {
      botState.setAuthInputFlag(packet, 'item_stack_request', true)
      packet.item_stack_request = request
    })

    botState.flushPlayerAuthInput()
  }

  function sendItemStackRequest (request) {
    queueRequestInAuthInput(request)
    botState.emit('inventory_action_request', request)

    logAction('[inventory-actions]', 'item_stack_request', {
      requestId: request.request_id,
      actions: request.actions.map(action => action.type_id)
    })

    return request.request_id
  }

  function sendStandaloneItemStackRequest (request) {
    client.queue('item_stack_request', {
      requests: [request]
    })
    botState.emit('inventory_action_request', request)

    logAction('[inventory-actions]', 'standalone item_stack_request', {
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
      item: itemToRaw(item, botState.itemClass),
      slot,
      selected_slot: slot,
      window_id: 'inventory'
    })

    botState.heldItemSlot = slot
    botState.emit('held_item_slot_changed', slot, item)

    logAction('[inventory-actions]', 'mob_equipment', {
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

  function applyServerSlotInfo (response, changedSlots) {
    const serverSlots = responseInventorySlots(response, { containerIds: ['inventory', 'hotbar'] })

    for (const slot of changedSlots) {
      const serverSlot = serverSlots.get(slot)
      if (!serverSlot) continue

      const item = botState.inventory.slots[slot]
      if (!item || serverSlot.count === 0) {
        botState.inventory.updateSlot(slot, null)
        continue
      }

      const updated = setStackId(cloneItem(item, serverSlot.count), serverSlot.item_stack_id)
      botState.inventory.updateSlot(slot, updated)
    }
  }

  function applyConfirmedAction (action) {
    if (action.type_id === 'swap') {
      const sourceSlot = action.source.slot
      const destinationSlot = action.destination.slot
      const source = itemAt(sourceSlot)
      const destination = itemAt(destinationSlot)

      botState.inventory.updateSlot(sourceSlot, cloneItem(destination))
      botState.inventory.updateSlot(destinationSlot, cloneItem(source))
      return [sourceSlot, destinationSlot]
    }

    if (action.type_id === 'take' || action.type_id === 'place') {
      const sourceSlot = action.source.slot
      const destinationSlot = action.destination.slot
      const source = itemAt(sourceSlot)
      const destination = itemAt(destinationSlot)
      const count = action.count

      botState.inventory.updateSlot(sourceSlot, cloneItem(source, (source?.count || 0) - count))

      if (destination) {
        botState.inventory.updateSlot(destinationSlot, cloneItem(destination, destination.count + count))
      } else {
        botState.inventory.updateSlot(destinationSlot, cloneItem(source, count))
      }

      return [sourceSlot, destinationSlot]
    }

    if (action.type_id === 'drop' || action.type_id === 'destroy') {
      const sourceSlot = action.source.slot
      const source = itemAt(sourceSlot)
      botState.inventory.updateSlot(sourceSlot, cloneItem(source, (source?.count || 0) - action.count))
      return [sourceSlot]
    }

    return []
  }

  function applyConfirmedRequest (request, response, changedSlots) {
    const appliedSlots = new Set()

    for (const action of request.actions) {
      for (const slot of applyConfirmedAction(action)) {
        appliedSlots.add(slot)
      }
    }

    for (const slot of changedSlots) {
      appliedSlots.add(slot)
    }

    applyServerSlotInfo(response, appliedSlots)
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
        waiter.reject(new Error(`item_stack_response rejected request ${id}: ${response.status}`))
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

  async function transactInventory (request, changedSlots) {
    const id = sendItemStackRequest(request)
    const response = await waitForItemStackResponse(id)
    applyConfirmedRequest(request, response, changedSlots)
    return response
  }

  function makeRequest (actions) {
    return {
      request_id: requestId(),
      actions,
      custom_names: [],
      cause: 'chat_public'
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

  async function swapInventorySlots (slotA, slotB) {
    const source = stackRequestSlotInfo(slotA, itemAt(slotA))
    const destination = stackRequestSlotInfo(slotB, itemAt(slotB))

    const request = makeRequest([
      swapAction(source, destination)
    ])

    return transactInventory(request, [slotA, slotB])
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

  async function moveInventorySlot (fromSlot, toSlot) {
    const source = stackRequestSlotInfo(fromSlot, itemAt(fromSlot))
    const destination = stackRequestSlotInfo(toSlot, itemAt(toSlot))

    const request = makeRequest([
      takeAction(itemAt(fromSlot).count, source, destination)
    ])

    return transactInventory(request, [fromSlot, toSlot])
  }

  async function mergeInventorySlots (fromSlot, toSlot) {
    const from = itemAt(fromSlot)
    const to = itemAt(toSlot)
    const count = Math.min(from.count, maxStackSize(to) - to.count)

    const request = makeRequest([
      takeAction(count, stackRequestSlotInfo(fromSlot, from), stackRequestSlotInfo(toSlot, to))
    ])

    return transactInventory(request, [fromSlot, toSlot])
  }

  async function moveOneInventoryItem (fromSlot, toSlot) {
    const from = itemAt(fromSlot)
    const to = itemAt(toSlot)

    const source = stackRequestSlotInfo(fromSlot, from)
    const destination = stackRequestSlotInfo(toSlot, to)

    const request = makeRequest([
      takeAction(1, source, destination)
    ])

    return transactInventory(request, [fromSlot, toSlot])
  }

  async function splitInventorySlot (fromSlot, toSlot) {
    const count = Math.ceil(itemAt(fromSlot).count / 2)

    const request = makeRequest([
      takeAction(count, stackRequestSlotInfo(fromSlot, itemAt(fromSlot)), stackRequestSlotInfo(toSlot, itemAt(toSlot)))
    ])

    return transactInventory(request, [fromSlot, toSlot])
  }

  async function dropInventorySlot (slot, randomly = false) {
    const request = makeRequest([
      dropAction(itemAt(slot).count, stackRequestSlotInfo(slot, itemAt(slot)), randomly)
    ])

    return transactInventory(request, [slot])
  }

  async function dropOneInventoryItem (slot, randomly = false) {
    const request = makeRequest([
      dropAction(1, stackRequestSlotInfo(slot, itemAt(slot)), randomly)
    ])

    return transactInventory(request, [slot])
  }

  async function destroyInventorySlot (slot) {
    const request = makeRequest([
      dropAction(itemAt(slot).count, stackRequestSlotInfo(slot, itemAt(slot)), false)
    ])

    return transactInventory(request, [slot])
  }

  async function destroyOneInventoryItem (slot) {
    const request = makeRequest([
      dropAction(1, stackRequestSlotInfo(slot, itemAt(slot)), false)
    ])

    return transactInventory(request, [slot])
  }

  function clearInventoryActionWaiters () {
    for (const waiter of pendingResponses.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error('Inventory action waiters cleared'))
    }

    pendingResponses.clear()
    pendingSlotUpdates.clear()
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

  botState.dropInventorySlot = dropInventorySlot
  botState.dropOneInventoryItem = dropOneInventoryItem

  botState.destroyInventorySlot = destroyInventorySlot
  botState.destroyOneInventoryItem = destroyOneInventoryItem

  botState.inventoryActionHelpers = {
    makeRequest,
    takeAction,
    placeAction,
    swapAction,
    dropAction,
    destroyAction,
    stackSlotInfo: stackRequestSlotInfo,
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

  client.on('close', clearInventoryActionWaiters)
}
