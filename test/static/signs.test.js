'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const injectSigns = require('../../src/builtins/signs')

function tag (type, value) {
  return { type, value }
}

function signEntity (pos, options = {}) {
  return tag('compound', {
    id: tag('string', 'Sign'),
    x: tag('int', pos.x),
    y: tag('int', pos.y),
    z: tag('int', pos.z),
    FrontText: tag('compound', {
      Text: tag('string', options.frontText ?? ''),
      SignTextColor: tag('int', -16777216)
    }),
    BackText: tag('compound', {
      Text: tag('string', options.backText ?? '')
    }),
    IsWaxed: tag('byte', options.waxed ? 1 : 0)
  })
}

function createBotState (entity) {
  const client = new EventEmitter()
  client.queued = []
  client.queue = (name, params) => {
    client.queued.push({ name, params })
    if (name === 'block_entity_data') block.entity = params.nbt
  }

  const block = {
    name: 'standing_sign',
    entity
  }

  const botState = {
    client,
    getBlock: async () => block,
    getBlockEntity: async () => block.entity,
    self: {
      position: { x: 0.7085602283477783, y: 65.62001037597656, z: 2.0086140632629395 },
      yaw: 0,
      pitch: 40.3
    }
  }

  injectSigns(botState)
  return botState
}

