'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { pathfinder } = require('mineflayer-pathfinder')
const mineflayerCompatPlugin = require('../../src/builtins/mineflayer-compat')

function createCompatState () {
  const registry = require('prismarine-registry')('bedrock_1.26.10')
  const state = new EventEmitter()
  const blocks = new Map()

  function blockKey (pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
  }

  function makeBlock (pos, name = 'air') {
    const blockName = name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name
    const registryBlock = registry.blocksByName[blockName] || registry.blocksByName.air
    return {
      position: pos.floored ? pos.floored() : new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)),
      type: registryBlock.id,
      name: registryBlock.name,
      boundingBox: blockName === 'air' ? 'empty' : 'block',
      shapes: blockName === 'air' ? [] : [[0, 0, 0, 1, 1, 1]]
    }
  }

  state.registry = registry
  state.blockClass = require('prismarine-block')(registry)
  state.client = new EventEmitter()
  state.client.entityId = 1n
  state.self = {
    runtimeId: 1n,
    name: 'player',
    position: new Vec3(0, 65.62, 0),
    velocity: new Vec3(0, 0, 0),
    onGround: true,
    effects: {}
  }
  state.entities = new Map()
  state.playerEntities = new Map([[1n, state.self]])
  state.inventory = {
    slots: [
      null,
      { type: registry.itemsByName.dirt.id, name: 'dirt', count: 3 },
      null
    ]
  }
  state.game = { gameMode: 'survival' }
  state.worldMinY = -64
  state.worldHeight = 384
  state.controlState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  }
  state.setControlState = (name, value) => {
    state.controlState[name] = value
  }
  state.clearControlStates = () => {
    for (const key of Object.keys(state.controlState)) state.controlState[key] = false
  }
  state.look = (yaw, pitch) => {
    state.self.yaw = yaw
    state.self.pitch = pitch
  }
  state.lookAt = () => {}
  state.swingCalls = []
  state.swingArm = (arm, showHand) => {
    state.swingCalls.push({ arm, showHand })
  }
  state.equipCalls = []
  state.equipItem = async slot => {
    state.equipCalls.push(slot)
    state.heldItemSlot = slot
    return state.inventory.slots[slot]
  }
  state.placeCalls = []
  state.placeBlock = async (pos, face, options) => {
    state.placeCalls.push({ pos, face, options })
  }
  state.setCompatBlock = (pos, name) => {
    blocks.set(blockKey(pos), makeBlock(pos, name))
  }
  state.world = {
    sync: {
      getBlock (pos) {
        const blockPos = pos.floored ? pos.floored() : new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
        return blocks.get(blockKey(blockPos)) || makeBlock(blockPos, 'air')
      }
    }
  }

  return state
}

