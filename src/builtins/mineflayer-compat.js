'use strict'

const { Vec3 } = require('vec3')
const { bedrockRegistryName } = require('../version')
const { getConstants } = require('./physics-constants')
const { createPathfinderPhysicsShim } = require('./physics/pathfinder-physics-shim')
const {
  blockFaceFromVector,
  degreesToRadians,
  javaYawRadiansToBedrockDegrees,
  normalizeBlockPos,
  radiansToDegrees
} = require('../utils')

const FACADE = Symbol('mineflayerCompatFacade')
const ENTITY_FACADE = Symbol('mineflayerCompatEntityFacade')
const REGISTRY_FACADE = Symbol('mineflayerCompatRegistryFacade')
const EVENT_BRIDGES = Symbol('mineflayerCompatEventBridges')
const PATHFINDER_PHYSICS = Symbol('mineflayerCompatPathfinderPhysics')

const EVENT_NAME_ALIASES = {
  physicTick: 'physicsTick'
}

const MINEFLAYER_EQUIPMENT_SLOTS = {
  hand: 36,
  head: 5,
  torso: 6,
  legs: 7,
  feet: 8,
  'off-hand': 45
}

function bindFunction (target, value) {
  return typeof value === 'function' ? value.bind(target) : value
}

function asRuntimeKey (key) {
  if (typeof key === 'bigint') return key.toString()
  if (key == null) return ''
  return String(key)
}

function entityObjectFromMaps (botState) {
  const entities = {}

  function add (key, entity) {
    if (!entity) return
    const runtimeKey = asRuntimeKey(entity.runtimeId ?? key)
    if (runtimeKey) entities[runtimeKey] = entity
  }

  if (botState.self) add(botState.self.runtimeId ?? botState.client?.entityId ?? 'self', botState.self)
  for (const [key, entity] of botState.entities || []) add(key, entity)
  for (const [key, entity] of botState.playerEntities || botState.players || []) add(key, entity)

  return entities
}

function inventoryFacade (botState) {
  const inventory = botState.inventory || { slots: [] }

  return new Proxy(inventory, {
    get (target, prop, receiver) {
      if (prop === 'items') {
        return () => (target.slots || []).filter(Boolean)
      }

      return bindFunction(target, Reflect.get(target, prop, receiver))
    }
  })
}

function ensureMineflayerEntityDefaults (entity) {
  if (!entity) return entity

  entity.velocity ??= new Vec3(0, 0, 0)
  entity.effects ??= {}
  entity.attributes ??= {}
  entity.yaw ??= 0
  entity.pitch ??= 0
  entity.onGround ??= false
  entity.isInWater ??= false
  entity.isInLava ??= false
  entity.isInWeb ??= false
  entity.isCollidedHorizontally ??= false
  entity.isCollidedVertically ??= false
  entity.elytraFlying ??= false

  return entity
}

function toMineflayerPosition (entity) {
  if (!entity?.position) return entity?.position
  const eyeHeight = Number.isFinite(entity.eyeHeight) ? entity.eyeHeight : 1.62
  return entity.position.offset(0, -eyeHeight, 0)
}

function entityFacade (botState) {
  if (botState[ENTITY_FACADE]) return botState[ENTITY_FACADE]

  botState[ENTITY_FACADE] = new Proxy({}, {
    get (_target, prop) {
      const entity = ensureMineflayerEntityDefaults(botState.self)
      if (!entity) return undefined
      if (prop === 'position') return toMineflayerPosition(entity)
      if (prop === 'yaw') return degreesToRadians(entity.yaw)
      if (prop === 'pitch') return degreesToRadians(entity.pitch)
      return bindFunction(entity, entity[prop])
    },

    set (_target, prop, value) {
      const entity = ensureMineflayerEntityDefaults(botState.self)
      if (!entity) return true
      if (prop === 'position' && value) {
        const eyeHeight = Number.isFinite(entity.eyeHeight) ? entity.eyeHeight : 1.62
        entity.position = value.offset ? value.offset(0, eyeHeight, 0) : new Vec3(value.x, value.y + eyeHeight, value.z)
        return true
      }
      if (prop === 'yaw' || prop === 'pitch') {
        entity[prop] = radiansToDegrees(value)
        return true
      }
      entity[prop] = value
      return true
    }
  })

  return botState[ENTITY_FACADE]
}

