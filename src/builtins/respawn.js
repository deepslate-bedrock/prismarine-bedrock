const { logAction, sameRuntimeId } = require('../utils')

/**
 * Handles Bedrock death-screen respawn lifecycle.
 * @param {import('../state')} botState
 */
module.exports = (botState) => {
  const client = botState.client

  botState.lifecycle ??= {}
  botState.playerState ??= {}

  botState.lifecycle.isDead = false
  botState.lifecycle.respawnTimeout = null
  botState.lifecycle.lastRespawnPosition = null
  botState.lifecycle.sentDeathRespawnReady = false
  botState.lifecycle.sentDeathRespawnAction = false
  botState.playerState.health ??= null

  client.on('set_health', (packet) => {
    botState.playerState.health = packet.health
    logAction('[<-]', 'set_health', {
      health: botState.playerState.health,
      isDead: botState.lifecycle.isDead
    })

    if (botState.playerState.health > 0 && botState.lifecycle.isDead) {
      markAlive(botState.playerState.health)
      logAction('[->]', 'set_health -> alive')
    }
  })

  client.on('death_info', (packet) => {
    if (botState.lifecycle.isDead) return
    botState.lifecycle.isDead = true
    botState.playerState.health = 0
    botState.lifecycle.lastRespawnPosition = null
    botState.lifecycle.sentDeathRespawnReady = false
    botState.lifecycle.sentDeathRespawnAction = false
    logAction('[<-]', 'death_info', {
      cause: packet.cause,
      message: packet.messages?.[0]
    })
    scheduleRespawn(300)
  })

  client.on('respawn', (packet) => {
    logAction('[<-]', 'respawn', { state: packet.state, position: packet.position })

    if (packet.state === 0) {
      botState.lifecycle.lastRespawnPosition = packet.position
      logAction('[<-]', 'respawn(state=0 searching)')
      return
    }

    if (packet.state === 1) {
      clearTimeout(botState.lifecycle.respawnTimeout)
      botState.lifecycle.lastRespawnPosition = packet.position

      if (botState.lifecycle.isDead) {
        sendDeathRespawnReady()
        sendDeathRespawnAction()
        return
      }

      logAction('[->]', 'respawn(state=2 ack) + set_local_player_as_initialized')
      client.queue('respawn', {
        position: packet.position,
        state: 2,
        runtime_entity_id: client.entityId
      })
      client.queue('set_local_player_as_initialized', {
        runtime_entity_id: client.entityId
      })
      return
    }

    logAction('[<-]', 'respawn', { msg: 'unknown state', state: packet.state })
  })

  client.on('spawn', () => {
    if (botState.lifecycle.isDead) {
      logAction('[<-]', 'spawn', { msg: 'respawn completed' })
      markAlive()
    } else {
      logAction('[<-]', 'spawn', { msg: 'initial join' })
    }
  })

  client.on('entity_event', (packet) => {
    const event = packet.event ?? packet.event_id

    if (!botState.lifecycle.isDead || event !== 'respawn') return
    if (!sameRuntimeId(packet.runtime_entity_id ?? packet.entity_id ?? packet.id, client.entityId)) return

    logAction('[<-]', 'entity_event(respawn)', { msg: 'respawn completed' })
    markAlive()
  })

  function scheduleRespawn (delay = 300) {
    clearTimeout(botState.lifecycle.respawnTimeout)
    botState.lifecycle.respawnTimeout = setTimeout(() => {
      if (!botState.lifecycle.isDead) {
        logAction('[->]', 'respawn', { msg: 'skipped - already alive' })
        return
      }

      sendDeathRespawnReady()

      botState.lifecycle.respawnTimeout = setTimeout(() => {
        if (!botState.lifecycle.isDead) return
        sendDeathRespawnAction()
      }, 5000)
    }, delay)
  }

  function sendDeathRespawnReady () {
    if (botState.lifecycle.sentDeathRespawnReady) return
    botState.lifecycle.sentDeathRespawnReady = true
    logAction('[->]', 'respawn(state=2) death-screen ready')
    client.queue('respawn', {
      position: { x: 0, y: 0, z: 0 },
      state: 2,
      runtime_entity_id: client.entityId
    })
  }

  function sendDeathRespawnAction () {
    if (botState.lifecycle.sentDeathRespawnAction) return
    botState.lifecycle.sentDeathRespawnAction = true
    logAction('[->]', 'player_action(respawn) request')
    client.queue('player_action', {
      runtime_entity_id: client.entityId,
      action: 'respawn',
      position: { x: 0, y: 0, z: 0 },
      result_position: { x: 0, y: 0, z: 0 },
      face: -1
    })
  }

  function clearRespawnState () {
    clearTimeout(botState.lifecycle.respawnTimeout)
    botState.lifecycle.respawnTimeout = null
    botState.lifecycle.lastRespawnPosition = null
    botState.lifecycle.sentDeathRespawnReady = false
    botState.lifecycle.sentDeathRespawnAction = false
  }

  function markAlive (health = 20) {
    clearRespawnState()
    botState.lifecycle.isDead = false
    botState.playerState.health = health
  }
}
