# Prismarine Bedrock API

This is the working API reference for `prismarine-bedrock`. It is written from
the current built-in runtime surface, not from Mineflayer parity claims. The API
is Mineflayer-inspired where that shape is useful, but Bedrock packet identity,
runtime entity ids, stack ids, and server-authoritative movement/inventory rules
remain visible where they matter.

## Maturity Labels

| Label | Meaning |
| --- | --- |
| `stable` | Intended user-facing API for scripts and examples. |
| `partial` | Useful, but narrower than the Mineflayer equivalent or still missing edge cases. |
| `compat` | Exposed for Mineflayer-shaped plugins; behavior may be adapted from Bedrock-native state. |
| `packet-level` | Thin helper over Bedrock packets. Callers must understand packet semantics. |
| `internal` | Agent/debug/helper surface. It exists today but should not be treated as stable public API. |

## Built-in Reference Sheets

This page is the compact API map. Subsystem sheets provide the scoreboard-style
detail for individual built-ins and related built-in groups:

| Built-in area | Reference sheet |
| --- | --- |
| Chat and commands | [`chat-and-commands.md`](reference/chat-and-commands.md) |
| Auth input, controls, and movement | [`auth-input-and-movement.md`](reference/auth-input-and-movement.md) |
| World, chunks, entities, and players | [`world-and-entities.md`](reference/world-and-entities.md) |
| Inventory and item stack requests | [`inventory-and-actions.md`](reference/inventory-and-actions.md) |
| Containers | [`containers.md`](reference/containers.md) |
| Crafting | [`crafting.md`](reference/crafting.md) |
| Digging, placement, and entity interaction | [`digging-placement-and-interaction.md`](reference/digging-placement-and-interaction.md) |
| Emotes, food, flight, and environment | [`emotes-food-flight-environment.md`](reference/emotes-food-flight-environment.md) |
| Scoreboards | [`scoreboards.md`](reference/scoreboards.md) |
| Trading | [`trading.md`](reference/trading.md) |
| Mineflayer compatibility facade | [`mineflayer-compat-facade.md`](reference/mineflayer-compat-facade.md) |

## Creating A Bot

```js
const { createBot } = require('prismarine-bedrock')

const bot = createBot({
  host: 'localhost',
  port: 19132,
  username: 'BedrockBot',
  offline: true,
  version: '1.21.80',
  loggingEnabled: false
})
```

### `createBot(options)` `stable`

Creates a `BotState`, starts the Bedrock client with delayed initialization, and
loads every built-in plugin.

| Item | Details |
| --- | --- |
| Signature | `createBot(options)` |
| Parameters | `options` is passed to `bedrock-protocol.createClient` after runtime option normalization. |
| Returns | A started `BotState`. |
| Side effects | Opens a Bedrock client, injects built-ins, registers packet listeners, and may start logging. |
| Preconditions/failures | Connection failures come from `bedrock-protocol`; invalid runtime options throw before connect. |

### `new BotState(options)` `stable`

Constructs the runtime without starting the client. Use this only when tests or
custom bootstrapping need manual control.

| Item | Details |
| --- | --- |
| Signature | `new BotState(options)` |
| Returns | An EventEmitter with registry/classes/world/state roots initialized. |
| Side effects | Loads the requested Bedrock registry and creates Prismarine classes. |
| Follow-up | Call `bot.start()` to connect and inject built-ins. |

### Runtime Options

| Option | Default | Notes |
| --- | --- | --- |
| `version` | package default Bedrock version | Normalized through `normalizeBedrockVersion`. |
| `loggingEnabled` | `true` | Controls `logAction` output. Accepts booleans and boolean-like strings. |
| `worldDecodeEnabled` | `true` | Enables world/chunk decode and chunk requests. |
| `physicsEnabled` | same as `worldDecodeEnabled` | Requires `worldDecodeEnabled: true`. Disable for packet-only bots. |
| `physicsEngine` | `'native'` | Supports `'native'`, `'nxg'`, and alias `'nxg-org'`. |
| `chunkRadius` | `6` | Sent after player spawn when world decode is enabled. |
| `commandVersion` | `'52'` | Default version used by `command_request`. |
| `commandTimeoutMs` | `5000` | Default timeout for `commandWithOutput`. |
| `commandPacket` | `'command_request'` | Can be overridden for E2E command paths. |
| `placeCompletionTimeoutMs` | `5000` | Default wait for block update after placement. |

### Lifecycle Methods

| API | Maturity | Returns | Side effects and failures |
| --- | --- | --- | --- |
| `bot.start()` | `stable` | `undefined` | Creates the Bedrock client, attaches registry, and injects built-ins. |
| `bot.disconnect(reason = 'Client shutting down')` | `stable` | `undefined` | Calls client `disconnect` or `close`. Fails if no client exists. |

### Package Exports

| Export | Maturity | Description |
| --- | --- | --- |
| `createBot` | `stable` | Started bot factory. |
| `BotState` | `stable` | Runtime class. |
| `pluginLoader` | `partial` | Local plugin helpers: `loadPlugin`, `loadPlugins`, `hasPlugin`, `isPluginLoaded`, `installPlugin`, `injectAll`, `injectPlugins`, `loadBuiltins`, `isInjected`, `shouldLoadBuiltin`, `ensureState`. |
| `utils` | `internal` | Shared packet/runtime helpers. Useful for agents and advanced plugins. |
| Version helpers | `stable` | `normalizeBedrockVersion`, `bedrockVersionFromEnv`, `bedrockRegistryName`, `minecraftDataBedrockDir`. |

### Native Plugin Loading

Native Prismarine Bedrock plugins are install functions, following the same
general shape as Mineflayer plugins. Plugin-specific settings should not be
threaded through `createBot(options)`. Instead, load the plugin and adjust its
public state/API directly before starting the bot.

```js
const { BotState, pluginLoader } = require('prismarine-bedrock')
const examplePlugin = require('bedrock-example-plugin')

const bot = new BotState({
  host: 'localhost',
  port: 19132,
  username: 'BedrockBot',
  offline: true
})

pluginLoader.installPlugin(bot, examplePlugin)
bot.examplePlugin.settings.chatCommand = '!example'
bot.start()
```

The native plugin shape is:

```js
function examplePlugin (bot, options) {
  bot.examplePlugin = {
    settings: {
      chatCommand: '!example'
    }
  }
}
```