function gameFacade (botState) {
  const game = botState.game || {}

  return new Proxy(game, {
    get (target, prop, receiver) {
      if (prop === 'minY') return botState.runtimeState?.worldMinY ?? botState.worldMinY ?? botState.minY ?? -64
      if (prop === 'height') return botState.runtimeState?.worldHeight ?? botState.worldHeight ?? 384
      return Reflect.get(target, prop, receiver)
    }
  })
}

function registryFacade (botState) {
  const registry = botState.registry
  if (!registry) return registry
  if (botState[REGISTRY_FACADE]) return botState[REGISTRY_FACADE]

  const Block = botState.blockClass
  const blocksArray = (registry.blocksArray || []).filter(blockData => {
    try {
      if (!Block) return true
      const block = Block.fromStateId(blockData.minStateId, 0)
      return Array.isArray(block.shapes)
    } catch {
      return false
    }
  })

  botState[REGISTRY_FACADE] = new Proxy(registry, {
    get (target, prop, receiver) {
      if (prop === 'blocksArray') return blocksArray
      return Reflect.get(target, prop, receiver)
    }
  })

  return botState[REGISTRY_FACADE]
}

function blockAt (botState, pos) {
  const blockPos = pos ? normalizeBlockPos(pos) : pos
  if (!blockPos) return null

  const getter = botState.world?.sync?.getBlock || botState.world?.getBlock
  if (typeof getter !== 'function') return null

  const block = getter.call(botState.world.sync || botState.world, blockPos)
  if (block && typeof block.then === 'function') return null
  return block || null
}

function blockMatches (block, matching, useExtraInfo) {
  if (!block) return false
  if (typeof matching === 'function') return !!matching(block)

  const id = block.type ?? block.id
  const name = block.name
  const candidates = Array.isArray(matching) || matching instanceof Set
    ? matching
    : [matching]

  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      if (candidate(block)) return true
    } else if (typeof candidate === 'number') {
      if (id === candidate) return true
    } else if (typeof candidate === 'string') {
      if (name === candidate || name === `minecraft:${candidate}`) return true
    } else if (candidate && typeof candidate === 'object') {
      if (candidate.type === id || candidate.id === id || candidate.name === name) return true
    }
  }

  return typeof useExtraInfo === 'function' ? !!useExtraInfo(block) : false
}

function findBlocks (botState, options = {}) {
  const origin = options.point || toMineflayerPosition(botState.self) || botState.self?.position
  const matching = options.matching
  if (!origin || matching == null) return []

  const maxDistance = Math.max(0, Math.floor(options.maxDistance ?? 16))
  const count = Number.isFinite(options.count) ? Math.max(0, options.count) : Infinity
  const center = normalizeBlockPos(origin)
  const matches = []

  for (let y = -maxDistance; y <= maxDistance; y++) {
    for (let x = -maxDistance; x <= maxDistance; x++) {
      for (let z = -maxDistance; z <= maxDistance; z++) {
        const distanceSq = x * x + y * y + z * z
        if (distanceSq > maxDistance * maxDistance) continue

        const pos = center.offset(x, y, z)
        const block = blockAt(botState, pos)
        if (!blockMatches(block, matching, options.useExtraInfo)) continue

        matches.push({ pos: block.position || pos, distanceSq })
      }
    }
  }

  matches.sort((a, b) => a.distanceSq - b.distanceSq)
  return matches.slice(0, count).map(match => match.pos)
}

function findBlock (botState, options = {}) {
  const positions = findBlocks(botState, { ...options, count: 1 })
  return positions.length > 0 ? blockAt(botState, positions[0]) : null
}

