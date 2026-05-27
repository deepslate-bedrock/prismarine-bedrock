const { itemStackId } = require('./item')

function selfRuntimeEntityId (botState) {
  return botState.client?.entityId
}

function fullContainerName (containerId = 'inventory', dynamicContainerId = 0) {
  return {
    container_id: containerId,
    dynamic_container_id: dynamicContainerId
  }
}

function requestSlotInfo (containerId, slot, stackId = 0, dynamicContainerId = 0) {
  return {
    slot_type: fullContainerName(containerId, dynamicContainerId),
    slot,
    stack_id: stackId || 0
  }
}

function inventoryRequestSlotInfo (slot, stackId = 0) {
  return slot < 9
    ? requestSlotInfo('hotbar', slot, stackId)
    : requestSlotInfo('inventory', slot - 9, stackId)
}

function playerInventorySlotInfo (slot, item = null) {
  return inventoryRequestSlotInfo(slot, itemStackId(item))
}

function stackRequestSlotInfo (slot, item, containerId = 'inventory') {
  return {
    slot_type: fullContainerName(containerId),
    slot,
    stack_id: itemStackId(item)
  }
}

function parseItemStackResponsePacket (packet) {
  return packet.responses || packet.response || packet.entries || []
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

function responseInventorySlots (response, options = {}) {
  const containerIds = new Set(options.containerIds ?? ['hotbar', 'inventory', 'hotbar_and_inventory'])
  const slots = new Map()

  for (const container of response?.containers || []) {
    const containerId = container.slot_type?.container_id
    if (!containerIds.has(containerId)) continue

    for (const slot of container.slots || []) {
      slots.set(slot.slot, slot)
    }
  }

  return slots
}

module.exports = {
  selfRuntimeEntityId,
  fullContainerName,
  requestSlotInfo,
  inventoryRequestSlotInfo,
  playerInventorySlotInfo,
  stackRequestSlotInfo,
  parseItemStackResponsePacket,
  responseSlot,
  responseStackId,
  responseInventorySlots
}
