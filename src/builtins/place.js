// builtins/place.js
// Auto-loaded by plugin-loader. Adds placeBlock() and placeEntity() methods
// to the bot state. Uses the InventoryTransaction packet (item_use) to perform placements.
//
// Assumes:
//   - bot.lookAt(pos) exists (user stated it is available)
//   - botState.heldItemSlot is maintained by the inventory plugin
//   - botState.playerState.spawnPosition reflects current player position
//   - botState.world.getBlock(pos) returns a block with .stateId
//   - botState.itemClass.toNotch(stack) exists (prismarine-item provides it)

const Vec3 = require('vec3').Vec3
const {
  blockFaceFromEye,
  clickPositionForFace,
  getBlockRuntimeId: getRuntimeIdAt,
  itemToRaw: toRawItem,
  logAction,
  positionForFace,
  sameBlockPos,
  toVec3f
} = require('../utils')

/**
 * @param {import('../state')} botState
 * @param {object} options
 */
function inject (botState, options) {
  const client = botState.client

  function waitForPlacedBlockUpdate (position, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for placed block update at ${position}`))
      }, timeoutMs)
      timeout.unref?.()

      const cleanup = () => {
        clearTimeout(timeout)
        client.off('update_block', onUpdateBlock)
        client.off('update_block_synced', onUpdateBlockSynced)
        client.off('update_subchunk_blocks', onUpdateSubchunkBlocks)
      }

      const finish = () => {
        cleanup()
        resolve()
      }

      const onUpdateBlock = packet => {
        if (sameBlockPos(packet.position, position)) finish()
      }
      const onUpdateBlockSynced = packet => {
        if (sameBlockPos(packet.position, position)) finish()
      }
      const onUpdateSubchunkBlocks = packet => {
        if ((packet.blocks || []).some(entry => sameBlockPos(entry.position, position))) finish()
      }

      client.on('update_block', onUpdateBlock)
      client.on('update_block_synced', onUpdateBlockSynced)
      client.on('update_subchunk_blocks', onUpdateSubchunkBlocks)
    })
  }

  // ------------------------------------------------------------------
  // Helper: send the actual InventoryTransaction packet
  // ------------------------------------------------------------------
  function sendPlaceTransaction (useItemData) {
    // Build the Transaction object
    const transaction = {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use',
      // actions is an empty array for block placement; the inventory change is
      // handled by the server after the transaction is accepted.
      actions: [],
      transaction_data: useItemData
    }

    client.queue('inventory_transaction', { transaction })
    logAction('[place]', 'sent inventory_transaction (item_use)')
  }

  // ------------------------------------------------------------------
  // placeBlock: place the held item on a specific block face
  // ------------------------------------------------------------------
  /**
   * @param {Vec3} targetPos - position of the block to place against
   * @param {number} [face] - block face to click (0=bottom, 1=top, 2=z-, 3=z+, 4=x-, 5=x+)
   * @returns {Promise<void>} resolves after the look and packet send
   */
  botState.placeBlock = async function (targetPos, face, placeOptions = {}) {
    if (!(targetPos instanceof Vec3)) {
      throw new TypeError('placeBlock: targetPos must be a Vec3')
    }
    face ??= blockFaceFromEye(botState.self.position, targetPos)

    if (placeOptions.offhand) {
      throw new Error('Bedrock placeBlock does not support offhand placement yet')
    }

    // Look at the requested point on the target block.
    if (placeOptions.forceLook !== 'ignore' && typeof botState.lookAt === 'function') {
      const lookOffset = placeOptions.lookOffset || { x: 0.5, y: 0.5, z: 0.5 }
      const lookPos = targetPos.offset(lookOffset.x, lookOffset.y, lookOffset.z)
      await botState.lookAt(lookPos, placeOptions.forceLook)
    }

    // Determine the hotbar slot holding the item we want to place
    const heldSlot = botState.heldItemSlot
    const heldItem = botState.inventory.slots[heldSlot]
    if (!heldItem) {
      throw new Error('No item in the active hotbar slot to place')
    }

    // Build the TransactionUseItem data
    const playerPos = botState.self?.position ?? botState.playerState?.spawnPosition
    const useItemData = {
      action_type: 'click_block',
      trigger_type: 'player_input',
      block_position: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      face: face,
      hotbar_slot: heldSlot,
      held_item: toRawItem(heldItem, botState.itemClass),
      player_pos: toVec3f(playerPos),
      click_pos: clickPositionForFace(face),
      block_runtime_id: getRuntimeIdAt(botState, targetPos),
      client_prediction: 'success',
      client_cooldown_state: 0 // off
    }

    sendPlaceTransaction(useItemData)
    botState.emit('blockPlaceRequested', { targetPos, face, options: placeOptions })

    if (placeOptions.waitForUpdate !== false) {
      const timeoutMs = Number(placeOptions.placeCompletionTimeoutMs ?? options.placeCompletionTimeoutMs ?? botState.options?.placeCompletionTimeoutMs ?? 5000)
      await waitForPlacedBlockUpdate(positionForFace(targetPos, face), timeoutMs)
    }
  }

  // ------------------------------------------------------------------
  // placeEntity: use the held item in the world (e.g. place a boat, minecart)
  // ------------------------------------------------------------------
  /**
   * @param {Vec3} targetPos - world position where to place the entity
   * @returns {Promise<void>}
   */
  botState.placeEntity = async function (targetPos) {
    if (!(targetPos instanceof Vec3)) {
      throw new TypeError('placeEntity: targetPos must be a Vec3')
    }

    // Look at the position
    if (typeof botState.lookAt === 'function') {
      await botState.lookAt(targetPos.offset(0, 1.5, 0)) // look slightly above
    }

    const heldSlot = botState.heldItemSlot
    const heldItem = botState.inventory.slots[heldSlot]
    if (!heldItem) {
      throw new Error('No item in the active hotbar slot to place')
    }

    // Use item on air (action_type = 1)
    const playerPos = botState.self?.position ?? botState.playerState?.spawnPosition
    const useItemData = {
      action_type: 'click_air',
      trigger_type: 'player_input',
      block_position: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      face: 1, // ignored for click_air
      hotbar_slot: heldSlot,
      held_item: toRawItem(heldItem, botState.itemClass),
      player_pos: toVec3f(playerPos),
      click_pos: { x: 0.5, y: 0.5, z: 0.5 },
      block_runtime_id: 0,
      client_prediction: 'success',
      client_cooldown_state: 0
    }

    sendPlaceTransaction(useItemData)
  }
}

module.exports = inject