The loader tracks installed plugin functions per bot and prevents reinstalling
the same function on the same bot. `pluginsLoaded` fires once after queued
external plugins have been injected during startup. The second `options`
argument is still the bot's normalized runtime options for compatibility and
shared runtime decisions, but plugin-specific settings should usually live on
the plugin API and be changed after load.

## State Roots And Properties

These roots are available after construction or after the relevant built-in
handles packets. Many values are server authoritative and may be `null` before
login/spawn.

| Property | Maturity | Shape and notes |
| --- | --- | --- |
| `bot.options` | `stable` | Normalized runtime options. |
| `bot.version` | `stable` | Bedrock version string used for registry loading. |
| `bot.registry` | `stable` | Prismarine registry for `bedrock_<version>`, patched with live item/block runtime ids. |
| `bot.client` | `stable` | Underlying `bedrock-protocol` client after `start()`. |
| `bot.world` | `partial` | Prismarine world mirror. Updated by chunk/block packets when world decode is enabled. |
| `bot.worldClass`, `bot.chunkColumn`, `bot.blockClass`, `bot.itemClass`, `bot.entityClass`, `bot.windowFactory`, `bot.chatMessageClass` | `partial` | Prismarine constructors/factories bound to the current registry. |
| `bot.self` | `stable` | Local player entity, if known. Includes position, rotation, metadata, abilities, effects, pose, and movement fields. |
| `bot.entities` | `stable` | `Map` of non-player entities keyed by Bedrock runtime entity id. |
| `bot.playerEntities` | `stable` | `Map` of spawned player entities keyed by Bedrock runtime entity id. |
| `bot.players` | `stable` | Alias getter/setter for `playerEntities`. |
| `bot.playerList` | `stable` | Online player-list/profile records keyed by username. |
| `bot.playerListByUuid` | `stable` | Online player-list/profile records keyed by normalized UUID. |
| `bot.inventory` | `stable` | Player inventory window from `prismarine-windows`. |
| `bot.windows` | `stable` | `Map` of windows by window id. Window id `0` is player inventory. |
| `bot.uiSlots` | `partial` | Bedrock UI slot projection map. |
| `bot.heldItemSlot` | `stable` | Selected hotbar slot, usually `0..8`. |
| `bot.heldItem` | `stable` | Getter for `bot.inventory.slots[bot.heldItemSlot]` or `null`. |
| `bot.game` | `partial` | `{ gameMode, dimension, gamerules }`. |
| `bot.playerState` | `partial` | `{ health, experience, experienceLevel, spawnPosition, spawnRotation }`. |
| `bot.lifecycle` | `partial` | Respawn/death state including `isDead`, timers, and last respawn position. |
| `bot.environment` | `partial` | Time/weather mirror. Use `getEnvironment()` for a copied snapshot. |
| `bot.scoreboards` | `partial` | Bedrock scoreboard mirror with `objectives`, `displaySlots`, `scores`, and `identities` maps. |
| `bot.chunkState` | `partial` | Chunk publisher center/radius and count state. |
| `bot.protocolState` | `partial` | Protocol feature flags such as runtime id palette mode. |
| `bot.creativeItems` | `partial` | Raw creative content entries after `creative_content`. |
| `bot.bedrockCraftingRecipes` | `partial` | Raw server-authoritative `crafting_data` recipes. |
| `bot.blockRuntimeIdsByName` | `partial` | Known item/block runtime ids populated from creative/crafting packets. |

## Chat

See [`docs/reference/chat-and-commands.md`](reference/chat-and-commands.md) for
packet paths, events, and examples.

### `bot.chat(message)` `stable`

| Item | Details |
| --- | --- |
| Signature | `bot.chat(message)` |
| Parameters | `message` string. |
| Returns | `undefined`. |
| Side effects | Queues a Bedrock `text` packet with `type: 'chat'`. |
| Preconditions/failures | Requires a connected client. Message must be acceptable to the server. |

### `bot.whisper(target, message)` `partial`

| Item | Details |
| --- | --- |
| Signature | `bot.whisper(target, message)` |
| Parameters | `target` player name, `message` string. |
| Returns | `undefined`. |
| Side effects | Sends a slash-style whisper command/message through the text packet path. |
| Preconditions/failures | Server command/chat rules may reject the message. |

Chat packet handling emits `chat` with a parsed payload and, for recognized
message categories, category-specific events such as `whisper`.

```js
bot.on('chat', msg => {
  if (msg.message === '!ping') bot.chat('pong')
})
```

## Commands

See [`docs/reference/chat-and-commands.md`](reference/chat-and-commands.md) for
command packet behavior, output waiters, and events.

| API | Maturity | Signature | Returns | Side effects, preconditions, failures |
| --- | --- | --- | --- | --- |
| `bot.command` | `stable` | `command(value, opts = {})` | request id string | Sends `command_request`, `settings_command`, or writes a server command file depending on `opts.packet`/configured packet. Prefixes `/` if missing. |
| `bot.commandWithOutput` | `stable` | `async commandWithOutput(value, opts = {})` | parsed command output | Sends a command and waits for matching `command_output`. Rejects on timeout. |
| `bot.chatCommand` | `partial` | `chatCommand(value)` | `undefined` | Sends the slash command as authored chat text. |
| `bot.rawCommand` | `partial` | `rawCommand(value)` | `undefined` | Sends a raw text packet. |
| `bot.setCommandVersion` | `partial` | `setCommandVersion(version)` | `undefined` | Changes the default `command_request.version`. |
| `bot.setCommandTimeout` | `partial` | `setCommandTimeout(ms)` | `undefined` | Changes default output wait timeout. |
| `bot.setCommandPacket` | `partial` | `setCommandPacket(packet)` | `undefined` | Changes the default packet path. |
| `bot.clearCommandWaiters` | `internal` | `clearCommandWaiters()` | `undefined` | Rejects pending command-output waits. Called on close. |

```js
const output = await bot.commandWithOutput('time query daytime')
console.log(output.lines.join('\n'))
```

## Auth Input And Controls

See [`docs/reference/auth-input-and-movement.md`](reference/auth-input-and-movement.md)
for auth-input hooks, control state, movement, look, and physics tick events.

### Packet edit hooks `packet-level`

