# Feature Comparison: bedrock-test vs Mineflayer

Date: 2026-05-12

This document compares the current feature surface of this repository with Mineflayer. It is written from the local code in this repo and public Mineflayer package documentation. Mineflayer is currently published as `mineflayer@4.32.0` on npm and is described as a stable, high-level JavaScript API for Minecraft Java Edition bots, with protocol support across Java versions 1.8 through 1.21.

Sources:

- Local repo modules under `src/`, especially `src/state.js` and `src/builtins/`.
- Mineflayer npm package page: https://www.npmjs.com/package/mineflayer
- Mineflayer site: https://mineflayer.com/

## Executive Summary

This repo is not a Mineflayer replacement yet. It is closer to a Bedrock/Geyser bot runtime that is incrementally rebuilding Mineflayer-like primitives on top of `bedrock-protocol`.

Mineflayer is broader, older, and production-shaped. It has a mature Java Edition API, authentication defaults, broad version support, stable plugin expectations, many examples, third-party plugin ecosystem support, and long-lived abstractions for movement, entities, blocks, inventory, crafting, containers, chat, health, and world state.

This repo is narrower but deeper in Bedrock-specific packet handling. Its strongest areas are Bedrock connection setup, chunk/world mirroring, entity tracking, player-auth-input movement, inventory stack request handling, container specialization, crafting through Bedrock `crafting_data`, and villager trading. The code is clearly focused on making Bedrock/Geyser semantics work correctly rather than matching Mineflayer's Java protocol assumptions.

The practical comparison:

- Mineflayer is the stable Java Edition bot framework.
- This repo is an experimental Bedrock Edition compatibility/runtime layer.
- This repo already covers a surprising amount of the core bot surface, but many APIs are not Mineflayer-compatible in shape, naming, event payloads, maturity, or edge-case coverage.
- The largest missing Mineflayer-level areas are pathfinding, mature auth/session ergonomics, full plugin ecosystem compatibility, robust world/game-state metadata, high-level item/use/block activation APIs, vehicles, weather/time/game metadata, and documentation/examples.

## Architecture

| Area | This repo | Mineflayer |
| --- | --- | --- |
| Protocol | Uses `bedrock-protocol` directly. Targets Bedrock protocol shape, currently configured around `1.26.10` protocol data for BDS 1.26.12. | Uses `minecraft-protocol` for Java Edition. Supports many Java versions through version-aware protocol/data packages. |
| Bot entrypoint | `createBot(options)` from the package root starts a bot; `BotState` in `src/state.js` remains available for manual construction. | `mineflayer.createBot(options)` creates a ready high-level bot with built-in plugins. |
| Data model | Uses Prismarine packages with a Bedrock registry: `prismarine-registry`, `prismarine-block`, `prismarine-item`, `prismarine-entity`, `prismarine-world`, `prismarine-windows`, `prismarine-chat`. | Uses the same Prismarine ecosystem, but most packages are exercised against Java protocol semantics. |
| Plugin model | Has `loadPlugin`, `loadPlugins`, `hasPlugin`, `injectPlugins`, and auto-loaded local builtins. | Mature plugin API with a broad third-party ecosystem and strong expectations around common bot APIs. |
| Edition target | Bedrock/Geyser. | Java Edition. |

The key architectural risk is that API names can look Mineflayer-like while packet semantics are not equivalent. For example, inventory movement in this repo must preserve Bedrock stack IDs and encode `item_stack_request` actions correctly. Mineflayer's Java-side inventory APIs do not need those Bedrock-specific identities.

## Connection, Login, and Lifecycle

This repo:

- Creates a Bedrock client with `bedrock.createClient({ delayedInit: true })`.
- Handles `connect_allowed`, `start_game`, `item_registry`, `creative_content`, `biome_definition_list`, `crafting_data`, `play_status`, `set_health`, `death_info`, `respawn`, `spawn`, `error`, and `close` in `src/builtins/setup.js`.
- Requests chunk radius and sends `set_local_player_as_initialized` after `player_spawn`.
- Implements Bedrock respawn handshake fallback logic.
- Supports offline-style local test configuration in `src/index.js`.

Mineflayer:

