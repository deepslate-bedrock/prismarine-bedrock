'use strict'

const { EventEmitter } = require('events')

// ------------------------------------------------------------------
// Helper: ItemStack abstraction over prismarine-item objects
// ------------------------------------------------------------------
function isPresent (item) { return item !== null && item.count > 0 }
function isAir (item) { return !item || item.type === -1 || item.count <= 0 }
function stackable (item) { return item && item.count < 64 } // vanilla max stack 64
function count (item) { return item ? item.count : 0 }
function kind (item) { return item ? item.type : -1 }

function stackId (item) {
  return item ? item.stackId ?? item.stack_id ?? 0 : 0
}

function setStackId (item, id) {
  if (!item) return item
  item.stackId = id
  item.stack_id = id
  return item
}

function cloneStack (item, newCount = item?.count) {
  if (!item || newCount <= 0) return null

  let cloned
  try {
    cloned = item.constructor && item.constructor !== Object
      ? new item.constructor(item.type, newCount, item.metadata, item.nbt, stackId(item), true)
      : { ...item }
  } catch {
    cloned = { ...item }
  }

  Object.assign(cloned, item)
  cloned.count = newCount
  return setStackId(cloned, stackId(item))
}

function cloneSlots (slots) {
  return Array.from(slots || [], item => cloneStack(item))
}

function sameStackType (a, b) {
  if (!a || !b) return false
  if (a.name != null && b.name != null && a.name !== b.name) return false
  return a.type === b.type && (a.metadata ?? 0) === (b.metadata ?? 0)
}

function maxStackSizeFor (item, options = {}) {
  if (!item) return 64
  if (typeof options.maxStackSize === 'function') return options.maxStackSize(item)
  return item.stackSize || item.maxStackSize || 64
}

function fullContainerId (slotInfo) {
  return slotInfo?.slot_type?.container_id ?? slotInfo?.container_id ?? 'inventory'
}

function slotIndexForStackRequest (slotInfo, state = null) {
  const containerId = fullContainerId(slotInfo)
  if (containerId === 'cursor') return null
  if (containerId === 'inventory') return slotInfo.slot
  if (containerId === 'hotbar' || containerId === 'hotbar_and_inventory') return slotInfo.slot
  if (containerId === 'armor' || containerId === 'offhand') return slotInfo.slot
  if (containerId === 'container' || containerId === 'crafting_input' || containerId === 'creative_output') return slotInfo.slot

  if (state?.windows?.has(containerId)) return slotInfo.slot

  throw new Error(`Unsupported predictive inventory container: ${containerId}`)
}

function containerArrayFor (state, containerId) {
  if (containerId === 'hotbar' || containerId === 'inventory' || containerId === 'hotbar_and_inventory') return state.slots
  if (containerId === 'container') return state.activeWindow?.slots ?? state.windows?.get(state.activeWindowId)?.slots ?? []
  if (containerId === 'crafting_input') return state.craftingInput ?? state.windows?.get('crafting_input')?.slots ?? []
  if (containerId === 'creative_output') return state.creativeOutput ?? state.windows?.get('creative_output')?.slots ?? []
  if (containerId === 'armor') return state.armor ?? state.windows?.get('armor')?.slots ?? []
  if (containerId === 'offhand') return state.offhand ?? state.windows?.get('offhand')?.slots ?? []
  return state.windows?.get(containerId)?.slots ?? []
}

function getPredictedRef (state, slotInfo) {
  const containerId = fullContainerId(slotInfo)
  if (containerId === 'cursor') return state.cursor
  return containerArrayFor(state, containerId)[slotIndexForStackRequest(slotInfo, state)]
}

function markContainerChanged (state, containerId, slot) {
  if (containerId === 'hotbar' || containerId === 'inventory' || containerId === 'hotbar_and_inventory') {
    state.changedSlots.add(slot)
    return
  }
  state.changedContainers ??= new Map()
  if (!state.changedContainers.has(containerId)) state.changedContainers.set(containerId, new Set())
  state.changedContainers.get(containerId).add(slot)
}

function setPredictedRef (state, slotInfo, item) {
  const containerId = fullContainerId(slotInfo)
  if (containerId === 'cursor') {
    state.cursor = cloneStack(item)
    state.cursorChanged = true
    return
  }

  const slot = slotIndexForStackRequest(slotInfo, state)
  containerArrayFor(state, containerId)[slot] = cloneStack(item)
  markContainerChanged(state, containerId, slot)
}