| API | Signature | Returns | Side effects and failures |
| --- | --- | --- | --- |
| `bot.authInputFlags` | property | flag enum object | Bedrock `player_auth_input` flag names and bit positions. |
| `bot.setAuthInputFlag` | `setAuthInputFlag(packet, flag, enabled = true)` | `packet` | Mutates a packet's input bitset. Throws if packet shape is invalid. |
| `bot.onPlayerAuthInputPreSend` | `onPlayerAuthInputPreSend(hook)` | unsubscribe function | Registers a hook before each auth-input send. |
| `bot.queuePlayerAuthInputEdit` | `queuePlayerAuthInputEdit(edit)` | `undefined` | Queues an object/function edit for the next outgoing auth-input. |
| `bot.flushPlayerAuthInput` | `flushPlayerAuthInput()` | sent packet or `null` | Forces the current movement/auth-input packet path to flush if available. |

### Control state `stable`

| API | Signature | Returns | Side effects and failures |
| --- | --- | --- | --- |
| `bot.controlState` | property | object with `forward`, `back`, `left`, `right`, `jump`, `sprint`, `sneak`, `swim` | Setters call `setControlState`. |
| `bot.setControlState` | `setControlState(name, value)` | `undefined` | Updates movement input. Throws for unknown control or non-boolean value. |
| `bot.getControlState` | `getControlState(name)` | boolean | Reads a control. |
| `bot.clearControlStates` | `clearControlStates()` | `undefined` | Clears all movement controls. |
| `bot.setFlag` | `setFlag(name, value)` | `undefined` | Low-level input-data flag write on `bot.self`; ignored if self is missing. |

```js
bot.setControlState('forward', true)
setTimeout(() => bot.clearControlStates(), 1000)
```

### Movement and look `partial`

| API | Signature | Returns | Side effects and failures |
| --- | --- | --- | --- |
| `bot.applyMovement` | `async applyMovement()` | tick result | Runs one local movement simulation tick and emits physics tick events. |
| `bot.setPosition` | `setPosition(x, y, z)` | `undefined` | Sets local self position and authoritative movement base. |
| `bot.look` | `look(yaw, pitch, force = false)` | `Promise` or immediate result | Rotates the bot using Bedrock degrees. |
| `bot.lookAt` | `lookAt(point, force = false)` | `Promise` or immediate result | Looks at a world point. Requires movement packet sender. |
| `bot.waitForLookComplete` | `waitForLookComplete()` | `Promise<void>` | Resolves when interpolated look reaches target. |
| `bot.syncLook` | function | implementation detail | Exposed by movement packet sender; use `look`/`lookAt` first. |

`look` uses Bedrock yaw/pitch degrees. The Mineflayer facade adapts radians and
Java yaw orientation for compat callers.

## World And Chunks

See [`docs/reference/world-and-entities.md`](reference/world-and-entities.md) for
world mirror state, chunk readiness, entity stores, helpers, and events.

| API | Maturity | Signature | Returns | Side effects, preconditions, failures |
| --- | --- | --- | --- | --- |
| `bot.resetWorld` | `partial` | `resetWorld()` | `undefined` | Replaces `bot.world` with a fresh Prismarine world. |
| `bot.setDimension` | `partial` | `setDimension(dimension, options = {})` | `undefined` | Updates dimension and world settings; may reset world depending on options. |
| `bot.getBlock` | `stable` | `async getBlock(pos, options?)` | block or `null` | Reads from the world mirror; may request/wait for chunk data depending on arguments. |
| `bot.getBlockStateIdAt` | `stable` | `getBlockStateIdAt(pos)` | state id or fallback | Reads a block state id from the world/chunk mirror. |
| `bot.setBlockStateIdAt` | `partial` | `async setBlockStateIdAt(pos, stateId)` | result from world set | Writes the local mirror. Does not place a block on the server. |
| `bot.areChunksLoadedAround` | `stable` | `areChunksLoadedAround(position = bot.self?.position, radius = 0)` | boolean | Checks loaded chunk bookkeeping. |
| `bot.waitForChunksToLoad` | `stable` | `waitForChunksToLoad(options = {})` | `Promise<boolean>` | Waits until chunks are loaded around a position. Rejects/returns according to timeout behavior. |

```js
const block = await bot.getBlock(bot.self.position.offset(0, -1, 0))
console.log(block?.name)
```

## Entities And Players

See [`docs/reference/world-and-entities.md`](reference/world-and-entities.md) for
world mirror state, chunk readiness, entity stores, helpers, and events.

### Entity stores

| API | Maturity | Details |
| --- | --- | --- |
| `bot.self` | `stable` | Local player entity. Set from `start_game`/player packets. |
| `bot.entities` | `stable` | Non-player entity map. |
| `bot.playerEntities` / `bot.players` | `stable` | Spawned player entity map. |
| `bot.playerList` | `stable` | Profile/tab-list records keyed by username. |
| `bot.playerListByUuid` | `stable` | Profile/tab-list records keyed by normalized UUID. |
| `bot.nearestEntity(filter = entity => true)` | `stable` | Returns nearest matching entity to `bot.self`, or `null`. Requires self positions. |

### Entity helper methods `stable`

Entities touched by the metadata layer may have helper methods installed:

| API | Signature | Returns | Notes |
| --- | --- | --- | --- |
| `entity.getEffect` | `getEffect(nameOrId)` | effect object or `null` | Looks up a visible effect by name/id. |
| `entity.hasEffect` | `hasEffect(nameOrId)` | boolean | True if the effect exists. |
| `entity.effectLevel` | `effectLevel(nameOrId)` | number | Effect amplifier/level, or `0`. |
| `entity.getStatus` | `getStatus(name)` | value | Reads normalized status flags. |
| `entity.hasStatus` | `hasStatus(name)` | boolean | True if a status value is truthy. |
| `entity.checkStatus` | `checkStatus(name, expected)` | boolean | Compares a status value. |
| `entity.hasMetadataFlag` | `hasMetadataFlag(name)` | boolean | Reads Bedrock metadata flags. |
| `entity.isPose` | `isPose(pose)` | boolean | Compares normalized pose. |
| `entity.isOnFire` | `isOnFire()` | boolean | Reads metadata/on-fire state. |

Events emitted by entity/player built-ins are listed in the event table below.

## Inventory

See [`docs/reference/inventory-and-actions.md`](reference/inventory-and-actions.md)
for inventory mirror shape, stack request helpers, common actions, and events.

