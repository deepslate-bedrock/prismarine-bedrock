const assert = require('assert')
const EventEmitter = require('events')
const Vec3 = require('vec3')

const installEntities = require('../../src/builtins/entities')
const installPhysics = require('../../src/builtins/physics')
const { createMovementPacketSender } = require('../../src/builtins/physics/movement-packets')
const { eyeHeightFor, toFeetPosition } = require('../../src/builtins/physics/position')
const { getConstants } = require('../../src/builtins/physics-constants')

class TestEntity {
  constructor (id) {
    this.id = id
    this.position = new Vec3(0, 0, 0)
    this.velocity = new Vec3(0, 0, 0)
  }
}

function createClient () {
  const client = new EventEmitter()
  client.entityId = 1n
  client.queue = () => {}
  return client
}

describe('Bedrock rotation mapping', function () {
  it('uses vec2f.z as yaw when physics handles start_game', function () {
    const client = createClient()
    const botState = new EventEmitter()
    botState.client = client
    botState.version = '1.26.10'
    botState.self = new TestEntity(1n)
    botState.self.runtimeId = 1n
    botState.world = {
      sync: { getBlock: () => null },
      waitForChunks: async () => {}
    }

    installPhysics(botState, { worldDecodeEnabled: true, physicsEnabled: true })

    client.emit('start_game', {
      player_position: { x: 1, y: 65, z: 2 },
      rotation: { x: 12, z: 34 }
    })

    assert.strictEqual(botState.self.pitch, 12)
    assert.strictEqual(botState.self.yaw, 34)
    assert.strictEqual(botState.self.headYaw, 34)
    assert.strictEqual(botState.self.position.y, 65)
  })

  it('does not change look rotation when physics handles movement correction', function () {
    const client = createClient()
    const botState = new EventEmitter()
    botState.client = client
    botState.version = '1.26.10'
    botState.self = new TestEntity(1n)
    botState.self.runtimeId = 1n
    botState.self.pitch = 5
    botState.self.yaw = 25
    botState.self.headYaw = 25
    botState.world = {
      sync: { getBlock: () => null },
      waitForChunks: async () => {}
    }

    installPhysics(botState, { worldDecodeEnabled: true, physicsEnabled: true })

    client.emit('correct_player_move_prediction', {
      position: { x: 1, y: 65, z: 2 },
      rotation: { x: 15, z: 75 },
      on_ground: true
    })

    assert.strictEqual(botState.self.pitch, 5)
    assert.strictEqual(botState.self.yaw, 25)
    assert.strictEqual(botState.self.headYaw, 25)
    assert.strictEqual(botState.self.position.y, 65)
  })

  it('uses correction rotation when physics handles vehicle movement prediction', function () {
    const client = createClient()
    const botState = new EventEmitter()
    botState.client = client
    botState.version = '1.26.10'
    botState.self = new TestEntity(1n)
    botState.self.runtimeId = 1n
    botState.self.pitch = 5
    botState.self.yaw = 25
    botState.self.headYaw = 25
    botState.world = {
      sync: { getBlock: () => null },
      waitForChunks: async () => {}
    }

    installPhysics(botState, { worldDecodeEnabled: true, physicsEnabled: true })

    client.emit('correct_player_move_prediction', {
      position: { x: 1, y: 65, z: 2 },
      rotation: { x: 15, z: 75 },
      on_ground: true,
      prediction_type: 'vehicle'
    })

    assert.strictEqual(botState.self.pitch, 15)
    assert.strictEqual(botState.self.yaw, 75)
    assert.strictEqual(botState.self.headYaw, 75)
    assert.strictEqual(botState.self.position.y, 65)
  })

  it('snaps tiny grounded correction noise to the block top', function () {
    const client = createClient()
    const botState = new EventEmitter()
    botState.client = client
    botState.version = '1.26.10'
    botState.self = new TestEntity(1n)
    botState.self.runtimeId = 1n
    botState.world = {
      sync: { getBlock: () => null },
      waitForChunks: async () => {}
    }

    installPhysics(botState, { worldDecodeEnabled: true, physicsEnabled: true })

    client.emit('correct_player_move_prediction', {
      position: { x: 1, y: 66.62001037597656, z: 2 },
      rotation: { x: 0, z: 0 },
      on_ground: true
    })

    const feet = toFeetPosition(botState.self.position, botState.self, getConstants('1.26.10'))
    assert.strictEqual(feet.y, 65)
    assert(Math.abs(botState.self.position.y - (65 + Math.fround(1.6200100183486938))) < 1e-12)
  })

  it('does not change look rotation when entities handles movement correction', function () {
    const client = createClient()
    const botState = new EventEmitter()
    botState.client = client
    botState.registry = { entitiesArray: [] }
    botState.entityClass = TestEntity
    botState.itemClass = { fromNotch: () => null }
    botState.entities = new Map()
    botState.playerEntities = new Map()
    botState.self = new TestEntity(1n)
    botState.self.pitch = 5
    botState.self.yaw = 25
    botState.self.headYaw = 25

    installEntities(botState, {})

    client.emit('correct_player_move_prediction', {
      position: { x: 1, y: 65, z: 2 },
      rotation: { x: 15, z: 75 },
      on_ground: true
    })

    assert.strictEqual(botState.self.pitch, 5)
    assert.strictEqual(botState.self.yaw, 25)
    assert.strictEqual(botState.self.headYaw, 25)
    assert.strictEqual(botState.self.position.y, 65)
  })

  it('uses correction rotation when entities handles vehicle movement prediction', function () {
    const client = createClient()
    const botState = new EventEmitter()
    botState.client = client
    botState.registry = { entitiesArray: [] }
    botState.entityClass = TestEntity
    botState.itemClass = { fromNotch: () => null }
    botState.entities = new Map()
    botState.playerEntities = new Map()
    botState.self = new TestEntity(1n)
    botState.self.pitch = 5
    botState.self.yaw = 25
    botState.self.headYaw = 25

    installEntities(botState, {})

    client.emit('correct_player_move_prediction', {
      position: { x: 1, y: 65, z: 2 },
      rotation: { x: 15, z: 75 },
      on_ground: true,
      prediction_type: 'vehicle'
    })

    assert.strictEqual(botState.self.pitch, 15)
    assert.strictEqual(botState.self.yaw, 75)
    assert.strictEqual(botState.self.headYaw, 75)
    assert.strictEqual(botState.self.position.y, 65)
  })

  it('sends player_auth_input from the public eye position', function () {
    const client = createClient()
    let sentPacket = null
    client.queue = (name, packet) => {
      if (name === 'player_auth_input') sentPacket = packet
    }

    const botState = new EventEmitter()
    botState.client = client
    botState.canSendPlayerAuthInput = true
    botState.world = { sync: { getBlock: () => null } }
    botState.self = new TestEntity(1n)
    botState.self.position = new Vec3(1, 65.62, 2)
    botState.self.yaw = 90
    botState.self.pitch = 0

    const sender = createMovementPacketSender(botState, getConstants('1.26.10'))
    sender.sendPlayerAuthInput(0)

    assert.deepStrictEqual(sentPacket.position, { x: 1, y: 65.62, z: 2 })
  })

  it('keeps Bedrock movement-position conversion independent of pose', function () {
    const C = getConstants('1.26.10')
    const self = new TestEntity(1n)
    self.position = new Vec3(1, 65.62, 2)

    self.pose = 'standing'
    assert.strictEqual(eyeHeightFor(self, C), Math.fround(1.6200100183486938))
    assert.strictEqual(toFeetPosition(self.position, self, C).y, 65.62 - Math.fround(1.6200100183486938))
    assert.strictEqual(self.eyeHeight, Math.fround(1.6200100183486938))

    self.pose = 'sneaking'
    assert.strictEqual(eyeHeightFor(self, C), Math.fround(1.6200100183486938))
    assert.strictEqual(toFeetPosition(self.position, self, C).y, 65.62 - Math.fround(1.6200100183486938))

    self.pose = 'standing'
    self.swimming = true
    assert.strictEqual(eyeHeightFor(self, C), Math.fround(1.6200100183486938))
    assert.strictEqual(toFeetPosition(self.position, self, C).y, 65.62 - Math.fround(1.6200100183486938))
  })
})
