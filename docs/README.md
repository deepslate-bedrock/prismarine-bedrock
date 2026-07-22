# Documentation

This directory contains library-facing documentation for `prismarine-bedrock`.

## Runtime Logging

Prismarine Bedrock action logging is enabled by default for compatibility with
the existing examples and diagnostics. Each bot owns its `bot.logAction`
logger. Pass `loggingEnabled: false` when creating a bot to silence that bot's
action-log output:

```js
const { createBot } = require('prismarine-bedrock')

const bot = createBot({
  host: 'localhost',
  port: 19132,
  username: 'MyBot',
  offline: true,
  loggingEnabled: false
})
```

## Reference Docs

- [API reference](API.md)
- [Example plugin](https://github.com/deepslate-bedrock/bedrock-example-plugin)
- [Chat and commands](reference/chat-and-commands.md)
- [Bedrock forms](reference/forms.md)
- [Auth input and movement](reference/auth-input-and-movement.md)
- [World and entities](reference/world-and-entities.md)
- [Inventory and actions](reference/inventory-and-actions.md)
- [Containers](reference/containers.md)
- [Crafting](reference/crafting.md)
- [Digging, placement, and interaction](reference/digging-placement-and-interaction.md)
- [Emotes, food, flight, and environment](reference/emotes-food-flight-environment.md)
- [Trading](reference/trading.md)
- [Mineflayer compatibility facade](reference/mineflayer-compat-facade.md)
- [Mineflayer feature comparison](reference/mineflayer-feature-comparison.md)
- [Scoreboard handling](reference/scoreboards.md)

Agent workflow notes, packet parity task logs, recorded BDS scenarios, and e2e capture tooling now live in [`prismarine-bedrock-ai`](https://github.com/deepslate-bedrock/prismarine-bedrock-ai).