function movePredictedCount (state, sourceInfo, destinationInfo, amount, options) {
  const source = getPredictedRef(state, sourceInfo)
  if (!isPresent(source)) throw new Error('Cannot predict stack request: source slot is empty')
  if (!Number.isInteger(amount) || amount <= 0 || amount > source.count) {
    throw new RangeError(`Cannot predict stack request: count must be between 1 and ${source.count}`)
  }

  const destination = getPredictedRef(state, destinationInfo)
  if (isPresent(destination) && !sameStackType(source, destination)) {
    throw new Error('Cannot predict stack request: destination contains a different item')
  }

  const remaining = source.count - amount
  const nextSource = cloneStack(source, remaining)
  let nextDestination

  if (isPresent(destination)) {
    const space = maxStackSizeFor(destination, options) - destination.count
    if (amount > space) throw new Error(`Cannot predict stack request: destination only has room for ${space}`)
    nextDestination = cloneStack(destination, destination.count + amount)
  } else {
    nextDestination = cloneStack(source, amount)
    const destinationStackId = destinationInfo?.stack_id ?? 0
    setStackId(nextDestination, destinationStackId || options.provisionalStackId || 0)
  }

  setPredictedRef(state, sourceInfo, nextSource)
  setPredictedRef(state, destinationInfo, nextDestination)
}

function swapPredictedRefs (state, sourceInfo, destinationInfo) {
  const source = cloneStack(getPredictedRef(state, sourceInfo))
  const destination = cloneStack(getPredictedRef(state, destinationInfo))
  setPredictedRef(state, sourceInfo, destination)
  setPredictedRef(state, destinationInfo, source)
}

function removePredictedCount (state, sourceInfo, amount) {
  const source = getPredictedRef(state, sourceInfo)
  if (!isPresent(source)) throw new Error('Cannot predict stack request: source slot is empty')
  if (!Number.isInteger(amount) || amount <= 0 || amount > source.count) {
    throw new RangeError(`Cannot predict stack request: count must be between 1 and ${source.count}`)
  }

  setPredictedRef(state, sourceInfo, cloneStack(source, source.count - amount))
}

function simulateStackRequestAction (state, action, options = {}) {
  switch (action.type_id) {
    case 'take':
    case 'place':
    case 'place_in_container':
    case 'take_out_container':
      movePredictedCount(state, action.source, action.destination, action.count, options)
      break
    case 'swap':
      swapPredictedRefs(state, action.source, action.destination)
      break
    case 'drop':
    case 'destroy':
    case 'consume':
      removePredictedCount(state, action.source, action.count)
      break
    case 'create':
      // Created leftovers are represented by subsequent place/take actions or by
      // server response slots. Marking a slot here would require item identity.
      state.metadataActions.push(action)
      break
    case 'craft_recipe':
    case 'craft_recipe_auto':
    case 'craft_creative':
    case 'optional':
    case 'craft_grindstone_request':
    case 'craft_loom_request':
    case 'results_deprecated':
    case 'lab_table_combine':
    case 'beacon_payment':
    case 'mine_block':
    case 'non_implemented':
      state.metadataActions.push(action)
      break
    default:
      throw new Error(`Unsupported predictive stack request action: ${action.type_id}`)
  }
}

function simulateStackRequest (baseState, requestOrActions, options = {}) {
  const actions = Array.isArray(requestOrActions) ? requestOrActions : requestOrActions?.actions
  if (!Array.isArray(actions)) throw new TypeError('simulateStackRequest expects a request or action array')

  const state = {
    slots: cloneSlots(baseState?.slots),
    cursor: cloneStack(baseState?.cursor),
    changedSlots: new Set(),
    changedContainers: new Map(),
    cursorChanged: false,
    metadataActions: [],
    windows: cloneWindowMap(baseState?.windows),
    activeWindowId: baseState?.activeWindowId,
    activeWindow: cloneWindow(baseState?.activeWindow),
    uiSlots: cloneSlotMap(baseState?.uiSlots),
    armor: cloneSlots(baseState?.armor),
    offhand: cloneSlots(baseState?.offhand),
    craftingInput: cloneSlots(baseState?.craftingInput),
    creativeOutput: cloneSlots(baseState?.creativeOutput),
    syntheticStackId: 0
  }

  for (const action of actions) simulateStackRequestAction(state, action, options)

  return {
    slots: state.slots,
    cursor: state.cursor,
    changedSlots: [...state.changedSlots],
    changedContainers: mapSetToObject(state.changedContainers),
    cursorChanged: state.cursorChanged,
    metadataActions: state.metadataActions,
    windows: state.windows,
    activeWindowId: state.activeWindowId,
    activeWindow: state.activeWindow,
    uiSlots: state.uiSlots,
    armor: state.armor,
    offhand: state.offhand,
    craftingInput: state.craftingInput,
    creativeOutput: state.creativeOutput
  }
}

function cloneSlotMap (map) {
  const cloned = new Map()
  for (const [key, item] of map || []) cloned.set(key, cloneStack(item))
  return cloned
}

function cloneWindow (window) {
  if (!window) return null
  return {
    id: window.id,
    type: window.type,
    title: window.title,
    windowType: window.windowType,
    inventoryStart: window.inventoryStart,
    inventoryEnd: window.inventoryEnd,
    hotbarStart: window.hotbarStart,
    slots: cloneSlots(window.slots || [])
  }
}

function cloneWindowMap (windows) {
  const cloned = new Map()
  for (const [id, window] of windows || []) cloned.set(id, cloneWindow(window))
  return cloned
}

