# Digging, Placement, And Entity Interaction

These builtins send server-visible actions: block breaking, block/item
placement, arm swing animation, and item use on entities.

## Digging

| API | Purpose |
| --- | --- |
| `bot.dig(block, forceLook = true, digFace = 'auto')` | Looks at target, hooks auth-input block actions, and waits for block update. |
| `bot.digTime(block)` | Computes break time from held item/tool and block hardness. |
| `bot.canDigBlock(block)` | Checks diggable state, position, self position, and range. |
| `bot.stopDigging()` | Aborts the active dig promise. |

```js
const target = await bot.getBlock(bot.self.position.offset(1, 0, 0))
if (bot.canDigBlock(target)) await bot.dig(target)
```

## Placement

| API | Purpose |
| --- | --- |
| `bot.placeBlock(targetPos, face?, placeOptions = {})` | Sends item-use transaction and optionally waits for placed block update. |
| `bot.placeEntity(targetPos)` | Sends click-air item-use transaction. |

Placement requires a held item. Offhand placement is not supported by the public
helper.

## Entity Interaction

| API | Purpose |
| --- | --- |
| `bot.mouseOverEntity(entity, opts = {})` | Queues an `interact` packet with `mouse_over_entity`. |
| `bot.swingArm(opts = {})` | Queues an `animate` packet. |
| `bot.queueItemUseOnEntity(entity, actionType, opts = {})` | Sends `item_use_on_entity`; action is interact or attack. |
| `bot.interactEntity(entity, opts = {})` / `bot.interactAtEntity` | Optionally mouse-overs, waits, then interacts. |
| `bot.attackEntity(entity, opts = {})` | Optionally mouse-overs, attacks, and swings. |

Packet-level interaction helpers require known runtime entity ids. `swingArm`
also requires the bot's own runtime id.

## Events

| Event | Payload |
| --- | --- |
| `diggingCompleted` | Block, target. |
| `diggingAborted` | Block, target, error. |
| `blockPlaceRequested` | `{ targetPos, face, options }` |
| `entity_mouse_over_request` | Payload. |
| `entity_swing_request` | Packet. |
| `entity_item_use_request` | Payload. |

