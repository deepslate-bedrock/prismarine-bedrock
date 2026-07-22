// builtins/containers/index.js
// Generic Bedrock container window helpers. Inventory request construction and
// response waiting are delegated to inventory-actions.js.

const { Vec3 } = require('vec3')
const {
  blockFaceFromEye,
  clickPositionForFace,
  getBlockRuntimeId,
  itemToRawWithoutStackId,
  lookPositionForFace,
  positionForFace,
  raycastBlock,
  sleep,
  toVec3f
} = require('../../utils')
const {
  containerSlotInfoFor,
  containerSlotTypeFor,
  normalizeWindowId
} = require('../../container-metadata')
const specializeContainer = require('./specialize')

function lookPositionForClick (pos, clickPos) {
  const target = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z)
  return target.offset(clickPos.x, clickPos.y, clickPos.z)
}

function blockAt (botState, target) {
  try {
    const world = botState.world?.sync || botState.world
    return world?.getBlock?.(target) ?? null
  } catch {
    return null
  }
}

function raycastTargetBlock (botState, target, opts = {}) {
  const playerPos = botState.self?.position ?? botState.playerState?.spawnPosition
  return raycastBlock(
    playerPos,
    target,
    botState.self?.yaw ?? 0,
    botState.self?.pitch ?? 0,
    {
      block: opts.block ?? blockAt(botState, target),
      shapeOverride: opts.shapeOverride
    }
  )
}