function mapSetToObject (map) {
  const out = {}
  for (const [key, set] of map || []) out[key] = [...set]
  return out
}

function itemStackIdFromServerSlot (slot) {
  return slot?.item_stack_id ?? slot?.stack_id ?? 0
}

function readonlySnapshot (state) {
  const windows = {}
  for (const [id, window] of state.windows || []) windows[id] = cloneWindow(window)
  const activeWindow = state.activeWindowId != null ? windows[state.activeWindowId] ?? cloneWindow(state.activeWindow) : null
  const slots = cloneSlots(state.slots)
  Object.defineProperties(slots, {
    slots: { value: slots, enumerable: false },
    cursor: { value: cloneStack(state.cursor), enumerable: false },
    windows: { value: windows, enumerable: false },
    activeWindowId: { value: state.activeWindowId, enumerable: false },
    activeWindow: { value: activeWindow, enumerable: false },
    uiSlots: { value: cloneSlotMap(state.uiSlots), enumerable: false },
    armor: { value: cloneSlots(state.armor), enumerable: false },
    offhand: { value: cloneSlots(state.offhand), enumerable: false },
    craftingInput: { value: cloneSlots(state.craftingInput), enumerable: false },
    creativeOutput: { value: cloneSlots(state.creativeOutput), enumerable: false },
    slot: { value: slotInfo => cloneStack(getPredictedRef(state, slotInfo)), enumerable: false }
  })
  return Object.freeze(slots)
}

class InventorySimulationState extends EventEmitter {
  constructor (botState = null, options = {}) {
    super()
    this.botState = botState
    this.options = options
    this.slots = []
    this.cursor = null
    this.windows = new Map()
    this.uiSlots = new Map()
    this.activeWindowId = null
    this.activeWindow = null
    this.armor = []
    this.offhand = []
    this.craftingInput = []
    this.creativeOutput = []
    this.pendingTransactions = new Map()
    this.activeBatch = null
    if (botState) this.syncFromBot(true)
  }

  syncFromBot (force = false) {
    if (!this.botState?.inventory) return
    if (!force && (this.pendingTransactions.size > 0 || this.activeBatch)) return

    this.slots = cloneSlots(this.botState.inventory.slots)
    this.activeWindowId = this.botState.activeWindowId
    this.windows = cloneWindowMap(this.botState.windows)
    this.uiSlots = cloneSlotMap(this.botState.uiSlots)
    this.activeWindow = this.windows.get(this.activeWindowId) ?? null
    this.armor = cloneSlots(this.botState.armor?.slots)
    this.offhand = cloneSlots(this.botState.offhand?.slots)
    this.craftingInput = cloneSlots(this.windows.get(this.activeWindowId)?.slots)
    this.creativeOutput = cloneSlots(this.botState.creativeItems)
  }

  stateView () {
    return {
      slots: this.activeBatch?.state.slots ?? this.slots,
      cursor: this.activeBatch?.state.cursor ?? this.cursor,
      windows: this.activeBatch?.state.windows ?? this.windows,
      activeWindowId: this.activeBatch?.state.activeWindowId ?? this.activeWindowId,
      activeWindow: this.activeBatch?.state.activeWindow ?? this.activeWindow,
      uiSlots: this.activeBatch?.state.uiSlots ?? this.uiSlots,
      armor: this.activeBatch?.state.armor ?? this.armor,
      offhand: this.activeBatch?.state.offhand ?? this.offhand,
      craftingInput: this.activeBatch?.state.craftingInput ?? this.craftingInput,
      creativeOutput: this.activeBatch?.state.creativeOutput ?? this.creativeOutput
    }
  }

  snapshot () {
    return readonlySnapshot(this.stateView())
  }

  simulateRequest (request) {
    const base = this.stateView()
    return {
      request,
      before: this.cloneState(base),
      after: simulateStackRequest(base, request, {
        ...this.options,
        provisionalStackId: request?.request_id
      })
    }
  }

  beginBatch () {
    if (this.activeBatch) throw new Error('Nested inventory simulation batches are not supported')
    this.syncFromBot(false)
    this.activeBatch = {
      before: this.cloneState(this.stateView()),
      state: this.cloneState(this.stateView()),
      requests: [],
      predictions: []
    }
  }

  recordBatchRequest (request) {
    if (!this.activeBatch) throw new Error('No active inventory simulation batch')
    const prediction = this.simulateRequest(request)
    this.activeBatch.requests.push(request)
    this.activeBatch.predictions.push(prediction)
    this.activeBatch.state = this.cloneState(prediction.after)
    this.publishPrediction(prediction.after)
    return prediction
  }