describe('mineflayer compatibility facade', function () {
  it('exposes Mineflayer-shaped wrappers without replacing native maps', function () {
    const state = createCompatState()
    const cow = {
      runtimeId: 2n,
      name: 'cow',
      width: 0.9,
      height: 1.4,
      position: new Vec3(2, 65, 2)
    }
    state.entities.set(2n, cow)

    mineflayerCompatPlugin(state)

    const bot = state.asMineflayerBot()
    assert.strictEqual(state.entities instanceof Map, true)
    assert.notStrictEqual(bot.entity, state.self)
    assert.strictEqual(bot.entity.position.y, 64)
    assert.deepStrictEqual(Object.values(bot.entities).map(entity => entity.name).sort(), ['cow', 'player'])
    assert.strictEqual(bot.inventory.items().length, 1)
    assert.strictEqual(bot.game.minY, -64)
    assert.strictEqual(bot.version, 'bedrock_1.26.10')
    assert.strictEqual(bot.blockAt(new Vec3(1.8, 65.2, 1.1)).position.x, 1)

    state.setCompatBlock(new Vec3(2, 64, 0), 'dirt')
    assert.strictEqual(bot.findBlock({ matching: 'dirt', maxDistance: 4 }).position.x, 2)
    assert.deepStrictEqual(bot.findBlocks({ matching: block => block.name === 'dirt', maxDistance: 4 }), [new Vec3(2, 64, 0)])

    bot.look(Math.PI / 2, -Math.PI / 4)
    assert.strictEqual(state.self.yaw, 90)
    assert.strictEqual(state.self.pitch, -45)

    bot.look(0, 0)
    assert.strictEqual(state.self.yaw, 180)
  })

  it('passes bot.dig through to the native dig helper', function () {
    const state = createCompatState()
    let digCalls = 0
    state.dig = (block, forceLook) => { digCalls++; return Promise.resolve({ block, forceLook }) }
    state.canDigBlock = (block) => !!block?.diggable
    state.digTime = () => 100

    mineflayerCompatPlugin(state)
    const bot = state.asMineflayerBot()

    assert.strictEqual(typeof bot.dig, 'function', 'bot.dig should be exposed via the facade')
    assert.strictEqual(typeof bot.canDigBlock, 'function', 'bot.canDigBlock should be exposed via the facade')
    const dummyBlock = { position: new Vec3(1, 2, 3), name: 'stone', diggable: true, hardness: 1.5 }
    return bot.dig(dummyBlock, true).then((result) => {
      assert.strictEqual(digCalls, 1, 'native dig was called')
      assert.strictEqual(result.block, dummyBlock)
      assert.strictEqual(result.forceLook, true)
      assert.strictEqual(bot.canDigBlock(dummyBlock), true)
    })
  })

  it('loads upstream mineflayer-pathfinder against the facade', function () {
    const state = createCompatState()
    mineflayerCompatPlugin(state)

    state.loadPlugin(pathfinder)

    assert.ok(state.pathfinder)
    assert.strictEqual(state.hasMineflayerPlugin(pathfinder), true)
    assert.strictEqual(state.mineflayer.hasPlugin(pathfinder), true)
    assert.strictEqual(state.mineflayer.pathfinder, state.pathfinder)
    assert.strictEqual(typeof state.pathfinder.goto, 'function')
    assert.strictEqual(typeof state.pathfinder.getPathFromTo, 'function')
    assert.strictEqual(typeof state.pathfinder.movements.getNeighbors, 'function')
  })

  it('bridges Mineflayer event aliases from Bedrock world packets', async function () {
    const state = createCompatState()
    state.networkChunks = new Map()
    state.networkChunks.set('1,2', { x: 16, z: 32 })
    mineflayerCompatPlugin(state)

    const bot = state.asMineflayerBot()
    const seen = {}
    bot.once('chunkColumnLoad', chunk => {
      seen.chunk = chunk
    })

    state.client.emit('level_chunk', { x: 1, z: 2 })
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(seen.chunk.x, 16)
    assert.strictEqual(seen.chunk.z, 32)

    state.setCompatBlock(new Vec3(3, 64, 4), 'dirt')
    bot.once('blockUpdate', (oldBlock, newBlock) => {
      seen.oldBlock = oldBlock
      seen.newBlock = newBlock
    })

    state.client.emit('update_block', {
      layer: 0,
      position: { x: 3, y: 64, z: 4 },
      block_runtime_id: 0
    })
    state.setCompatBlock(new Vec3(3, 64, 4), 'stone')
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(seen.oldBlock.name, 'dirt')
    assert.strictEqual(seen.newBlock.name, 'stone')
  })

  it('normalizes Mineflayer event method aliases on the facade', function () {
    const state = createCompatState()
    mineflayerCompatPlugin(state)

    const bot = state.asMineflayerBot()
    let ticks = 0
    bot.on('physicTick', () => {
      ticks++
    })

    state.emit('physicsTick')
    assert.strictEqual(ticks, 1)
    assert.strictEqual(bot.listenerCount('physicTick'), 1)
    bot.removeAllListeners('physicTick')
    assert.strictEqual(bot.listenerCount('physicTick'), 0)
  })

  it('adapts Mineflayer equip and placeBlock signatures to native Bedrock helpers', async function () {
    const state = createCompatState()
    mineflayerCompatPlugin(state)

    const bot = state.asMineflayerBot()
    const dirt = state.inventory.slots[1]
    const equipped = await bot.equip(dirt, 'hand')

    assert.strictEqual(equipped, dirt)
    assert.deepStrictEqual(state.equipCalls, [1])
    assert.strictEqual(state.heldItemSlot, 1)
    assert.strictEqual(bot.getEquipmentDestSlot(null), 37)
    assert.strictEqual(bot.getEquipmentDestSlot('head'), 5)
    await assert.rejects(() => bot.equip(dirt, 'head'), /not backed by a Bedrock equipment action/)

    const referenceBlock = { position: new Vec3(4, 64, 5), name: 'stone' }
    await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0))
    await bot.placeBlock(referenceBlock, new Vec3(-1, 0, 0))
    await bot._placeBlockWithOptions(referenceBlock, new Vec3(0, 0, 1), {
      half: 'top',
      forceLook: false,
      swingArm: 'left',
      showHand: true
    })
    await assert.rejects(
      () => bot._placeBlockWithOptions(referenceBlock, new Vec3(0, 1, 0), { offhand: true }),
      /offhand block placement/
    )

    assert.strictEqual(state.placeCalls.length, 3)
    assert.strictEqual(state.placeCalls[0].pos, referenceBlock.position)
    assert.strictEqual(state.placeCalls[0].face, 1)
    assert.deepStrictEqual(state.placeCalls[0].options.lookOffset, { x: 0.5, y: 1, z: 0.5 })
    assert.strictEqual(state.placeCalls[1].face, 4)
    assert.deepStrictEqual(state.placeCalls[1].options.lookOffset, { x: 0, y: 0.5, z: 0.5 })
    assert.strictEqual(state.placeCalls[2].face, 3)
    assert.strictEqual(state.placeCalls[2].options.forceLook, false)
    assert.deepStrictEqual(state.placeCalls[2].options.lookOffset, { x: 0.5, y: 0.75, z: 1 })
    assert.deepStrictEqual(state.swingCalls, [
      { arm: 'right', showHand: undefined },
      { arm: 'right', showHand: undefined },
      { arm: 'left', showHand: true }
    ])
  })
})
