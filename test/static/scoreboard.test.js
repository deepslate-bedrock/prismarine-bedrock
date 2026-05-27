'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const scoreboardPlugin = require('../../src/builtins/scoreboard')

function createState () {
  const botState = new EventEmitter()
  botState.client = new EventEmitter()
  botState.entities = new Map()
  botState.playerEntities = new Map()
  botState.playerList = new Map()
  scoreboardPlugin(botState, {})
  return botState
}

describe('scoreboard builtin', function () {
  it('tracks displayed objectives and score changes', function () {
    const state = createState()
    const seen = []
    state.on('scoreboardScore', event => seen.push(event))

    state.client.emit('set_display_objective', {
      display_slot: 'sidebar',
      objective_name: 'kills',
      display_name: 'Kills',
      criteria_name: 'dummy',
      sort_order: 1
    })

    state.client.emit('set_score', {
      action: 'change',
      entries: [
        { scoreboard_id: 11n, objective_name: 'kills', score: 3, entry_type: 'fake_player', custom_name: 'Alex' },
        { scoreboard_id: 12n, objective_name: 'kills', score: 7, entry_type: 'fake_player', custom_name: 'Steve' }
      ]
    })

    const objective = state.scoreboards.getObjective('sidebar')
    assert.strictEqual(objective.name, 'kills')
    assert.strictEqual(objective.displayName, 'Kills')
    assert.strictEqual(objective.displaySlots.has('sidebar'), true)

    const scores = state.scoreboards.getDisplayedScores('sidebar')
    assert.deepStrictEqual(scores.map(score => [score.displayName, score.score]), [
      ['Steve', 7],
      ['Alex', 3]
    ])
    assert.strictEqual(state.scoreboards.getObjective('sidebar'), objective)
    assert.deepStrictEqual(state.scoreboards.getScores('kills').map(score => score.customName), ['Steve', 'Alex'])
    assert.strictEqual(state.scoreboards.getDisplayedScores('sidebar')[0].customName, 'Steve')
    assert.strictEqual(state.scoreboards.getScore('sidebar', 'Steve').score, 7)
    assert.strictEqual(state.scoreboards.getScore('kills', 11n).customName, 'Alex')
    assert.strictEqual(state.scoreboards.getScore('kills', score => score.score === 7).customName, 'Steve')
    assert.strictEqual(state.scoreboards.getScore('kills', 'missing'), null)
    assert.strictEqual(state.getScoreboardObjective, undefined)
    assert.strictEqual(state.getDisplayedScores, undefined)
    assert.strictEqual(seen.length, 2)
  })

  it('removes score entries and objectives', function () {
    const state = createState()

    state.client.emit('set_display_objective', {
      display_slot: 'sidebar',
      objective_name: 'coins',
      display_name: 'Coins',
      criteria_name: 'dummy',
      sort_order: 0
    })
    state.client.emit('set_score', {
      action: 0,
      entries: [
        { scoreboard_id: 1n, objective_name: 'coins', score: 10, entry_type: 3, custom_name: 'one' },
        { scoreboard_id: 2n, objective_name: 'coins', score: 20, entry_type: 3, custom_name: 'two' }
      ]
    })

    state.client.emit('set_score', {
      action: 1,
      entries: [{ scoreboard_id: 1n, objective_name: 'coins' }]
    })

    assert.strictEqual(state.scoreboards.getEntry(1n), null)
    assert.deepStrictEqual(state.scoreboards.getDisplayedScores('sidebar').map(score => score.customName), ['two'])

    state.client.emit('remove_objective', { objective_name: 'coins' })

    assert.strictEqual(state.scoreboards.getObjective('coins'), null)
    assert.strictEqual(state.scoreboards.getObjective('sidebar'), null)
    assert.strictEqual(state.scoreboards.scores.size, 0)
  })

  it('registers scoreboard identities and resolves player names', function () {
    const state = createState()
    const player = { id: 99n, username: 'KnownPlayer', displayName: 'KnownPlayer' }
    state.playerEntities.set(5n, player)

    state.client.emit('set_score', {
      action: 'change',
      entries: [
        { scoreboard_id: 15n, objective_name: 'seen', score: 1, entry_type: 'player', entity_unique_id: 99n }
      ]
    })

    state.client.emit('set_scoreboard_identity', {
      action: 'register_identity',
      entries: [{ scoreboard_id: 15n, entity_unique_id: 99n }]
    })

    const entry = state.scoreboards.getEntry(15n)
    assert.strictEqual(entry.displayName, 'KnownPlayer')
    assert.strictEqual(entry.identityEntityUniqueId, 99n)
  })

  it('resets mirrored scoreboard state on close', function () {
    const state = createState()
    state.client.emit('set_display_objective', {
      display_slot: 'sidebar',
      objective_name: 'server',
      display_name: 'Server Stats',
      criteria_name: 'dummy',
      sort_order: 0
    })

    state.client.emit('close')

    assert.strictEqual(state.scoreboards.objectives.size, 0)
    assert.strictEqual(state.scoreboards.displaySlots.size, 0)
  })
})