  commitBatch () {
    const batch = this.activeBatch
    this.activeBatch = null
    if (!batch) throw new Error('No active inventory simulation batch')
    const prediction = {
      request: batch.requests[batch.requests.length - 1] ?? null,
      requests: batch.requests,
      before: batch.before,
      after: batch.state,
      changedSlots: [...new Set(batch.predictions.flatMap(entry => entry.after.changedSlots || []))],
      changedContainers: mergeChangedContainers(batch.predictions.map(entry => entry.after.changedContainers)),
      cursorChanged: batch.predictions.some(entry => entry.after.cursorChanged)
    }
    this.applyPredictedState(batch.state)
    return prediction
  }

  rollbackBatch () {
    if (!this.activeBatch) return
    this.applyPredictedState(this.activeBatch.before)
    this.activeBatch = null
  }

  startPending (requestOrRequests, prediction) {
    const requests = Array.isArray(requestOrRequests) ? requestOrRequests : [requestOrRequests]
    const transaction = {
      requests,
      request: requests[requests.length - 1],
      before: this.cloneState(prediction.before),
      after: this.cloneState(prediction.after),
      changedSlots: new Set(prediction.changedSlots ?? prediction.after?.changedSlots ?? []),
      changedContainers: prediction.changedContainers ?? prediction.after?.changedContainers ?? {},
      cursorChanged: prediction.cursorChanged ?? prediction.after?.cursorChanged ?? false,
      responses: new Map()
    }
    for (const request of requests) this.pendingTransactions.set(request.request_id, transaction)
    this.applyPredictedState(transaction.after)
    return transaction
  }

  transactionForResponse (response) {
    return this.pendingTransactions.get(response?.request_id)
  }

  shouldDeferResponse (response) {
    return this.pendingTransactions.has(response?.request_id)
  }

  noteResponse (response) {
    const transaction = this.transactionForResponse(response)
    if (!transaction) return null
    transaction.responses.set(response.request_id, response)
    return transaction
  }

  transactionComplete (transaction) {
    return transaction.requests.every(request => transaction.responses.has(request.request_id))
  }

  reconcileTransaction (transaction) {
    const mismatches = []
    const slotsToApply = new Set(transaction.changedSlots)
    const finalState = this.cloneState(transaction.after)

    for (const request of transaction.requests) {
      const response = transaction.responses.get(request.request_id)
      if (!response || !itemStackResponseOk(response)) {
        this.rollbackTransaction(transaction, response, 'server rejected request')
        const err = new Error(`Inventory prediction failed for request ${request.request_id}: server rejected request`)
        err.request = request
        err.response = response
        err.mismatches = []
        throw err
      }
      this.applyResponseSlots(finalState, response, transaction.before, slotsToApply, mismatches)
    }

    this.applyPredictedState(finalState)
    this.applyPredictedSlotsToBot(slotsToApply)
    for (const request of transaction.requests) this.pendingTransactions.delete(request.request_id)
    if (mismatches.length > 0) {
      const err = new Error(`Inventory prediction failed for request ${transaction.request.request_id}: server state differed from prediction`)
      err.request = transaction.request
      err.response = [...transaction.responses.values()]
      err.mismatches = mismatches
      throw err
    }
    return { changedSlots: [...slotsToApply], mismatches }
  }

  rollbackTransaction (transaction) {
    for (const request of transaction.requests) this.pendingTransactions.delete(request.request_id)
    this.syncFromBot(true)
    this.cursor = cloneStack(transaction.before.cursor)
  }

  applyResponseSlots (state, response, before, slotsToApply, mismatches) {
    for (const container of response?.containers || []) {
      const containerId = container.slot_type?.container_id
      for (const serverSlot of container.slots || []) {
        const slotInfo = { slot_type: { container_id: containerId }, slot: serverSlot.slot }
        const expected = getPredictedRef(state, slotInfo)
        if ((expected?.count ?? 0) !== serverSlot.count) {
          const label = containerId === 'cursor' ? 'cursor' : (isPlayerContainer(containerId) ? `slot ${slotIndexForStackRequest(slotInfo, state)}` : `${containerId} ${serverSlot.slot}`)
          mismatches.push(`${label}: predicted ${expected?.count ?? 0}, server ${serverSlot.count}`)
        }
        const fallback = getPredictedRef(before, slotInfo)
        setPredictedRef(state, slotInfo, serverSlot.count === 0 ? null : setStackId(cloneStack(expected || fallback, serverSlot.count), itemStackIdFromServerSlot(serverSlot)))
        if (isPlayerContainer(containerId)) slotsToApply.add(slotIndexForStackRequest(slotInfo, state))
      }
    }
  }

  applyPredictedState (state) {
    this.slots = cloneSlots(state.slots)
    this.cursor = cloneStack(state.cursor)
    this.windows = cloneWindowMap(state.windows)
    this.activeWindowId = state.activeWindowId
    this.activeWindow = cloneWindow(state.activeWindow ?? this.windows.get(this.activeWindowId))
    this.uiSlots = cloneSlotMap(state.uiSlots)
    this.armor = cloneSlots(state.armor)
    this.offhand = cloneSlots(state.offhand)
    this.craftingInput = cloneSlots(state.craftingInput)
    this.creativeOutput = cloneSlots(state.creativeOutput)
    this.publishPrediction(state)
  }

