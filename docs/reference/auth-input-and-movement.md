# Auth Input And Movement

The auth-input builtin owns low-level `player_auth_input` edits and control
state. The movement/physics builtins consume that state to simulate local
movement and send Bedrock movement packets.

## Packet Edit Hooks

| API | Purpose |
| --- | --- |
| `bot.authInputFlags` | Bedrock `player_auth_input` flag names and bit positions. |
| `bot.setAuthInputFlag(packet, flag, enabled = true)` | Mutates a packet input bitset. |
| `bot.onPlayerAuthInputPreSend(hook)` | Registers a hook before each outgoing auth-input packet. |
| `bot.queuePlayerAuthInputEdit(edit)` | Queues an object/function edit for the next outgoing auth-input. |
| `bot.flushPlayerAuthInput()` | Forces the current movement/auth-input packet path to flush if available. |

Hooks are packet-level APIs. Callers are responsible for preserving valid
Bedrock packet shape.

## Control State

| API | Purpose |
| --- | --- |
| `bot.controlState` | Object with `forward`, `back`, `left`, `right`, `jump`, `sprint`, `sneak`, and `swim`. |
| `bot.setControlState(name, value)` | Sets one boolean movement control. |
| `bot.getControlState(name)` | Reads one control. |
| `bot.clearControlStates()` | Clears all movement controls. |
| `bot.setFlag(name, value)` | Low-level input-data flag write on `bot.self`. |

```js
bot.setControlState('forward', true)
setTimeout(() => bot.clearControlStates(), 1000)
```

## Movement And Look

| API | Purpose |
| --- | --- |
| `bot.applyMovement()` | Runs one local movement simulation tick and emits physics tick events. |
| `bot.setPosition(x, y, z)` | Sets local self position and authoritative movement base. |
| `bot.look(yaw, pitch, force = false)` | Rotates the bot using Bedrock degrees. |
| `bot.lookAt(point, force = false)` | Looks at a world point. |
| `bot.waitForLookComplete()` | Resolves when interpolated look reaches the target. |

`look` uses Bedrock yaw/pitch degrees. The Mineflayer facade adapts radians and
Java yaw orientation for compat callers.

## Events

| Event | Payload |
| --- | --- |
| `physicsTickPre` | Tick payload before simulation. |
| `physicsTick` | Tick payload after simulation. |

