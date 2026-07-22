// src/builtins/entity-interact.js
'use strict'

/**
 * builtins/entity-interact.js
 *
 * Adds:
 *   botState.mouseOverEntity(entity, opts?)
 *   botState.interactEntity(entity, opts?)
 *   botState.attackEntity(entity, opts?)
 *   botState.queueItemUseOnEntity(entity, actionType, opts?)
 *
 * Bedrock/Geyser notes:
 * - inventory_transaction.transaction_type must remain 'item_use_on_entity'
 *   so ProtoDef selects the right transaction_data shape.
 * - transaction_data.action_type is:
 *     0 = interact
 *     1 = attack
 * - Do not share attack animation/swing behavior with normal interact.
 *   Trading should call interact only, with no swing animation.
 */

const {
  entityRuntimeId,
  itemToRaw,
  selfRuntimeEntityId,
  sleep,
  toPlainId,
  toVec3f
} = require('../utils')

module.exports = function entityInteractPlugin (botState) {
  const client = botState.client

  function assertEntityRuntimeId (entity) {
    const runtimeId = entityRuntimeId(entity)
    if (runtimeId == null) {
      throw new Error('Entity interaction requires an entity with runtimeId')
    }

    return runtimeId
  }

  function heldHotbarSlot () {
    const slot = botState.heldItemSlot
    if (Number.isInteger(slot) && slot >= 0 && slot <= 8) return slot
    return 0
  }

  function heldItemForSlot (slot) {
    return botState.heldItem ?? botState.inventory?.slots?.[slot] ?? null
  }

  function heldItemRaw (opts = {}) {
    if (opts.heldItemRaw) return opts.heldItemRaw

    const slot = opts.hotbarSlot ?? heldHotbarSlot()
    const item = opts.heldItem ?? heldItemForSlot(slot)

    return itemToRaw(item, botState.itemClass, { logAction: botState.logAction })
  }

  function playerPosition (opts = {}) {
    if (opts.playerPos) return toVec3f(opts.playerPos)
    if (opts.position) return toVec3f(opts.position)
    if (botState.self?.position) return toVec3f(botState.self.position)

    return { x: 0, y: 0, z: 0 }
  }

  function defaultEntityClickPosition (entity, opts = {}) {
    if (opts.clickPos) return toVec3f(opts.clickPos)

    const pos = entity?.position
    if (!pos) return { x: 0, y: 1, z: 0 }

    // For Geyser, entity interactions are translated into Java InteractAt.
    // Geyser subtracts entity.bedrockPosition() from this value, so send an
    // absolute point near the entity body, not {0,0,0}.
    const height = Number(entity.height || opts.height || 1.95)

    return {
      x: Number(pos.x),
      y: Number(pos.y) + Math.min(height * 0.75, 1.5),
      z: Number(pos.z)
    }
  }

  function normalizeEntityActionType (actionType) {
    if (actionType === 0 || actionType === 'interact') return 0
    if (actionType === 1 || actionType === 'attack') return 1

    throw new Error(`Unknown item_use_on_entity action type: ${actionType}`)
  }

  function actionName (actionType) {
    return actionType === 0 ? 'interact' : 'attack'
  }

  function queueMouseOverEntity (entity, opts = {}) {
    const runtimeId = assertEntityRuntimeId(entity)

    const packet = {
      action_id: 'mouse_over_entity',
      target_entity_id: runtimeId,
      has_position: false
    }

    if (opts.position) {
      packet.has_position = true
      packet.position = toVec3f(opts.position)
    }

    client.queue('interact', packet)

    botState.emit('entity_mouse_over_request', {
      entity,
      runtimeId,
      packet
    })

    botState.logAction?.('[entity-interact]', 'interact mouse_over_entity', {
      target: toPlainId(runtimeId),
      has_position: packet.has_position
    })

    return packet
  }

  function queueSwingArm (opts = {}) {
    const runtimeId = selfRuntimeEntityId(botState)
    if (runtimeId == null) {
      throw new Error('Cannot swing arm before self runtimeId is known')
    }

    const packet = {
      action_id: opts.actionId ?? 1,
      runtime_entity_id: runtimeId,
      data: opts.data ?? 0,
      has_swing_source: false,
      swing_source: ''
    }

    client.queue('animate', packet)

    botState.emit('entity_swing_request', packet)

    botState.logAction?.('[entity-interact]', 'animate swing_arm', {
      runtime_entity_id: toPlainId(runtimeId)
    })

    return packet
  }

  function queueItemUseOnEntity (entity, actionType, opts = {}) {
    const runtimeId = assertEntityRuntimeId(entity)
    const normalizedActionType = normalizeEntityActionType(actionType)
    const hotbarSlot = opts.hotbarSlot ?? heldHotbarSlot()

    const transaction = {
      legacy: {
        legacy_request_id: 0,
        legacy_transactions: []
      },
      transaction_type: 'item_use_on_entity',
      actions: [],
      transaction_data: {
        entity_runtime_id: runtimeId,
        action_type: normalizedActionType,
        hotbar_slot: hotbarSlot,
        held_item: heldItemRaw({ ...opts, hotbarSlot }),
        player_pos: playerPosition(opts),
        click_pos: defaultEntityClickPosition(entity, opts)
      }
    }

    const packet = { transaction }

    client.queue('inventory_transaction', packet)

    botState.emit('entity_item_use_request', {
      entity,
      runtimeId,
      actionType: normalizedActionType,
      packet,
      transaction
    })

    botState.logAction?.('[entity-interact]', `inventory_transaction item_use_on_entity ${actionName(normalizedActionType)}`, {
      target: toPlainId(runtimeId),
      action_type: normalizedActionType,
      hotbar_slot: hotbarSlot,
      click_pos: transaction.transaction_data.click_pos
    })

    return packet
  }

  async function interactEntity (entity, opts = {}) {
    if (opts.mouseOver !== false) {
      queueMouseOverEntity(entity, opts)

      const delayMs = opts.mouseOverDelayMs ?? 50
      if (delayMs > 0) await sleep(delayMs)
    }

    return queueItemUseOnEntity(entity, 0, opts)
  }

  async function attackEntity (entity, opts = {}) {
    if (opts.mouseOver !== false) {
      queueMouseOverEntity(entity, opts)

      const delayMs = opts.mouseOverDelayMs ?? 0
      if (delayMs > 0) await sleep(delayMs)
    }

    const packet = queueItemUseOnEntity(entity, 1, opts)

    if (opts.swing !== false) {
      queueSwingArm(opts)
    }

    return packet
  }

  botState.mouseOverEntity = queueMouseOverEntity
  botState.swingArm = queueSwingArm
  botState.queueItemUseOnEntity = queueItemUseOnEntity
  botState.interactEntity = interactEntity
  botState.interactAtEntity = interactEntity
  botState.attackEntity = attackEntity
}
