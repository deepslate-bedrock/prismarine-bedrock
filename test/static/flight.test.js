'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const Vec3 = require('vec3')

const { getConstants } = require('../../src/builtins/physics-constants')
const installEntities = require('../../src/builtins/entities')
const { installControls } = require('../../src/builtins/physics/input-controls')
const { createMovementPacketSender } = require('../../src/builtins/physics/movement-packets')
const installFlight = require('../../src/builtins/flight')
const { applyAbilities, isSpectatorGameMode, normalizeGameMode } = require('../../src/entity-metadata')

const C = getConstants('1.26.10')
const ABILITY = {
  flying: 1 << 9,
  may_fly: 1 << 10,
  no_clip: 1 << 17
}

function createClient () {
  const client = new EventEmitter()
  client.entityId = 1n
  client.queued = []
  client.queue = (name, params) => {
    client.queued.push({ name, params })
  }
  return client
}

function createBot () {
  const client = createClient()
  const botState = new EventEmitter()
  botState.options = {}
  botState.version = '1.26.10'
  botState.client = client
  botState.registry = { entitiesArray: [] }
  botState.entityClass = function TestEntity () {}
  botState.itemClass = { fromNotch: () => null }
  botState.entities = new Map()
  botState.playerEntities = new Map()
  botState.game = { gameMode: 'creative' }
  botState.canSendPlayerAuthInput = true
  botState.world = { sync: { getBlock: () => null } }
  botState.self = {
    position: new Vec3(0, 66.62, 0),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    headYaw: 0,
    onGround: true,
    tick: 0n
  }

  installEntities(botState, {})
  const controls = installControls(botState, C)
  installFlight(botState)
  const sender = createMovementPacketSender(botState, C)
  return { botState, client, controls, sender }
}

function emitAbilities (client, { mayFly = true, flying = false, noClip = false, spectator = false } = {}) {
  const baseEnabled = (flying ? ABILITY.flying : 0)
  const baseAllowed = (mayFly ? ABILITY.may_fly : 0)
  const abilities = [{
    type: 'base',
    allowed: baseAllowed,
    enabled: baseEnabled,
    fly_speed: 0.05,
    vertical_fly_speed: 1,
    walk_speed: 0.1
  }]

  if (spectator) {
    abilities.unshift({
      type: 'spectator',
      allowed: ABILITY.may_fly | ABILITY.flying | ABILITY.no_clip,
      enabled: ABILITY.flying | (noClip ? ABILITY.no_clip : 0),
      fly_speed: 0.05,
      vertical_fly_speed: 1,
      walk_speed: 0.1
    })
  }

  client.emit('update_abilities', {
    entity_unique_id: 1n,
    permission_level: 'member',
    command_permission: 'any',
    abilities
  })
}

function sendAuthPacket (controls, sender, client) {
  controls.evaluateControls()
  sender.sendPlayerAuthInput(0.05)
  return client.queued.at(-1).params
}

describe('creative flight builtin', function () {
  it('tracks ability layers and sends one-shot flight start/stop requests', function () {
    const { botState, client, controls, sender } = createBot()

    emitAbilities(client, { mayFly: true, flying: false })
    assert.strictEqual(botState.canFly(), true)
    assert.strictEqual(botState.isFlying(), false)

    assert.strictEqual(botState.startFlying(), true)
    let packet = sendAuthPacket(controls, sender, client)

    assert.strictEqual(packet.input_data.start_flying, true)
    assert.strictEqual(packet.input_data.stop_flying, false)
    assert.strictEqual(botState.self.flying, true)

    packet = sendAuthPacket(controls, sender, client)
    assert.strictEqual(!!packet.input_data.start_flying, false)

    emitAbilities(client, { mayFly: true, flying: true })
    assert.strictEqual(botState.self.flying, true)
    assert.strictEqual(botState.isFlying(), true)

    assert.strictEqual(botState.stopFlying(), true)
    packet = sendAuthPacket(controls, sender, client)

    assert.strictEqual(!!packet.input_data.start_flying, false)
    assert.strictEqual(packet.input_data.stop_flying, true)
    assert.strictEqual(botState.self.flying, false)
  })

  it('does not request flight without may_fly unless forced', function () {
    const { botState, client, controls, sender } = createBot()

    emitAbilities(client, { mayFly: false, flying: false })

    assert.strictEqual(botState.startFlying(), false)
    let packet = sendAuthPacket(controls, sender, client)
    assert.strictEqual(!!packet.input_data.start_flying, false)

    assert.strictEqual(botState.startFlying({ force: true }), true)
    packet = sendAuthPacket(controls, sender, client)
    assert.strictEqual(packet.input_data.start_flying, true)
  })

  it('maps jump and sneak controls to ascend and descend while flying', function () {
    const { botState, client, controls, sender } = createBot()

    emitAbilities(client, { mayFly: true, flying: true })
    botState.setControlState('jump', true)
    let packet = sendAuthPacket(controls, sender, client)

    assert.strictEqual(packet.input_data.ascend, true)
    assert.strictEqual(packet.input_data.want_up, true)

    botState.setControlState('jump', false)
    botState.setControlState('sneak', true)
    packet = sendAuthPacket(controls, sender, client)

    assert.strictEqual(packet.input_data.descend, true)
    assert.strictEqual(packet.input_data.want_down, true)
    assert.strictEqual(packet.input_data.sneaking, false)
    assert.strictEqual(packet.input_data.start_sneaking, false)
    assert.strictEqual(botState.self.sneaking, false)
    assert.strictEqual(botState.self.inferredPose, 'standing')
    assert.notStrictEqual(botState.self.pose, 'sneaking')
  })

  it('treats spectator ability layers as flight locked with no-clip state', function () {
    const { botState, client } = createBot()

    client.emit('update_player_game_type', {
      gamemode: 'spectator',
      player_unique_id: 1n,
      tick: 0n
    })
    emitAbilities(client, { mayFly: true, flying: true, noClip: true, spectator: true })

    assert.strictEqual(botState.isSpectator(), true)
    assert.strictEqual(botState.canFly(), true)
    assert.strictEqual(botState.isFlying(), true)
    assert.strictEqual(botState.self.noClip, true)
  })
})

describe('entity metadata ability parsing', function () {
  it('tracks base ability layer flight permission and speeds on the entity', function () {
    const entity = {}

    applyAbilities(entity, [{
      type: 'base',
      allowed: ABILITY.may_fly,
      enabled: ABILITY.flying,
      fly_speed: 0.08,
      vertical_fly_speed: 1.2,
      walk_speed: 0.11
    }])

    assert.strictEqual(entity.mayFly, true)
    assert.strictEqual(entity.allowFlight, true)
    assert.strictEqual(entity.flying, true)
    assert.strictEqual(entity.flySpeed, 0.08)
    assert.strictEqual(entity.verticalFlySpeed, 1.2)
    assert.strictEqual(entity.walkSpeed, 0.11)
  })

  it('treats spectator layers and gamemode aliases as spectator flight state', function () {
    const entity = { gamemode: 'creative_spectator' }

    applyAbilities(entity, [{
      type: 'spectator',
      allowed: ABILITY.may_fly | ABILITY.no_clip,
      enabled: ABILITY.flying | ABILITY.no_clip
    }])

    assert.strictEqual(normalizeGameMode(4), 'spectator')
    assert.strictEqual(isSpectatorGameMode('survival_spectator'), true)
    assert.strictEqual(entity.spectator, true)
    assert.strictEqual(entity.mayFly, true)
    assert.strictEqual(entity.flying, true)
    assert.strictEqual(entity.noClip, true)
  })
})
