'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const SubChunk = require('prismarine-chunk/src/bedrock/1.26/SubChunk')
const Stream = require('prismarine-chunk/src/bedrock/common/Stream')
const { StorageType } = require('prismarine-chunk/src/bedrock/common/constants')
const injectSetup = require('../../src/builtins/setup')
const injectWorld = require('../../src/builtins/world')

function waitImmediate () {
  return new Promise(resolve => setImmediate(resolve))
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function singleValueSubchunk (networkRuntimeId, subchunkY = 0) {
  const stream = new Stream()
  stream.writeUInt8(9) // subchunk version
  stream.writeUInt8(1) // storage count
  stream.writeUInt8(subchunkY) // subchunk y
  stream.writeUInt8(1) // runtime palette, 0 bits per block
  stream.writeZigZagVarInt(networkRuntimeId)
  return stream.getBuffer()
}

function startGamePacket (hashes) {
  return {
    entity_id: 1n,
    runtime_entity_id: 1n,
    player_position: { x: 0, y: 64, z: 0 },
    rotation: { x: 0, z: 0 },
    player_gamemode: 'creative',
    dimension: 0,
    block_network_ids_are_hashes: hashes,
    server_authoritative_inventory: true,
    itemstates: [],
    block_properties: []
  }
}

function createRuntimeBotState ({ hashes }) {
  const client = new EventEmitter()
  client.entityId = 1n
  client.queued = []
  client.queue = (name, params) => {
    client.queued.push({ name, params })
  }

  const registry = require('prismarine-registry')('bedrock_1.26.10')
  const blockClass = require('prismarine-block')(registry)
  const worldClass = require('prismarine-world')(registry)
  const botState = {
    client,
    registry,
    blockClass,
    entityClass: require('prismarine-entity')(registry),
    itemClass: require('prismarine-item')(registry),
    chatMessageClass: require('prismarine-chat')(registry),
    windowFactory: require('prismarine-windows')(registry),
    chunkColumn: require('prismarine-chunk')(registry),
    worldClass,
    world: new worldClass(null),
    options: {},
    game: { dimension: 0 },
    lifecycle: {},
    playerState: { spawnPosition: new Vec3(0, 64, 0) },
    protocolState: {}
  }

  botState.setDimension = function setDimension (dimension, options = {}) {
    const changed = this.game.dimension !== dimension
    this.game.dimension = dimension
    if (changed && options.resetWorld) this.world = new this.worldClass(null)
    return changed
  }

  injectSetup(botState, {})
  client.emit('start_game', startGamePacket(hashes))
  injectWorld(botState)

  return botState
}

function createRuntimeContext ({ hashes }) {
  const botState = createRuntimeBotState({ hashes })
  botState.client.emit('close')

  return {
    registry: botState.registry,
    blockClass: botState.blockClass,
    protocolState: {
      blockNetworkIdsAreHashes: botState.protocolState.blockNetworkIdsAreHashes,
      hasLiveBlockRuntimePalette: botState.protocolState.hasLiveBlockRuntimePalette,
      blockNetworkRuntimeIdsAreStateIds: botState.protocolState.blockNetworkRuntimeIdsAreStateIds
    }
  }
}

function createWorldBotState (context) {
  const client = new EventEmitter()
  client.entityId = 1n
  client.queued = []
  client.queue = (name, params) => {
    client.queued.push({ name, params })
  }

  const worldClass = require('prismarine-world')(context.registry)
  const botState = {
    client,
    registry: context.registry,
    blockClass: context.blockClass,
    chunkColumn: require('prismarine-chunk')(context.registry),
    worldClass,
    world: new worldClass(null),
    options: {},
    game: { dimension: 0 },
    lifecycle: {},
    playerState: { spawnPosition: new Vec3(0, 64, 0) },
    protocolState: { ...context.protocolState }
  }

  botState.setDimension = function setDimension (dimension, options = {}) {
    const changed = this.game.dimension !== dimension
    this.game.dimension = dimension
    if (changed && options.resetWorld) this.world = new this.worldClass(null)
    return changed
  }

  injectWorld(botState)

  return botState
}

function runtimeIdFor (botState, blockName) {
  const stateId = botState.registry.blocksByName[blockName].defaultState
  if (botState.protocolState.blockNetworkIdsAreHashes) {
    return botState.blockClass.getHash(`minecraft:${blockName}`, {})
  }
  return stateId
}

function stateIdFor (botState, blockName) {
  return botState.registry.blocksByName[blockName].defaultState
}

async function seedColumn (botState, cx = 0, cz = 0) {
  const chunk = new botState.chunkColumn({ x: cx, z: cz })
  await botState.world.setColumn(cx, cz, chunk)
  botState.networkChunks.set(`${cx},${cz}`, chunk)
  return chunk
}

async function assertBlockAt (botState, pos, blockName) {
  const block = await botState.world.getBlock(pos)
  assert.strictEqual(block.name, blockName)
  assert.strictEqual(block.stateId, stateIdFor(botState, blockName))
}

async function waitForBlockAt (botState, pos, blockName, timeoutMs = 500) {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const block = await botState.world.getBlock(pos)
    if (block?.name === blockName) {
      assert.strictEqual(block.stateId, stateIdFor(botState, blockName))
      return
    }
    await sleep(10)
  }

  await assertBlockAt(botState, pos, blockName)
}

