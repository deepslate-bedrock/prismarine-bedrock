# Documentation

This directory contains library-facing documentation for `prismarine-bedrock`.

## Runtime Logging

Prismarine Bedrock action logging is enabled by default for compatibility with
the existing examples and diagnostics. Pass `loggingEnabled: false` when
creating a bot to silence `logAction` output:

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
- [Mineflayer feature comparison](reference/mineflayer-feature-comparison.md)
- [Scoreboard handling](reference/scoreboards.md)

Agent workflow notes, packet parity task logs, recorded BDS scenarios, and e2e capture tooling now live in [`prismarine-bedrock-ai`](https://github.com/deepslate-bedrock/prismarine-bedrock-ai).
