# World, Chunks, Entities, And Players

The world builtin mirrors decoded Bedrock chunks when `worldDecodeEnabled` is
true. Entity and player builtins maintain local maps for runtime entities,
player-list records, metadata, effects, and common player state.

## World API

| API | Purpose |
| --- | --- |
| `bot.resetWorld()` | Replaces `bot.world` with a fresh Prismarine world. |
| `bot.setDimension(dimension, options = {})` | Updates dimension/world settings and may reset world state. |
| `bot.getBlock(pos, options?)` | Reads a block from the world mirror, optionally waiting for chunks. |
| `bot.getBlockStateIdAt(pos)` | Reads a block state id from the world/chunk mirror. |
| `bot.setBlockStateIdAt(pos, stateId)` | Writes the local mirror only; it does not place a server block. |
| `bot.areChunksLoadedAround(position, radius)` | Checks loaded chunk bookkeeping. |
| `bot.waitForChunksToLoad(options = {})` | Waits until chunks are loaded around a position. |

```js
const block = await bot.getBlock(bot.self.position.offset(0, -1, 0))
console.log(block?.name)
```

## Entity Stores

| Store | Contents |
| --- | --- |
| `bot.self` | Local player entity, set from start-game/player packets. |
| `bot.entities` | Non-player entity map keyed by Bedrock runtime entity id. |
| `bot.playerEntities` / `bot.players` | Spawned player entity map keyed by runtime entity id. |
| `bot.playerList` | Player-list/profile records keyed by username. |
| `bot.playerListByUuid` | Player-list/profile records keyed by normalized UUID. |

`bot.nearestEntity(filter = entity => true)` returns the nearest matching entity
to `bot.self`, or `null` when positions are unavailable.

## Entity Helpers

Entities touched by metadata handling may have:

| API | Purpose |
| --- | --- |
| `entity.getEffect(nameOrId)` | Reads a visible effect. |
| `entity.hasEffect(nameOrId)` | Checks whether an effect exists. |
| `entity.effectLevel(nameOrId)` | Returns effect amplifier/level, or `0`. |
| `entity.getStatus(name)` | Reads normalized status flags. |
| `entity.hasStatus(name)` | Checks a truthy status value. |
| `entity.checkStatus(name, expected)` | Compares a status value. |
| `entity.hasMetadataFlag(name)` | Reads Bedrock metadata flags. |
| `entity.isPose(pose)` | Compares normalized pose. |
| `entity.isOnFire()` | Reads metadata/on-fire state. |

## Events

| Event | Payload |
| --- | --- |
| `playerSpawned` | Entity. |
| `entitySpawned` | Entity. |
| `entityRemoved` | Entity. |
| `itemPickup` | Pickup payload. |
| `entityEvent` | Entity, event id, data. |
| `entityAction` | Entity, action, packet. |
| `entityEffect` | Entity, packet. |
| `entityMovementEffect` | Entity, packet. |
| `health` | No payload. |
| `death` | No payload. |
| `game` | No payload. |
| `playerAnimate` | Entity, action id. |
| `entityCrouch` / `entityUncrouch` | Entity. |