| API | Maturity | Signature | Returns | Side effects, preconditions, failures |
| --- | --- | --- | --- | --- |
| `bot.getWindow` | `getWindow(windowId = 0)` | window or `null` | Reads `bot.windows`. |
| `bot.getUiSlot` | `getUiSlot(slot)` | projected UI slot or `null` | Reads Bedrock UI slot projection. |
| `bot.inventory.getItem` | `getItem(slot, windowId = 0)` | item or `null` | Reads a window slot. |
| `bot.inventory.findItem` | `findItem(itemType, metadata, notFull, nbt, windowId = 0)` | item or `null` | Searches inventory range through Prismarine window helpers. |
| `bot.inventory.count` | `count(itemType, metadata, windowId = 0)` | number | Counts matching items in a window. |
| `bot.inventory.applyItemStackResponse` | `applyItemStackResponse(response)` | `undefined` | Applies accepted server stack ids/counts into local inventory mirror. |
| `bot.inventory.predicted` | property | prediction snapshot | Read-only unified predicted inventory state. The snapshot is array-compatible for player slots and also exposes `.slots`, `.cursor`, `.windows`, `.activeWindowId`, `.activeWindow`, `.uiSlots`, `.armor`, `.offhand`, `.craftingInput`, `.creativeOutput`, and `.slot(slotInfo)`. Syncs with actual slots when no predicted transaction is pending. |
| `bot.inventory.cursor` | property | item or `null` | Compatibility alias for `bot.inventory.predicted.cursor`. |

```js
const stick = bot.inventory.findItem(bot.registry.itemsByName.stick.id)
console.log(stick?.count ?? 0)
```

## Inventory Actions

See [`docs/reference/inventory-and-actions.md`](reference/inventory-and-actions.md)
for inventory mirror shape, stack request helpers, common actions, and events.

These helpers send Bedrock `item_stack_request` actions. They rely on stack ids,
server responses, and inventory mirror updates. Player inventory actions update
`bot.inventory.predicted` before the response arrives, then reconcile against
the server response as ground truth.

| API | Maturity | Signature | Returns | Side effects and failures |
| --- | --- | --- | --- | --- |
| `bot.inventory.actions.send` | `send(request)` | request id | Queues request in the auth-input path and emits `inventory_action_request`. |
| `bot.inventory.actions.sendStandalone` | `sendStandalone(request)` | request id | Sends standalone `item_stack_request` and emits `inventory_action_request`. |
| `bot.inventory.actions.wait` | `wait(id, timeoutMs?)` | `Promise<response>` | Resolves only accepted responses; rejects on error/timeout. |
| `bot.inventory.actions.waitRaw` | `waitRaw(id, timeoutMs?)` | `Promise<response>` | Resolves even rejected responses for callers that need raw status. |
| `bot.inventory.actions.batch` | `batch(fn)` | `Promise<{ request, requests, response, responses, result, predicted, cursor }>` | Records player inventory actions inside `fn` and sends one packet containing ordered stack request entries. Adjacent same-source/same-destination split-and-merge operations may be coalesced into one request when that is the valid server shape. |
| `bot.inventory.select` | `select(slot)` | selected item | Sends hotbar selection and emits `held_item_slot_changed`. |
| `bot.inventory.equip` | `async equip(slot, hotbarSlot = 0)` | equipped item | Selects hotbar item or swaps inventory slot into a hotbar slot. |
| `bot.inventory.swap` | `async swap(slotA, slotB)` | response | Swaps slots. |
| `bot.inventory.move` | `async move(fromSlot, toSlot)` | response | Moves the full source stack into destination. |
| `bot.inventory.merge` | `async merge(fromSlot, toSlot)` | response | Moves as much as destination can accept. |
| `bot.inventory.move1` | `async move1(fromSlot, toSlot)` | response | Moves one item. |
| `bot.inventory.split` | `async split(fromSlot, toSlot)` | response | Moves half of source, rounded up. |
| `bot.inventory.pickup` | `async pickup(slot, count?)` | prediction result | Takes a slot, or part of it, onto the predicted cursor. In the closed-inventory player path this may be local-only until a later cursor placement/drop flushes a request. |
| `bot.inventory.placeCursor` | `async placeCursor(slot, count?)` | response | Places the predicted cursor, or part of it, into a slot and flushes the pending cursor move when possible. |
| `bot.inventory.drop` | `async drop(slot, randomly = false)` | response | Drops the whole stack. |
| `bot.inventory.drop1` | `async drop1(slot, randomly = false)` | response | Drops one item. |
| `bot.inventory.destroy` | `async destroy(slot)` | response | Destroys/removes the whole stack through the request path. |
| `bot.inventory.destroy1` | `async destroy1(slot)` | response | Destroys/removes one item. |
| `bot.inventory.actions.setResponseTimeout` | `setResponseTimeout(ms)` | `undefined` | Changes response timeout. |
| `bot.inventory.actions.setUpdateTimeout` | `setUpdateTimeout(ms)` | `undefined` | Changes slot update timeout. |
| `bot.inventory.actions.clearWaiters` | `clearWaiters()` | `undefined` | Rejects pending inventory waits. |

```js
await bot.inventory.equip(12, 0)
await bot.inventory.drop1(bot.heldItemSlot)
```

## Containers

See [`docs/reference/containers.md`](reference/containers.md) for opening
containers, the base wrapper API, specialized helpers, and container events.

### Opening and tracking containers

| API | Maturity | Signature | Returns | Side effects, preconditions, failures |
| --- | --- | --- | --- | --- |
| `bot.openContainer` / `bot.openBlockContainer` | `async openContainer(pos, opts = {})` | container API object | Looks at the block unless `opts.look === false`, sends open action, waits for window content. |
| `bot.getCurrentContainer` | `getCurrentContainer()` | active container or `null` | Reads active container pointer. |
| `bot.containers.waitForOpen` | `waitForOpen(predicate?, timeoutMs?)` | `Promise<packet>` | Waits for a matching `container_open`. |
| `bot.containers.wrapWindow` | `wrapWindow(packet)` | container API object | Wraps an existing Bedrock container window. Throws if the window was not created. |
| `bot.containers.get` | `get(windowId)` | container or `null` | Reads by window id. |
| `bot.containers.open` | property | `Map` | Open container wrappers keyed by window id. |

### Base container window API

Every wrapped container has this common surface.

