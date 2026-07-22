const { Vec3 } = require('vec3')
const {
  getBlockRuntimeId,
  blockFaceFromEye,
  isSignBlockName,
  itemToRawWithoutStackId,
  nbtValue,
  normalizeBlockPos,
  positionForFace,
  raycastBlock,
  sameBlockPos,
  signShapeOverride,
  sleep,
  toVec3f
} = require('../utils')

function nbtTag (type, value) {
  return { type, value }
}

function cloneNbt (value) {
  if (value == null || typeof value !== 'object') return value
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (Array.isArray(value)) return value.map(cloneNbt)

  const out = {}
  for (const [key, child] of Object.entries(value)) out[key] = cloneNbt(child)
  return out
}

function signEntityIdForBlock (blockName) {
  return String(blockName || '').includes('hanging_sign') ? 'HangingSign' : 'Sign'
}

function signSideKey (side = 'front') {
  if (side === 'auto') return 'auto'
  if (side === true || side === 'front' || side === 'FrontText') return 'FrontText'
  if (side === false || side === 'back' || side === 'BackText') return 'BackText'
  throw new Error(`Unknown sign side: ${side}`)
}

function normalizeSignText (text) {
  if (Array.isArray(text)) return text.map(line => String(line ?? '')).join('\n')
  return String(text ?? '')
}

function ensureCompoundTag (parent, key) {
  const existing = parent[key]
  if (existing?.type === 'compound' && existing.value && typeof existing.value === 'object') return existing

  parent[key] = nbtTag('compound', {})
  return parent[key]
}

function ensureSignTextFields (side) {
  if (side.value.FilteredText == null) setTypedValue(side.value, 'FilteredText', 'string', '')
  if (side.value.HideGlowOutline == null) setTypedValue(side.value, 'HideGlowOutline', 'byte', 0)
  if (side.value.IgnoreLighting == null) setTypedValue(side.value, 'IgnoreLighting', 'byte', 0)
  if (side.value.PersistFormatting == null) setTypedValue(side.value, 'PersistFormatting', 'byte', 1)
  if (side.value.SignTextColor == null) setTypedValue(side.value, 'SignTextColor', 'int', -16777216)
  if (side.value.Text == null) setTypedValue(side.value, 'Text', 'string', '')
  if (side.value.TextOwner == null) setTypedValue(side.value, 'TextOwner', 'string', '')
}

function setTypedValue (parent, key, type, value) {
  parent[key] = nbtTag(type, value)
}

function rootValue (entity) {
  if (entity?.type === 'compound' && entity.value && typeof entity.value === 'object') return entity.value
  return null
}

function plainSignValue (entity) {
  return nbtValue(entity) || {}
}

function readTextFromPlainSign (value, side) {
  return String(value?.[signSideKey(side)]?.Text ?? '')
}

function signSnapshot (block, entity) {
  const value = plainSignValue(entity)

  return {
    block,
    entity,
    frontText: readTextFromPlainSign(value, 'front'),
    backText: readTextFromPlainSign(value, 'back'),
    isWaxed: !!value.IsWaxed,
    raw: value
  }
}

function buildSignEntity (block, entity, pos, updates) {
  const next = cloneNbt(entity) || nbtTag('compound', {})
  next.type = 'compound'
  next.name ??= ''
  next.value = next.value && typeof next.value === 'object' ? next.value : {}

  const value = rootValue(next)
  setTypedValue(value, 'id', 'string', value.id?.value || signEntityIdForBlock(block?.name))
  setTypedValue(value, 'x', 'int', pos.x)
  setTypedValue(value, 'y', 'int', pos.y)
  setTypedValue(value, 'z', 'int', pos.z)
  if (value.IsWaxed == null) setTypedValue(value, 'IsWaxed', 'byte', 0)
  if (value.LockedForEditingBy == null) setTypedValue(value, 'LockedForEditingBy', 'long', '-1')
  if (value.isMovable == null) setTypedValue(value, 'isMovable', 'byte', 1)

  for (const key of ['FrontText', 'BackText']) {
    const side = ensureCompoundTag(value, key)
    ensureSignTextFields(side)
  }

  if (updates.frontText != null) {
    const side = ensureCompoundTag(value, 'FrontText')
    setTypedValue(side.value, 'Text', 'string', normalizeSignText(updates.frontText))
  }

  if (updates.backText != null) {
    const side = ensureCompoundTag(value, 'BackText')
    setTypedValue(side.value, 'Text', 'string', normalizeSignText(updates.backText))
  }

  return next
}

function normalizeEditArgs (textOrOptions, options) {
  if (textOrOptions && typeof textOrOptions === 'object' && !Array.isArray(textOrOptions)) {
    return {
      updates: {
        frontText: textOrOptions.frontText,
        backText: textOrOptions.backText
      },
      options: { ...options, ...textOrOptions },
      pendingText: undefined
    }
  }

  const side = signSideKey(options.side ?? 'auto')
  return {
    updates: {
      frontText: side === 'FrontText' ? textOrOptions : undefined,
      backText: side === 'BackText' ? textOrOptions : undefined
    },
    options,
    pendingText: side === 'auto' ? textOrOptions : undefined
  }
}