function waitForChunks (botState, options = {}) {
  const waiter = botState.waitForChunksToLoad
  if (typeof waiter !== 'function') return Promise.resolve()

  const point = options.point || botState.self?.position
  const radius = options.radius ?? options.maxDistance ?? 16
  const timeout = options.timeout ?? options.timeoutMs
  const verticalSectionRadius = options.verticalSectionRadius

  return waiter.call(botState, radius, point, timeout, verticalSectionRadius)
}

function inventorySlots (botState) {
  return botState.inventory?.slots || []
}

function inventorySlotMatchesItem (slotItem, item) {
  if (!slotItem || !item) return false
  if (slotItem === item) return true

  const sameType = slotItem.type === item.type || slotItem.id === item.id
  if (!sameType) return false

  if (item.name && slotItem.name && item.name !== slotItem.name) return false
  if (item.metadata != null && slotItem.metadata != null && item.metadata !== slotItem.metadata) return false
  if (item.count != null && slotItem.count != null && item.count !== slotItem.count) return false

  return true
}

function findInventorySlotForItem (botState, item) {
  if (Number.isInteger(item)) return item
  if (Number.isInteger(item?.slot) && inventorySlots(botState)[item.slot]) return item.slot

  const slots = inventorySlots(botState)
  const exact = slots.findIndex(slotItem => slotItem === item)
  if (exact >= 0) return exact

  return slots.findIndex(slotItem => inventorySlotMatchesItem(slotItem, item))
}

function normalizeEquipmentDestination (destination) {
  return destination == null || destination === 'heldItem' ? 'hand' : destination
}

function getEquipmentDestSlotCompat (botState, destination) {
  destination = normalizeEquipmentDestination(destination)
  const slot = MINEFLAYER_EQUIPMENT_SLOTS[destination]
  if (slot == null) throw new Error(`invalid destination: ${destination}`)
  if (destination === 'hand') return 36 + (botState.heldItemSlot ?? 0)
  return slot
}

async function equipCompat (botState, item, destination = 'hand') {
  destination = normalizeEquipmentDestination(destination)

  const slot = findInventorySlotForItem(botState, item)
  if (slot < 0) throw new Error(`Cannot equip missing item: ${item?.name || item?.type || item}`)

  if (destination === 'hand') {
    if (typeof botState.equipItem === 'function') return botState.equipItem(slot)
    if (typeof botState.selectHotbarSlot === 'function' && slot >= 0 && slot <= 8) {
      botState.selectHotbarSlot(slot)
      return inventorySlots(botState)[slot]
    }

    throw new Error('Cannot equip item: no Bedrock equipItem/selectHotbarSlot helper is available')
  }

  throw new Error(`Mineflayer compat equip destination ${destination} is not backed by a Bedrock equipment action yet`)
}

async function unequipCompat (botState, destination = 'hand') {
  destination = normalizeEquipmentDestination(destination)

  if (destination === 'hand') {
    const emptyHotbarSlot = inventorySlots(botState).findIndex((item, slot) => slot >= 0 && slot <= 8 && !item)
    if (emptyHotbarSlot >= 0 && typeof botState.selectHotbarSlot === 'function') {
      botState.selectHotbarSlot(emptyHotbarSlot)
      return
    }
    throw new Error('Cannot unequip hand: no empty hotbar slot is available')
  }

  throw new Error(`Mineflayer compat unequip destination ${destination} is not backed by a Bedrock equipment action yet`)
}

function blockPosition (blockOrPos) {
  if (!blockOrPos) return null
  const pos = blockOrPos.position || blockOrPos
  if (pos instanceof Vec3) return pos
  if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) return new Vec3(pos.x, pos.y, pos.z)
  return null
}

async function placeBlockCompat (botState, referenceBlock, faceVector) {
  return placeBlockWithOptionsCompat(botState, referenceBlock, faceVector, { swingArm: 'right' })
}