| API | Signature | Returns | Notes |
| --- | --- | --- | --- |
| `container.id` / `container.windowId` | property | number | Normalized Bedrock window id. |
| `container.type` | property | string | Bedrock/prismarine window type. |
| `container.containerSlotType` | property | string | Bedrock stack request container id/type. |
| `container.position` | property | position | Block coordinates from open packet. |
| `container.window` | property | Prismarine window | Underlying window object. |
| `container.slots` | getter | slots array | Backed by `container.window.slots`. |
| `container.containerSlotCount` | getter | number | Container slot count before player inventory starts. |
| `container.getItem(slot)` | function | item or `null` | Reads a container slot. |
| `container.getInventoryItem(slot)` | function | item or `null` | Reads bot inventory slot. |
| `container.firstEmptyContainerSlot()` | function | slot or `-1` | Finds first empty container slot. |
| `container.firstEmptyInventorySlot()` | function | slot or `-1` | Finds first empty inventory slot. |
| `container.findContainerItem(name)` | function | slot or `-1` | Searches by item name. |
| `container.putInventorySlot(inventorySlot, containerSlot?, count?)` | async function | response | Transfers inventory to container. |
| `container.depositInventorySlot(inventorySlot, containerSlot?, count?)` | async function | response | Alias for `putInventorySlot`. |
| `container.takeContainerSlot(containerSlot, inventorySlot?, count?)` | async function | response | Transfers container to inventory. |
| `container.withdrawContainerSlot(containerSlot, inventorySlot?, count?)` | async function | response | Alias for `takeContainerSlot`. |
| `container.moveContainerSlot(fromSlot, toSlot, count?)` | async function | response | Moves within the container. |
| `container.swapContainerSlots(slotA, slotB)` | async function | response | Swaps two container slots. |
| `container.waitForContent(timeoutMs?)` | function | `Promise` | Waits for content update. |
| `container.close()` | function | `undefined` | Queues `container_close`. |

Transfer helpers throw on invalid slots, missing source items, incompatible
destination stacks, and insufficient destination space.

### Specialized container helpers

| Container type | Maturity | Added API |
| --- | --- | --- |
| `armor` | `partial` | `putArmor(index, inventorySlot, count?)`, `putHelmet`, `putChestplate`, `putLeggings`, `putBoots`. |
| `hand` | `partial` | `putOffhand`. |
| `anvil` | `partial` | `putInput`, `putMaterial`, `takeResult`. |
| `beacon` | `partial` | `putPayment`. |
| `brewing_stand` | `partial` | `ingredientSlot`, `fuelSlot`, `bottleSlots`, `resultSlots`, `getBottle`, `getBottles`, `getIngredient`, `getFuel`, `putBottle`, `putInput`, `putIngredient`, `putFuel`, `takeBottle`, `takeIngredient`, `takeFuel`, `takeResult`, `progress`, `brewing`, `getProgress`, `getBrewingProgress`, `setBrewDuration`, `setFuelTotal`. |
| `cartography` | `partial` | `putInput`, `putAdditional`, `takeResult`. |
| `crafter` | `partial` | `putCraftingInput`, `putInput`, `takeResult`. |
| `enchantment` | `partial` | `putInput`, `putLapis`, `enchantOptions`, `lastEnchantOptionsPacket`, `getEnchantOptions`, `getEnchantOption`, `findEnchantOption`, `waitForEnchantOptions`, `selectEnchantOption`. |
| `furnace`/furnace-like | `partial` | `putInput`, `putIngredient`, `putFuel`, `takeInput`, `takeIngredient`, `takeFuel`, `takeOutput`, `takeResult`, `progress`, `furnace`, `getProgress`, `getFurnaceProgress`, `setCookDuration`. |
| `grindstone` | `partial` | `putInput`, `putAdditional`, `takeResult`. |
| `loom` | `partial` | `putInput`, `putBanner`, `putDye`, `putMaterial`, `putPattern`, `takeResult`. |
| `smithing_table` | `partial` | `putTemplate`, `putInput`, `putMaterial`, `takeResult`. |
| `stonecutter` | `partial` | `putInput`, `takeResult`. |
| `trading` | `partial` | `putIngredient1`, `putIngredient2`, `takeResult`. |
| `workbench` | `partial` | `putCraftingInput`, `takeCraftingOutput`, `takeResult`. |

```js
const chest = await bot.openContainer(new Vec3(10, 64, 10))
await chest.takeContainerSlot(0)
chest.close()
```

## Crafting

See [`docs/reference/crafting.md`](reference/crafting.md) for planning state,
execution paths, and crafting events.

| API | Maturity | Signature | Returns | Side effects and failures |
| --- | --- | --- | --- | --- |
| `bot.craftingRecipeRegistry` | `partial` | property | registry | Registry used by recipe planner. |
| `bot.craftingRecipe` | `partial` | property | Recipe class | Recipe constructor/class. |
| `bot.craftingItemIdsByName` | `partial` | property | object | Name to item id map. |
| `bot.craftingItemNamesById` | `partial` | property | object | Item id to name map. |
| `bot.planCraftInventory` | `async planCraftInventory(wantedItem)` | plan | Uses `mineflayer-crafting-util`; returns plan with `status` and `source`. |
| `bot.planCraftInventoryWithUtil` | alias | plan | Alias for `planCraftInventory`. |
| `bot.planCraft` | alias | plan | Alias for `planCraftInventory`. |
| `bot.craftPlanRecipeBookAuto` | `craftPlanRecipeBookAuto(plan, craftingTableBlock?)` | `Promise<plan>` | Sends recipe-book style auto craft actions. |
| `bot.craftPlanAuto` | `craftPlanAuto(plan, craftingTableBlock?)` | `Promise<plan>` | Chooses auto or normal according to options. |
| `bot.craftPlanNormal` | `craftPlanNormal(plan, craftingTableBlock?)` | `Promise<plan>` | Places ingredients and takes result through normal stack requests. |
| `bot.craftPlan` | alias | `Promise<plan>` | Alias for `craftPlanNormal`. |
| `bot.craftItemAuto` | `async craftItemAuto(itemId, count, craftingTableBlock?)` | plan | Plans then executes auto craft. |
| `bot.craftItemRecipeBookAuto` | `async craftItemRecipeBookAuto(itemId, count, craftingTableBlock?)` | plan | Plans then executes recipe-book auto craft. |
| `bot.craftItemNormal` | `async craftItemNormal(itemId, count, craftingTableBlock?)` | plan | Plans then executes normal craft. |
| `bot.craftItem` | alias | plan | Alias for `craftItemNormal`. |
| `bot.craftAuto` | alias | plan | Alias for `craftItemAuto`. |
| `bot.craftRecipeBookAuto` | alias | plan | Alias for `craftItemRecipeBookAuto`. |
| `bot.craftNormal` | alias | plan | Alias for `craftItemNormal`. |