module.exports = function containersPlugin (botState, options = {}) {
  const client = botState.client
  const openTimeoutMs = options.containerOpenTimeoutMs ?? 5000
  const contentTimeoutMs = options.containerContentTimeoutMs ?? 1500

  let activeContainer = null
  const openContainers = new Map()
  const pendingContainerData = new Map()

  function helpers () {
    const inventoryActions = botState.inventory?.actions ?? botState.inventoryActionHelpers
    if (!inventoryActions) {
      throw new Error('inventory-actions builtin is required before using container actions')
    }
    return inventoryActions
  }

  function waitForContainerOpen (predicate = () => true, timeoutMs = openTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for container_open'))
      }, timeoutMs)

      function onOpen (packet) {
        if (!predicate(packet)) return
        cleanup()
        resolve(packet)
      }

      function cleanup () {
        clearTimeout(timeout)
        client.off('container_open', onOpen)
      }

      client.on('container_open', onOpen)
    })
  }

  function waitForInventoryContent (windowId, timeoutMs = contentTimeoutMs) {
    const id = normalizeWindowId(windowId)
    const win = botState.windows?.get(id)
    if (win?.lastContentAt) return Promise.resolve(true)

    return new Promise(resolve => {
      const timeout = setTimeout(() => cleanup(false), timeoutMs)

      function onContent (packet) {
        if (normalizeWindowId(packet.window_id) !== id) return
        cleanup(true)
      }

      function onContentUpdated (updatedWindowId) {
        if (normalizeWindowId(updatedWindowId) !== id) return
        cleanup(true)
      }

      function cleanup (seen) {
        clearTimeout(timeout)
        client.off('inventory_content', onContent)
        botState.off('inventory_content_updated', onContentUpdated)
        resolve(seen)
      }

      client.on('inventory_content', onContent)
      botState.on('inventory_content_updated', onContentUpdated)
    })
  }

  function sendOpenBlockContainer (pos, face, opts = {}) {
    const target = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z)
    const resultPosition = Number.isInteger(face) ? positionForFace(target, face) : target
    const heldSlot = botState.heldItemSlot ?? 0
    const heldItem = botState.inventory?.slots?.[heldSlot] ?? null
    const playerPos = botState.self?.position ?? botState.playerState?.spawnPosition
    const rayHit = raycastTargetBlock(botState, target, opts)
    const clickPos = opts.clickPosition ?? (rayHit?.face === face ? rayHit.clickPosition : null) ?? clickPositionForFace(face)
    const runtimeEntityId = client.entityId ?? botState.self?.runtimeId ?? 0n

    client.queue('player_action', {
      runtime_entity_id: runtimeEntityId,
      action: 'start_item_use_on',
      position: { x: target.x, y: target.y, z: target.z },
      result_position: { x: resultPosition.x, y: resultPosition.y, z: resultPosition.z },
      face
    })

    client.queue('animate', {
      action_id: 'swing_arm',
      runtime_entity_id: runtimeEntityId,
      data: 0,
      has_swing_source: true,
      swing_source: 'interact'
    })

    client.queue('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0, legacy_transactions: [] },
        transaction_type: 'item_use',
        actions: [],
        transaction_data: {
          action_type: 'click_block',
          trigger_type: 'player_input',
          block_position: { x: target.x, y: target.y, z: target.z },
          face,
          hotbar_slot: heldSlot,
          held_item: itemToRawWithoutStackId(heldItem, botState.itemClass, {
            hasStackId: 'always',
            logAction: botState.logAction
          }),
          player_pos: toVec3f(playerPos),
          click_pos: clickPos,
          block_runtime_id: getBlockRuntimeId(botState, target, {
            blockName: opts.blockName,
            blockRuntimeId: opts.blockRuntimeId
          }),
          client_prediction: 'success',
          client_cooldown_state: 0
        }
      }
    })

    botState.logAction?.('[containers]', 'open block container', { pos: target, face })

    return () => {
      client.queue('player_action', {
        runtime_entity_id: runtimeEntityId,
        action: 'stop_item_use_on',
        position: { x: resultPosition.x, y: resultPosition.y, z: resultPosition.z },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0
      })
    }
  }

  async function ensureContainerOpenHeldSlot (opts = {}) {
    const heldSlot = botState.heldItemSlot ?? 0
    if (opts.preserveHeldSlot || botState.inventory?.slots?.[heldSlot]) return
    if (typeof botState.setHeldItemSlot !== 'function') return

    for (let slot = 0; slot < 9; slot++) {
      if (!botState.inventory?.slots?.[slot]) continue
      botState.setHeldItemSlot(slot)
      await sleep(opts.heldSlotSettleMs ?? 50)
      return
    }
  }

  function wrapContainerWindow (packet) {
    const windowId = normalizeWindowId(packet.window_id)
    const window = botState.windows?.get(windowId)
    if (!window) throw new Error(`Container window ${windowId} was not created`)

    const existing = openContainers.get(windowId)
    if (existing) {
      existing.type = packet.window_type
      existing.containerSlotType = containerSlotTypeFor({
        windowType: packet.window_type,
        blockName: blockNameAt(packet.coordinates)
      })
      existing.position = packet.coordinates
      existing.window = window
      existing.lastOpenPacket = packet
      activeContainer = existing
      botState.currentContainer = existing
      replayPendingContainerData(windowId)
      return existing
    }

    const container = createContainerWindow(packet, window)
    activeContainer = container
    openContainers.set(windowId, container)
    botState.currentContainer = container

    replayPendingContainerData(windowId)

    return container
  }

  async function openContainer (pos, opts = {}) {
    const target = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z)
    let face = opts.face
    const initialFace = face ?? blockFaceFromEye(botState.self.position, target, { verticalMode: 'centered' })
    const openPromise = waitForContainerOpen(packet => {
      if (!opts.type) return true
      return packet.window_type === opts.type
    }, opts.timeoutMs ?? openTimeoutMs)

    if (typeof botState.lookAt === 'function' && opts.look !== false) {
      const lookPosition = opts.lookPosition ||
        (opts.clickPosition ? lookPositionForClick(target, opts.clickPosition) : lookPositionForFace(target, initialFace))
      botState.lookAt(lookPosition, false)
      if (typeof botState.waitForLookComplete === 'function') {
        await botState.waitForLookComplete()
      }
      await sleep(opts.lookSettleMs ?? 100)
    }

    face ??= raycastTargetBlock(botState, target, opts)?.face ?? initialFace

    await ensureContainerOpenHeldSlot(opts)

    const stopItemUse = sendOpenBlockContainer(target, face, opts)
    let packet
    try {
      packet = await openPromise
    } finally {
      stopItemUse?.()
    }

    const container = wrapContainerWindow(packet)
    await waitForInventoryContent(container.id, opts.contentTimeoutMs ?? contentTimeoutMs)
    return container
  }

  function createContainerWindow (packet, window) {
    const windowId = normalizeWindowId(packet.window_id)
    const windowType = packet.window_type
    const containerSlotType = containerSlotTypeFor({
      windowType,
      blockName: blockNameAt(packet.coordinates)
    })

    const api = {
      id: windowId,
      windowId,
      botState,
      type: windowType,
      containerSlotType,
      position: packet.coordinates,
      window,
      properties: {},
      data: {},
      lastDataPacket: null,
      lastOpenPacket: packet,

      get containerSlotCount () {
        return window.inventoryStart
      },

      get slots () {
        return window.slots
      },

      getItem (slot) {
        assertContainerSlot(api, slot)
        return window.slots[slot] ?? null
      },

      getInventoryItem (slot) {
        assertInventorySlot(slot)
        return botState.inventory.slots[slot] ?? null
      },

      firstEmptyContainerSlot () {
        return firstEmpty(window, 0, window.inventoryStart)
      },

      firstEmptyInventorySlot () {
        return firstEmpty(botState.inventory, 0, botState.inventory.slots.length)
      },

      findContainerItem (name) {
        return findByName(window, 0, window.inventoryStart, name)
      },

      putInventorySlot (inventorySlot, containerSlot = api.firstEmptyContainerSlot(), count) {
        return transfer({
          source: inventoryRef(inventorySlot),
          destination: containerRef(api, containerSlot),
          count
        })
      },

      depositInventorySlot (inventorySlot, containerSlot, count) {
        return api.putInventorySlot(inventorySlot, containerSlot, count)
      },

      takeContainerSlot (containerSlot, inventorySlot = api.firstEmptyInventorySlot(), count) {
        return transfer({
          source: containerRef(api, containerSlot),
          destination: inventoryRef(inventorySlot),
          count
        })
      },

      withdrawContainerSlot (containerSlot, inventorySlot, count) {
        return api.takeContainerSlot(containerSlot, inventorySlot, count)
      },

      moveContainerSlot (fromSlot, toSlot, count) {
        return transfer({
          source: containerRef(api, fromSlot),
          destination: containerRef(api, toSlot),
          count
        })
      },

      swapContainerSlots (slotA, slotB) {
        return swap(containerRef(api, slotA), containerRef(api, slotB))
      },

      waitForContent (timeoutMs) {
        return waitForInventoryContent(windowId, timeoutMs)
      },

      close () {
        client.queue('container_close', {
          window_id: windowId,
          window_type: windowType,
          server: false
        })
      }
    }

    return specializeContainer(api)
  }

  function blockNameAt (position) {
    if (position) {
      try {
        const block = botState.world.getBlock(new Vec3(position.x, position.y, position.z))
        return block?.name
      } catch {}
    }

    return null
  }

  function assertInventorySlot (slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= botState.inventory.slots.length) {
      throw new RangeError(`inventory slot must be between 0 and ${botState.inventory.slots.length - 1}`)
    }
  }

  function assertContainerSlot (container, slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= container.containerSlotCount) {
      throw new RangeError(`container slot must be between 0 and ${container.containerSlotCount - 1}`)
    }
  }

  function firstEmpty (window, start, end) {
    for (let slot = start; slot < end; slot++) {
      if (!window.slots[slot]) return slot
    }
    return -1
  }

  function findByName (window, start, end, name) {
    for (let slot = start; slot < end; slot++) {
      if (window.slots[slot]?.name === name) return slot
    }
    return -1
  }

  function inventoryRef (slot) {
    assertInventorySlot(slot)
    return {
      kind: 'inventory',
      window: botState.inventory,
      slot,
      protocolSlot: slot,
      containerId: slot < 9 ? 'hotbar' : 'inventory'
    }
  }

  function containerRef (container, slot) {
    assertContainerSlot(container, slot)
    const slotInfo = containerSlotInfoFor(container, slot)
    return {
      kind: 'container',
      window: container.window,
      slot,
      protocolSlot: slotInfo.protocolSlot,
      containerId: slotInfo.containerId
    }
  }

  function refItem (ref) {
    return ref.window.slots[ref.slot] ?? null
  }

  function updateRef (ref, item) {
    ref.window.updateSlot(ref.slot, item)
  }

  function requestSlot (ref) {
    return helpers().stackSlotInfo(ref.protocolSlot, refItem(ref), ref.containerId)
  }

  function validateTransfer (sourceRef, destinationRef, count) {
    const source = refItem(sourceRef)
    if (!source) throw new Error(`No item in ${sourceRef.kind} slot ${sourceRef.slot}`)

    const destination = refItem(destinationRef)
    const amount = count ?? source.count
    if (!Number.isInteger(amount) || amount <= 0 || amount > source.count) {
      throw new RangeError(`count must be between 1 and ${source.count}`)
    }

    if (destination && !helpers().sameItem(source, destination)) {
      throw new Error(`Destination slot ${destinationRef.slot} already contains ${destination.name}`)
    }

    if (destination) {
      const space = helpers().maxStackSize(destination) - destination.count
      if (amount > space) throw new Error(`Destination slot ${destinationRef.slot} only has room for ${space}`)
    }

    return amount
  }

  async function transfer ({ source, destination, count }) {
    const amount = validateTransfer(source, destination, count)
    const sourceItem = helpers().cloneItem(refItem(source))
    const destinationItem = helpers().cloneItem(refItem(destination))
    const action = helpers().takeAction(amount, requestSlot(source), requestSlot(destination))
    const request = helpers().makeRequest([action])
    const id = helpers().sendStandalone(request)
    const response = await helpers().wait(id)

    applyTransfer(source, destination, amount, sourceItem, destinationItem)
    applyServerSlots(response, [source, destination])
    return response
  }

  async function swap (source, destination) {
    const sourceItem = helpers().cloneItem(refItem(source))
    const destinationItem = helpers().cloneItem(refItem(destination))
    const action = helpers().swapAction(requestSlot(source), requestSlot(destination))
    const request = helpers().makeRequest([action])
    const id = helpers().sendStandalone(request)
    const response = await helpers().wait(id)

    updateRef(source, helpers().cloneItem(destinationItem))
    updateRef(destination, helpers().cloneItem(sourceItem))
    applyServerSlots(response, [source, destination])
    return response
  }

  function applyTransfer (sourceRef, destinationRef, count, source, destination) {
    if (!source) return

    updateRef(sourceRef, helpers().cloneItem(source, source.count - count))
    if (destination) {
      updateRef(destinationRef, helpers().cloneItem(destination, destination.count + count))
    } else {
      updateRef(destinationRef, helpers().cloneItem(source, count))
    }
  }

  function applyServerSlots (response, refs) {
    const byContainer = new Map()
    for (const container of response.containers || []) {
      byContainer.set(container.slot_type?.container_id, container.slots || [])
    }

    for (const ref of refs) {
      const slots = byContainer.get(ref.containerId)
      if (!slots) continue
      const serverSlot = slots.find(slot => slot.slot === ref.protocolSlot)
      if (!serverSlot) continue

      const item = refItem(ref)
      if (!item || serverSlot.count === 0) {
        updateRef(ref, null)
      } else {
        updateRef(ref, helpers().setStackId(helpers().cloneItem(item, serverSlot.count), serverSlot.item_stack_id))
      }
    }
  }

  function packetProperty (packet) {
    return packet.property ??
      packet.property_id ??
      packet.propertyId ??
      packet.data_id ??
      packet.dataId
  }

  function packetValue (packet) {
    return packet.value ??
      packet.data ??
      packet.data_value ??
      packet.dataValue
  }

  function getContainerForWindowId (windowId) {
    const id = normalizeWindowId(windowId)

    if (activeContainer?.id === id) return activeContainer
    if (botState.currentContainer?.id === id) return botState.currentContainer

    return openContainers.get(id) ?? null
  }

  function bufferContainerSetData (windowId, packet) {
    const pending = pendingContainerData.get(windowId) ?? []
    pending.push(packet)
    pendingContainerData.set(windowId, pending)

    botState.logAction?.('[containers]', 'buffered container_set_data for pending container', {
      windowId,
      keys: Object.keys(packet),
      pending: pending.length
    })
  }

  function replayPendingContainerData (windowId) {
    const id = normalizeWindowId(windowId)
    const pending = pendingContainerData.get(id)
    if (!pending || pending.length === 0) return

    pendingContainerData.delete(id)

    botState.logAction?.('[containers]', 'replaying buffered container_set_data', {
      windowId: id,
      count: pending.length
    })

    for (const packet of pending) {
      handleContainerSetData(packet)
    }
  }

  function handleContainerSetData (packet) {
    const windowId = normalizeWindowId(packet.window_id)
    const container = getContainerForWindowId(windowId)

    if (!container) {
      bufferContainerSetData(windowId, packet)
      return
    }

    const property = packetProperty(packet)
    const value = packetValue(packet)

    if (property == null || value == null) {
      botState.logAction?.('[containers]', 'container_set_data missing property/value', {
        windowId,
        type: container.type,
        keys: Object.keys(packet)
      })
      return
    }

    container.properties ??= {}
    container.data ??= {}
    container.properties[property] = value
    container.lastDataPacket = packet

    const handled = container.handleContainerData?.(property, value, packet) === true

    botState.emit('container_data', {
      windowId,
      container,
      property,
      value,
      packet,
      handled
    })

    if (!handled) {
      botState.logAction?.('[containers]', 'container_set_data', {
        windowId,
        type: container.type,
        property,
        value
      })
    }
  }

  botState.openContainer = openContainer
  botState.openBlockContainer = openContainer
  botState.getCurrentContainer = () => activeContainer
  botState.containers = {
    waitForOpen: waitForContainerOpen,
    wrapWindow: wrapContainerWindow,
    get: windowId => getContainerForWindowId(windowId),
    open: openContainers
  }

  botState.on('inventory_trade_window_updated', (_windowId, _win, packet) => {
    wrapContainerWindow(packet)
  })

  client.on('container_set_data', handleContainerSetData)

  client.on('player_enchant_options', packet => {
    const container = activeContainer ?? botState.currentContainer
    const handled = container?.handlePlayerEnchantOptions?.(packet) === true

    botState.emit('player_enchant_options', {
      container: handled ? container : null,
      packet,
      handled
    })

    if (!handled) {
      botState.logAction?.('[containers]', 'unhandled player_enchant_options', {
        optionCount: packet.options?.length ?? 0
      })
    }
  })

  client.on('container_close', packet => {
    const windowId = normalizeWindowId(packet.window_id)
    const container = getContainerForWindowId(windowId)

    if (container?.handleContainerClose) {
      container.handleContainerClose(packet)
    }

    openContainers.delete(windowId)
    pendingContainerData.delete(windowId)

    if (activeContainer?.id === windowId) {
      activeContainer = null
      botState.currentContainer = null
    }
  })
}
