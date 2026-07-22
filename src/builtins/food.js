// builtins/food.js
// Auto-loaded by plugin-loader. Provides botState.eat().

const {
  floorVec3,
  itemToRaw,
  normalizeItemId,
  sleep,
  toVec3f
} = require('../utils')

const DEFAULT_USE_DURATION_MS = 1700
const DEFAULT_COMPLETION_TIMEOUT_MS = 3000

function itemName (item) {
  if (!item) return null
  const normalized = normalizeItemId(item.name ?? item.displayName ?? item.identifier ?? item.id)
  return normalized?.replace(/^minecraft:/, '') ?? null
}

function registryFood (registry, item) {
  const name = itemName(item)
  if (!name) return null

  return registry?.foodsByName?.[name] ??
    registry?.foods?.[item.type] ??
    registry?.foods?.[item.id] ??
    null
}

function hasFoodMetadata (registry) {
  return !!(
    registry?.foodsByName ||
    registry?.foods ||
    (Array.isArray(registry?.foodsArray) && registry.foodsArray.length > 0)
  )
}

function isFoodItem (registry, item) {
  if (!item) return false
  if (registryFood(registry, item)) return true
  return !!(item.food || item.foodPoints || item.foodSaturation || item.nutrition)
}

function canAlwaysEat (registry, item) {
  const food = registryFood(registry, item)
  return !!(food?.canAlwaysEat || food?.alwaysEdible || item?.canAlwaysEat || item?.alwaysEdible)
}

function hungerValue (botState) {
  return botState.food ?? botState.self?.food ?? botState.self?.getStatus?.('food') ?? null
}

function makeUseItemData (botState, slot, item, actionType) {
  const playerPos = botState.self?.position ?? botState.playerState?.spawnPosition ?? { x: 0, y: 0, z: 0 }
  const blockPos = floorVec3(playerPos)

  return {
    action_type: actionType,
    trigger_type: 'player_input',
    block_position: { x: blockPos.x, y: blockPos.y, z: blockPos.z },
    face: -1,
    hotbar_slot: slot,
    held_item: itemToRaw(item, botState.itemClass, { logAction: botState.logAction }),
    player_pos: toVec3f(playerPos),
    click_pos: { x: 0, y: 0, z: 0 },
    block_runtime_id: 0,
    client_prediction: 'success'
  }
}

function makeItemUsePacket (botState, slot, item) {
  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use',
      actions: [],
      transaction_data: makeUseItemData(botState, slot, item, 'click_air')
    }
  }
}

function makeItemReleasePacket (botState, slot, item) {
  const playerPos = botState.self?.position ?? botState.playerState?.spawnPosition ?? { x: 0, y: 0, z: 0 }

  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_release',
      actions: [],
      transaction_data: {
        action_type: 'consume',
        hotbar_slot: slot,
        held_item: itemToRaw(item, botState.itemClass, { logAction: botState.logAction }),
        head_pos: toVec3f(playerPos)
      }
    }
  }
}