Crafting depends on current inventory state, server recipe data, stack ids,
container/window availability, and response acceptance. Failed plans throw before
packet execution.

```js
const planks = bot.craftingItemIdsByName.oak_planks
await bot.craftItem(planks, 4)
```

## Digging And Placement

See [`docs/reference/digging-placement-and-interaction.md`](reference/digging-placement-and-interaction.md)
for digging, placement, entity interaction, and action events.

| API | Maturity | Signature | Returns | Side effects and failures |
| --- | --- | --- | --- | --- |
| `bot.dig` | `stable` | `async dig(block, forceLook = true, digFace = 'auto')` | resolves when block update completes | Looks at target, hooks auth-input block actions, waits for update. Throws for null, already digging, non-diggable, or infinite dig time. |
| `bot.digTime` | `stable` | `digTime(block)` | milliseconds | Uses held item/tool and block hardness. May return `Infinity`. |
| `bot.canDigBlock` | `stable` | `canDigBlock(block)` | boolean | Requires diggable block, block position, self position, and range <= 5.1. |
| `bot.stopDigging` | `stable` | `stopDigging()` | `undefined` | Aborts active dig promise if any. |
| `bot.placeBlock` | `partial` | `async placeBlock(targetPos, face?, placeOptions = {})` | `Promise<void>` | Looks, sends item-use transaction, optionally waits for placed-block update. Throws if `targetPos` is not `Vec3`, offhand requested, or no held item. |
| `bot.placeEntity` | `partial` | `async placeEntity(targetPos)` | `Promise<void>` | Sends click-air item-use transaction. Throws if `targetPos` is not `Vec3` or no held item. |

```js
const target = await bot.getBlock(bot.self.position.offset(1, 0, 0))
if (bot.canDigBlock(target)) await bot.dig(target)
```

## Entity Interaction

See [`docs/reference/digging-placement-and-interaction.md`](reference/digging-placement-and-interaction.md)
for digging, placement, entity interaction, and action events.

| API | Maturity | Signature | Returns | Side effects and failures |
| --- | --- | --- | --- | --- |
| `bot.mouseOverEntity` | `packet-level` | `mouseOverEntity(entity, opts = {})` | interact packet | Queues `interact` with `mouse_over_entity`. Throws without runtime id. |
| `bot.swingArm` | `packet-level` | `swingArm(opts = {})` | animate packet | Queues `animate`. Throws before self runtime id is known. |
| `bot.queueItemUseOnEntity` | `packet-level` | `queueItemUseOnEntity(entity, actionType, opts = {})` | inventory transaction packet | Sends Bedrock `item_use_on_entity`; action type is `0`/`interact` or `1`/`attack`. |
| `bot.interactEntity` / `bot.interactAtEntity` | `partial` | `async interactEntity(entity, opts = {})` | packet | Optionally sends mouse-over, waits, then sends interact transaction. |
| `bot.attackEntity` | `partial` | `async attackEntity(entity, opts = {})` | packet | Optionally sends mouse-over, sends attack transaction, and swings unless `opts.swing === false`. |

## Emotes

See [`docs/reference/emotes-food-flight-environment.md`](reference/emotes-food-flight-environment.md)
for emote, food, flight, environment, and related event details.

| API | Maturity | Signature | Returns | Side effects and failures |
| --- | --- | --- | --- | --- |
| `bot.emotes` | `partial` | property | state object | `{ equipped, byPlayerRuntimeId }`. |
| `bot.emotes.sendList` | `sendList(emoteIds = bot.emotes.equipped)` | equipped ids | Sends `emote_list`. Throws before self runtime id is known. |
| `bot.emotes.equip` | `equip(emoteIds, options = {})` | equipped ids | Stores unique emote ids and optionally sends list. Throws if `emoteIds` is not an array. |
| `bot.emotes.play` / `bot.emotes.send` / `bot.emotes.emote` | `play(emoteId, options = {})` | packet | Sends an `emote`; records `bot.emotes.lastSent`. Throws before runtime id is known. |

## Food And Eating

See [`docs/reference/emotes-food-flight-environment.md`](reference/emotes-food-flight-environment.md)
for emote, food, flight, environment, and related event details.

| API | Maturity | Signature | Returns | Side effects and failures |
| --- | --- | --- | --- | --- |
| `bot.eat` | `partial` | `async eat(target?, eatOptions = {})` | completion result | Equips food if needed, starts use, optionally releases, waits for completion/inventory/attribute evidence, emits `ate`. Throws for active use, missing food, non-food, or full hunger unless forced. |
| `bot.isFoodItem` | `isFoodItem(item)` | boolean | Uses registry food metadata if available. |
| `bot.canAlwaysEat` | `canAlwaysEat(item)` | boolean | True for food that can be eaten at full hunger. |
| `bot.usingHeldItem` | property | boolean | Set while an item use is active. |

## Flight

See [`docs/reference/emotes-food-flight-environment.md`](reference/emotes-food-flight-environment.md)
for emote, food, flight, environment, and related event details.

| API | Maturity | Signature | Returns | Side effects and failures |
| --- | --- | --- | --- | --- |
| `bot.startFlying` | `startFlying(options?)` | `true`, `false`, or `Promise` | Queues `start_flying`; may optimistically set `self.flying`; emits `flightRequest`. |
| `bot.stopFlying` | `stopFlying(options?)` | `true` or `Promise` | Queues `stop_flying`; may wait for `flightChanged`. |
| `bot.setFlying` | `setFlying(enabled, options?)` | `true`, `false`, or `Promise` | Shared flight toggle. |
| `bot.canFly` | `canFly()` | boolean | Reads canonical ability/spectator state. |
| `bot.isFlying` | `isFlying()` | boolean | Reads canonical/optimistic flight state. |
| `bot.isSpectator` | `isSpectator()` | boolean | Reads spectator game mode/state. |

`startFlying({ wait: true })` resolves when a matching `flightChanged` event is
seen or rejects on timeout. Starting flight returns `false` if the bot lacks
flight permission unless `force` is true.

## Environment

See [`docs/reference/emotes-food-flight-environment.md`](reference/emotes-food-flight-environment.md)
for emote, food, flight, environment, and related event details.