function assertSignBlock (block, pos) {
  if (!block) throw new Error(`No block loaded at ${pos}`)
  if (!isSignBlockName(block.name)) throw new Error(`Block at ${pos} is not a sign: ${block.name}`)
}

function signClickPositionForFace (face) {
  switch (face) {
    case 0: return { x: 0.5, y: 0.25, z: 0.5 }
    case 1: return { x: 0.5, y: 0.95, z: 0.5 }
    case 2: return { x: 0.5, y: 0.75, z: 0.25 }
    case 3: return { x: 0.5, y: 0.75, z: 0.75 }
    case 4: return { x: 0.25, y: 0.75, z: 0.5 }
    case 5: return { x: 0.75, y: 0.75, z: 0.5 }
    default: return { x: 0.5, y: 0.75, z: 0.5 }
  }
}

async function blockAt (botState, pos) {
  if (typeof botState.getBlock === 'function') {
    try {
      return await botState.getBlock(pos)
    } catch {}
  }

  try {
    const world = botState.world?.sync || botState.world
    return world?.getBlock?.(pos) ?? null
  } catch {
    return null
  }
}

function raycastSignBlock (botState, pos, block, options = {}) {
  const playerPos = botState.self?.position ?? botState.playerState?.spawnPosition ?? pos
  return raycastBlock(
    playerPos,
    pos,
    botState.self?.yaw ?? 0,
    botState.self?.pitch ?? 0,
    {
      block,
      shapeOverride: options.shapeOverride ?? signShapeOverride
    }
  )
}