const SERVER_MODES = [
  {
    name: 'Endstone hash runtime IDs',
    hashes: true,
    expectsTeleportSubchunkRequests: true
  },
  {
    name: 'Geyser local-state runtime IDs',
    hashes: false,
    expectsTeleportSubchunkRequests: false
  }
]

describe('world runtime mapping routes', function () {
  for (const mode of SERVER_MODES) {
    describe(mode.name, function () {
      let context
      let currentBotState

      before(function () {
        context = createRuntimeContext(mode)
      })

      afterEach(function () {
        currentBotState?.client.emit('close')
        currentBotState = null
      })

      it('decodes direct 1.26 subchunk palettes into local state IDs', function () {
        const botState = (currentBotState = createWorldBotState(context))
        const subchunk = new SubChunk(botState.registry, botState.blockClass, { y: 0 })

        subchunk.decode(StorageType.Runtime, singleValueSubchunk(runtimeIdFor(botState, 'air')))

        const block = subchunk.getBlock(undefined, 0, 0, 0, 0)
        assert.strictEqual(block.name, 'air')
        assert.strictEqual(block.stateId, stateIdFor(botState, 'air'))
      })

      it('uses the server-specific teleport chunk reporting pattern', function () {
        const botState = (currentBotState = createWorldBotState(context))

        botState.client.emit('move_player', {
          runtime_id: 1,
          position: { x: 17.5, y: 81.62, z: 16.5 },
          mode: 'teleport'
        })

        const radiusRequest = botState.client.queued.find(packet => packet.name === 'request_chunk_radius')
        const subchunkRequests = botState.client.queued.filter(packet => packet.name === 'subchunk_request')

        assert.ok(radiusRequest)
        assert.strictEqual(subchunkRequests.length > 0, mode.expectsTeleportSubchunkRequests)

        if (mode.expectsTeleportSubchunkRequests) {
          assert.deepStrictEqual(subchunkRequests[0].params.origin, { x: 0, y: 5, z: 0 })
          assert.deepStrictEqual(subchunkRequests[0].params.requests, [
            { dx: 0, dy: -1, dz: 0 },
            { dx: 0, dy: 0, dz: 0 },
            { dx: 0, dy: 1, dz: 0 }
          ])
        }
      })

      it('decodes non-cached subchunk packets through the world route', async function () {
        const botState = (currentBotState = createWorldBotState(context))

        botState.client.emit('subchunk', {
          origin: { x: 0, y: 4, z: 0 },
          cache_enabled: false,
          entries: [
            {
              result: 'success',
              dx: 0,
              dy: 0,
              dz: 0,
              payload: singleValueSubchunk(runtimeIdFor(botState, 'air'), 4)
            }
          ]
        })

        await waitImmediate()

        await assertBlockAt(botState, new Vec3(0, 64, 0), 'air')
      })

      it('decodes cached subchunk packets through the blob route', async function () {
        const botState = (currentBotState = createWorldBotState(context))
        const pos = new Vec3(0, 64, 0)
        await seedColumn(botState)
        await botState.setBlockStateIdAt(pos, stateIdFor(botState, 'stone'))
        await assertBlockAt(botState, pos, 'stone')

        const blobHash = {
          y: 4,
          toString: () => '12345'
        }
        botState.blobCache.set(blobHash.toString(), singleValueSubchunk(runtimeIdFor(botState, 'air'), 4))

        botState.client.emit('subchunk', {
          origin: { x: 0, y: 4, z: 0 },
          cache_enabled: true,
          entries: [
            {
              result: 'success',
              dx: 0,
              dy: 0,
              dz: 0,
              blob_id: blobHash,
              payload: Buffer.alloc(0)
            }
          ]
        })

        await waitImmediate()

        await waitForBlockAt(botState, pos, 'air')
      })

      it('applies update_block through the runtime registry map', async function () {
        const botState = (currentBotState = createWorldBotState(context))
        await seedColumn(botState)

        botState.client.emit('update_block', {
          position: { x: 1, y: 64, z: 1 },
          block_runtime_id: runtimeIdFor(botState, 'air'),
          layer: 0
        })

        await waitImmediate()

        await assertBlockAt(botState, new Vec3(1, 64, 1), 'air')
      })

      it('applies update_block_synced through the runtime registry map', async function () {
        const botState = (currentBotState = createWorldBotState(context))
        await seedColumn(botState)

        botState.client.emit('update_block_synced', {
          position: { x: 2, y: 64, z: 2 },
          block_runtime_id: runtimeIdFor(botState, 'stone'),
          layer: 0
        })

        await waitImmediate()

        await assertBlockAt(botState, new Vec3(2, 64, 2), 'stone')
      })

      it('applies update_subchunk_blocks through the runtime registry map', async function () {
        const botState = (currentBotState = createWorldBotState(context))
        await seedColumn(botState)

        botState.client.emit('update_subchunk_blocks', {
          blocks: [
            {
              position: { x: 3, y: 64, z: 3 },
              runtime_id: runtimeIdFor(botState, 'emerald_block')
            }
          ]
        })

        await waitImmediate()

        await assertBlockAt(botState, new Vec3(3, 64, 3), 'emerald_block')
      })
    })
  }
})