function placeLookOffset (faceVector, options = {}) {
  let dx = 0.5 + (Number(faceVector?.x) || 0) * 0.5
  let dy = 0.5 + (Number(faceVector?.y) || 0) * 0.5
  let dz = 0.5 + (Number(faceVector?.z) || 0) * 0.5

  if (dy === 0.5) {
    if (options.half === 'top') dy += 0.25
    else if (options.half === 'bottom') dy -= 0.25
  }

  if (options.delta) {
    dx = Number(options.delta.x) || 0
    dy = Number(options.delta.y) || 0
    dz = Number(options.delta.z) || 0
  }

  return { x: dx, y: dy, z: dz }
}

async function placeBlockWithOptionsCompat (botState, referenceBlock, faceVector, options = {}) {
  if (typeof botState.placeBlock !== 'function') {
    throw new Error('Cannot place block: native placeBlock helper is not available')
  }

  const position = blockPosition(referenceBlock)
  if (!position) throw new Error('Cannot place block: reference block has no position')

  if (options.offhand) {
    throw new Error('Mineflayer compat offhand block placement is not backed by a Bedrock action yet')
  }

  if (options.swingArm && typeof botState.swingArm === 'function') {
    botState.swingArm(options.swingArm, options.showHand)
  }

  return botState.placeBlock(position, blockFaceFromVector(faceVector, undefined), {
    ...options,
    lookOffset: placeLookOffset(faceVector, options)
  })
}

function mineflayerYawToBedrockDegrees (yaw) {
  return javaYawRadiansToBedrockDegrees(yaw)
}

function mineflayerDataVersion (botState) {
  const explicit = botState.options?.mineflayerDataVersion ?? botState.mineflayerDataVersion
  if (explicit) return explicit
  return bedrockRegistryName(botState.version || botState.options?.version)
}

// Real bedrock physics bridged into the bot.physics interface pathfinder
// consumes. Falls back to the cheap heuristic shim below if the bedrock
// constants aren't available (e.g. very early in startup before version is
// resolved).
function getPathfinderPhysics (botState) {
  if (botState[PATHFINDER_PHYSICS]) return botState[PATHFINDER_PHYSICS]
  try {
    const version = botState.version || botState.options?.version
    if (!version) return null
    const C = getConstants(version)
    if (!C) return null
    const shim = createPathfinderPhysicsShim(botState, C)
    botState[PATHFINDER_PHYSICS] = shim
    return shim
  } catch {
    return null
  }
}

function createSimplePhysicsShim (botState) {
  return {
    simulatePlayer (state) {
      if (!state?.pos) return state

      const control = state.control || {}
      const yaw = Number.isFinite(state.yaw) ? state.yaw : 0
      const speed = control.sprint ? 0.28 : 0.18
      let forward = 0
      let strafe = 0

      if (control.forward) forward += 1
      if (control.back) forward -= 1
      if (control.left) strafe += 1
      if (control.right) strafe -= 1

      const length = Math.hypot(forward, strafe)
      if (length > 1) {
        forward /= length
        strafe /= length
      }

      if (forward !== 0 || strafe !== 0) {
        const bedrockYaw = Math.PI - yaw
        const sin = Math.sin(bedrockYaw)
        const cos = Math.cos(bedrockYaw)
        state.pos.x += (strafe * cos - forward * sin) * speed
        state.pos.z += (forward * cos + strafe * sin) * speed
      }

      if (control.jump && state.onGround) {
        state.pos.y += 0.42
        state.onGround = false
      } else if (!state.onGround) {
        const selfFeetY = toMineflayerPosition(botState.self)?.y ?? state.pos.y
        state.pos.y -= 0.08
        if (state.pos.y <= selfFeetY) {
          state.pos.y = selfFeetY
          state.onGround = true
        }
      }

      state.isInWater = !!botState.self?.isInWater
      state.isInLava = !!botState.self?.isInLava
      return state
    }
  }
}

function normalizeEventName (eventName) {
  return EVENT_NAME_ALIASES[eventName] || eventName
}

