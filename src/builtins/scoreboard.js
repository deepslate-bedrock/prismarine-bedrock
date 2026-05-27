'use strict'

const { sameRuntimeId } = require('../utils')

function idKey (value) {
  if (value == null) return null
  return typeof value === 'bigint' ? value.toString() : String(value)
}

function normalizeAction (action) {
  if (action === 0 || action === 'change' || action === 'modify') return 'change'
  if (action === 1 || action === 'remove') return 'remove'
  return String(action)
}

function normalizeIdentityAction (action) {
  if (action === 0 || action === 'register_identity' || action === 'register') return 'register_identity'
  if (action === 1 || action === 'clear_identity' || action === 'clear') return 'clear_identity'
  return String(action)
}

function normalizeEntryType (entryType) {
  if (entryType === 1 || entryType === 'player') return 'player'
  if (entryType === 2 || entryType === 'entity') return 'entity'
  if (entryType === 3 || entryType === 'fake_player') return 'fake_player'
  if (entryType == null) return null
  return String(entryType)
}

function createScoreboardState () {
  return {
    objectives: new Map(),
    displaySlots: new Map(),
    scores: new Map(),
    identities: new Map()
  }
}

class ScoreboardMirror {
  constructor (botState) {
    this.botState = botState
    this.reset()
  }

  reset () {
    const state = createScoreboardState()
    this.objectives = state.objectives
    this.displaySlots = state.displaySlots
    this.scores = state.scores
    this.identities = state.identities
  }

  getObjective (objectiveNameOrSlot) {
    const objectiveName = this.displaySlots.get(objectiveNameOrSlot) ?? objectiveNameOrSlot
    return this.objectives.get(objectiveName) ?? null
  }

  getEntry (scoreboardId) {
    return cloneEntry(this.scores.get(idKey(scoreboardId)))
  }

  getScores (objectiveNameOrSlot = 'sidebar', options = {}) {
    const objective = this.getObjective(objectiveNameOrSlot)
    if (!objective) return []

    const scores = Array.from(objective.scores.values()).map(entry => cloneEntry(refreshEntryIdentity(this.botState, entry)))
    scores.sort(scoreCompare(objective))
    if (options.limit != null) return scores.slice(0, options.limit)
    return scores
  }

  getDisplayedScores (displaySlot = 'sidebar', options = {}) {
    return this.getScores(displaySlot, options)
  }

  getScore (objectiveNameOrSlot, query) {
    if (query == null) return null
    const scores = this.getScores(objectiveNameOrSlot)
    if (typeof query === 'function') return scores.find(query) ?? null

    const key = idKey(query)
    return scores.find(entry => {
      return entry.id === key ||
        idKey(entry.scoreboardId) === key ||
        entry.customName === query ||
        entry.displayName === query ||
        entry.name === query
    }) ?? null
  }
}

function cloneEntry (entry) {
  return entry ? { ...entry } : null
}

function resolveEntityByUniqueId (botState, uniqueId) {
  if (uniqueId == null) return null
  const maps = [botState.playerEntities, botState.entities]
  for (const map of maps) {
    if (!map) continue
    for (const entity of map.values()) {
      if (sameRuntimeId(entity?.id, uniqueId) || sameRuntimeId(entity?.uniqueId, uniqueId) || sameRuntimeId(entity?.entityUniqueId, uniqueId)) {
        return entity
      }
    }
  }
  return null
}

function resolvePlayerListByUniqueId (botState, uniqueId) {
  if (uniqueId == null || !botState.playerList) return null
  for (const player of botState.playerList.values()) {
    if (sameRuntimeId(player?.entityUniqueId, uniqueId)) return player
  }
  return null
}

function displayNameForEntry (botState, entry) {
  if (!entry) return null
  if (entry.customName) return entry.customName

  const entity = resolveEntityByUniqueId(botState, entry.entityUniqueId)
  if (entity?.username) return entity.username
  if (entity?.displayName) return entity.displayName
  if (entity?.name) return entity.name

  const player = resolvePlayerListByUniqueId(botState, entry.entityUniqueId)
  if (player?.username) return player.username
  if (player?.displayName) return player.displayName

  return entry.entityUniqueId != null ? idKey(entry.entityUniqueId) : idKey(entry.scoreboardId)
}