  publishPrediction (state = this.stateView()) {
    this.emit('updated', this.snapshot(), state)
  }

  applyPredictedSlotsToBot (slots) {
    if (!this.botState?.inventory) return
    for (const slot of slots) this.botState.inventory.updateSlot(slot, cloneStack(this.slots[slot]))
  }

  cloneState (state) {
    return {
      slots: cloneSlots(state.slots),
      cursor: cloneStack(state.cursor),
      windows: cloneWindowMap(state.windows),
      activeWindowId: state.activeWindowId,
      activeWindow: cloneWindow(state.activeWindow),
      uiSlots: cloneSlotMap(state.uiSlots),
      armor: cloneSlots(state.armor),
      offhand: cloneSlots(state.offhand),
      craftingInput: cloneSlots(state.craftingInput),
      creativeOutput: cloneSlots(state.creativeOutput)
    }
  }
}

function isPlayerContainer (containerId) {
  return containerId === 'inventory' || containerId === 'hotbar' || containerId === 'hotbar_and_inventory'
}

function itemStackResponseOk (response) {
  return response?.status === 'ok' || response?.status === 0
}

function mergeChangedContainers (items) {
  const out = {}
  for (const item of items) {
    for (const [containerId, slots] of Object.entries(item || {})) {
      out[containerId] ??= []
      for (const slot of slots) if (!out[containerId].includes(slot)) out[containerId].push(slot)
    }
  }
  return out
}

// ------------------------------------------------------------------
// Click types (mirrors azalea-buf AzBuf enum)
// ------------------------------------------------------------------
const ClickType = {
  Pickup:     0,
  QuickMove:  1,
  Swap:       2,
  Clone:      3,
  Throw:      4,
  QuickCraft: 5,
  PickupAll:  6
}

// ------------------------------------------------------------------
// Button numbers per operation (derived from Azalea's button_num())
// ------------------------------------------------------------------
function buttonNum (operation) {
  switch (operation.type) {
    case 'Pickup':
      return operation.mode === 'left' ? 0 : 1
    case 'QuickMove':
      return operation.button === 0 ? 0 : 1
    case 'Swap':
      return operation.targetSlot  // 0-8 for hotbar, 40 for offhand, etc.
    case 'Clone':
      return 2
    case 'Throw':
      return operation.all ? 1 : 0
    case 'QuickCraft': {
      const kind = operation.kind  // 'left', 'right', 'middle'
      const status = operation.status  // 'start', 'add', 'end'
      const map = {
        left:   { start: 0, add: 1, end: 2 },
        right:  { start: 4, add: 5, end: 6 },
        middle: { start: 8, add: 9, end: 10 }
      }
      return map[kind][status]
    }
    case 'PickupAll':
      return 0
    default:
      return 0
  }
}

// ------------------------------------------------------------------
// Container window type -> Azalea MenuLocation mapping
// ------------------------------------------------------------------
function menuLocationForWindow (window) {
  const type = window.type  // e.g. 'minecraft:furnace'
  // We match against the known types used in prismarine-windows
  // and the Bedrock-to-Azalea mapping.
  switch (type) {
    case 'minecraft:inventory':
      return 'Player'
    case 'minecraft:generic_9x1':
      return 'Generic9x1'
    case 'minecraft:generic_9x2':
      return 'Generic9x2'
    case 'minecraft:generic_9x3':
      return 'Generic9x3'
    case 'minecraft:generic_9x4':
      return 'Generic9x4'
    case 'minecraft:generic_9x5':
      return 'Generic9x5'
    case 'minecraft:generic_9x6':
      return 'Generic9x6'
    case 'minecraft:crafting_table':
      return 'Crafting'
    case 'minecraft:furnace':
      return 'Furnace'
    case 'minecraft:blast_furnace':
      return 'BlastFurnace'
    case 'minecraft:smoker':
      return 'Smoker'
    case 'minecraft:brewing_stand':
      return 'BrewingStand'
    case 'minecraft:enchantment':
      return 'Enchantment'
    case 'minecraft:anvil':
      return 'Anvil'
    case 'minecraft:grindstone':
      return 'Grindstone'
    case 'minecraft:cartography':
      return 'CartographyTable'
    case 'minecraft:smithing':
      return 'Smithing'
    case 'minecraft:stonecutter':
      return 'Stonecutter'
    case 'minecraft:loom':
      return 'Loom'
    case 'minecraft:hopper':
      return 'Hopper'
    case 'minecraft:beacon':
      return 'Beacon'
    case 'minecraft:dispenser':
    case 'minecraft:dropper':
      return 'Generic9x3' // 3x3 grid + inventory
    case 'minecraft:crafter_3x3':
      return 'Crafter3x3'
    case 'minecraft:lectern':
      return 'Lectern'
    case 'minecraft:merchant':
      return 'Merchant'
    case 'EntityHorse':
      return 'Generic9x6' // fallback
    default:
      return 'Generic9x6' // safest fallback
  }
}

