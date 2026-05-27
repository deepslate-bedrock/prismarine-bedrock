// builtins/dig.js
// Auto-loaded by plugin-loader.
// Provides botState.dig(block).

const { blockFaceFromEye, blockFaceFromVector, logAction, toVec3i } = require('../utils')

module.exports = (botState, options = {}) => {
  const digState = {
    target: null,
    startTime: null,
    startTick: null,
    digTicks: null,
    face: null,
    started: false,
    predicted: false,
    unhook: null,
    timeout: null,
    resolve: null,
    reject: null,
    block: null
  }

  botState.currentDig = digState

  function heldItem () {
    return botState.heldItem
  }

  function heldItemType () {
    return heldItem()?.type ?? null
  }

  function digTime (block) {
    return block.digTime(heldItemType(), false, false, !botState.self.onGround)
  }

  function clearDigState () {
    digState.unhook?.()

    digState.target = null
    digState.startTime = null
    digState.startTick = null
    digState.digTicks = null
    digState.face = null
    digState.started = false
    digState.predicted = false
    digState.unhook = null
    digState.timeout = null
    digState.resolve = null
    digState.reject = null
    digState.block = null
  }

  function finishDigState (status, value) {
    const resolve = digState.resolve
    const reject = digState.reject
    const block = digState.block
    const target = digState.target?.clone?.() || digState.target
    const timeout = digState.timeout

    if (timeout) clearTimeout(timeout)
    clearDigState()

    if (status === 'completed') {
      botState.emit('diggingCompleted', block, target)
      resolve?.(value ?? block)
    } else {
      const error = value instanceof Error ? value : new Error(String(value || 'Digging aborted'))
      botState.emit('diggingAborted', block, target, error)
      reject?.(error)
    }
  }

  function armDigTimeout (ms) {
    const timeoutMs = Math.max(
      Number(options.digCompletionTimeoutMs ?? botState.options?.digCompletionTimeoutMs ?? 10000),
      ms + Number(options.digCompletionGraceMs ?? botState.options?.digCompletionGraceMs ?? 5000)
    )

    digState.timeout = setTimeout(() => {
      if (!digState.target) return
      finishDigState('aborted', new Error(`Timed out waiting for dig completion at ${digState.target}`))
    }, timeoutMs)
    digState.timeout.unref?.()
  }

  function targetPointForDigFace (block, digFace) {
    const pos = block.position
    if (digFace && typeof digFace === 'object') {
      return pos.offset(
        0.5 + (Number(digFace.x) || 0) * 0.5,
        0.5 + (Number(digFace.y) || 0) * 0.5,
        0.5 + (Number(digFace.z) || 0) * 0.5
      )
    }

    return pos.offset(0.5, 0.5, 0.5)
  }

  function appendBlockActions (packet, actions, pos, face) {
    botState.setAuthInputFlag(packet, 'block_action', true)
    packet.block_action ??= []
    for (const action of actions) {
      packet.block_action.push({
        action,
        position: toVec3i(pos),
        face
      })
    }
  }

  function installDigHook () {
    digState.unhook = botState.onPlayerAuthInputPreSend(packet => {
      if (!digState.target) return

      if (digState.startTick === null) digState.startTick = packet.tick

      const elapsedTicks = Number(BigInt(packet.tick) - BigInt(digState.startTick))
      let actions
      if (!digState.started) {
        digState.startTime = Date.now()
        actions = ['start_break']
      } else if (!digState.predicted && elapsedTicks >= digState.digTicks) {
        actions = ['continue_break', 'predict_break']
        digState.predicted = true
      } else {
        actions = ['continue_break']
      }

      digState.started = true
      appendBlockActions(packet, actions, digState.target, digState.face)

      if (actions.includes('predict_break')) {
        logAction('[dig]', 'predict break', {
          pos: digState.target.toString(),
          dugMs: Date.now() - digState.startTime,
          dugTicks: elapsedTicks
        })

      }
    })
  }

  async function digBlock (block, forceLook = true, digFace = 'auto') {
    if (block == null) {
      throw new Error('dig was called with an undefined or null block')
    }

    if (digState.target) {
      throw new Error(`Already digging ${digState.target}`)
    }

    if (!block.diggable || block.hardness < 0) {
      throw new Error(`Cannot dig block: ${block.name}`)
    }

    const pos = block.position

    if (!digFace || typeof digFace === 'function') digFace = 'auto'
    if (forceLook !== 'ignore' && typeof botState.lookAt === 'function') {
      await botState.lookAt(targetPointForDigFace(block, digFace), forceLook)
    }

    const ms = digTime(block)
    if (ms === Infinity) {
      throw new Error(`dig time for ${block?.name ?? block} is Infinity`)
    }

    return new Promise((resolve, reject) => {
      digState.target = pos.clone()
      digState.startTime = null
      digState.startTick = null
      digState.digTicks = Math.max(1, Math.ceil(ms / 50))
      digState.face = blockFaceFromVector(digFace) ?? blockFaceFromEye(botState.self.position, pos)
      digState.started = false
      digState.predicted = false
      digState.resolve = resolve
      digState.reject = reject
      digState.block = block
      installDigHook()
      armDigTimeout(ms)

      logAction('[dig]', 'start break', {
        block: block.name,
        pos: pos.toString(),
        digMs: ms,
        tool: heldItem()?.name || 'empty'
      })
    })
  }

  botState.dig = digBlock
  botState.digTime = digTime
  botState.canDigBlock = block => {
    if (!block?.diggable) return false
    if (!block.position || !botState.self?.position) return false
    return block.position.offset(0.5, 0.5, 0.5).distanceTo(botState.self.position) <= 5.1
  }
  botState.stopDigging = () => {
    if (!digState.target) return
    finishDigState('aborted', new Error('Digging aborted'))
  }

  function handlePossibleDigUpdate (position) {
    if (!digState.target) return
    if (!position) return

    const pos = position
    if (
      pos.x !== digState.target.x ||
      pos.y !== digState.target.y ||
      pos.z !== digState.target.z
    ) return

    logAction('[dig]', 'block updated while digging', {
      pos: digState.target.toString()
    })

    finishDigState('completed')
  }

  botState.client.on('update_block', (packet) => {
    handlePossibleDigUpdate(packet.position)
  })

  botState.client.on('update_block_synced', (packet) => {
    handlePossibleDigUpdate(packet.position)
  })

  botState.client.on('update_subchunk_blocks', (packet) => {
    for (const entry of packet.blocks || []) handlePossibleDigUpdate(entry.position)
  })
}
