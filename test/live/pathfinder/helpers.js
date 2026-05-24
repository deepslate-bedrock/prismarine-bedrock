'use strict'

const BotState = require('../../../src/state')
const { Vec3 } = require('vec3')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const {
  clearPlayer,
  givePlayer,
  sendCommand,
  setPlayerGamemode,
  teleportPlayer
} = require('../../helpers/commands')
const {
  HOST,
  PORT,
  USERNAME: DEFAULT_USERNAME,
  OFFLINE,
  VERSION,
  SETUP_DELAY_MS
} = require('../../helpers/test-env')

const USERNAME = process.env.PATHFINDER_USERNAME || DEFAULT_USERNAME
const START_DELAY_MS = Number(process.env.PATHFINDER_START_DELAY_MS || 0)
const GOAL_DELAY_MS = Number(process.env.PATHFINDER_GOAL_DELAY_MS || 0)
const PHYSICS_ENGINE = process.env.PATHFINDER_PHYSICS_ENGINE || process.env.BEDROCK_PHYSICS_ENGINE || 'native'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function blockNameMatches (actual, expected) {
  const normalize = value => String(value || '').replace(/^minecraft:/, '')
  return normalize(actual) === normalize(expected)
}

function isPhysicalBlock (block) {
  return block?.boundingBox === 'block' || (Array.isArray(block?.shapes) && block.shapes.length > 0)
}

function blockAt (botState, pos) {
  const getter = botState.world?.sync?.getBlock || botState.world?.getBlock
  if (typeof getter !== 'function') return null
  const block = getter.call(botState.world?.sync || botState.world, pos)
  if (block && typeof block.then === 'function') return null
  return block || null
}

async function waitForWorldBlock (botState, pos, blockName, timeoutMs = 5000) {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const block = blockAt(botState, pos)
    if (blockNameMatches(block?.name, blockName)) return block
    await sleep(50)
  }

  const block = blockAt(botState, pos)
  throw new Error(`Timed out waiting for pathfinder course block ${blockName} at ${pos.x},${pos.y},${pos.z}; got ${block?.name || 'missing'}`)
}

async function waitForAirBlock (botState, pos, timeoutMs = 5000) {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const block = blockAt(botState, pos)
    if (block?.boundingBox === 'empty') return block
    await sleep(50)
  }

  const block = blockAt(botState, pos)
  throw new Error(`Timed out waiting for pathfinder air at ${pos.x},${pos.y},${pos.z}; got ${block?.name || 'missing'} bbox=${block?.boundingBox || 'missing'}`)
}

async function waitForPhysicalBlock (botState, pos, timeoutMs = 5000) {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const block = blockAt(botState, pos)
    if (isPhysicalBlock(block)) return block
    await sleep(50)
  }

  const block = blockAt(botState, pos)
  throw new Error(`Timed out waiting for pathfinder support at ${pos.x},${pos.y},${pos.z}; got ${block?.name || 'missing'} bbox=${block?.boundingBox || 'missing'}`)
}

function summarizeBlock (botState, pos) {
  const block = blockAt(botState, pos)
  return {
    pos: `${pos.x},${pos.y},${pos.z}`,
    name: block?.name || null,
    type: block?.type ?? null,
    boundingBox: block?.boundingBox || null,
    shapes: Array.isArray(block?.shapes) ? block.shapes.length : null
  }
}

function pathfinderWorldDebug (botState, target) {
  const feet = feetPosition(botState)?.floored()
  const positions = []
  if (feet) {
    positions.push(feet, feet.offset(0, -1, 0), feet.offset(1, 0, 0), feet.offset(1, -1, 0), feet.offset(0, 1, 0))
  }
  positions.push(target, target.offset(0, -1, 0), target.offset(0, 1, 0))

  let neighborCount = null
  try {
    const movements = botState.pathfinder?.movements
    if (feet && movements?.getNeighbors) {
      neighborCount = movements.getNeighbors({
        x: feet.x,
        y: feet.y,
        z: feet.z,
        remainingBlocks: movements.countScaffoldingItems?.() ?? 0
      }).length
    }
  } catch (err) {
    neighborCount = `error:${err.message}`
  }

  return `world=${JSON.stringify({ neighborCount, blocks: positions.map(pos => summarizeBlock(botState, pos)) })}`
}