// ------------------------------------------------------------------
// Slot range helpers (based on azalea-inventory macros)
// ------------------------------------------------------------------
function playerSlotsRange () {
  // player inventory is always last 36 slots (9 hotbar + 27 main)
  // plus the crafting/armor/offhand slots in the Player menu.
  // For a generic container, the window has those 36 slots at the end.
  // prismarine-windows defines inventoryStart, inventoryEnd for the player part.
  // We'll rely on those if present, otherwise fallback.
}

function hotbarSlotsRange (window) {
  const start = window.inventoryStart
  const end = window.inventoryEnd
  // hotbar is the last 9 slots of player inventory
  return { start: end - 8, end }
}

function inventoryWithoutHotbarRange (window) {
  const start = window.inventoryStart
  const end = window.inventoryEnd
  return { start, end: end - 9 }
}

// ------------------------------------------------------------------
// Main simulation function
// ------------------------------------------------------------------

/**
 * Simulate a click operation on a prismarine-windows Window object.
 *
 * @param {object} window - A window instance (e.g. from prismarine-windows)
 * @param {object} operation - Click operation descriptor {@see ClickOperation}
 * @param {object|null} carriedItem - The item currently on cursor, or null
 * @param {boolean} isCreative - Whether the player is in creative mode
 * @returns {{ updatedSlots: Array<{slot:number, newItem:object|null}>, newCarriedItem: object|null, changedSlots: object }}
 */