- Provides `createBot` as the standard entrypoint.
- Handles Java server version detection when possible.
- Has mature authentication behavior, including Microsoft authentication through `minecraft-protocol`.
- Emits well-known lifecycle events such as spawn, login, kicked, error, end, death, health, and game-related events.

Gap:

- This repo now exposes a basic public `createBot` API and keeps runnable demo code in `examples/`, but the surrounding API/documentation surface is still less mature than Mineflayer.
- Authentication/session ergonomics are far behind Mineflayer.

## Chat and Commands

This repo:

- Parses Bedrock `text` packets in `src/builtins/chat.js`.
- Emits `chat` and message-type-specific events.
- Implements `botState.chat(message)` and `botState.whisper(target, message)`.
- Provides command helpers in `src/builtins/command.js`: `command`, `commandWithOutput`, `chatCommand`, `rawCommand`, command output waiters, and configurable command protocol version/timeout.

Mineflayer:

- Has mature chat APIs, chat events, message parsing, signed/unsigned message differences by Java version, tab completion, command handling patterns, and common examples.

Gap:

- This repo has useful Bedrock chat and command primitives but does not yet match Mineflayer's full chat event compatibility or Java-version-specific behavior.

## World, Blocks, and Chunks

This repo:

- Builds a `prismarine-world` instance in `BotState`.
- Decodes and stores Bedrock chunks in `src/builtins/world.js`.
- Tracks blob cache state, missing blob requests, chunk sections, full chunk load state, subchunk updates, block updates, synced block updates, subchunk block updates, block entity data, and network chunk publisher updates.
- Exposes `getBlockAt`, `getBlockStateIdAt`, `setBlockStateIdAt`, `areChunksLoadedAround`, and `waitForChunksToLoad`.
- Maintains world bounds such as `worldMinY` and `worldHeight`.

Mineflayer:

- Provides mature world/block querying APIs such as block lookup, block search, block updates, and block entity support.
- Has long-tested Java chunk loading semantics and integrates directly with common plugins like pathfinder and viewer.

Gap:

- This repo has strong Bedrock-specific chunk work, but it needs more evidence before claiming Mineflayer-level world coverage.
- Block entity decoding and high-level block helpers appear narrower than Mineflayer's established surface.
- Compatibility with Mineflayer ecosystem tools such as `prismarine-viewer` is not established.

## Entities and Players

This repo:

- Tracks entities in `src/builtins/entities.js`.
- Handles `start_game`, `add_player`, `add_entity`, `add_item_entity`, `remove_entity`, `take_item_entity`, `move_entity`, `move_player`, `move_entity_delta`, `motion_prediction_hints`, `correct_player_move_prediction`, `set_entity_data`, `set_entity_motion`, `entity_event`, `update_attributes`, and `set_entity_link`.
- Emits `playerSpawned`, `entitySpawned`, `entityRemoved`, `itemPickup`, and `entityEvent`.
- Maintains `botState.self`, `botState.entities`, and `botState.players`.
- Provides `nearestEntity(filter)`.
- Adds player-specific handling in `src/builtins/players.js` for player list, movement, metadata, health, spawn position, equipment, armor, animation, crouch/uncrouch, death, and game events.

Mineflayer:

- Has mature entity and player tracking, stable event names, entity metadata interpretation, equipment, health, effects, vehicles, and combat-related helpers.

Gap:

- This repo has the basic entity mirror and some self/player state, but likely does not yet cover Mineflayer's full entity metadata, vehicle control, combat state, effects, and cross-version behavior.

## Movement and Physics

This repo:

- Implements Bedrock movement in `src/builtins/physics/`.
- Sends `player_auth_input` and `move_player` packets.
- Exposes `setControlState`, `getControlState`, `clearControlStates`, `setFlag`, `look`, `lookAt`, `waitForLookComplete`, `applyMovement`, and `setPosition`.
- Integrates `@nxg-org/mineflayer-physics-util` through an adapter layer.
- Tracks Bedrock movement authority, prediction corrections, attributes, abilities, effects, entity motion, game mode, dimension changes, respawn, health, spawn position, and game rules.

Mineflayer:

- Uses mature physics behavior for Java movement and exposes common controls such as `setControlState`, look helpers, and movement state.
- Commonly pairs with `mineflayer-pathfinder` for high-level navigation.