function waitForSpawn (botState, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${botState.options.username} spawn`)), timeoutMs)
    botState.client.once('spawn', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

function feetPosition (botState) {
  const position = botState.self?.position
  if (!position) return null
  const eyeHeight = Number.isFinite(botState.self.eyeHeight) ? botState.self.eyeHeight : 1.62
  return position.offset(0, -eyeHeight, 0)
}

async function waitForFeetNear (botState, target, radius = 1.2, timeoutMs = 20000, debugInfo = () => '') {
  const started = Date.now()
  const radiusSq = radius * radius

  while (Date.now() - started < timeoutMs) {
    const position = feetPosition(botState)
    if (position) {
      const dx = position.x - target.x
      const dy = position.y - target.y
      const dz = position.z - target.z
      if (dx * dx + dy * dy + dz * dz <= radiusSq) return position.clone()
    }

    await sleep(100)
  }

  const position = feetPosition(botState)
  const debug = debugInfo()
  throw new Error(`Timed out waiting for pathfinder target; position=${position ? `${position.x},${position.y},${position.z}` : 'missing'}${debug ? `; ${debug}` : ''}`)
}

async function waitForFeetInsideBlock (botState, target, timeoutMs = 20000, debugInfo = () => '') {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const position = feetPosition(botState)
    if (position) {
      const block = position.floored()
      if (block.x === target.x && block.y === target.y && block.z === target.z) return position.clone()
    }

    await sleep(100)
  }

  const position = feetPosition(botState)
  const block = position?.floored()
  const debug = debugInfo()
  throw new Error(`Timed out waiting for pathfinder target block ${target.x},${target.y},${target.z}; feet=${position ? `${position.x},${position.y},${position.z}` : 'missing'} block=${block ? `${block.x},${block.y},${block.z}` : 'missing'}${debug ? `; ${debug}` : ''}`)
}

function createPathfinderBot () {
  return new BotState({
    host: HOST,
    port: PORT,
    username: USERNAME,
    offline: OFFLINE,
    version: VERSION,
    skipPing: true,
    physicsEngine: PHYSICS_ENGINE,
    yawStepSpeed: 100000,
    pitchStepSpeed: 100000
  })
}

async function preparePathfinderBot (botState) {
  if (START_DELAY_MS > 0) await sleep(START_DELAY_MS)
  botState.start()
  await waitForSpawn(botState)
  setPlayerGamemode(botState, USERNAME, 'creative')
  await sleep(SETUP_DELAY_MS)
}

async function teardownPathfinderBot (botState) {
  if (!botState?.client) return
  try {
    botState.pathfinder?.stop()
    botState.clearControlStates?.()
    setPlayerGamemode(botState, USERNAME, 'survival')
  } catch {}
  botState.disconnect('live pathfinder compatibility test complete')
}

async function runCommands (botState, commands, delayMs = SETUP_DELAY_MS) {
  for (const command of commands) {
    sendCommand(botState, command)
    if (delayMs > 0) await sleep(delayMs)
  }
}

async function placeBlocks (botState, positions, block, delayMs = 25) {
  for (const pos of positions) {
    sendCommand(botState, `setblock ${pos.x} ${pos.y} ${pos.z} ${block}`)
    if (delayMs > 0) await sleep(delayMs)
    await waitForWorldBlock(botState, pos, block)
  }
}

async function clearCourseVolume (botState, min, max, floorY = -61) {
  await runCommands(botState, [
    `fill ${min.x} -60 ${min.z} ${max.x} ${max.y} ${max.z} minecraft:air`,
    `fill ${min.x} ${floorY} ${min.z} ${max.x} ${floorY} ${max.z} minecraft:stone`,
    `fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} minecraft:air`
  ])
}

async function teleportToStart (botState, start) {
  sendCommand(botState, `setblock ${start.x} ${start.y + 4} ${start.z} minecraft:stone`)
  await sleep(SETUP_DELAY_MS)
  teleportPlayer(botState, USERNAME, start.x + 0.5, start.y + 5, start.z + 0.5)
  await sleep(SETUP_DELAY_MS)
  teleportPlayer(botState, USERNAME, start.x + 0.5, start.y + 0.1, start.z + 0.5)
  await sleep(SETUP_DELAY_MS)
  await waitForFeetNear(botState, start.offset(0.5, 0, 0.5), 0.5, 5000, () => 'waiting for pathfinder course start teleport')
  sendCommand(botState, `setblock ${start.x} ${start.y + 4} ${start.z} minecraft:air`)
}

function installPathfinderTrace (botState) {
  const pathTrace = []
  const controlTrace = []
  const authInputTrace = []
  const remember = (event, data) => {
    pathTrace.push({ event, data })
    if (pathTrace.length > 8) pathTrace.shift()
  }
  const rememberControl = (name, value) => {
    controlTrace.push({ name, value })
    if (controlTrace.length > 16) controlTrace.shift()
  }

  const originalSetControlState = botState.setControlState.bind(botState)
  botState.setControlState = (name, value) => {
    rememberControl(name, value)
    return originalSetControlState(name, value)
  }
  const applyPlayerAuthInputHooks = botState._applyPlayerAuthInputHooks?.bind(botState)
  botState._applyPlayerAuthInputHooks = (packet, context = {}) => {
    applyPlayerAuthInputHooks?.(packet, context)
    authInputTrace.push({
      move: packet.move_vector,
      yaw: packet.yaw,
      up: !!packet.input_data?.up,
      blockAction: packet.block_action?.map(action => action.action),
      tick: String(packet.tick)
    })
    if (authInputTrace.length > 8) authInputTrace.shift()
    return packet
  }
  botState.on('path_update', result => {
    remember('path_update', {
      status: result?.status,
      pathLength: result?.path?.length ?? 0,
      visitedNodes: result?.visitedNodes,
      path: result?.path?.slice(0, 5).map(node => ({ x: node.x, y: node.y, z: node.z }))
    })
  })
  botState.on('path_reset', reason => remember('path_reset', { reason }))
  botState.on('goal_reached', () => remember('goal_reached', {}))

  return () => {
    const feet = feetPosition(botState)
    return `controls=${JSON.stringify({
      forward: botState.getControlState?.('forward'),
      jump: botState.getControlState?.('jump'),
      sprint: botState.getControlState?.('sprint')
    })} yaw=${botState.self?.yaw} feet=${feet ? `${feet.x},${feet.y},${feet.z}` : 'missing'} pathTrace=${JSON.stringify(pathTrace)} controlTrace=${JSON.stringify(controlTrace)} authInputTrace=${JSON.stringify(authInputTrace)}`
  }
}

async function loadPathfinder (botState, options = {}) {
  botState.loadPlugin(pathfinder)

  const movements = new Movements(botState.mineflayer)
  movements.canDig = options.canDig ?? false
  movements.allow1by1towers = options.allow1by1towers ?? false
  movements.allowParkour = options.allowParkour ?? false
  movements.allowSprinting = options.allowSprinting ?? false
  movements.allowEntityDetection = options.allowEntityDetection ?? false
  movements.scafoldingBlocks = options.scafoldingBlocks ?? []

  if (options.blocksToAvoid) movements.blocksToAvoid = options.blocksToAvoid
  if (options.blocksToStayAway) movements.blocksToStayAway = options.blocksToStayAway
  if (options.digCost !== undefined) movements.digCost = options.digCost
  if (options.placeCost !== undefined) movements.placeCost = options.placeCost

  botState.pathfinder.setMovements(movements)
  return movements
}

async function goToBlock (botState, target, options = {}) {
  const debugInfo = options.debugInfo || (() => '')
  const timeoutMs = options.timeoutMs ?? 20000
  if (GOAL_DELAY_MS > 0) await sleep(GOAL_DELAY_MS)
  const start = feetPosition(botState)?.floored()
  if (start) {
    await waitForAirBlock(botState, start)
    await waitForPhysicalBlock(botState, start.offset(0, -1, 0))
  }
  await waitForAirBlock(botState, target)
  await waitForPhysicalBlock(botState, target.offset(0, -1, 0))
  botState.pathfinder.setGoal(new goals.GoalBlock(target.x, target.y, target.z))
  await waitForFeetInsideBlock(botState, target, timeoutMs, () => {
    const base = debugInfo()
    const world = pathfinderWorldDebug(botState, target)
    return base ? `${base} ${world}` : world
  })
  botState.pathfinder.stop()
  botState.clearControlStates()
}

async function goToGoalReached (botState, target, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000
  if (GOAL_DELAY_MS > 0) await sleep(GOAL_DELAY_MS)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      const debug = options.debugInfo?.()
      reject(new Error(`Timed out waiting for pathfinder goal_reached ${target.x},${target.y},${target.z}${debug ? `; ${debug}` : ''}`))
    }, timeoutMs)
    timeout.unref?.()

    const cleanup = () => {
      clearTimeout(timeout)
      botState.off('goal_reached', onGoalReached)
    }
    const onGoalReached = () => {
      cleanup()
      resolve()
    }

    botState.on('goal_reached', onGoalReached)
    botState.pathfinder.setGoal(new goals.GoalBlock(target.x, target.y, target.z))
  })

  botState.pathfinder.stop()
  botState.clearControlStates()
}

async function giveScaffolding (botState, itemName, count = 16) {
  clearPlayer(botState, USERNAME)
  await sleep(SETUP_DELAY_MS)
  givePlayer(botState, USERNAME, itemName, count)
  await sleep(SETUP_DELAY_MS * 2)
}

module.exports = {
  GOAL_DELAY_MS,
  PHYSICS_ENGINE,
  SETUP_DELAY_MS,
  USERNAME,
  Vec3,
  clearCourseVolume,
  createPathfinderBot,
  feetPosition,
  giveScaffolding,
  goToBlock,
  goToGoalReached,
  installPathfinderTrace,
  loadPathfinder,
  pathfinder,
  placeBlocks,
  preparePathfinderBot,
  runCommands,
  sleep,
  teardownPathfinderBot,
  teleportToStart,
  waitForFeetInsideBlock,
  waitForFeetNear
}