describe('signs builtin', function () {
  it('reads front and back sign text from block entity NBT', async function () {
    const botState = createBotState(signEntity(new Vec3(1, 64, 1), {
      frontText: 'front line',
      backText: 'back line'
    }))

    const sign = await botState.readSign(new Vec3(1, 64, 1))

    assert.strictEqual(sign.frontText, 'front line')
    assert.strictEqual(sign.backText, 'back line')
    assert.strictEqual(sign.isWaxed, false)
  })

  it('queues block_entity_data with updated sign text and preserved NBT', async function () {
    const pos = new Vec3(2, 64, 2)
    const botState = createBotState(signEntity(pos, {
      frontText: 'old',
      backText: 'keep'
    }))

    const result = await botState.editSign(pos, ['new', 'text'], { waitForServer: false })
    const packet = botState.client.queued.find(entry => entry.name === 'block_entity_data')

    assert(packet)
    assert.deepStrictEqual(packet.params.position, { x: 2, y: 64, z: 2 })
    assert.strictEqual(packet.params.nbt.value.id.value, 'Sign')
    assert.strictEqual(packet.params.nbt.value.FrontText.value.Text.value, 'new\ntext')
    assert.strictEqual(packet.params.nbt.value.FrontText.value.SignTextColor.value, -16777216)
    assert.strictEqual(packet.params.nbt.value.BackText.value.Text.value, 'keep')
    assert.strictEqual(result.frontText, 'new\ntext')
  })

  it('fills recorded default sign NBT fields when creating sign entity data', async function () {
    const pos = new Vec3(2, 64, 2)
    const botState = createBotState(null)

    await botState.editSign(pos, 'new text', { waitForServer: false })
    const packet = botState.client.queued.find(entry => entry.name === 'block_entity_data')
    const value = packet.params.nbt.value

    assert.strictEqual(value.IsWaxed.value, 0)
    assert.strictEqual(value.LockedForEditingBy.value, '-1')
    assert.strictEqual(value.isMovable.value, 1)
    assert.strictEqual(value.FrontText.value.FilteredText.value, '')
    assert.strictEqual(value.FrontText.value.HideGlowOutline.value, 0)
    assert.strictEqual(value.FrontText.value.IgnoreLighting.value, 0)
    assert.strictEqual(value.FrontText.value.PersistFormatting.value, 1)
    assert.strictEqual(value.FrontText.value.SignTextColor.value, -16777216)
    assert.strictEqual(value.FrontText.value.TextOwner.value, '')
  })

  it('can edit the back side without changing front text', async function () {
    const pos = new Vec3(3, 64, 3)
    const botState = createBotState(signEntity(pos, {
      frontText: 'keep front',
      backText: 'old back'
    }))

    await botState.editSign(pos, 'new back', { side: 'back', waitForServer: false })
    const packet = botState.client.queued.find(entry => entry.name === 'block_entity_data')

    assert.strictEqual(packet.params.nbt.value.FrontText.value.Text.value, 'keep front')
    assert.strictEqual(packet.params.nbt.value.BackText.value.Text.value, 'new back')
  })

  it('rejects waxed signs unless forced', async function () {
    const botState = createBotState(signEntity(new Vec3(4, 64, 4), { waxed: true }))

    await assert.rejects(
      () => botState.editSign(new Vec3(4, 64, 4), 'blocked', { waitForServer: false }),
      /waxed sign/
    )
  })

  it('opens sign editor with human-observed interact packet sequence', async function () {
    const pos = new Vec3(0, 64, 3)
    const botState = createBotState(signEntity(pos))
    botState.client.entityId = 1n

    const openedPromise = botState.openSignEditor(pos, { face: 2 })
    setImmediate(() => {
      botState.client.emit('open_sign', {
        position: { x: 0, y: 64, z: 3 },
        is_front: false
      })
    })

    const opened = await openedPromise
    const names = botState.client.queued.map(entry => entry.name)
    const transaction = botState.client.queued.find(entry => entry.name === 'inventory_transaction').params.transaction

    assert.strictEqual(opened.is_front, false)
    assert.deepStrictEqual(names, ['player_action', 'animate', 'inventory_transaction'])
    assert.strictEqual(transaction.transaction_data.face, 2)
    assert.deepStrictEqual(transaction.transaction_data.block_position, { x: 0, y: 64, z: 3 })
    assert.deepStrictEqual(transaction.transaction_data.held_item, { network_id: 0 })
    assert.deepStrictEqual(transaction.transaction_data.click_pos, { x: 0.5, y: 0.75, z: 0.25 })
    assert.deepStrictEqual(botState.currentOpenSign.position, pos)
  })

  it('closes the open sign editor with stop_item_use_on', async function () {
    const pos = new Vec3(0, 64, 3)
    const botState = createBotState(signEntity(pos))
    botState.client.entityId = 1n

    const openedPromise = botState.openSignEditor(pos, { face: 2 })
    setImmediate(() => {
      botState.client.emit('open_sign', {
        position: { x: 0, y: 64, z: 3 },
        is_front: false
      })
    })
    await openedPromise

    assert.strictEqual(botState.closeSignEditor(pos), true)
    const stop = botState.client.queued.find(entry => entry.params?.action === 'stop_item_use_on')

    assert.strictEqual(stop.params.action, 'stop_item_use_on')
    assert.deepStrictEqual(stop.params.position, { x: 0, y: 64, z: 2 })
    assert.deepStrictEqual(stop.params.result_position, { x: 0, y: 0, z: 0 })
    assert.strictEqual(stop.params.face, 0)
    assert.strictEqual(botState.currentOpenSign, null)
  })

  it('live edit flow opens the sign, sends text, then closes it', async function () {
    const pos = new Vec3(0, 64, 3)
    const botState = createBotState(signEntity(pos))
    botState.client.entityId = 1n

    const editPromise = botState.editSign(pos, 'Alpha\nBeta\nGamma\n', { face: 2 })
    setImmediate(() => {
      botState.client.emit('open_sign', {
        position: { x: 0, y: 64, z: 3 },
        is_front: false
      })
    })

    const updated = await editPromise
    const names = botState.client.queued.map(entry => entry.name)
    const packet = botState.client.queued.find(entry => entry.name === 'block_entity_data')

    assert.deepStrictEqual(names, ['player_action', 'animate', 'inventory_transaction', 'block_entity_data', 'player_action'])
    assert.strictEqual(packet.params.nbt.value.BackText.value.Text.value, 'Alpha\nBeta\nGamma\n')
    assert.strictEqual(updated.backText, 'Alpha\nBeta\nGamma\n')
    assert.strictEqual(botState.currentOpenSign, null)
  })

  it('requires an already open editor when editing with open disabled', async function () {
    const pos = new Vec3(0, 64, 3)
    const botState = createBotState(signEntity(pos))

    await assert.rejects(
      () => botState.editSign(pos, 'blocked', { open: false, timeoutMs: 10 }),
      /Sign editor is not open/
    )
  })
})
