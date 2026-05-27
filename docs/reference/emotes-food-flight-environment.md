# Emotes, Food, Flight, And Environment

These smaller builtins expose Bedrock state and actions that are useful in bot
scripts but do not need the larger window/world APIs.

## Emotes

| API | Purpose |
| --- | --- |
| `bot.emotes` | State object with equipped emotes and per-player emote lists. |
| `bot.sendEmoteList(emoteIds = bot.emotes.equipped)` | Sends `emote_list`. |
| `bot.equipEmotes(emoteIds, options = {})` | Stores unique emote ids and optionally sends the list. |
| `bot.playEmote(emoteId, options = {})` / `bot.sendEmote` / `bot.emote` | Sends an `emote` packet and records `lastSentEmote`. |

## Food And Eating

| API | Purpose |
| --- | --- |
| `bot.eat(target?, eatOptions = {})` | Equips food if needed, uses it, and waits for completion evidence. |
| `bot.isFoodItem(item)` | Uses registry food metadata when available. |
| `bot.canAlwaysEat(item)` | Checks food that can be eaten at full hunger. |
| `bot.usingHeldItem` | True while an item use is active. |

`bot.eat` can throw for active use, missing food, non-food, or full hunger unless
forced.

## Flight

| API | Purpose |
| --- | --- |
| `bot.startFlying(options?)` | Queues `start_flying`; may wait for `flightChanged`. |
| `bot.stopFlying(options?)` | Queues `stop_flying`; may wait for `flightChanged`. |
| `bot.setFlying(enabled, options?)` | Shared flight toggle. |
| `bot.canFly()` | Reads ability/spectator state. |
| `bot.isFlying()` | Reads canonical/optimistic flight state. |
| `bot.isSpectator()` | Reads spectator state. |

`startFlying({ wait: true })` resolves on matching `flightChanged` or rejects on
timeout. Starting flight returns `false` when the bot lacks permission unless
`force` is true.

## Environment

| API | Purpose |
| --- | --- |
| `bot.environment` | Mutable time/weather mirror. |
| `bot.getEnvironment()` | Snapshot including nested `weather`. |

Environment fields include `time`, `timeOfDay`, `day`, `rainLevel`,
`lightningLevel`, `raining`, `thundering`, and `lastWeatherEvent`.

## Events

| Event | Payload |
| --- | --- |
| `entityEmote` | Emote payload. |
| `playerEmote` | Entity, emote payload. |
| `entityEmoteList` | Emote list payload. |
| `ate` | `{ slot, item, ...result }` |
| `flightChanged` | Flight state with previous/entity/reason/packet. |
| `flightRequest` | `{ flying, state }` |
| `time` / `environmentTime` | Time payload. |
| `weather` / `environmentWeather` | Weather payload. |

