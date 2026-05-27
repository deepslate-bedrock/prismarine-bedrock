# Mineflayer Compatibility Facade

The native bot exposes Bedrock-first maps and packet-aware APIs. `bot.mineflayer`
and `bot.asMineflayerBot()` return a Mineflayer-shaped `Proxy` for plugins that
expect common Mineflayer names.

## Loading Plugins

| API | Purpose |
| --- | --- |
| `bot.mineflayer` | Facade proxy. |
| `bot.asMineflayerBot()` | Returns the facade. |
| `bot.loadMineflayerPlugin(plugin)` | Calls a plugin with the facade once. |
| `bot.loadMineflayerPlugins(plugins)` | Loads each facade plugin. |
| `bot.hasMineflayerPlugin(plugin)` | Checks facade plugin set. |
| `bot.loadPlugin`, `bot.loadPlugins`, `bot.hasPlugin` | Aliases when not already defined. |

Mineflayer compatibility plugins are direct install functions and are called as
`plugin(bot.mineflayer)`. Native Prismarine Bedrock plugins use the same
function-shaped loading model through `pluginLoader.loadPlugin(bot, plugin)`,
but receive the native Bedrock bot instead of the facade.

## Facade Surface

| API | Behavior |
| --- | --- |
| `facade.entity` | Mineflayer-shaped local entity facade. |
| `facade.entities` | Object view of native entity maps. |
| `facade.inventory` | Inventory facade. |
| `facade.game` | Game facade. |
| `facade.registry` | Registry facade. |
| `facade.version` | Mineflayer data version selection. |
| `facade.blockAt(pos)` | Synchronous/compat block read where possible. |
| `facade.findBlock(options)` / `facade.findBlocks(options)` | Local-world block searches. |
| `facade.waitForChunks(options)` | Delegates to chunk wait behavior. |
| `facade.equip(item, destination)` | Adapts Mineflayer equip to Bedrock inventory helpers where supported. |

## Notes

The facade is compatibility-oriented, not a guarantee of full Mineflayer parity.
When Bedrock semantics differ, native APIs remain the source of truth.