Gap:

- This repo has low-level movement controls and simulation, but no built-in pathfinder equivalent.
- The movement system is Bedrock-first and likely not API-compatible with Mineflayer plugins expecting Java movement semantics.
- Pathfinding, navigation goals, stuck handling, digging/building integration, and high-level route planning remain major missing pieces.

## Inventory

This repo:

- Maintains passive inventory mirrors in `src/builtins/inventory.js`.
- Tracks windows, UI slots, inventory, armor, offhand, active window, held hotbar slot, and server-confirmed raw Bedrock item identity.
- Preserves `stackId`, `stack_id`, `networkId`, `network_id`, `blockRuntimeId`, `block_runtime_id`, and `raw` on items.
- Exposes `heldItem`, `getWindow`, `getUiSlot`, `getItem`, `findItem`, and `count`.
- Handles `inventory_content`, `inventory_slot`, `mob_equipment`, `container_open`, `update_trade`, `container_set_data`, and `container_close`.

Mineflayer:

- Has mature inventory and window abstractions, including item counts, slots, held item, equipment, window updates, and click/clickWindow style operations.

Gap:

- This repo's inventory mirror is a strong base, especially for Bedrock stack identity.
- API compatibility with Mineflayer's inventory/window methods is partial.
- More high-level helpers are needed for common user flows such as choosing tools, consuming items, using items, automatic equipment, and robust click patterns.

## Inventory Actions

This repo:

- Implements Bedrock `item_stack_request` actions in `src/builtins/inventory-actions.js`.
- Groups request helpers under `bot.inventory.actions` and common slot actions under `bot.inventory`, including `select`, `equip`, `swap`, `move`, `merge`, `move1`, `split`, `drop`, `drop1`, `destroy`, and `destroy1`.
- Applies accepted server responses back to the local inventory mirror.
- Provides helper builders for stack request slots, take/swap/drop/destroy actions, cloning, stack IDs, max stack size, response status, and item comparison.

Mineflayer:

- Provides established inventory manipulation through Java window clicks and higher-level helpers.

Gap:

- This repo's Bedrock request construction is one of its most important differentiators.
- It needs continued round-trip and Geyser validation because malformed Bedrock action shapes can serialize incorrectly or be rejected by the server.

## Containers

This repo:

- Implements generic container opening and transfer helpers in `src/builtins/containers/index.js`.
- Supports top-level `openContainer`, `openBlockContainer`, and `getCurrentContainer`; bookkeeping helpers live under `bot.containers` as `wrapWindow`, `get`, and `open`.
- Provides container actions: get item, first empty slot, find item, deposit, withdraw, move, swap, wait for content, and close.
- Specializes multiple container types through files under `src/builtins/containers/`: anvil, armor, beacon, brewing stand, cartography table, crafter, enchantment table, furnace, grindstone, loom, smithing table, stonecutter, trading, workbench, and helpers.
- Tracks furnace and brewing progress/data in more detail than a simple generic window wrapper.

Mineflayer:

- Has mature support for chests, furnaces, dispensers, enchantment tables, crafting tables, and other windows through Java window APIs and examples.

Gap:

- This repo has broad container specialization scaffolding, but behavior depth varies by container.
- Mineflayer has more established public APIs and examples for common containers.
- Bedrock UI slot projection is a necessary complexity here and means a one-to-one Mineflayer API clone may need compatibility adapters.

## Crafting

This repo:

- Implements crafting in `src/builtins/crafting.js`.
- Stores Bedrock `crafting_data` packets.
- Bridges `mineflayer-crafting-util` into Bedrock `crafting_data`.
- Exposes `planCraftInventory`, `planCraftInventoryWithUtil`, `planCraft`, `craftPlan`, and `craftItem`.
- Builds Bedrock stack request actions for crafting results and predicts inventory changes.
- Can open crafting tables when required.

Mineflayer:

- Has mature recipe lookup and crafting APIs built around Java recipes and inventory/window mechanics.

Gap:

- This repo's crafting is a targeted Bedrock bridge and should be considered promising but not fully Mineflayer-equivalent.
- Bedrock recipe network IDs, output resolution, utility planner steps, and server acceptance make this more fragile than Java-side Mineflayer crafting.

