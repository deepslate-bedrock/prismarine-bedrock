'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const BotState = require('../../src/state')
const { isLoggingEnabled, logAction, setLoggingEnabled } = require('../../src/utils')
const pluginLoader = require('../../src/plugin-loader')
const setupPlugin = require('../../src/builtins/setup')
const worldPlugin = require('../../src/builtins/world')

function createSetupBotState () {
  const client = new EventEmitter()
  client.entityId = 1n
  client.queued = []
  client.queue = (name, params) => {
    client.queued.push({ name, params })
  }

  const registry = require('prismarine-registry')('bedrock_1.26.10')
  registry.handleStartGame = () => {}

  return {
    client,
    registry,
    blockClass: require('prismarine-block')(registry),
    game: {}
  }
}

describe('runtime options', function () {
  it('defaults to world decoding with physics mode for compatibility', function () {
    const bot = new BotState({ username: 'RuntimeOptionsBot' })

    assert.strictEqual(bot.options.worldDecodeEnabled, true)
    assert.strictEqual(bot.options.physicsEnabled, true)
    assert.strictEqual(bot.options.physicsEngine, 'native')
    assert.strictEqual(bot.options.loggingEnabled, true)
  })

  it('supports disabling Prismarine Bedrock action logging', function () {
    const originalLog = console.log
    const lines = []

    try {
      console.log = line => lines.push(line)

      const bot = new BotState({
        username: 'RuntimeOptionsBot',
        loggingEnabled: false
      })

      assert.strictEqual(bot.options.loggingEnabled, false)
      assert.strictEqual(isLoggingEnabled(), false)

      logAction('[test]', 'hidden')
      assert.deepStrictEqual(lines, [])
    } finally {
      console.log = originalLog
      setLoggingEnabled(true)
    }
  })

  it('supports selecting the nxg physics wrapper', function () {
    const bot = new BotState({
      username: 'RuntimeOptionsBot',
      physicsEngine: 'nxg-org'
    })

    assert.strictEqual(bot.options.physicsEngine, 'nxg')
  })

  it('supports explicitly disabled physics', function () {
    const bot = new BotState({
      username: 'RuntimeOptionsBot',
      physicsEnabled: false
    })

    assert.strictEqual(bot.options.worldDecodeEnabled, true)
    assert.strictEqual(bot.options.physicsEnabled, false)
    assert.strictEqual(pluginLoader.shouldLoadBuiltin(bot, 'physics.js'), false)
    assert.strictEqual(pluginLoader.shouldLoadBuiltin(bot, 'world.js'), true)
  })

  it('disables physics by default when world decoding is disabled', function () {
    const bot = new BotState({
      username: 'RuntimeOptionsBot',
      worldDecodeEnabled: false
    })

    assert.strictEqual(bot.options.worldDecodeEnabled, false)
    assert.strictEqual(bot.options.physicsEnabled, false)
    assert.strictEqual(pluginLoader.shouldLoadBuiltin(bot, 'physics.js'), false)
    assert.strictEqual(pluginLoader.shouldLoadBuiltin(bot, 'world.js'), true)
  })

  it('rejects physics without world decoding', function () {
    assert.throws(
      () => new BotState({
        username: 'RuntimeOptionsBot',
        worldDecodeEnabled: false,
        physicsEnabled: true
      }),
      /physicsEnabled requires worldDecodeEnabled: true/
    )
  })

  it('installs dimension and world reset handling from the world builtin', function () {
    const bot = new BotState({
      username: 'RuntimeOptionsBot',
      physicsEnabled: false
    })
    const originalWorld = bot.world

    assert.strictEqual(typeof bot.setDimension, 'undefined')
    assert.strictEqual(typeof bot.resetWorld, 'undefined')

    bot.client = new EventEmitter()
    worldPlugin(bot)
    bot.setDimension(1, { resetWorld: true })

    assert.notStrictEqual(bot.world, originalWorld)
    assert.strictEqual(bot.game.dimension, 1)
  })

  it('keeps categorized state off top-level primitive aliases', function () {
    const bot = new BotState({
      username: 'RuntimeOptionsBot',
      physicsEnabled: false
    })

    for (const key of [
      'dimension',
      'playerHealth',
      'spawnPosition',
      'worldMinY',
      'chunkCount',
      'blockNetworkIdsAreHashes',
      'sentAvailableCommandsReadyPackets',
      'worldDecodeEnabled',
      'physicsEnabled',
      'runtimeState'
    ]) {
      assert.strictEqual(Object.hasOwn(bot, key), false, key)
    }
  })

  it('does not request chunk radius when world decoding is disabled', function () {
    const botState = createSetupBotState()

    setupPlugin(botState, { worldDecodeEnabled: false })
    botState.client.emit('play_status', { status: 'player_spawn' })

    assert.deepStrictEqual(
      botState.client.queued.map(packet => packet.name),
      ['set_local_player_as_initialized']
    )
  })

  it('acks Boar network latency challenges with client timestamp magnitude', function () {
    const botState = createSetupBotState()

    setupPlugin(botState, {})
    botState.client.emit('network_stack_latency', {
      timestamp: BigInt.asUintN(64, -123n),
      needs_response: 1
    })

    assert.deepStrictEqual(botState.client.queued.at(-1), {
      name: 'network_stack_latency',
      params: {
        timestamp: BigInt.asUintN(64, -123000000n),
        needs_response: 0
      }
    })
  })

  it('echoes normal network latency challenges unchanged', function () {
    const botState = createSetupBotState()

    setupPlugin(botState, {})
    botState.client.emit('network_stack_latency', {
      timestamp: 123456789n,
      needs_response: 1
    })

    assert.deepStrictEqual(botState.client.queued.at(-1), {
      name: 'network_stack_latency',
      params: {
        timestamp: 123456789n,
        needs_response: 0
      }
    })
  })

  it('keeps dimension handling available when world decoding is disabled', function () {
    const bot = new BotState({
      username: 'RuntimeOptionsBot',
      worldDecodeEnabled: false
    })
    bot.client = new EventEmitter()
    bot.client.entityId = 1n
    bot.client.queued = []
    bot.client.queue = (name, params) => {
      bot.client.queued.push({ name, params })
    }

    worldPlugin(bot, bot.options)
    setupPlugin(bot, bot.options)
    bot.client.emit('start_game', {
      entity_id: 1n,
      runtime_entity_id: 1n,
      player_position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, z: 0 },
      player_gamemode: 'creative',
      dimension: 2,
      block_network_ids_are_hashes: false,
      server_authoritative_inventory: true,
      itemstates: [],
      block_properties: []
    })

    assert.strictEqual(bot.game.dimension, 2)
  })

  it('keeps plugin loading state in the external loader', function () {
    const bot = new BotState({
      username: 'RuntimeOptionsBot',
      physicsEnabled: false
    })
    const seenEvents = []
    const plugin = (botState, options) => {
      botState.loaderTestRan = true
      botState.loaderTestOptions = options
    }

    assert.strictEqual(typeof bot.loadPlugin, 'undefined')
    bot.on('pluginsLoaded', event => seenEvents.push(event))
    pluginLoader.loadPlugin(bot, plugin)
    assert.strictEqual(pluginLoader.hasPlugin(bot, plugin), true)
    assert.strictEqual(pluginLoader.isPluginLoaded(bot, plugin), false)
    pluginLoader.injectPlugins(bot)

    assert.strictEqual(bot.loaderTestRan, true)
    assert.strictEqual(bot.loaderTestOptions, bot.options)
    assert.strictEqual(bot.pluginLoader, undefined)
    assert.strictEqual(pluginLoader.isInjected(bot), true)
    assert.strictEqual(pluginLoader.isPluginLoaded(bot, plugin), true)
    assert.strictEqual(seenEvents.length, 1)
    assert.deepStrictEqual(seenEvents[0].plugins, [plugin])
    assert.strictEqual(seenEvents[0].bot, bot)
  })

  it('does not reinstall the same plugin for the same bot', function () {
    const bot = new BotState({
      username: 'RuntimeOptionsBot',
      physicsEnabled: false
    })
    let installs = 0
    let pluginsLoadedEvents = 0
    const plugin = () => {
      installs++
    }
    bot.on('pluginsLoaded', () => {
      pluginsLoadedEvents++
    })

    pluginLoader.loadPlugin(bot, plugin)
    pluginLoader.loadPlugin(bot, plugin)
    pluginLoader.injectPlugins(bot)
    pluginLoader.injectPlugins(bot)

    assert.strictEqual(installs, 1)
    assert.strictEqual(pluginsLoadedEvents, 1)
  })
})