function eventMethod (target, prop) {
  return (eventName, ...args) => {
    const nativeName = normalizeEventName(eventName)
    return target[prop](nativeName, ...args)
  }
}

function oncePromiseOrListener (target, eventName, listener) {
  const nativeName = normalizeEventName(eventName)
  if (typeof listener === 'function') return target.once(nativeName, listener)

  return new Promise(resolve => {
    target.once(nativeName, (...args) => resolve(args.length > 1 ? args : args[0]))
  })
}

function chunkEventPayload (botState, cx, cz) {
  const key = `${cx},${cz}`
  const column = botState.networkChunks?.get?.(key)
  if (column && typeof column === 'object') {
    if (!Number.isFinite(column.x)) column.x = cx << 4
    if (!Number.isFinite(column.z)) column.z = cz << 4
    column.chunkX ??= cx
    column.chunkZ ??= cz
    return column
  }

  return {
    x: cx << 4,
    z: cz << 4,
    chunkX: cx,
    chunkZ: cz,
    column: column || null
  }
}

function emitChunkColumnLoad (botState, emittedChunks, cx, cz) {
  const key = `${cx},${cz}`
  if (emittedChunks.has(key)) return
  emittedChunks.add(key)

  setImmediate(() => {
    const chunk = chunkEventPayload(botState, cx, cz)
    botState.emit('chunkColumnLoad', chunk)
    botState.emit('chunkColumnLoaded', chunk)
  })
}

function emitBlockUpdate (botState, oldBlock, position) {
  if (!position) return

  setImmediate(() => {
    const newBlock = blockAt(botState, position)
    botState.emit('blockUpdate', oldBlock || null, newBlock || null)
    botState.emit('blockUpdated', oldBlock || null, newBlock || null)
  })
}

function isSubchunkLoadedResult (result) {
  return result === 1 || result === 6 || result === 'success' || result === 'success_all_air'
}

function installMineflayerEventBridges (botState) {
  const client = botState.client
  if (!client || typeof client.on !== 'function') return
  if (botState[EVENT_BRIDGES]) return

  const emittedChunks = new Set()
  const oldBlockAt = position => {
    try {
      return blockAt(botState, position)
    } catch {
      return null
    }
  }

  client.on('level_chunk', packet => {
    if (!Number.isFinite(packet?.x) || !Number.isFinite(packet?.z)) return
    emitChunkColumnLoad(botState, emittedChunks, packet.x, packet.z)
  })

  client.on('subchunk', packet => {
    const origin = packet?.origin
    if (!origin || !Array.isArray(packet.entries)) return

    for (const entry of packet.entries) {
      if (!entry) continue
      if (!isSubchunkLoadedResult(entry.result)) continue
      emitChunkColumnLoad(botState, emittedChunks, origin.x + entry.dx, origin.z + entry.dz)
    }
  })

  const updateBlock = packet => {
    if (packet?.layer !== undefined && packet.layer !== 0) return
    const position = packet?.position
    const oldBlock = oldBlockAt(position)
    emitBlockUpdate(botState, oldBlock, position)
  }

  client.on('update_block', updateBlock)
  client.on('update_block_synced', updateBlock)
  client.on('update_subchunk_blocks', packet => {
    if (!Array.isArray(packet?.blocks)) return
    for (const entry of packet.blocks) {
      const oldBlock = oldBlockAt(entry?.position)
      emitBlockUpdate(botState, oldBlock, entry?.position)
    }
  })

  botState[EVENT_BRIDGES] = true
}