| API | Maturity | Signature | Returns | Notes |
| --- | --- | --- | --- | --- |
| `bot.environment` | `partial` | property | mutable state | Time/weather mirror. |
| `bot.getEnvironment` | `getEnvironment()` | snapshot object | Includes copied environment fields and nested `weather`. |

Environment state fields include `time`, `timeOfDay`, `day`, `rainLevel`,
`lightningLevel`, `raining`, `thundering`, and `lastWeatherEvent`.

## Scoreboards

| API | Maturity | Signature | Returns | Notes |
| --- | --- | --- | --- | --- |
| `bot.scoreboards` | `partial` | property | `ScoreboardMirror` | Mirrors server scoreboard packets and owns the read helpers. |
| `bot.scoreboards.getObjective` | `getObjective(objectiveNameOrDisplaySlot)` | objective or `null` | Accepts an objective name or display slot such as `sidebar`. |
| `bot.scoreboards.getEntry` | `getEntry(scoreboardId)` | score entry or `null` | Looks up a mirrored score by Bedrock scoreboard id. |
| `bot.scoreboards.getScores` | `getScores(objectiveNameOrDisplaySlot = 'sidebar', options?)` | sorted score entries | Reads scores for any known objective or display slot. Supports `options.limit`. |
| `bot.scoreboards.getScore` | `getScore(objectiveNameOrDisplaySlot, query)` | score entry or `null` | Finds one score by scoreboard id, display/custom name, or predicate. |
| `bot.scoreboards.getDisplayedScores` | `getDisplayedScores(displaySlot = 'sidebar', options?)` | sorted score entries | Alias for display-slot score reads. |

The mirror listens to Bedrock `set_display_objective`, `set_score`,
`remove_objective`, and `set_scoreboard_identity` packets. Servers only send
scoreboard data that the client is allowed to know, typically displayed
sidebar/player-list/below-name objectives and updates. See
[`docs/reference/scoreboards.md`](reference/scoreboards.md) for state shape,
events, and examples.

## Trading

See [`docs/reference/trading.md`](reference/trading.md) for trade window state,
recipe lookup, execution, and events.

| API | Maturity | Signature | Returns | Side effects and failures |
| --- | --- | --- | --- | --- |
| `bot.openTrade` / `bot.tradeWith` | `async openTrade(entity, opts?)` | trade window packet/container state | Interacts with villager-like entity and waits for trade window. |
| `bot.trading.waitForWindow` | `waitForWindow(predicate?, timeoutMs?)` | `Promise<packet>` | Waits for `update_trade`. |
| `bot.trading.closeWindow` | `closeWindow()` | `undefined` | Closes active trade/container state. |
| `bot.trading.currentRecipes` | `currentRecipes()` | recipes array | Reads recipes from current trade window. |
| `bot.trading.find` | `find(predicateOrOptions?)` | recipe/result | Finds a matching trade recipe. |
| `bot.trading.execute` | `async execute(recipeOrOptions, options?)` | response | Sends ingredient/selection/result stack requests. |
| `bot.trading.setTimeout` | `setTimeout(ms)` | `undefined` | Updates trade wait timeout. |
| `bot.trading.currentWindow` | property | packet or `null` | Last active trade window packet. |
| `bot.trading.currentEntity` | property | entity or `null` | Entity associated with current trade window. |

Trading is one of the most Bedrock/Geyser-specific APIs. It intentionally keeps
some helper access available for agents because server responses can differ
between native BDS and Geyser.

## Mineflayer Compatibility Facade

See [`docs/reference/mineflayer-compat-facade.md`](reference/mineflayer-compat-facade.md)
for facade plugin loading and supported compat properties.

The native bot exposes Bedrock-first `Map` state. `bot.mineflayer` and
`bot.asMineflayerBot()` return a `Proxy` facade for Mineflayer-shaped plugins.

| API | Maturity | Signature/property | Behavior |
| --- | --- | --- | --- |
| `bot.mineflayer` | `compat` | property | Facade proxy. |
| `bot.asMineflayerBot` | `compat` | `asMineflayerBot()` | Returns the facade. |
| `bot.loadMineflayerPlugin` | `compat` | `loadMineflayerPlugin(plugin)` | Calls plugin with facade once. |
| `bot.loadMineflayerPlugins` | `compat` | `loadMineflayerPlugins(plugins)` | Loads each facade plugin. |
| `bot.hasMineflayerPlugin` | `compat` | `hasMineflayerPlugin(plugin)` | Checks facade plugin set. |
| `bot.loadPlugin`, `bot.loadPlugins`, `bot.hasPlugin` | `compat` | aliases if not already defined | Facade plugin loading aliases. |
| `facade.entity` | `compat` | property | Mineflayer-shaped local entity facade. |
| `facade.entities` | `compat` | property | Object view of native entity maps. |
| `facade.inventory` | `compat` | property | Inventory facade. |
| `facade.game` | `compat` | property | Game facade. |
| `facade.registry` | `compat` | property | Registry facade. |
| `facade.version` | `compat` | property | Mineflayer data version selection. |
| `facade.blockAt(pos)` | `compat` | function | Synchronous/compat block read from native world where possible. |
| `facade.findBlock(options)` / `facade.findBlocks(options)` | `compat` | function | Local-world block searches. |
| `facade.waitForChunks(options)` | `compat` | function | Delegates to chunk wait behavior. |
| `facade.equip(item, destination)` | `compat` | function | Adapts Mineflayer equip to Bedrock inventory helpers where supported. |
| `facade.unequip(destination)` | `compat` | function | Supported only for destinations backed by current Bedrock actions. |
| `facade.getEquipmentDestSlot(destination)` | `compat` | function | Maps supported Mineflayer equipment destinations. |
| `facade.placeBlock(referenceBlock, faceVector)` | `compat` | function | Adapts Mineflayer placement signature to native `placeBlock`. |
| `facade._placeBlockWithOptions(referenceBlock, faceVector, options)` | `compat` | function | Compat placement with options. |
| `facade.physics` | `compat` | property | Pathfinder physics shim where available. |
| `facade.look(yaw, pitch = 0, force = true)` | `compat` | function | Converts Mineflayer yaw/pitch to Bedrock degrees. |
| `facade.nativeBot` | `compat` | property | Back-reference to native `BotState`. |

The facade normalizes selected event names for Mineflayer plugins. It does not
make third-party plugins universally compatible; Java protocol assumptions,
window layouts, item ids, and movement semantics may still differ.