## Digging, Placing, and Block Interaction

This repo:

- Implements `dig` in `src/builtins/dig.js`.
- Implements `placeBlock` and `placeEntity` in `src/builtins/place.js`.
- Uses Bedrock inventory transaction packets for block placement and item use.
- Adds entity interaction helpers in `src/builtins/entity-interact.js`: `mouseOverEntity`, `swingArm`, `queueItemUseOnEntity`, `interactEntity`, `interactAtEntity`, and `attackEntity`.

Mineflayer:

- Has mature `dig`, `placeBlock`, block activation, item use, entity attack, and related events.
- Common plugins add tool selection, auto-eat, collect-block, PvP, projectiles, and pathfinder-integrated digging/building.

Gap:

- This repo covers basic Bedrock packet sending for digging, placement, and entity interaction.
- Higher-level behaviors such as block activation, item consumption, tool choice, build planning, collect-block, and pathfinder-integrated actions are not at Mineflayer maturity.

## Trading

This repo:

- Implements villager trading in `src/builtins/trading.js`.
- Supports opening trade windows, tracking trade recipes, finding trades, building trade stack requests, transferring ingredients, taking results, restoring excess inputs, waiting for outputs, and executing trades.
- Keeps `openTrade` and `tradeWith` as the primary top-level actions, with related helpers grouped under `bot.trading` (`waitForWindow`, `closeWindow`, `currentRecipes`, `find`, `execute`, `helpers`, and `setTimeout`).

Mineflayer:

- Has villager/window support through Java inventory windows and plugin/userland patterns.

Gap:

- This repo is relatively strong here for Bedrock/Geyser because it handles Bedrock trade packet details directly.
- More compatibility docs and end-to-end tests would be needed before treating it as a stable public API.

## Game State and Miscellaneous Features

This repo has partial support for:

- Health/death/respawn.
- Spawn position.
- Player gamemode.
- Attributes, abilities, effects, dimension changes, game rules, and some movement metadata in the physics adapter.
- Command output.
- Creative content and biome definition packet receipt, though not much high-level API surface is exposed around them.

Mineflayer has broader support for:

- Weather/rain state.
- Time and day/night information.
- Experience, food, oxygen, scoreboards, teams, boss bars, titles, tab list, statistics, resource packs, plugin channels, and many Java game-state packets.
- Mature events around many of these systems.

Gap:

- This repo's game-state layer is functional for current tests and Bedrock packet work, but not a broad Mineflayer-style game-state API yet.

## Pathfinding and Plugin Ecosystem

This repo:

- Does not currently include a pathfinder.
- Does not advertise compatibility with Mineflayer third-party plugins.
- Has a local plugin mechanism, but most builtins are Bedrock-specific.

Mineflayer:

- Has a major ecosystem around plugins such as pathfinder, viewer, web inventory, statemachine, armor manager, PvP, auto-eat, tool selection, projectile helpers, movement plugins, and collect-block.

Gap:

- This is the largest user-facing difference.
- Even if this repo implements Mineflayer-like method names, third-party plugins may still fail because they expect Java protocol events, Mineflayer event names, Java registry details, Java window layouts, and Java movement behavior.

## Testing Coverage

This repo has focused tests for:

- Chunk readiness.
- Inventory mirror.
- Inventory simulation.
- Inventory actions.
- Containers.
- Container specialization.
- Container metadata.
- Place block.
- Trading.

Scripts also exist for:

- Block breaking.
- Block/world access.
- Superflat/world access checks.
- Interaction.
- Crafting.
- Packet round-trip validation.

Mineflayer:

- Has a mature upstream test and example culture, plus broad user exposure across many server versions.

Gap:

- This repo has good focused tests for the systems currently under active development.
- It still needs broader integration coverage, public examples, and compatibility tests if the goal is Mineflayer-like API parity.

## Feature Matrix