function refreshEntryIdentity (botState, entry) {
  if (!entry) return entry
  const identity = botState.scoreboards.identities.get(entry.id)
  if (identity) entry.identityEntityUniqueId = identity.entityUniqueId
  entry.entity = resolveEntityByUniqueId(botState, entry.entityUniqueId ?? entry.identityEntityUniqueId)
  entry.player = resolvePlayerListByUniqueId(botState, entry.entityUniqueId ?? entry.identityEntityUniqueId)
  entry.displayName = displayNameForEntry(botState, entry)
  entry.name = entry.displayName
  return entry
}

function makeObjective (packet) {
  return {
    name: packet.objective_name,
    objectiveName: packet.objective_name,
    displayName: packet.display_name ?? packet.objective_display_name ?? packet.objective_name,
    criteriaName: packet.criteria_name ?? '',
    sortOrder: Number(packet.sort_order ?? 0),
    displaySlots: new Set(packet.display_slot ? [packet.display_slot] : []),
    scores: new Map(),
    raw: packet.raw ?? packet
  }
}

function scoreCompare (objective) {
  const direction = objective?.sortOrder === 1 ? -1 : 1
  return (a, b) => {
    const scoreDelta = (a.score - b.score) * direction
    if (scoreDelta !== 0) return scoreDelta
    return String(a.displayName ?? a.name ?? a.scoreboardId).localeCompare(String(b.displayName ?? b.name ?? b.scoreboardId))
  }
}

