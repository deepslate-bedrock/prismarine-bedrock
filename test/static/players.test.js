'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const playersPlugin = require('../../src/builtins/players')

function createState () {
  const state = new EventEmitter()
  state.client = new EventEmitter()
  state.playerEntities = new Map()
  state.registry = {}
  state.itemClass = {}
  return state
}

describe('players builtin', function () {
  it('stores normalized online player UUIDs separately from entities', function () {
    const state = createState()
    const entity = { id: 42n, username: 'OldName', displayName: 'OldName' }
    state.playerEntities.set(9n, entity)
    playersPlugin(state, {})

    state.client.emit('player_list', {
      records: {
        type: 'add',
        records: [{
          uuid: 'dc4d50d8-6252-af99-d9ea-7c8b95f2028d',
          entity_unique_id: 42n,
          username: 'KnownPlayer',
          xbox_user_id: '123',
          platform_chat_id: '',
          build_platform: 7
        }]
      }
    })

    const listed = state.playerList.get('KnownPlayer')
    assert.ok(listed)
    assert.strictEqual(listed.uuid, '99af5262-d850-4ddc-8d02-f2958b7cead9')
    assert.strictEqual(listed.rawUuid, 'dc4d50d8-6252-af99-d9ea-7c8b95f2028d')
    assert.strictEqual(listed.xuid, '123')
    assert.strictEqual(listed.entityUniqueId, 42n)
    assert.strictEqual(state.playerListByUuid.get(listed.uuid), listed)
    assert.strictEqual(entity.uuid, undefined)
    assert.strictEqual(entity.rawUuid, undefined)
  })

  it('removes online player records by UUID', function () {
    const state = createState()
    playersPlugin(state, {})

    state.client.emit('player_list', {
      records: {
        type: 0,
        records: [{
          uuid: 'dc4d50d8-6252-af99-d9ea-7c8b95f2028d',
          entity_unique_id: 42n,
          username: 'KnownPlayer'
        }]
      }
    })

    state.client.emit('player_list', {
      records: {
        type: 1,
        records: [{ uuid: 'dc4d50d8-6252-af99-d9ea-7c8b95f2028d' }]
      }
    })

    assert.strictEqual(state.playerList.has('KnownPlayer'), false)
    assert.strictEqual(state.playerListByUuid.has('99af5262-d850-4ddc-8d02-f2958b7cead9'), false)
  })
})