| Feature | This repo status | Mineflayer status | Notes |
| --- | --- | --- | --- |
| Java Edition support | Not supported | Core target | This repo is Bedrock/Geyser-oriented. |
| Bedrock Edition support | Core target | Not core Mineflayer target | Main differentiator of this repo. |
| Public bot factory | Weak/unfinished | Mature | This repo needs a clean exported API. |
| Plugin loading | Basic local system | Mature ecosystem | Mineflayer plugins are not automatically compatible. |
| Chat | Partial/good | Mature | This repo supports Bedrock text send/receive. |
| Commands | Good for Bedrock command packets | Mature Java patterns | This repo has command output waiters. |
| Chunks/world mirror | Good active implementation | Mature | This repo handles Bedrock blobs/subchunks. |
| Block lookup | Partial/good | Mature | This repo has `getBlockAt`; Mineflayer has richer helpers. |
| Entity tracking | Partial/good | Mature | This repo tracks core Bedrock entities and players. |
| Self/player state | Partial | Mature | Health/death/spawn exist; broader game state missing. |
| Movement controls | Good low-level support | Mature | This repo sends Bedrock auth input. |
| Physics | Active Bedrock adapter | Mature Java physics | Bedrock semantics differ. |
| Pathfinding | Missing | Common via plugin | Major gap. |
| Inventory mirror | Good | Mature | Bedrock stack identity preservation is a strength. |
| Inventory actions | Good active implementation | Mature | This repo uses Bedrock stack requests. |
| Containers | Partial/good | Mature | Broad scaffolding; depth varies by container. |
| Crafting | Partial/good | Mature | Bedrock `crafting_data` bridge is promising. |
| Digging | Basic/partial | Mature | Needs more high-level behavior and edge coverage. |
| Placing/building | Basic/partial | Mature | Packet send exists; builder-level APIs missing. |
| Entity interaction/combat | Basic/partial | Mature | Attack/interact exist; PvP-style behavior missing. |
| Vehicles | Missing/unclear | Supported | No clear vehicle control API here. |
| Trading | Good active implementation | Available through windows/userland | This repo is strong for Bedrock/Geyser trading. |
| Weather/time/scoreboard | Missing/unclear | Mature/available | Mineflayer has broader game-state APIs. |
| Viewer/web ecosystem | Missing/unclear | Common | Prismarine viewer compatibility not established. |
| Documentation/examples | Sparse | Mature | This repo needs public API docs and examples. |

## Recommended Parity Roadmap

1. Harden the public API entrypoint.

   `createBot(options)` now exists and runnable demo code is separated into `examples/`. The remaining work is documenting the exported surface and keeping the API stable.

2. Decide on API compatibility goals.

   Pick one of these explicitly:

   - "Mineflayer-inspired Bedrock API": safer and more honest.
   - "Mineflayer-compatible where practical": requires shims and compatibility tests.
   - "Drop-in Mineflayer replacement for Bedrock": much larger scope and probably not realistic short-term.

3. Document the supported method/event surface.

   Generate or maintain a concise API table from builtins: chat, command, chunks, entities, movement, inventory, inventory actions, containers, crafting, digging, placing, entity interaction, and trading.

4. Add pathfinding.

   This is the biggest practical feature gap. It will need Bedrock block/world semantics, movement controls, digging/building integration, and stuck recovery.

5. Add compatibility adapters only after semantics are stable.

   Do not copy Mineflayer names blindly. For inventory, crafting, and containers, the Bedrock stack ID and request/response model needs to remain explicit somewhere.

6. Expand game-state coverage.

   Add high-level APIs/events for time, weather, food, oxygen, XP, scoreboards, boss bars, titles, resource packs, game rules, and dimension state where Bedrock protocol support exists.

7. Expand end-to-end examples.

   Useful examples would be:

   - Echo/chat bot.
   - Block scan bot.
   - Move/look bot.
   - Dig and place bot.
   - Chest transfer bot.
   - Craft item bot.
   - Villager trade bot.
   - Minimal Geyser test bot.

## Bottom Line

This repo already contains the hard beginning of a Bedrock-native Mineflayer-like runtime. It is strongest where Mineflayer's Java assumptions do not apply: Bedrock auth input, Bedrock stack requests, Bedrock inventory identity, Geyser-compatible trading, Bedrock chunk handling, and Bedrock container slot projection.

Mineflayer remains far ahead as a complete user-facing framework. The quickest path to usefulness is not to claim full Mineflayer parity, but to expose a stable Bedrock-first API, document the differences clearly, and add selective Mineflayer-compatible aliases where the behavior genuinely matches.