module.exports = (botState) => {
  const client = botState.client
  let currentOpenSign = null

  function setCurrentOpenSign (state) {
    currentOpenSign = state
    botState.currentOpenSign = state
    return state
  }

  function waitForOpenSign (pos, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for open_sign at ${pos}`))
      }, timeoutMs)
      timeout.unref?.()

      function cleanup () {
        clearTimeout(timeout)
        client.off('open_sign', onOpenSign)
      }

      function onOpenSign (packet) {
        if (!sameBlockPos(packet.position, pos)) return
        cleanup()
        resolve(packet)
      }

      client.on('open_sign', onOpenSign)
    })
  }

  async function openSignEditor (pos, options = {}) {
    pos = normalizeBlockPos(pos)
    if (currentOpenSign && sameBlockPos(currentOpenSign.position, pos) && options.reopen !== true) {
      return currentOpenSign.packet
    }
    if (currentOpenSign && !sameBlockPos(currentOpenSign.position, pos)) {
      throw new Error(`Sign editor already open at ${currentOpenSign.position}`)
    }

    const block = options.block ?? await blockAt(botState, pos)
    const initialFace = options.face ?? blockFaceFromEye(botState.self?.position, pos, { verticalMode: 'centered', fallback: 3 })
    const heldSlot = botState.heldItemSlot ?? 0
    const held = {
      heldSlot,
      raw: itemToRawWithoutStackId(
        botState.inventory?.slots?.[heldSlot] ?? null,
        botState.itemClass,
        { logAction: botState.logAction }
      )
    }
    const playerPos = botState.self?.position ?? botState.playerState?.spawnPosition ?? pos
    const runtimeEntityId = client.entityId ?? botState.self?.runtimeId ?? 0n

    if (options.look !== false && typeof botState.lookAt === 'function') {
      await botState.lookAt(pos.offset(0.5, 0.75, 0.5), options.forceLook ?? true)
      if (typeof botState.waitForLookComplete === 'function') await botState.waitForLookComplete()
    }

    const rayHit = raycastSignBlock(botState, pos, block, options)
    const face = options.face ?? rayHit?.face ?? initialFace
    const resultPosition = positionForFace(pos, face)
    const clickPosition = options.clickPosition ?? (options.face == null && rayHit?.face === face ? rayHit.clickPosition : null) ?? signClickPositionForFace(face)
    const openSign = waitForOpenSign(pos, options.openTimeoutMs ?? 5000)

    client.queue('player_action', {
      runtime_entity_id: runtimeEntityId,
      action: 'start_item_use_on',
      position: { x: pos.x, y: pos.y, z: pos.z },
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
          block_position: { x: pos.x, y: pos.y, z: pos.z },
          face,
          hotbar_slot: held.heldSlot,
          held_item: held.raw,
          player_pos: toVec3f(playerPos),
          click_pos: clickPosition,
          block_runtime_id: getBlockRuntimeId(botState, pos),
          client_prediction: 'success',
          client_cooldown_state: 0
        }
      }
    })

    const packet = await openSign

    return setCurrentOpenSign({
      position: pos,
      packet,
      isFront: !!packet.is_front,
      face,
      resultPosition,
      runtimeEntityId
    }).packet
  }

  function assertOpenSignEditor (pos) {
    if (!currentOpenSign) throw new Error(`Sign editor is not open at ${pos}`)
    if (!sameBlockPos(currentOpenSign.position, pos)) {
      throw new Error(`Sign editor is open at ${currentOpenSign.position}, not ${pos}`)
    }
    return currentOpenSign
  }

  function closeSignEditor (posLike, options = {}) {
    const state = currentOpenSign
    if (!state) {
      if (options.ifOpen) return false
      throw new Error('Sign editor is not open')
    }

    const pos = posLike == null ? state.position : normalizeBlockPos(posLike)
    if (!sameBlockPos(state.position, pos)) {
      throw new Error(`Sign editor is open at ${state.position}, not ${pos}`)
    }

    client.queue('player_action', {
      runtime_entity_id: state.runtimeEntityId,
      action: 'stop_item_use_on',
      position: { x: state.resultPosition.x, y: state.resultPosition.y, z: state.resultPosition.z },
      result_position: { x: 0, y: 0, z: 0 },
      face: 0
    })

    setCurrentOpenSign(null)
    return true
  }

  async function readSign (posLike) {
    const pos = normalizeBlockPos(posLike)
    const block = await botState.getBlock(pos)
    assertSignBlock(block, pos)

    const entity = block.entity ?? await botState.getBlockEntity(pos)
    return signSnapshot(block, entity)
  }

  async function waitForSignText (pos, updates, timeoutMs = 8000) {
    const expectedFront = updates.frontText == null ? null : normalizeSignText(updates.frontText)
    const expectedBack = updates.backText == null ? null : normalizeSignText(updates.backText)
    const start = Date.now()
    let last

    while (Date.now() - start < timeoutMs) {
      last = await readSign(pos)
      if (
        (expectedFront == null || last.frontText === expectedFront) &&
        (expectedBack == null || last.backText === expectedBack)
      ) return last

      await sleep(100)
    }

    throw new Error(`Timed out waiting for sign text update at ${pos}; last=${JSON.stringify({
      frontText: last?.frontText,
      backText: last?.backText
    })}`)
  }

  async function editSign (posLike, textOrOptions, options = {}) {
    const pos = normalizeBlockPos(posLike)
    const { updates, options: editOptions, pendingText } = normalizeEditArgs(textOrOptions, options)
    const current = await readSign(pos)

    if (current.isWaxed && !editOptions.force) {
      throw new Error(`Cannot edit waxed sign at ${pos}`)
    }

    let resolvedUpdates = updates
    let opened = currentOpenSign && sameBlockPos(currentOpenSign.position, pos)
      ? currentOpenSign.packet
      : null

    if (editOptions.waitForServer === false) {
      if (pendingText !== undefined) resolvedUpdates = { frontText: pendingText }
    } else if (editOptions.open !== false) {
      opened = opened ?? await openSignEditor(pos, editOptions)
      const openedSide = opened.is_front ? 'FrontText' : 'BackText'
      const requestedSide = signSideKey(editOptions.side ?? 'auto')

      if (requestedSide !== 'auto' && requestedSide !== openedSide) {
        throw new Error(`Server opened ${openedSide}, but edit requested ${requestedSide}`)
      }

      if (pendingText !== undefined) {
        resolvedUpdates = openedSide === 'FrontText'
          ? { frontText: pendingText }
          : { backText: pendingText }
      }
    } else {
      opened = assertOpenSignEditor(pos).packet
      const openedSide = opened.is_front ? 'FrontText' : 'BackText'
      const requestedSide = signSideKey(editOptions.side ?? 'auto')

      if (requestedSide !== 'auto' && requestedSide !== openedSide) {
        throw new Error(`Open sign editor is ${openedSide}, but edit requested ${requestedSide}`)
      }

      if (pendingText !== undefined) {
        resolvedUpdates = openedSide === 'FrontText'
          ? { frontText: pendingText }
          : { backText: pendingText }
      }
    }

    const nextEntity = buildSignEntity(current.block, current.entity, pos, resolvedUpdates)
    client.queue('block_entity_data', {
      position: { x: pos.x, y: pos.y, z: pos.z },
      nbt: nextEntity
    })

    if (editOptions.waitForServer !== false && editOptions.close !== false) {
      closeSignEditor(pos)
    }

    if (editOptions.waitForServer === false) {
      return signSnapshot(current.block, nextEntity)
    }

    return waitForSignText(pos, resolvedUpdates, editOptions.timeoutMs ?? editOptions.signEditTimeoutMs)
  }

  botState.signs = {
    isSignBlockName,
    signSideKey,
    openEditor: openSignEditor,
    closeEditor: closeSignEditor,
    read: readSign,
    edit: editSign,
    write: editSign
  }
}