module.exports = function scoreboardPlugin (botState) {
  const client = botState.client
  botState.scoreboards = new ScoreboardMirror(botState)

  function ensureObjective (objectiveName, patch = {}) {
    if (!objectiveName) return null
    let objective = botState.scoreboards.objectives.get(objectiveName)
    if (!objective) {
      objective = makeObjective({
        objective_name: objectiveName,
        display_name: patch.displayName ?? patch.display_name ?? objectiveName,
        criteria_name: patch.criteriaName ?? patch.criteria_name ?? '',
        sort_order: patch.sortOrder ?? patch.sort_order ?? 0
      })
      botState.scoreboards.objectives.set(objectiveName, objective)
    }

    if (patch.displayName != null || patch.display_name != null) objective.displayName = patch.displayName ?? patch.display_name
    if (patch.criteriaName != null || patch.criteria_name != null) objective.criteriaName = patch.criteriaName ?? patch.criteria_name
    if (patch.sortOrder != null || patch.sort_order != null) objective.sortOrder = Number(patch.sortOrder ?? patch.sort_order)
    if (patch.raw != null) objective.raw = patch.raw
    return objective
  }

  function storeEntry (entry, rawPacket = null) {
    const objective = ensureObjective(entry.objectiveName)
    refreshEntryIdentity(botState, entry)
    botState.scoreboards.scores.set(entry.id, entry)
    objective.scores.set(entry.id, entry)
    botState.emit('scoreboardScore', {
      action: 'change',
      objective,
      entry: cloneEntry(entry),
      rawPacket
    })
    return entry
  }

  function removeEntry (scoreboardId, objectiveName = null, rawPacket = null) {
    const id = idKey(scoreboardId)
    const entry = botState.scoreboards.scores.get(id)
    const objective = objectiveName
      ? botState.scoreboards.objectives.get(objectiveName)
      : botState.scoreboards.objectives.get(entry?.objectiveName)

    if (objective) objective.scores.delete(id)
    botState.scoreboards.scores.delete(id)

    botState.emit('scoreboardScore', {
      action: 'remove',
      objective,
      entry: entry ? cloneEntry(entry) : { scoreboardId, id, objectiveName },
      rawPacket
    })
  }

  function removeObjective (objectiveName, rawPacket = null) {
    const objective = botState.scoreboards.objectives.get(objectiveName)
    if (!objective) return null

    for (const id of objective.scores.keys()) botState.scoreboards.scores.delete(id)
    for (const [slot, displayedObjectiveName] of botState.scoreboards.displaySlots) {
      if (displayedObjectiveName === objectiveName) botState.scoreboards.displaySlots.delete(slot)
    }
    botState.scoreboards.objectives.delete(objectiveName)

    botState.emit('scoreboardObjectiveRemoved', { objective, rawPacket })
    botState.emit('scoreboardObjective', { action: 'remove', objective, rawPacket })
    return objective
  }

  function applyDisplayObjective (packet) {
    const objective = ensureObjective(packet.objective_name, {
      displayName: packet.display_name ?? packet.objective_display_name,
      criteriaName: packet.criteria_name,
      sortOrder: packet.sort_order,
      raw: packet
    })

    if (packet.display_slot) {
      const previousObjectiveName = botState.scoreboards.displaySlots.get(packet.display_slot)
      if (previousObjectiveName && previousObjectiveName !== objective.name) {
        botState.scoreboards.objectives.get(previousObjectiveName)?.displaySlots.delete(packet.display_slot)
      }
      objective.displaySlots.add(packet.display_slot)
      botState.scoreboards.displaySlots.set(packet.display_slot, objective.name)
    }

    const payload = {
      displaySlot: packet.display_slot,
      objective,
      rawPacket: packet
    }
    botState.emit('scoreboardDisplay', payload)
    botState.emit('scoreboardObjective', { action: 'display', ...payload })
    return objective
  }

  function applyScorePacket (packet) {
    const action = normalizeAction(packet.action)
    const entries = Array.isArray(packet.entries) ? packet.entries : []

    for (const raw of entries) {
      if (action === 'remove') {
        removeEntry(raw.scoreboard_id, raw.objective_name, packet)
        continue
      }

      const entry = {
        id: idKey(raw.scoreboard_id),
        scoreboardId: raw.scoreboard_id,
        objectiveName: raw.objective_name,
        score: Number(raw.score ?? 0),
        type: normalizeEntryType(raw.entry_type),
        entryType: normalizeEntryType(raw.entry_type),
        entityUniqueId: raw.entity_unique_id,
        customName: raw.custom_name,
        raw
      }
      storeEntry(entry, packet)
    }
  }

  function applyIdentityPacket (packet) {
    const action = normalizeIdentityAction(packet.action)
    const entries = Array.isArray(packet.entries) ? packet.entries : []

    for (const raw of entries) {
      const id = idKey(raw.scoreboard_id)
      if (action === 'clear_identity') {
        botState.scoreboards.identities.delete(id)
      } else {
        botState.scoreboards.identities.set(id, {
          id,
          scoreboardId: raw.scoreboard_id,
          entityUniqueId: raw.entity_unique_id,
          raw
        })
      }

      const score = botState.scoreboards.scores.get(id)
      if (score) {
        if (action === 'clear_identity') delete score.identityEntityUniqueId
        refreshEntryIdentity(botState, score)
      }

      botState.emit('scoreboardIdentity', {
        action,
        id,
        scoreboardId: raw.scoreboard_id,
        entityUniqueId: raw.entity_unique_id,
        entry: score ? cloneEntry(score) : null,
        rawPacket: packet
      })
    }
  }

  function getScoreboardObjective (objectiveNameOrSlot) {
    return botState.scoreboards.getObjective(objectiveNameOrSlot)
  }

  function getScoreboardEntry (scoreboardId) {
    return botState.scoreboards.getEntry(scoreboardId)
  }

  function getScoreboardScores (objectiveNameOrSlot = 'sidebar', options = {}) {
    return botState.scoreboards.getScores(objectiveNameOrSlot, options)
  }

  function getDisplayedScores (displaySlot = 'sidebar', options = {}) {
    return botState.scoreboards.getDisplayedScores(displaySlot, options)
  }

  function getScoreboardScore (objectiveNameOrSlot, query) {
    return botState.scoreboards.getScore(objectiveNameOrSlot, query)
  }

  client.on('set_display_objective', packet => applyDisplayObjective(packet))
  client.on('set_score', applyScorePacket)
  client.on('remove_objective', packet => removeObjective(packet.objective_name, packet))
  client.on('set_scoreboard_identity', applyIdentityPacket)
  client.on('close', () => {
    botState.scoreboards.reset()
  })

  botState.getScoreboardObjective = getScoreboardObjective
  botState.getScoreboardEntry = getScoreboardEntry
  botState.getScoreboardScores = getScoreboardScores
  botState.getScoreboardScore = getScoreboardScore
  botState.getDisplayedScores = getDisplayedScores
  botState.scoreboardHelpers = {
    idKey,
    normalizeAction,
    normalizeEntryType,
    normalizeIdentityAction,
    resolveEntityByUniqueId,
    resolvePlayerListByUniqueId
  }
}

module.exports._scoreboardHelpers = {
  ScoreboardMirror,
  idKey,
  normalizeAction,
  normalizeEntryType,
  normalizeIdentityAction,
  resolveEntityByUniqueId,
  resolvePlayerListByUniqueId
}
