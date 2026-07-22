'use strict'

const DAY_TICKS = 24000

function normalizeTimeOfDay (time) {
  if (!Number.isFinite(time)) return null
  return ((time % DAY_TICKS) + DAY_TICKS) % DAY_TICKS
}

function weatherEventName (event) {
  if (typeof event === 'string') return event
  switch (event) {
    case 3001: return 'start_rain'
    case 3002: return 'start_thunder'
    case 3003: return 'stop_rain'
    case 3004: return 'stop_thunder'
    default: return null
  }
}

function createEnvironmentState () {
  return {
    time: null,
    timeOfDay: null,
    day: null,
    rainLevel: 0,
    lightningLevel: 0,
    raining: false,
    thundering: false,
    lastWeatherEvent: null
  }
}

module.exports = function environmentPlugin (botState) {
  const client = botState.client

  botState.environment = createEnvironmentState()

  function currentWeather () {
    return {
      rainLevel: botState.environment.rainLevel,
      lightningLevel: botState.environment.lightningLevel,
      raining: botState.environment.raining,
      thundering: botState.environment.thundering
    }
  }

  function applyTime (time, rawPacket = null) {
    if (!Number.isFinite(time)) return

    botState.environment.time = time
    botState.environment.timeOfDay = normalizeTimeOfDay(time)
    botState.environment.day = Math.floor(time / DAY_TICKS)

    const payload = {
      time: botState.environment.time,
      timeOfDay: botState.environment.timeOfDay,
      day: botState.environment.day,
      rawPacket
    }

    botState.logAction?.('[environment]', 'time', {
      time: payload.time,
      timeOfDay: payload.timeOfDay,
      day: payload.day
    })
    botState.emit('time', payload)
    botState.emit('environmentTime', payload)
  }

  function applyWeather (patch, rawPacket = null) {
    Object.assign(botState.environment, patch)

    botState.environment.raining = botState.environment.rainLevel > 0
    botState.environment.thundering = botState.environment.lightningLevel > 0

    const payload = {
      ...currentWeather(),
      lastWeatherEvent: botState.environment.lastWeatherEvent,
      rawPacket
    }

    botState.logAction?.('[environment]', 'weather', {
      raining: payload.raining,
      thundering: payload.thundering,
      rainLevel: payload.rainLevel,
      lightningLevel: payload.lightningLevel,
      event: payload.lastWeatherEvent
    })
    botState.emit('weather', payload)
    botState.emit('environmentWeather', payload)
  }

  client.on('start_game', (packet) => {
    applyWeather({
      rainLevel: Number(packet.rain_level ?? 0),
      lightningLevel: Number(packet.lightning_level ?? 0),
      lastWeatherEvent: 'start_game'
    }, packet)
  })

  client.on('set_time', (packet) => {
    applyTime(Number(packet.time), packet)
  })

  client.on('level_event', (packet) => {
    const event = weatherEventName(packet.event)
    if (!event) return

    if (event === 'start_rain') {
      applyWeather({
        rainLevel: packet.data > 0 ? packet.data : 1,
        lastWeatherEvent: event
      }, packet)
    } else if (event === 'start_thunder') {
      applyWeather({
        lightningLevel: packet.data > 0 ? packet.data : 1,
        lastWeatherEvent: event
      }, packet)
    } else if (event === 'stop_rain') {
      applyWeather({
        rainLevel: 0,
        lastWeatherEvent: event
      }, packet)
    } else if (event === 'stop_thunder') {
      applyWeather({
        lightningLevel: 0,
        lastWeatherEvent: event
      }, packet)
    }
  })

  botState.getEnvironment = () => ({
    ...botState.environment,
    weather: currentWeather()
  })
}

module.exports.normalizeTimeOfDay = normalizeTimeOfDay
module.exports.weatherEventName = weatherEventName