## Events

The bot is an EventEmitter. Packet names are also available on `bot.client`; the
events below are higher-level built-in events emitted by `bot`.

| Event | Maturity | Arguments/payload | Source |
| --- | --- | --- | --- |
| `chat` | `stable` | parsed chat payload | chat |
| `whisper` and other chat category events | `partial` | parsed chat payload | chat |
| `command_output` | `stable` | `{ requestId, successCount, outputType, messages, lines, raw }` | command |
| `playerSpawned` | `stable` | entity | entities |
| `entitySpawned` | `stable` | entity | entities |
| `entityRemoved` | `stable` | entity | entities |
| `itemPickup` | `partial` | pickup payload | entities |
| `entityEvent` | `partial` | entity, event id, data | entities |
| `entityAction` | `partial` | entity, action, packet | entities |
| `entityEffect` | `partial` | entity, packet | entities |
| `entityMovementEffect` | `partial` | entity, packet | entities |
| `flightChanged` | `stable` | flight state with previous/entity/reason/packet | entities/flight |
| `flightRequest` | `stable` | `{ flying, state }` | flight |
| `health` | `stable` | none | players |
| `death` | `stable` | none | players |
| `game` | `partial` | none | players/setup |
| `playerAnimate` | `partial` | entity, action id | players |
| `entityCrouch` / `entityUncrouch` | `partial` | entity | players |
| `held_item_slot_changed` | `stable` | slot, item | inventory-actions |
| `inventory_action_request` | `packet-level` | request | inventory-actions |
| `inventory_prediction_updated` | `partial` | prediction snapshot payload | inventory-actions |
| `inventory_prediction_reconciled` | `partial` | request, response, changed slots, mismatches | inventory-actions |
| `inventory_prediction_failed` | `partial` | error, request, response, mismatches | inventory-actions |
| `item_stack_response` | `packet-level` | parsed response | inventory-actions |
| `inventory_response_applied` | `partial` | response, changed slot list | inventory |
| `ui_slot_projected` | `partial` | projection payload | inventory |
| `ui_slot_updated` | `partial` | slot, item, packet | inventory |
| `ui_content_updated` | `partial` | uiSlots, packet | inventory |
| `inventory_content_updated` | `stable` | windowId, window | inventory |
| `inventory_trade_window_updated` | `partial` | windowId, window, packet | inventory |
| `container_data_updated` | `partial` | windowId, data, packet | inventory |
| `container_data` | `partial` | `{ windowId, container, property, value, packet, handled }` | containers |
| `player_enchant_options` | `partial` | `{ container, packet, handled }` | containers |
| `craft_item_stack_request` | `packet-level` | request | crafting |
| `diggingCompleted` | `stable` | block, target | dig |
| `diggingAborted` | `stable` | block, target, error | dig |
| `blockPlaceRequested` | `partial` | `{ targetPos, face, options }` | place |
| `entity_mouse_over_request` | `packet-level` | payload | entity-interact |
| `entity_swing_request` | `packet-level` | packet | entity-interact |
| `entity_item_use_request` | `packet-level` | payload | entity-interact |
| `entityEmote` | `partial` | emote payload | emotes |
| `playerEmote` | `partial` | entity, emote payload | emotes |
| `entityEmoteList` | `partial` | emote list payload | emotes |
| `ate` | `partial` | `{ slot, item, ...result }` | food |
| `time` / `environmentTime` | `partial` | time payload | environment |
| `weather` / `environmentWeather` | `partial` | weather payload | environment |
| `scoreboardDisplay` | `partial` | `{ displaySlot, objective, rawPacket }` | scoreboard |
| `scoreboardObjective` | `partial` | objective action payload | scoreboard |
| `scoreboardObjectiveRemoved` | `partial` | `{ objective, rawPacket }` | scoreboard |
| `scoreboardScore` | `partial` | `{ action, objective, entry, rawPacket }` | scoreboard |
| `scoreboardIdentity` | `partial` | identity action payload | scoreboard |
| `trade_window_open` | `partial` | packet, entity | trading |
| `trade_window_update` | `partial` | packet, entity | trading |
| `trade_window_close` | `partial` | packet | trading |
| `trade_executed` | `partial` | execution payload | trading |
| `physicsTickPre` | `partial` | tick payload | physics |
| `physicsTick` | `partial` | tick payload | physics |
| `chunkColumnLoad` / `chunkColumnLoaded` | `compat` | chunk | mineflayer-compat |
| `blockUpdate` / `blockUpdated` | `compat` | oldBlock, newBlock | mineflayer-compat |

## Internal And Agent Appendix

The following surfaces are useful for packet parity work and agents, but are not
recommended as stable public API unless promoted later.

| API | Maturity | Notes |
| --- | --- | --- |
| `bot._applyPlayerAuthInputHooks` | `internal` | Applies auth-input hooks to a packet. |
| `bot._authInputHooks` | `internal` | Internal hook array. |
| `bot._craftRequestId` | `internal` | Crafting request id counter. |
| `bot._craftingUtilPlannerPromise` | `internal` | Cached planner promise. |
| `bot.inventoryActionHelpers` | `internal` | Request/action builders and item helpers: `batch`, `makeRequest`, `takeAction`, `placeAction`, `swapAction`, `dropAction`, `destroyAction`, `cursorSlotInfo`, `stackSlotInfo`, `cloneItem`, `setStackId`, `maxStackSize`, `sameItem`, `responseStatusOk`, `parseItemStackResponsePacket`. |
| `bot.tradeHelpers` | `internal` | Trade item/recipe/request builders used for packet parity and Geyser behavior. |
| `require('.../src/builtins/inventory-simulation')` | `internal` | Exports click simulation, pure stack-request prediction helpers, and `InventorySimulationState`; this file is not auto-injected as a bot plugin. |
| `crafting._craftingHelpers` | `internal` | Craft action builder/test helpers exported from `src/builtins/crafting.js`. |
| `food._foodHelpers` | `internal` | Food metadata and packet builders exported from `src/builtins/food.js`. |
| `bot.protocolState`, `bot.chunkState`, `bot.targetStateIds`, `bot.currentTargetBlock` | `internal` | Runtime bookkeeping for packet/world behavior. |

Future docs work should keep this appendix honest: if an internal helper becomes
part of the supported API, move it into the relevant subsystem section and add
tests/examples that prove the public contract.