function createMineflayerFacade (botState) {
  if (botState[FACADE]) return botState[FACADE]

  const loadedPlugins = new Set()

  const facade = new Proxy(botState, {
    get (target, prop, receiver) {
      if (prop === 'entity') return entityFacade(target)
      if (prop === 'entities') return entityObjectFromMaps(target)
      if (prop === 'inventory') return inventoryFacade(target)
      if (prop === 'game') return gameFacade(target)
      if (prop === 'registry') return registryFacade(target)
      if (prop === 'version') return mineflayerDataVersion(target)
      if (prop === 'blockAt') return (pos) => blockAt(target, pos)
      if (prop === 'findBlock') return target.findBlock || (options => findBlock(target, options))
      if (prop === 'findBlocks') return target.findBlocks || (options => findBlocks(target, options))
      if (prop === 'waitForChunks') return target.waitForChunks || (options => waitForChunks(target, options))
      if (prop === 'equip') return (item, destination) => equipCompat(target, item, destination)
      if (prop === 'unequip') return destination => unequipCompat(target, destination)
      if (prop === 'getEquipmentDestSlot') return destination => getEquipmentDestSlotCompat(target, destination)
      if (prop === 'fish') {
        return async () => {
          await target.fish()
        }
      }
      if (prop === 'placeBlock') return (referenceBlock, faceVector) => placeBlockCompat(target, referenceBlock, faceVector)
      if (prop === '_placeBlockWithOptions') return (referenceBlock, faceVector, options) => placeBlockWithOptionsCompat(target, referenceBlock, faceVector, options)
      if (prop === 'physics') return target.physics || getPathfinderPhysics(target) || createSimplePhysicsShim(target)
      if (prop === 'look') {
        return (yaw, pitch = 0, force = true) => target.look?.(mineflayerYawToBedrockDegrees(yaw), radiansToDegrees(pitch), force)
      }
      if (prop === 'on' || prop === 'addListener' || prop === 'prependListener' || prop === 'removeListener' || prop === 'off') return eventMethod(target, prop)
      if (prop === 'once') return (eventName, listener) => oncePromiseOrListener(target, eventName, listener)
      if (prop === 'removeAllListeners') return (eventName) => {
        if (eventName === undefined) return target.removeAllListeners()
        return target.removeAllListeners(normalizeEventName(eventName))
      }
      if (prop === 'listeners' || prop === 'rawListeners' || prop === 'listenerCount') return (eventName, ...args) => target[prop](normalizeEventName(eventName), ...args)
      if (prop === 'emit') return (eventName, ...args) => target.emit(normalizeEventName(eventName), ...args)
      if (prop === 'loadPlugin') {
        return (plugin) => {
          if (loadedPlugins.has(plugin)) return facade
          loadedPlugins.add(plugin)
          plugin(facade)
          return facade
        }
      }
      if (prop === 'hasPlugin') return plugin => loadedPlugins.has(plugin)
      if (prop === 'loadPlugins') {
        return (plugins = []) => {
          for (const plugin of plugins) facade.loadPlugin(plugin)
          return facade
        }
      }
      if (prop === 'asMineflayerBot') return () => facade
      if (prop === 'nativeBot') return target

      return bindFunction(target, Reflect.get(target, prop, receiver))
    },

    set (target, prop, value) {
      target[prop] = value
      return true
    }
  })

  botState[FACADE] = facade
  return facade
}

module.exports = function mineflayerCompatPlugin (botState) {
  installMineflayerEventBridges(botState)
  const facade = createMineflayerFacade(botState)

  Object.defineProperty(botState, 'mineflayer', {
    configurable: true,
    enumerable: true,
    get () {
      return facade
    }
  })

  botState.asMineflayerBot = () => facade
  botState.loadMineflayerPlugin = plugin => facade.loadPlugin(plugin)
  botState.loadMineflayerPlugins = plugins => facade.loadPlugins(plugins)
  botState.hasMineflayerPlugin = plugin => facade.hasPlugin(plugin)
  if (typeof botState.loadPlugin !== 'function') botState.loadPlugin = plugin => facade.loadPlugin(plugin)
  if (typeof botState.loadPlugins !== 'function') botState.loadPlugins = plugins => facade.loadPlugins(plugins)
  if (typeof botState.hasPlugin !== 'function') botState.hasPlugin = plugin => facade.hasPlugin(plugin)
}

module.exports.createMineflayerFacade = createMineflayerFacade
