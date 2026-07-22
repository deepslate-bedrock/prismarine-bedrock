process.env.DEBUG_PHYSICS = true

const { BotState } = require('..')
const Vec3 = require('vec3').Vec3
const { bedrockVersionFromEnv } = require('../src/version')

const options = {
  host: 'localhost',
  port: 19132,
  username: 'MyBot',
  offline: true,
  version: bedrockVersionFromEnv()
}

const bot = new BotState(options)

function computeLookAngles (observer, target) {
  const dx = target.x - observer.x
  const dy = target.y - observer.y
  const dz = target.z - observer.z
  const dist = Math.sqrt(dx * dx + dz * dz)

  const yaw = Math.atan2(dx, -dz) * (180 / Math.PI)
  const pitch = -Math.atan2(dy, dist) * (180 / Math.PI)

  return { yaw, pitch }
}

async function logBlocksAroundBot (radius = 2, yRadius = 2) {
  if (!bot.self || !bot.self.position) {
    bot.logAction('[->]', 'command', { msg: 'Bot position not available.' })
    return
  }

  const center = bot.self.position
  const cx = Math.floor(center.x)
  const cy = Math.floor(center.y)
  const cz = Math.floor(center.z)

  console.log('\n=== Blocks around bot ===')
  console.log(`bot position: (${center.x.toFixed(3)}, ${center.y.toFixed(3)}, ${center.z.toFixed(3)})`)
  console.log(`scan center: (${cx}, ${cy}, ${cz}), radius=${radius}, yRadius=${yRadius}`)

  for (let y = cy + yRadius; y >= cy - yRadius; y--) {
    console.log(`\n--- y=${y} ---`)

    for (let z = cz - radius; z <= cz + radius; z++) {
      let line = ''

      for (let x = cx - radius; x <= cx + radius; x++) {
        let block = null

        try {
          block = await bot.getBlock(x, y, z)
        } catch {}

        const name = block?.name ?? 'undefined'

        if (name === 'air') line += ' . '
        else if (name === 'bedrock') line += ' B '
        else if (name === 'dirt') line += ' D '
        else if (name === 'grass_block') line += ' G '
        else if (name === 'water') line += ' W '
        else if (name === 'lava') line += ' L '
        else if (name === 'undefined') line += ' ? '
        else line += ' # '
      }

      console.log(`z=${String(z).padStart(4, ' ')} ${line}`)
    }
  }

  console.log('\nLegend: .=air B=bedrock D=dirt G=grass W=water L=lava #=other ?=undefined')
  console.log('=== End blocks around bot ===\n')
}

