# Chat And Commands

`prismarine-bedrock` exposes two text paths: chat packets for normal player
messages and Bedrock command packets for server-authoritative command execution.
Use chat for player-visible messages and `commandWithOutput` when a script needs
the parsed result from the server.

## Chat API

| API | Purpose |
| --- | --- |
| `bot.chat(message)` | Sends a Bedrock `text` packet with `type: 'chat'`. |
| `bot.whisper(target, message)` | Sends a slash-style whisper through the text packet path. |

Incoming text packets emit `chat` with a parsed payload. Recognized categories
also emit category-specific events such as `whisper`.

```js
bot.on('chat', msg => {
  if (msg.message === '!ping') bot.chat('pong')
})
```

## Command API

| API | Purpose |
| --- | --- |
| `bot.command(value, opts = {})` | Sends a server command and returns the request id. |
| `bot.commandWithOutput(value, opts = {})` | Sends a command and waits for matching `command_output`. |
| `bot.chatCommand(value)` | Sends a slash command as authored chat text. |
| `bot.rawCommand(value)` | Sends a raw text packet. |
| `bot.setCommandVersion(version)` | Changes default `command_request.version`. |
| `bot.setCommandTimeout(ms)` | Changes default output wait timeout. |
| `bot.setCommandPacket(packet)` | Changes the default command packet path. |

`bot.command` prefixes `/` when needed. The default packet path is configured by
`commandPacket`, normally `command_request`.

```js
const output = await bot.commandWithOutput('time query daytime')
console.log(output.lines.join('\n'))
```

## Events

| Event | Payload |
| --- | --- |
| `chat` | Parsed chat payload. |
| `whisper` and other chat category events | Parsed chat payload. |
| `command_output` | `{ requestId, successCount, outputType, messages, lines, raw }` |

