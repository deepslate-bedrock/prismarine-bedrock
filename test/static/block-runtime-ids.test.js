'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { getBlockRuntimeId, getStateId } = require('../../src/utils')
const setupPlugin = require('../../src/builtins/setup')

describe('block runtime id mapping', function () {
  it('maps network hash runtime IDs back to local block state IDs', function () {
    const registry = {
      blocksByRuntimeId: {
        1921718966: { stateId: 14388, name: 'oak_planks' }
      }
    }

    assert.strictEqual(getStateId(registry, 1921718966), 14388)
  })

  it('falls back to palette state IDs when no runtime map exists', function () {
    const registry = {
      blocksByStateId: {
        14388: { name: 'oak_planks' }
      }
    }

    assert.strictEqual(getStateId(registry, 14388), 14388)
  })

  it('maps local state IDs to outbound hash runtime IDs', function () {
    const botState = {
      registry: {
        blockNetworkRuntimeIdsByStateId: {
          14388: 1921718966
        }
      },
      world: {
        getBlock: () => ({ stateId: 14388, name: 'oak_planks' })
      }
    }

    assert.strictEqual(getBlockRuntimeId(botState, new Vec3(1, 2, 3)), 1921718966)
  })

  it('reads outbound block runtime IDs from the synchronous world mirror', function () {
    const botState = {
      registry: {
        blockNetworkRuntimeIdsByStateId: {
          13313: -1132117234
        }
      },
      world: {
        getBlock: async () => {
          throw new Error('async world getter should not be used for packet construction')
        },
        sync: {
          getBlock: () => ({ stateId: 13313, name: 'chest' })
        }
      }
    }

    assert.strictEqual(getBlockRuntimeId(botState, new Vec3(2, 65, 0)), -1132117234)
  })

  it('keeps outbound palette state IDs when no hash map exists', function () {
    const botState = {
      registry: {},
      world: {
        getBlock: () => ({ stateId: 14388, name: 'oak_planks' })
      }
    }

    assert.strictEqual(getBlockRuntimeId(botState, new Vec3(1, 2, 3)), 14388)
  })

  it('rebuilds 1.26 hashed runtime IDs as local Prismarine state IDs from start_game', function () {
    const registry = require('prismarine-registry')('bedrock_1.26.10')
    const Block = require('prismarine-block')(registry)
    const client = new EventEmitter()
    const botState = {
      client,
      registry,
      blockClass: Block,
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

    const runtimeId = Block.getHash('minecraft:emerald_block', {})
    const expectedStateId = registry.blocksByName.emerald_block.defaultState

    assert.strictEqual(registry.blocksByRuntimeId[runtimeId].stateId, expectedStateId)
    assert.strictEqual(registry.blocksByStateId[expectedStateId].name, 'emerald_block')
    assert.strictEqual(registry.blockNetworkRuntimeIdsByStateId[expectedStateId], runtimeId)

    const bedrockNetworkState = registry.blockStates.find(state => state.name === 'bedrock')
    const bedrockRuntimeId = Block.getHash(bedrockNetworkState.name, bedrockNetworkState.states)
    const bedrockStateId = registry.blocksByName.bedrock.defaultState

    assert.strictEqual(registry.blocksByRuntimeId[bedrockRuntimeId].stateId, bedrockStateId)
    assert.strictEqual(registry.blocksByStateId[bedrockStateId].name, 'bedrock')
  })
})
