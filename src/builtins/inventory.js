// builtins/inventory.js
// Auto-loaded by plugin-loader.
//
// Passive Bedrock/Geyser inventory mirror.
//
// Normal logical windows live in botState.windows:
//   - inventory window 0
//   - persistent player equipment windows: armor 120, offhand 119
//   - container_open windows
//   - update_trade merchant windows
//
// Bedrock ContainerId.UI / 124 is not a normal open/close window.
// It is a shared active-screen UI slot namespace. Geyser uses it for merchant
// slot sync through UIInventoryUpdater, so inventory.js keeps it as uiSlots and
// projects known UI slots into the active logical window using container metadata.

const {
  cloneItem,
  itemStackResponseStatusOk,
  logAction,
  rawStackId,
  responseInventorySlots,
  sameRuntimeId,
  selfRuntimeEntityId
} = require('../utils')
const {
  normalizeWindowId,
  windowInfoFor,
  createContainerDataState,
  updateContainerDataState,
  normalizeContainerDataProperty,
  uiSlotToWindowSlotFor
} = require('../container-metadata')

const UI_WINDOW_ID = normalizeWindowId('ui')
const INVENTORY_WINDOW_ID = normalizeWindowId('inventory')
const ARMOR_WINDOW_ID = normalizeWindowId('armor')
const OFFHAND_WINDOW_ID = normalizeWindowId('offhand')
const PERSISTENT_WINDOW_IDS = new Set([
  INVENTORY_WINDOW_ID,
  ARMOR_WINDOW_ID,
  OFFHAND_WINDOW_ID
])

const PLAYER_EQUIPMENT_WINDOWS = [
  { id: ARMOR_WINDOW_ID, type: 'armor', title: 'Armor', property: 'armor' },
  { id: OFFHAND_WINDOW_ID, type: 'hand', title: 'Offhand', property: 'offhand' }
]

/**
 * @param {import('../state')} botState
 * @param {object} options
 */
