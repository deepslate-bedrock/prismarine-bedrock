function rawStackId (raw) {
  return raw?.stack_id ?? raw?.stackId ?? raw?.stack_network_id ?? raw?.network_stack_id
}

function itemStackId (item) {
  return item ? item.stackId ?? item.stack_id ?? 0 : 0
}

function itemStackResponseStatusOk (response) {
  return response?.status === 0 || response?.status === 'ok' || response?.status === 'success'
}

function sameItem (a, b) {
  return a && b && a.name === b.name && a.metadata === b.metadata
}

function maxStackSize (item) {
  return item?.stackSize || item?.maxStackSize || 64
}

function nbtValue (value) {
  if (value == null || Buffer.isBuffer(value) || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(nbtValue)

  if (
    Object.prototype.hasOwnProperty.call(value, 'type') &&
    Object.prototype.hasOwnProperty.call(value, 'value')
  ) {
    return nbtValue(value.value)
  }

  const out = {}
  for (const [key, child] of Object.entries(value)) out[key] = nbtValue(child)
  return out
}

function normalizeItemId (id) {
  if (id == null) return null
  const str = String(id)
  return str.startsWith('minecraft:') ? str : `minecraft:${str}`
}

function itemId (item) {
  item = nbtValue(item)
  return normalizeItemId(
    item?.id ??
    item?.name ??
    item?.Name ??
    item?.identifier ??
    item?.network_id ??
    item?.networkId
  )
}

function itemCount (item) {
  item = nbtValue(item)
  return Number(item?.count ?? item?.Count ?? item?.amount ?? item?.Amount ?? 0)
}

function itemToRaw (item, itemClass, options = {}) {
  if (!item) return { network_id: 0 }
  if (item.raw) return item.raw
  try {
    if (typeof item.toNotch === 'function') return item.toNotch()
    if (itemClass && typeof itemClass.toNotch === 'function') return itemClass.toNotch(item)
  } catch (err) {
    options.logAction?.('[utils]', 'itemToRaw error', { msg: err.message })
  }

  return {
    network_id: item.type,
    count: item.count,
    metadata: item.metadata ?? 0,
    block_runtime_id: item.blockRuntimeId ?? item.block_runtime_id ?? 0,
    extra: { can_place_on: [], can_destroy: [] }
  }
}

function itemToRawWithoutStackId (item, itemClass, options = {}) {
  const raw = { ...itemToRaw(item, itemClass, options) }
  const hadStackId = raw.stack_id != null ||
    raw.stackId != null ||
    raw.stack_network_id != null ||
    raw.network_stack_id != null

  delete raw.stack_id
  delete raw.stackId
  delete raw.stack_network_id
  delete raw.network_stack_id

  if (options.hasStackId === 'always' || (options.hasStackId !== false && hadStackId)) {
    raw.has_stack_id = 0
  }

  return raw
}

function toBedrockItem (item) {
  if (!item) return null
  return {
    network_id: item.type,
    count: item.count,
    metadata: item.metadata ?? 0,
    stack_id: 0
  }
}

function cloneItem (item, count = item?.count, options = {}) {
  if (!item || count <= 0) return null

  const clone = new item.constructor(item.type, count, item.metadata, item.nbt, item.stackId, true)
  if (options.preserveIdentity === false) return clone

  clone.stack_id = item.stack_id
  clone.networkId = item.networkId
  clone.network_id = item.network_id
  clone.blockRuntimeId = item.blockRuntimeId
  clone.block_runtime_id = item.block_runtime_id
  clone.raw = item.raw
  if (item.blocksCanPlaceOn) clone.blocksCanPlaceOn = item.blocksCanPlaceOn
  if (item.blocksCanDestroy) clone.blocksCanDestroy = item.blocksCanDestroy
  return clone
}

module.exports = {
  rawStackId,
  itemStackId,
  itemStackResponseStatusOk,
  sameItem,
  maxStackSize,
  nbtValue,
  normalizeItemId,
  itemId,
  itemCount,
  itemToRaw,
  itemToRawWithoutStackId,
  toBedrockItem,
  cloneItem
}