bot.on('chat', async (data) => {
  const { sourceName, message } = data

  if (!message.startsWith('!')) return
  if (sourceName === bot.client.username) return

  const rest = message.slice(1).trim()
  const [cmd, ...args] = rest.split(/\s+/)
  if (!cmd) return

  switch (cmd.toLowerCase()) {
    case 'search': {
      const blockName = normalizeBlockName(args.join(' '))

      if (!blockName) {
        bot.logAction('[->]', 'command', { msg: 'Usage: !search <block name>' })
        return
      }

      const ids = buildTargetSetForBlock(blockName, bot.registry)

      if (!ids) {
        bot.logAction('[->]', 'command', { msg: `Unknown block: ${blockName}` })
        return
      }

      bot.currentTargetBlock = blockName
      bot.targetStateIds = ids

      bot.logAction('[->]', 'command', {
        msg: `Now searching for: ${blockName}`,
        matchingStates: ids.size
      })

      if (bot.scanAllLoadedChunks) bot.scanAllLoadedChunks()
      break
    }

    case 'stop':
      bot.currentTargetBlock = null
      bot.targetStateIds = null
      bot.logAction('[->]', 'command', { msg: 'Stopped searching' })
      break

    case 'scan':
      if (bot.scanAllLoadedChunks) bot.scanAllLoadedChunks()
      break

    case 'blocks':
    case 'blockinfo':
    case 'around': {
      const radius = args[0] ? Number(args[0]) : 2
      const yRadius = args[1] ? Number(args[1]) : 2

      if (!Number.isFinite(radius) || !Number.isFinite(yRadius)) {
        bot.logAction('[->]', 'command', { msg: 'Usage: !blocks [radius] [yRadius]' })
        break
      }

      await logBlocksAroundBot(
        Math.max(0, Math.floor(radius)),
        Math.max(0, Math.floor(yRadius))
      )

      break
    }

    case 'forward':
    case 'back':
    case 'left':
    case 'right':
    case 'jump':
    case 'sprint':
    case 'sneak': {
      const controlName = cmd

      if (typeof bot.setControlState !== 'function') {
        bot.logAction('[->]', 'command', { msg: 'Control states not available' })
        break
      }

      const boolVal = args[0] ? args[0] === 'true' : !bot.getControlState(controlName)
      bot.setControlState(controlName, boolVal)

      bot.logAction('[->]', 'command', { msg: `${controlName} set to ${boolVal}` })
      break
    }

    case 'setcontrol': {
      if (args.length < 2) {
        bot.logAction('[->]', 'command', { msg: 'Usage: !setControl <control name> <true|false>' })
        break
      }

      const name = args[0].toLowerCase()
      const val = args.slice(1).join(' ')

      if (typeof bot.setControlState !== 'function') {
        bot.logAction('[->]', 'command', { msg: 'Control states not available' })
        break
      }

      const boolVal = val === 'true'
      bot.setControlState(name, boolVal)

      bot.logAction('[->]', 'command', { msg: `${name} set to ${boolVal}` })
      break
    }

    case 'clearcontrols':
      if (typeof bot.clearControlStates === 'function') {
        bot.clearControlStates()
        bot.logAction('[->]', 'command', { msg: 'All control states cleared' })
      } else {
        bot.logAction('[->]', 'command', { msg: 'Control states not available' })
      }
      break

    case 'look': {
      if (args.length < 2) {
        bot.logAction('[->]', 'command', { msg: 'Usage: !look <yaw> <pitch> (both numbers)' })
        break
      }

      const yaw = parseFloat(args[0])
      const pitch = parseFloat(args[1])

      if (isNaN(yaw) || isNaN(pitch)) {
        bot.logAction('[->]', 'command', { msg: 'Invalid yaw or pitch' })
        break
      }

      bot.look(yaw, pitch)
      bot.logAction('[->]', 'command', { msg: `Looked at yaw=${yaw}, pitch=${pitch}` })
      break
    }

    case 'lookat': {
      if (args.length < 3) {
        bot.logAction('[->]', 'command', { msg: 'Usage: !lookAt <x> <y> <z>' })
        break
      }

      const [tx, ty, tz] = args.map(parseFloat)

      if (isNaN(tx) || isNaN(ty) || isNaN(tz)) {
        bot.logAction('[->]', 'command', { msg: 'Invalid coordinates. Provide three numbers.' })
        break
      }

      const target = new Vec3(tx, ty, tz)

      if (!bot.self || !bot.self.position) {
        bot.logAction('[->]', 'command', { msg: 'Bot position not available.' })
        break
      }

      const { yaw, pitch } = computeLookAngles(bot.self.position, target)
      bot.look(yaw, pitch)

      bot.logAction('[->]', 'command', { msg: `Looked at vec3 (${tx}, ${ty}, ${tz})` })
      break
    }

    case 'lookatme': {
      const player = bot.nearestEntity(e => e.username === sourceName)

      if (!player || !player.position) {
        bot.logAction('[->]', 'command', { msg: `Cannot find player ${sourceName} position.` })
        break
      }

      if (!bot.self || !bot.self.position) {
        bot.logAction('[->]', 'command', { msg: 'Bot position not available.' })
        break
      }

      bot.lookAt(player.position, true)
      bot.chat('try')

      bot.logAction('[->]', 'command', { msg: `Looked at ${sourceName}` })
      break
    }

    default:
      bot.logAction('[->]', 'command', { msg: `Unknown command: ${cmd}` })
      break
  }
})

function normalizeBlockName (raw) {
  let name = String(raw).trim().toLowerCase()
  name = name.replace(/\s+/g, '_')
  if (name.startsWith('minecraft:')) name = name.slice('minecraft:'.length)
  return name || null
}

function buildTargetSetForBlock (blockName, registry) {
  const ids = new Set()

  for (const runtimeId of Object.keys(registry.blocksByRuntimeId)) {
    const block = registry.blocksByRuntimeId[runtimeId]

    if (block && block.name === blockName) {
      ids.add(block.stateId)
    }
  }

  return ids.size > 0 ? ids : null
}

bot.start()