function inject (botState, options = {}) {
  const ItemClass = botState.itemClass
  const Window = botState.windowFactory

  const windows = new Map()
  const uiSlots = new Map()

  botState.windows = windows
  botState.uiSlots = uiSlots

  const inv = Window.createWindow(INVENTORY_WINDOW_ID, 'minecraft:inventory', 'Inventory', 36)
  windows.set(INVENTORY_WINDOW_ID, inv)
  botState.inventory = inv

  let activeWindowId = INVENTORY_WINDOW_ID
  let heldItemSlot = 0
  let loggedRawItemIdentity = false
  const logUnchangedUiSlots = options.logUnchangedUiSlots === true

  botState.activeWindowId = activeWindowId
  botState.heldItemSlot = heldItemSlot

  function toItem (raw) {
    if (!raw || raw.network_id === 0) return null

    try {
      const stackId = rawStackId(raw)
      const item = ItemClass.fromNotch(raw, stackId)

      item.stackId = stackId
      item.stack_id = stackId
      item.networkId = raw.network_id
      item.network_id = raw.network_id
      item.blockRuntimeId = raw.block_runtime_id
      item.block_runtime_id = raw.block_runtime_id
      item.raw = raw

      if (stackId == null && !loggedRawItemIdentity) {
        loggedRawItemIdentity = true
        logAction('[inventory]', 'raw item identity fields missing', {
          keys: Object.keys(raw),
          networkId: raw.network_id,
          hasStackId: raw.has_stack_id,
          stack_id: raw.stack_id,
          stackId: raw.stackId,
          stack_network_id: raw.stack_network_id,
          network_stack_id: raw.network_stack_id
        })
      }

      return item
    } catch (e) {
      logAction('[inventory]', 'deserialize error', {
        networkId: raw.network_id,
        error: e.message
      })
      return null
    }
  }

  function itemDesc (item) {
    return item ? `${item.name} x${item.count}` : 'empty'
  }

  function getWindow (windowId) {
    return windows.get(normalizeWindowId(windowId))
  }

  function setActiveWindow (windowId) {
    activeWindowId = normalizeWindowId(windowId)
    botState.activeWindowId = activeWindowId
  }

  function activeWindow () {
    return windows.get(activeWindowId) ?? null
  }

  function attachLogger (win, windowId, label = 'window') {
    if (!win || win.__inventoryLoggerAttached) return
    win.__inventoryLoggerAttached = true

    win.on('updateSlot', (slot, oldItem, newItem) => {
      if (oldItem && !newItem) {
        logAction('[inventory]', `${label} ${windowId} slot ${slot} cleared (was ${oldItem.name} x${oldItem.count})`)
      } else if (!oldItem && newItem) {
        logAction('[inventory]', `${label} ${windowId} slot ${slot} gained ${newItem.name} x${newItem.count}`)
      } else if (oldItem && newItem && oldItem.type !== newItem.type) {
        logAction('[inventory]', `${label} ${windowId} slot ${slot} replaced: ${oldItem.name} x${oldItem.count} → ${newItem.name} x${newItem.count}`)
      } else if (oldItem && newItem && oldItem.count !== newItem.count) {
        logAction('[inventory]', `${label} ${windowId} slot ${slot} count changed: ${oldItem.count} → ${newItem.count}`)
      }
    })
  }

  function createWindow (windowId, windowType, title) {
    const info = windowInfoFor(windowType)
    const win = Window.createWindow(windowId, info.key, title || info.key, info.containerSlots)
    win.windowType = windowType
    win.containerData = createContainerDataState(windowType)
    windows.set(windowId, win)
    return win
  }

  for (const equipmentWindow of PLAYER_EQUIPMENT_WINDOWS) {
    const win = createWindow(equipmentWindow.id, equipmentWindow.type, equipmentWindow.title)
    botState[equipmentWindow.property] = win
    attachLogger(win, equipmentWindow.id, equipmentWindow.property)
  }

  function ensureWindow (windowId, windowType, title) {
    const id = normalizeWindowId(windowId)
    let win = windows.get(id)

    if (!win) {
      const info = windowInfoFor(windowType)
      win = createWindow(id, windowType, title || (info.fallback ? `Container ${id}` : info.key))
      attachLogger(win, id)
    }

    win.windowType = windowType
    win.containerData ??= createContainerDataState(windowType)
    return win
  }

  function resizeFromContentIfNeeded (win, windowId, slots) {
    if (windowId === 0 || slots.length <= win.inventoryStart) return

    win.inventoryStart = slots.length
    win.inventoryEnd = slots.length + 36
    win.hotbarStart = win.inventoryEnd - 9
    win.slots.length = win.inventoryEnd

    for (let i = 0; i < win.slots.length; i++) {
      if (win.slots[i] === undefined) win.slots[i] = null
    }

    logAction('[inventory]', 'resized container window from content', {
      windowId,
      containerSlots: slots.length,
      totalSlots: win.slots.length
    })
  }

  function projectUiSlotToActiveWindow (uiSlot, item, packet) {
    const win = activeWindow()
    if (!win || !win.windowType) return false

    const windowSlot = uiSlotToWindowSlotFor(win.windowType, uiSlot)
    if (windowSlot == null) return false

    win.updateSlot(windowSlot, item)

    botState.emit('ui_slot_projected', {
      windowId: activeWindowId,
      windowType: win.windowType,
      uiSlot,
      windowSlot,
      item,
      packet
    })

    return true
  }

  function projectKnownUiSlotsToActiveWindow () {
    for (const [uiSlot, item] of uiSlots) {
      projectUiSlotToActiveWindow(uiSlot, item, null)
    }
  }

  function handleUiSlot (packet) {
    const item = toItem(packet.item)
    const hadPrevious = uiSlots.has(packet.slot)
    const previous = uiSlots.get(packet.slot) ?? null
    const previousDesc = itemDesc(previous)
    uiSlots.set(packet.slot, item)

    const projected = projectUiSlotToActiveWindow(packet.slot, item, packet)
    const nextDesc = itemDesc(item)

    if (logUnchangedUiSlots || !hadPrevious || previousDesc !== nextDesc) {
      logAction('[inventory]', 'ui_slot', {
        slot: packet.slot,
        item: nextDesc,
        projected
      })
    }

    botState.emit('ui_slot_updated', packet.slot, item, packet)
  }

  function handleUiContent (packet) {
    const slots = packet.input

    for (let i = 0; i < slots.length; i++) {
      const item = toItem(slots[i])
      uiSlots.set(i, item)
      projectUiSlotToActiveWindow(i, item, packet)
    }

    logAction('[inventory]', 'ui_content', { slots: slots.length })
    botState.emit('ui_content_updated', uiSlots, packet)
  }

  function applyItemStackResponseToInventory (response) {
    const serverSlots = responseInventorySlots(response)

    for (const slot of serverSlots.keys()) {
      const item = inv.slots[slot]
      const serverSlot = serverSlots.get(slot)

      if (serverSlot) {
        if (serverSlot.count === 0) {
          inv.updateSlot(slot, null)
          continue
        }
        if (!item) continue

        const updated = cloneItem(item, serverSlot.count)
        updated.stackId = serverSlot.item_stack_id
        updated.stack_id = serverSlot.item_stack_id
        inv.updateSlot(slot, updated)
      }
    }

    botState.emit('inventory_response_applied', response, [...serverSlots.keys()])
  }

  Object.defineProperty(botState, 'heldItem', {
    get () {
      const slot = botState.heldItemSlot
      if (slot == null) return null
      return botState.inventory?.slots[slot] ?? null
    },
    enumerable: true,
    configurable: true
  })

  botState.getWindow = function (windowId = 0) {
    return getWindow(windowId) ?? null
  }

  botState.getUiSlot = function (slot) {
    return uiSlots.get(slot) ?? null
  }

  botState.getItem = function (slot, windowId = 0) {
    const win = getWindow(windowId)
    return win?.slots[slot] ?? null
  }

  botState.findItem = function (itemType, metadata, notFull, nbt, windowId = 0) {
    const win = getWindow(windowId)
    if (!win) return null
    return win.findItemRange(win.inventoryStart, win.inventoryEnd, itemType, metadata, notFull, nbt)
  }

  botState.count = function (itemType, metadata, windowId = 0) {
    const win = getWindow(windowId)
    return win ? win.count(itemType, metadata) : 0
  }

  botState.applyItemStackResponseToInventory = applyItemStackResponseToInventory

  botState.client.on('item_stack_response', (packet) => {
    for (const response of packet.responses || []) {
      if (itemStackResponseStatusOk(response)) applyItemStackResponseToInventory(response)
    }
  })

  botState.client.on('inventory_content', (packet) => {
    const windowId = normalizeWindowId(packet.window_id)

    if (windowId === UI_WINDOW_ID) {
      handleUiContent(packet)
      return
    }

    const win = getWindow(windowId)
    if (!win) {
      logAction('[inventory]', 'inventory_content for unknown window', { windowId })
      return
    }

    const slots = packet.input
    resizeFromContentIfNeeded(win, windowId, slots)

    logAction('[inventory]', `inventory_content: window=${windowId}, ${slots.length} slots`)

    for (let i = 0; i < Math.min(slots.length, win.slots.length); i++) {
      win.updateSlot(i, toItem(slots[i]))
    }

    win.lastContentAt = Date.now()
    botState.emit('inventory_content_updated', windowId, win)
  })

  botState.client.on('inventory_slot', (packet) => {
    const windowId = normalizeWindowId(packet.window_id)

    if (windowId === UI_WINDOW_ID) {
      handleUiSlot(packet)
      return
    }

    const win = getWindow(windowId)
    if (!win) {
      logAction('[inventory]', 'inventory_slot for unknown window', { windowId })
      return
    }

    const item = toItem(packet.item)
    logAction('[inventory]', `inventory_slot: window=${windowId}, slot=${packet.slot}, item=${itemDesc(item)}`)
    win.updateSlot(packet.slot, item)
  })

  botState.client.on('mob_equipment', (packet) => {
    if (!sameRuntimeId(packet.runtime_entity_id, selfRuntimeEntityId(botState))) return
    if (typeof packet.slot !== 'number') return

    const item = toItem(packet.item)
    logAction('[inventory]', `mob_equipment: slot=${packet.slot}, selected=${packet.selected_slot}, item=${itemDesc(item)}`)

    windows.get(0)?.updateSlot(packet.slot, item)

    if (typeof packet.selected_slot === 'number') {
      heldItemSlot = packet.selected_slot
      botState.heldItemSlot = heldItemSlot
    }
  })

  botState.client.on('container_open', (packet) => {
    const windowId = normalizeWindowId(packet.window_id)
    const windowType = packet.window_type
    const win = ensureWindow(windowId, windowType)

    setActiveWindow(windowId)

    logAction('[inventory]', `container_open: id=${windowId}, type=${windowType}, slots=${win.slots.length}`)
  })

  botState.client.on('update_trade', (packet) => {
    const windowId = normalizeWindowId(packet.window_id)
    const win = ensureWindow(windowId, packet.window_type || 'trading', packet.display_name || 'Trading')

    win.lastUpdateTrade = packet
    win.displayName = packet.display_name
    win.tradeTier = packet.trade_tier
    win.newTradingUi = packet.new_trading_ui
    win.economicTrades = packet.economic_trades

    setActiveWindow(windowId)
    projectKnownUiSlotsToActiveWindow()

    logAction('[inventory]', 'trade_window_open', {
      windowId,
      type: win.windowType,
      slots: win.slots.length,
      displayName: packet.display_name
    })

    botState.emit('inventory_trade_window_updated', windowId, win, packet)
  })

  botState.client.on('container_set_data', (packet) => {
    const windowId = normalizeWindowId(packet.window_id)
    const win = getWindow(windowId)

    if (!win) {
      logAction('[inventory]', 'container_set_data for unknown window', { windowId })
      return
    }

    const property = normalizeContainerDataProperty(packet.property)
    win.containerData = updateContainerDataState(win.windowType, win.containerData, property, packet.value)

    botState.emit('container_data_updated', windowId, win.containerData, packet)
  })

  botState.client.on('container_close', (packet) => {
    const windowId = normalizeWindowId(packet.window_id)

    if (windowId === UI_WINDOW_ID) {
      logAction('[inventory]', 'container_close ignored for ui container', { windowId })
      return
    }

    if (PERSISTENT_WINDOW_IDS.has(windowId)) {
      logAction('[inventory]', 'container_close ignored for persistent window', { windowId })
    } else if (windows.has(windowId)) {
      logAction('[inventory]', `container_close: id=${windowId}`)
      windows.delete(windowId)
    }

    if (activeWindowId === windowId) {
      setActiveWindow(INVENTORY_WINDOW_ID)
    }
  })

  attachLogger(inv, INVENTORY_WINDOW_ID, 'inv')
}

module.exports = inject
