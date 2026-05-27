# Scoreboard Handling

`prismarine-bedrock` mirrors the scoreboard packets a Bedrock server sends to
the bot. The mirror is read-only from the server's point of view: it tracks
server-authored objectives, display slots, score rows, removals, and scoreboard
identity updates. It does not create client-side-only scoreboards or try to
force UI state on the server.

## Packet Coverage

The scoreboard builtin listens to these clientbound Bedrock packets:

| Packet | Effect |
| --- | --- |
| `set_display_objective` | Creates or updates a displayed objective and binds it to a display slot such as `sidebar`. |
| `set_score` | Adds, updates, or removes score rows for an objective. |
| `remove_objective` | Removes an objective and clears its displayed slots and score rows. |
| `set_scoreboard_identity` | Associates a score row with an entity/player identity or clears that association. |

Servers only send data the client is allowed to know. A hidden objective that is
never displayed or otherwise sent by the server will not appear in
`bot.scoreboards`. Use server commands such as `/scoreboard objectives list`
through `bot.commandWithOutput` when you need command-authorized discovery
beyond the clientbound packet stream.

## State Shape

`bot.scoreboards` is a `ScoreboardMirror` object. It contains maps keyed by
Bedrock identifiers and read helpers for common lookups:

```js
{
  objectives: Map,   // objective name -> objective
  displaySlots: Map, // display slot -> objective name
  scores: Map,       // scoreboard id string -> score entry
  identities: Map    // scoreboard id string -> identity record
}
```

The mirror methods are:

| Method | Purpose |
| --- | --- |
| `getObjective(objectiveNameOrDisplaySlot)` | Reads an objective directly or through a display slot. |
| `getEntry(scoreboardId)` | Reads a score entry by Bedrock scoreboard id. |
| `getScores(objectiveNameOrDisplaySlot = 'sidebar', options?)` | Reads sorted scores for an objective or display slot. |
| `getScore(objectiveNameOrDisplaySlot, query)` | Finds one score by scoreboard id, display/custom name, or predicate. |
| `getDisplayedScores(displaySlot = 'sidebar', options?)` | Reads sorted scores from a display slot. |

An objective has:

```js
{
  name,
  objectiveName,
  displayName,
  criteriaName,
  sortOrder,
  displaySlots, // Set
  scores,       // Map of score entries for this objective
  raw           // latest set_display_objective-style packet data
}
```

A score entry has:

```js
{
  id,               // scoreboard id as a string key
  scoreboardId,     // original Bedrock scoreboard id
  objectiveName,
  score,
  type,             // player, entity, fake_player, or null
  entryType,
  entityUniqueId,
  identityEntityUniqueId,
  customName,
  displayName,
  name,
  entity,           // resolved live entity when known
  player,           // resolved player-list record when known
  raw
}
```

## Reading Scores

Read the currently displayed sidebar:

```js
const objective = bot.scoreboards.getObjective('sidebar')
const scores = bot.scoreboards.getDisplayedScores('sidebar')

console.log(objective?.displayName)
for (const entry of scores) {
  console.log(entry.displayName, entry.score)
}
```

Read by objective name instead of display slot:

```js
const scores = bot.scoreboards.getScores('kills')
```

Find one score row:

```js
const byName = bot.scoreboards.getScore('sidebar', 'Steve')
const byId = bot.scoreboards.getScore('kills', 12n)
const top = bot.scoreboards.getScore('sidebar', entry => entry.score >= 100)
```

`getDisplayedScores` and `getScores` return sorted copies of entries.
The sort follows the objective's Bedrock `sortOrder`, then display name as a
stable tie-breaker. Pass `{ limit: 15 }` when you only need the visible top
portion.

## Events

The builtin emits higher-level events after applying packets:

| Event | Payload |
| --- | --- |
| `scoreboardDisplay` | `{ displaySlot, objective, rawPacket }` |
| `scoreboardObjective` | Objective action payload. `action` is `display` or `remove`. |
| `scoreboardObjectiveRemoved` | `{ objective, rawPacket }` |
| `scoreboardScore` | `{ action, objective, entry, rawPacket }`, where `action` is `change` or `remove`. |
| `scoreboardIdentity` | Identity action payload with scoreboard id, entity unique id, and resolved entry when known. |

Example:

```js
bot.on('scoreboardScore', ({ action, objective, entry }) => {
  if (action !== 'change') return
  if (objective?.name !== 'kills') return
  console.log(`${entry.displayName}: ${entry.score}`)
})
```

## Server Commands

If the bot has permission, server commands can cause the server to send the
scoreboard packets that populate this mirror:

```js
bot.command('scoreboard objectives add kills dummy Kills')
bot.command('scoreboard objectives setdisplay sidebar kills')
bot.command('scoreboard players set Steve kills 3')
```

These commands still create and mutate server scoreboards. The builtin only
observes the packets sent back to this bot.