function inject (botState, options = {}) {
  const client = botState.client
  const useDurationMs = options.foodUseDurationMs ?? DEFAULT_USE_DURATION_MS
  const completionTimeoutMs = options.foodCompletionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS

  let activeUse = null

  function itemAt (slot) {
    return botState.inventory?.slots?.[slot] ?? null
  }

  function findFoodSlot () {
    const heldSlot = botState.heldItemSlot ?? 0
    if (isFoodItem(botState.registry, itemAt(heldSlot))) return heldSlot

    const slots = botState.inventory?.slots ?? []
    return slots.findIndex(item => isFoodItem(botState.registry, item))
  }

  function normalizeTarget (target) {
    if (Number.isInteger(target)) return target
    if (target && Number.isInteger(target.slot)) return target.slot
    return findFoodSlot()
  }

  function startUsingItemAuthFlag () {
    const unhook = botState.onPlayerAuthInputPreSend?.(packet => {
      botState.setAuthInputFlag(packet, 'start_using_item', true)
    })

    botState.usingHeldItem = true
    if (botState.self) botState.self.usingHeldItem = true
    botState.flushPlayerAuthInput?.()

    return () => {
      unhook?.()
      botState.usingHeldItem = false
      if (botState.self) botState.self.usingHeldItem = false
      botState.flushPlayerAuthInput?.()
    }
  }

  function waitForEatComplete (slot, item, timeoutMs) {
    return new Promise((resolve, reject) => {
      const beforeFood = hungerValue(botState)
      const beforeCount = item?.count
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for food consumption in slot ${slot}`))
      }, timeoutMs)

      function done (reason, packet) {
        cleanup()
        resolve({ reason, packet })
      }

      function onCompletedUsingItem (packet) {
        if (packet.use_method === 'eat' || packet.use_method === 'consume') {
          done('completed_using_item', packet)
        }
      }

      function onInventorySlot (packet) {
        if (packet.window_id !== 0 && packet.window_id !== 'inventory') return
        if (packet.slot !== slot) return
        const current = itemAt(slot)
        if (!current || current.count !== beforeCount) done('inventory_slot', packet)
      }

      function onInventoryContent (packet) {
        if (packet.window_id !== 0 && packet.window_id !== 'inventory') return
        const current = itemAt(slot)
        if (!current || current.count !== beforeCount) done('inventory_content', packet)
      }

      function onAttributes () {
        const afterFood = hungerValue(botState)
        if (beforeFood != null && afterFood != null && afterFood > beforeFood) done('food_status')
      }

      function cleanup () {
        clearTimeout(timeout)
        client.off('completed_using_item', onCompletedUsingItem)
        client.off('inventory_slot', onInventorySlot)
        client.off('inventory_content', onInventoryContent)
        client.off('update_attributes', onAttributes)
      }

      client.on('completed_using_item', onCompletedUsingItem)
      client.on('inventory_slot', onInventorySlot)
      client.on('inventory_content', onInventoryContent)
      client.on('update_attributes', onAttributes)
    })
  }

  function sendStartUse (slot, item) {
    client.queue('inventory_transaction', makeItemUsePacket(botState, slot, item))
    botState.logAction?.('[food]', 'start eating', { slot, item: itemName(item) })
  }

  function sendReleaseUse (slot, item) {
    client.queue('inventory_transaction', makeItemReleasePacket(botState, slot, item))
    botState.logAction?.('[food]', 'release eating', { slot, item: itemName(item) })
  }

  async function eat (target, eatOptions = {}) {
    if (target && typeof target === 'object' && !Number.isInteger(target.slot)) {
      eatOptions = target
      target = undefined
    }

    if (activeUse) throw new Error('Already using an item')

    const explicitSlot = Number.isInteger(target) || (target && Number.isInteger(target.slot))
    const slot = normalizeTarget(target)
    if (!Number.isInteger(slot) || slot < 0) throw new Error('No food item found in inventory')

    if (typeof botState.equipItem === 'function') {
      await botState.equipItem(slot, eatOptions.hotbarSlot ?? 0)
    } else if (slot !== (botState.heldItemSlot ?? 0)) {
      throw new Error('Cannot eat non-held food without inventory-actions builtin')
    }

    const heldSlot = botState.heldItemSlot ?? slot
    const item = itemAt(heldSlot)
    if (hasFoodMetadata(botState.registry) && !isFoodItem(botState.registry, item)) {
      throw new Error(`Item in slot ${heldSlot} is not food`)
    }

    if (!explicitSlot && !isFoodItem(botState.registry, item)) {
      throw new Error('No food item found in inventory; Bedrock registry does not expose food metadata, pass an explicit slot')
    }

    const food = hungerValue(botState)
    if (food >= 20 && !canAlwaysEat(botState.registry, item) && eatOptions.force !== true) {
      throw new Error('Cannot eat: hunger is full')
    }

    const stopUsing = startUsingItemAuthFlag()
    activeUse = { slot: heldSlot, item }

    try {
      const wait = waitForEatComplete(
        heldSlot,
        item,
        eatOptions.completionTimeoutMs ?? completionTimeoutMs
      )
      sendStartUse(heldSlot, item)
      await sleep(eatOptions.useDurationMs ?? useDurationMs)
      if (eatOptions.sendRelease !== false) sendReleaseUse(heldSlot, item)
      const result = await wait
      botState.emit('ate', { slot: heldSlot, item, ...result })
      return result
    } finally {
      activeUse = null
      stopUsing()
    }
  }

  botState.eat = eat
  botState.isFoodItem = item => isFoodItem(botState.registry, item)
  botState.canAlwaysEat = item => canAlwaysEat(botState.registry, item)

  client.on('close', () => {
    activeUse = null
    botState.usingHeldItem = false
  })
}

inject._foodHelpers = {
  hasFoodMetadata,
  registryFood,
  isFoodItem,
  canAlwaysEat,
  makeItemUsePacket,
  makeItemReleasePacket
}

module.exports = inject
