'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const registry = require('prismarine-registry')('bedrock_1.26.10')
const Block = require('prismarine-block')(registry)
const Chunk = require('prismarine-chunk')(registry)
const SubChunk = require('prismarine-chunk/src/bedrock/1.26/SubChunk')
const Stream = require('prismarine-chunk/src/bedrock/common/Stream')
const { StorageType } = require('prismarine-chunk/src/bedrock/common/constants')
const { Vec3 } = require('vec3')
const setupPlugin = require('../../src/builtins/setup')

function singleValueSubchunk (networkRuntimeId) {
  const stream = new Stream()
  stream.writeUInt8(9) // subchunk version
  stream.writeUInt8(1) // storage count
  stream.writeUInt8(0) // subchunk y
  stream.writeUInt8(1) // runtime palette, 0 bits per block
  stream.writeZigZagVarInt(networkRuntimeId)
  return stream.getBuffer()
}

function registryWithStartGame () {
  const liveRegistry = require('prismarine-registry')('bedrock_1.26.10')
  const liveBlock = require('prismarine-block')(liveRegistry)
  const client = new EventEmitter()
  const botState = {
    client,
    registry: liveRegistry,
    blockClass: liveBlock,
    game: {},
    setDimension (dimension) {
      this.game.dimension = dimension
    }
  }
  setupPlugin(botState, {})
  client.emit('start_game', {
    entity_id: 1n,
    runtime_entity_id: 1n,
    player_position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, z: 0 },
    player_gamemode: 'creative',
    dimension: 0,
    block_network_ids_are_hashes: true,
    server_authoritative_inventory: true,
    itemstates: [],
    block_properties: []
  })

  return { registry: liveRegistry, Block: liveBlock }
}

describe('Bedrock 1.26 subchunk runtime palette decoding', function () {
  const emeraldRuntimeId = registry.blockStates.findIndex(block => block && block.name === 'emerald_block')

  it('translates network runtime IDs to Prismarine block state IDs', function () {
    const subchunk = new SubChunk(registry, Block, { y: 0 })
    subchunk.decode(StorageType.Runtime, singleValueSubchunk(emeraldRuntimeId))

    const block = subchunk.getBlock(undefined, 0, 0, 0, 0)
    assert.strictEqual(registry.blockStates[emeraldRuntimeId].name, 'emerald_block')
    assert.strictEqual(block.name, 'emerald_block')
    assert.strictEqual(block.stateId, registry.blocksByName.emerald_block.defaultState)
  })

  it('uses the 1.26 subchunk decoder through chunk network decode paths', async function () {
    const chunk = new Chunk({ x: 0, z: 0 })

    await chunk.networkDecodeSubChunkNoCache(-4, singleValueSubchunk(emeraldRuntimeId))

    const block = chunk.getBlock(new Vec3(0, -64, 0))
    assert.strictEqual(block.name, 'emerald_block')
    assert.strictEqual(block.stateId, registry.blocksByName.emerald_block.defaultState)
  })

  it('decodes single-value hashed runtime palettes through the rebuilt registry', function () {
    const live = registryWithStartGame()
    const subchunk = new SubChunk(live.registry, live.Block, { y: 0 })
    const airRuntimeId = live.Block.getHash('minecraft:air', {})

    subchunk.decode(StorageType.Runtime, singleValueSubchunk(airRuntimeId))

    const block = subchunk.getBlock(undefined, 0, 0, 0, 0)
    assert.strictEqual(block.name, 'air')
    assert.strictEqual(block.stateId, live.registry.blocksByName.air.defaultState)
  })
})