function simulateClick (window, operation, carriedItem, isCreative) {
  let carried = carriedItem ? { ...carriedItem } : null
  const changedSlots = {}  // slot index -> new item (null means empty)
  const updatedSlots = []

  function updateSlot (slot, newItem) {
    const oldItem = window.slots[slot]
    window.updateSlot(slot, newItem)
    changedSlots[slot] = newItem
    updatedSlots.push({ slot, oldItem, newItem })
  }

  // Helper: try to move item from sourceSlot to targetSlot
  function tryMoveItem (sourceSlot, targetSlot) {
    const sourceItem = window.slots[sourceSlot]
    const targetItem = window.slots[targetSlot]
    if (!isPresent(sourceItem)) return false
    // If target has same item and is stackable
    if (isPresent(targetItem) && sourceItem.type === targetItem.type && sourceItem.metadata === targetItem.metadata &&
        stackable(targetItem)) {
      const space = 64 - targetItem.count
      const moveCount = Math.min(sourceItem.count, space)
      if (moveCount <= 0) return false
      sourceItem.count -= moveCount
      targetItem.count += moveCount
      updateSlot(targetSlot, targetItem)
      if (sourceItem.count <= 0) {
        updateSlot(sourceSlot, null)
      } else {
        updateSlot(sourceSlot, sourceItem)
      }
      return true
    }
    // If target is empty
    if (!isPresent(targetItem)) {
      // Move entire stack
      updateSlot(targetSlot, sourceItem)
      updateSlot(sourceSlot, null)
      return true
    }
    return false
  }

  // Helper: try to stack with existing or fill empty
  function tryMoveToSlots (sourceSlot, slotRange) {
    let sourceItem = window.slots[sourceSlot]
    if (!isPresent(sourceItem)) return
    // try stacking with existing items first
    for (let i = slotRange.start; i <= slotRange.end; i++) {
      if (i === sourceSlot) continue
      const target = window.slots[i]
      if (isPresent(target) && target.type === sourceItem.type && target.metadata === sourceItem.metadata &&
          stackable(target)) {
        const space = 64 - target.count
        if (space <= 0) continue
        const moveCount = Math.min(sourceItem.count, space)
        sourceItem.count -= moveCount
        target.count += moveCount
        updateSlot(i, target)
        if (sourceItem.count <= 0) {
          updateSlot(sourceSlot, null)
          sourceItem = null
          break
        } else {
          updateSlot(sourceSlot, sourceItem)
        }
      }
    }
    if (!sourceItem) return
    // then try empty slots
    for (let i = slotRange.start; i <= slotRange.end; i++) {
      if (i === sourceSlot) continue
      const target = window.slots[i]
      if (!isPresent(target)) {
        updateSlot(i, sourceItem)
        updateSlot(sourceSlot, null)
        sourceItem = null
        break
      }
    }
  }

  // Helper: try move item to slots, and if that fails, toggle hotbar/inventory
  function tryMoveItemOrToggleHotbar (sourceSlot, containerRange) {
    tryMoveToSlots(sourceSlot, containerRange)
    if (isPresent(window.slots[sourceSlot])) {
      // If source is still present, try the other half (hotbar vs inventory)
      const isHotbar = window.slots[sourceSlot] && hotbarSlotsRange(window).start <= sourceSlot && sourceSlot <= hotbarSlotsRange(window).end
      if (isHotbar) {
        tryMoveToSlots(sourceSlot, inventoryWithoutHotbarRange(window))
      } else {
        tryMoveToSlots(sourceSlot, hotbarSlotsRange(window))
      }
    }
  }

  // ── Execute based on operation type ──
  switch (operation.type) {
    // ---------- PICKUP (left/right click) ----------
    case 'Pickup': {
      const slot = operation.slot
      if (slot === undefined) {
        // drop (outside) – handled below
        if (!carried) break
        if (operation.mode === 'left') {
          // drop entire stack
          // (no slot – dropping on floor; not simulated here)
          carried = null
        } else {
          // drop one item
          carried.count -= 1
          if (carried.count <= 0) carried = null
        }
        break
      }
      const targetItem = window.slots[slot]
      if (carried) {
        if (targetItem) {
          // swap
          if (operation.mode === 'left') {
            // swap entire stacks
            updateSlot(slot, carried)
            carried = targetItem
          } else {
            // right click: distribute one
            if (carried.type === targetItem.type && carried.metadata === targetItem.metadata) {
              // merge one
              targetItem.count += 1
              carried.count -= 1
              updateSlot(slot, targetItem)
              if (carried.count <= 0) carried = null
            } else {
              // swap
              updateSlot(slot, carried)
              carried = targetItem
            }
          }
        } else {
          // empty slot
          if (operation.mode === 'left') {
            updateSlot(slot, carried)
            carried = null
          } else {
            // place one
            const newItem = { ...carried, count: 1 }
            updateSlot(slot, newItem)
            carried.count -= 1
            if (carried.count <= 0) carried = null
          }
        }
      } else {
        // no carried item: pick up
        if (targetItem) {
          if (operation.mode === 'left') {
            // pick up entire stack
            updateSlot(slot, null)
            carried = targetItem
          } else {
            // pick up half (rounding up)
            const half = Math.ceil(targetItem.count / 2)
            const newCarried = { ...targetItem, count: half }
            targetItem.count -= half
            updateSlot(slot, targetItem)
            carried = newCarried
            if (targetItem.count <= 0) updateSlot(slot, null)
          }
        }
      }
      break
    }

    // ---------- QUICK MOVE (shift+click) ----------
    case 'QuickMove': {
      const slot = operation.slot
      if (slot === undefined) break
      // replicate azalea's Menu::quick_move_stack
      const sourceItem = window.slots[slot]
      if (!isPresent(sourceItem)) break
      const loc = menuLocationForWindow(window)
      // Based on location, move to the appropriate slot range
      switch (loc) {
        case 'Player':
          // shift-clicking in player inventory behaves like vanilla
          // It's complex: depends on which region was clicked.
          // For simplicity, we'll treat main inventory slots -> hotbar, hotbar slots -> main inventory.
          // This matches Azalea's PlayerMenuLocation::Inventory branch.
          if (window.hotbarStart !== undefined && slot >= window.hotbarStart && slot <= window.hotbarEnd) {
            tryMoveToSlots(slot, inventoryWithoutHotbarRange(window))
          } else if (window.inventoryStart !== undefined && slot >= window.inventoryStart && slot <= window.inventoryEnd) {
            tryMoveToSlots(slot, hotbarSlotsRange(window))
          } else {
            // armor, crafting, etc. – move to inventory
            tryMoveToSlots(slot, { start: window.inventoryStart, end: window.inventoryEnd })
          }
          break
        case 'Furnace':
        case 'BlastFurnace':
        case 'Smoker': {
          // Input, fuel, result slots are 0,1,2 in furnace containers
          const containerRange = { start: 0, end: 2 }  // ingredient + fuel
          if (slot >= 3) {
            // from player part -> container part
            tryMoveToSlots(slot, containerRange)
          } else {
            tryMoveToSlots(slot, { start: window.inventoryStart, end: window.inventoryEnd })
          }
          break
        }
        case 'BrewingStand': {
          const bottleSlots = { start: 0, end: 2 }
          const ingredientSlot = 3
          const fuelSlot = 4
          if (slot >= 5) {
            // from player -> bottle or ingredient
            tryMoveToSlots(slot, { start: 0, end: 4 })
          } else {
            tryMoveToSlots(slot, { start: window.inventoryStart, end: window.inventoryEnd })
          }
          break
        }
        case 'Crafting': {
          const gridSlots = { start: 1, end: 9 }  // result is slot 0, grid 1-9
          if (slot === 0) {
            // result -> inventory
            tryMoveToSlots(slot, { start: window.inventoryStart, end: window.inventoryEnd })
          } else if (slot >= 1 && slot <= 9) {
            // grid -> player
            tryMoveToSlots(slot, { start: window.inventoryStart, end: window.inventoryEnd })
          } else {
            // player -> grid
            tryMoveToSlots(slot, gridSlots)
          }
          break
        }
        case 'Anvil': {
          // first slot 0, second slot 1, result 2
          if (slot >= 3) {
            tryMoveToSlots(slot, { start: 0, end: 1 })
          } else {
            tryMoveToSlots(slot, { start: window.inventoryStart, end: window.inventoryEnd })
          }
          break
        }
        case 'Grindstone':
        case 'CartographyTable':
        case 'Smithing':
        case 'Stonecutter':
        case 'Loom':
        case 'Merchant':
        case 'Lectern':
        case 'Beacon':
        case 'Hopper':
        case 'Dispenser':
        case 'Dropper':
        case 'Crafter3x3':
        case 'Generic9x1':
        case 'Generic9x2':
        case 'Generic9x3':
        case 'Generic9x4':
        case 'Generic9x5':
        case 'Generic9x6':
        default: {
          // generic: if clicked in player inventory, move to container part; else move to player
          const containerStart = 0
          const containerEnd = window.inventoryStart - 1
          if (slot >= window.inventoryStart && slot <= window.inventoryEnd) {
            tryMoveToSlots(slot, { start: containerStart, end: containerEnd })
          } else {
            tryMoveToSlots(slot, { start: window.inventoryStart, end: window.inventoryEnd })
          }
          break
        }
      }
      break
    }

    // ---------- SWAP (number key / F) ----------
    case 'Swap': {
      const sourceSlot = operation.sourceSlot
      const targetSlot = operation.targetSlot  // 0-8 hotbar, 40 offhand, etc.
      const sourceItem = window.slots[sourceSlot]
      const targetItem = window.slots[targetSlot]
      // Swap items
      updateSlot(sourceSlot, targetItem)
      updateSlot(targetSlot, sourceItem)
      break
    }

    // ---------- CLONE (middle click, creative only) ----------
    case 'Clone': {
      if (!isCreative) break
      const slot = operation.slot
      if (slot === undefined) break
      const sourceItem = window.slots[slot]
      if (!sourceItem) break
      // Clone a full stack of the item
      const clonedItem = { ...sourceItem, count: 64 }
      carried = clonedItem
      break
    }

    // ---------- THROW (Q / Ctrl+Q) ----------
    case 'Throw': {
      const slot = operation.slot
      if (slot === undefined) break
      const sourceItem = window.slots[slot]
      if (!sourceItem) break
      if (operation.all) {
        // throw entire stack
        updateSlot(slot, null)
      } else {
        // throw one
        sourceItem.count -= 1
        updateSlot(slot, sourceItem)
        if (sourceItem.count <= 0) updateSlot(slot, null)
      }
      break
    }

    // ---------- QUICK CRAFT (drag) ----------
    case 'QuickCraft': {
      const kind = operation.kind  // 'left', 'right', 'middle'
      const status = operation.status  // 'start', 'add', 'end'
      if (status === 'start') {
        // no immediate slot change; store drag state if needed
        // For simulation, we just ignore start
        break
      } else if (status === 'add') {
        const slot = operation.slot
        if (slot === undefined) break
        const targetItem = window.slots[slot]
        // For left drag: distribute equally
        // For right drag: place one per slot
        // For middle click: same as left but for creative
        // We need to keep track of total count per drag, but for simplicity we just simulate final distribution here.
        // Since prismarine-windows doesn't have drag automation, we'll assume the client does proper distribution.
        // This is a placeholder; a full implementation would require drag state.
        break
      } else if (status === 'end') {
        // Apply distribution
        const dragSlots = operation.slots || []  // client should collect these
        if (!carried) break
        const perSlot = Math.floor(carried.count / dragSlots.length)
        let remainder = carried.count % dragSlots.length
        for (const slot of dragSlots) {
          const amount = perSlot + (remainder > 0 ? 1 : 0)
          remainder--
          const targetItem = window.slots[slot]
          if (targetItem) {
            targetItem.count += amount
            updateSlot(slot, targetItem)
          } else {
            const newItem = { ...carried, count: amount }
            updateSlot(slot, newItem)
          }
        }
        carried = null
      }
      break
    }

    // ---------- PICKUP ALL (double click) ----------
    case 'PickupAll': {
      const slot = operation.slot
      if (slot === undefined) break
      // Double click collects all items of the same type as the carried item or target slot.
      const filterType = carried ? carried.type : (window.slots[slot] ? window.slots[slot].type : null)
      if (filterType === null) break
      let totalCount = 0
      for (let i = 0; i < window.slots.length; i++) {
        const item = window.slots[i]
        if (item && item.type === filterType && item.metadata === (carried ? carried.metadata : 0)) {
          totalCount += item.count
          updateSlot(i, null)
        }
      }
      if (carried) {
        carried.count += totalCount
      } else {
        carried = { type: filterType, count: totalCount, metadata: 0, nbt: null }
      }
      break
    }

    default:
      break
  }

  return { updatedSlots, newCarriedItem: carried, changedSlots }
}

// ------------------------------------------------------------------
// Exports
// ------------------------------------------------------------------
module.exports = {
  InventorySimulationState,
  simulateClick,
  simulateStackRequest,
  simulateStackRequestAction,
  cloneStack,
  cloneSlots,
  setStackId,
  stackId,
  ClickType,
  buttonNum,
  menuLocationForWindow
}
