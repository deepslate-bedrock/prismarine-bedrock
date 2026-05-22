# Pathfinder Support on Bedrock

Date: 2026-05-19

This document tracks what `mineflayer-pathfinder` currently does, partially does, and does not do when running on top of this Bedrock runtime. It complements [`mineflayer-feature-comparison.md`](./mineflayer-feature-comparison.md) but focuses on movement planning specifically. The bridge that makes pathfinder work at all is documented in [`TASK-22`](../../../prismarine-bedrock-ai/docs/tasks/TASK-22-mineflayer-pathfinder-adapter-review.md) and [`TASK-27`](../../../prismarine-bedrock-ai/docs/tasks/TASK-27-pathfinder-physics-shim.md).

## How pathfinder is wired

Pathfinder is the unmodified upstream `mineflayer-pathfinder@2.4.5` from npm. It loads via the Mineflayer-shaped facade exposed by `src/builtins/mineflayer-compat.js` and uses `bot.physics.simulatePlayer(state, world)` to validate each candidate path edge. The `bot.physics` shim returned by the facade delegates to the real Bedrock engine via [`src/builtins/physics/pathfinder-physics-shim.js`](../../src/builtins/physics/pathfinder-physics-shim.js) on a per-state synthetic self — the live `botState.self` is never mutated by planning, and a `WeakMap<state, synSelf>` keeps the internal `_aabb`, edge-tracking, and AABB anchor flags per pathfinder state object.

```js
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
botState.loadPlugin(pathfinder)
const movements = new Movements(botState.mineflayer)
movements.canDig = false
movements.allow1by1towers = false
botState.pathfinder.setMovements(movements)
botState.pathfinder.setGoal(new goals.GoalBlock(x, y, z))
```

## Movements capability status

| Movements option | Status | Notes |
| --- | --- | --- |
| `canDig` | partial | `bot.dig(block, forceLook)` and `bot.canDigBlock(block)` are exposed via the facade (verified by `test/static/mineflayer-compat.test.js`). Pathfinder will issue dig nodes when `canDig: true`; live test against a breakable block in the test world still pending. |
| `allow1by1towers` | unsupported | Requires `placeBlock` semantics not yet wired into the facade. Set `false`. |
| `allowParkour` | supported | Sprint-jump physics validated by the bridged simulator (static tests `sprint_jump_5x`, `walk_jump`, `jump_at_fence`, `jump_over_airborne_wall`) and end-to-end live run of the ladder route with parkour+sprint enabled — no stuck events, all waypoints reached. Gap-jumps over explicit chasms not yet stress-tested (no chasm in test world). |
| `canOpenDoors` | postponed | Upstream `mineflayer-pathfinder` defaults `canOpenDoors = false` ("Causes issues. Probably due to non-paper servers." [movements.js:101](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/d1f4d7fdbebc452f390a9bc8b64e9d8ebfdb9f95/lib/movements.js#L101)) and the path generation is brittle on both Java and Bedrock. Track upstream first; the Bedrock-side `bot.activateBlock` wiring can land alongside any pathfinder-side door fix. |
| `allowSprinting` | supported | Sprint-walk and sprint-jump exercised by static tests and the live route. |
| `allowFreeMotion` | supported | Used by the live demo without observed issues. |
| `allowEntityDetection` | supported | The facade exposes `bot.entities` as an object (Mineflayer shape). |
| `scafoldingBlocks` | unsupported (placement) | Climbing existing scaffolding works (see *Climbing*). Pathfinder's "build a scaffold tower" path is not wired because block placement is gated. |
| `climbables` | supported | Ladders and vines are recognized; the engine's `getClimbableType` handles ascent at the bedrock rates (≈0.20 m/tick for ladders, ≈0.15 m/tick for scaffolding). |
| `liquids` | partial | Swim across water works; sustained pool-exit jumps occasionally need a few extra retries because of the `_bdsSwimCancel` animation crossfade (see *Known limits*). |
| `blocksToAvoid` / `blocksToStayAway` | supported | Plain pathfinder behavior — passes through to the planner. |

## Goal support

| Goal | Status | Notes |
| --- | --- | --- |
| `GoalBlock(x, y, z)` | supported | Verified end-to-end on the multi-ladder + water-pool route. |
| `GoalNear(x, y, z, tol)` | supported | Used for waypoint chaining; tolerance ≥ 3 recommended for stair/ladder transitions where the bot may overshoot vertically. |
| `GoalXZ`, `GoalY`, `GoalGetToBlock`, `GoalLookAtBlock` | untested | No known reason they would fail; all are read-only against bot state. |
| `GoalFollow` | untested | Requires live entity tracking. The facade exposes entity positions and the registry; experimental. |
| `GoalPlaceBlock`, `GoalBreakBlock` | unsupported | Block place/dig is not bridged through the facade yet. |

## Movement primitives

| Primitive | Status | Where it's verified |
| --- | --- | --- |
| Walk forward / strafe | supported | Static tests `walk_forward_30_stop_20`, `walk_diagonal_*`, `strafe_left`, `strafe_right`; shim unit test `simulates forward walking on flat ground`. |
| Walk backward | supported | Static test `walk_backward`. |
| Sprint walk | supported | Static `sprint_forward`; shim test `sprint walking is faster than plain walking`. |
| Sneak walk | supported | Static `sneak_forward`, `sneak_to_edge`; shim test `sneak walking is slower than plain walking`. |
| Jump (single) | supported | Static `walk_jump`, `jump_at_fence`; shim test `produces a single-jump arc on the rising edge`. |
| Sprint-jump (parkour primitive) | supported | Static `sprint_jump_5x`, `sprint_jump_yaw_rotate`; shim test `sprint-jump covers more distance than walk-jump`. |
| Step-up onto a slab / stair | supported | Static `walk_up_stairs`, `step_up_slab`; shim test `steps up onto a slab via stepHeight without jumping`. The engine's `stepHeight=0.6` handles slabs (0.5 high) without a jump press. |
| Horizontal collision | supported | Engine sets `isCollidedHorizontally` correctly; shim test `horizontal collision stops the bot at a wall`. |
| Climb ladder | supported | Static `climb_ladder_jump_off`; shim test `ascends a ladder at the bedrock climb rate`. |
| Climb vine | supported | Static `climb_vine_up`. Same engine path as ladder. |
| Climb scaffolding | supported | Static `jump_off_scaffolding_top`; shim test `ascends scaffolding when jump is held`. |
| Swim across water | supported | Static `swim_forward_submerged`, `swim_diagonal_submerged`, `swim_sprint_forward`; live route swims through the connector pool. |
| Swim up in water | supported | Static `swim_up_in_water`, `swim_up_at_45`; shim test `lets a held jump rise out of water`. |
| Sink in water | supported | Static `sink_in_water` — bit-exact recorded trajectory. |
| Lava buoyancy | supported | Static `lava_swim_up`, `lava_swim_down_*`; shim test `lava buoyancy: held jump in lava rises`. |
| Fall into water | supported | Static `fall_into_water`. |
| Float on water surface | supported | Static `float_on_water_surface`. |
| Walk on ice / blue ice | supported | Static `walk_on_ice`, `walk_on_blue_ice`. |
| Walk on slime / honey | supported | Static `walk_on_slime`, `walk_on_honey`, `jump_on_slime`, `jump_on_honey`. |
| Walk into berry bush / powder snow | supported | Static `walk_into_berry_bush`, `walk_into_powder_snow`. |
| Elytra gliding | partial (engine) / unsupported (pathfinder) | The engine supports `gliding` and firework boost (used by the static elytra recordings), but pathfinder has no concept of gliding goals so the shim is never exercised with `gliding=true`. Bot can manually elytra-fly outside of pathfinder. |
| Effects (speed, slowness, jump boost, levitation) | supported | Static `effect_speed1_walk`, `effect_slowness1_walk`, `effect_jump_boost1`, `effect_levitation1`. Pathfinder doesn't model effects when planning, so heuristics can be off when buffed. |
| Dig blocks | partial | `bot.dig(block)` is wired and unit-tested. Returns a Promise that resolves when the bedrock server confirms the break. Native impl in `src/builtins/dig.js`. |
| Place blocks | unsupported | See `allow1by1towers`. |
| Open doors / use items | postponed | Pathfinder walk-through past a door is **postponed** — upstream's `canOpenDoors` default is `false` with a comment "Causes issues. Probably due to non-paper servers.", so this regression affects Java too. The Bedrock-side `bot.activateBlock` helper can land in a follow-up alongside any upstream fix. |
| Mount / dismount vehicles | unsupported | No vehicle support in the runtime. |

## Known limits

- **`chunk_loaded` resets the path.** Pathfinder calls `resetPath('chunk_loaded')` every time a new chunk arrives during a goal, which is common on Bedrock because subchunks stream in. The runtime tolerates this by re-issuing the goal in the demo `runRoute` helper.
- **`_bdsSwimCancel` can suppress jumps for ~3 ticks during pool exit.** The bedrock engine zeros vertical velocity while the swim→stand animation crossfades. The bot eventually re-jumps, so this manifests as a brief pause rather than a stuck state. A safer relaxation requires animation-state tracking and has been deferred.
- **Float precision drift in long simulations.** Pathfinder simulates up to 200 ticks per `canStraightLine` call. The bedrock engine uses `Math.fround` everywhere, so simulated trajectories track the real engine within a few ULPs over hundreds of ticks but can diverge slightly past that.
- **Pathfinder's `getController` holds `state.control.jump=true` for the entire simulation.** The shim treats this as a single rising edge to match the current `bedrock-physics-engine` + `pai-synth` pipeline, which fires one `StartJumping` bit per real press and gates ground re-jump on that edge. **Known gap vs real BDS:** real Bedrock auto-jumps on landing when the jump button is held; this codebase doesn't model that yet, and re-firing the edge in the shim alone (without fixing the engine + input layer) would make `canWalkJump` validate paths the live bot can't follow. When auto-jump-on-land lands across the runtime, the shim's edge gating should be re-evaluated alongside it.
- **`bot.entity.position` is offset-translated.** The facade returns feet position (Java convention) from the bedrock self's eye position. Plugins that read `bot.entity.position` see the Java semantics; the engine internally uses the bedrock convention.
- **`bot.look(yaw, pitch, force)` interpolates by default.** The bedrock side smooth-interpolates yaw at `yawStepSpeed=180°/s` and snaps when the delta exceeds 60°. This matches pathfinder's expectations in practice; forcing snap on every plugin call broke the live route by causing server-side `correct_player_move_prediction` snap-backs.

## Verifying support changes

When extending pathfinder support, run in this order:

1. `pnpm --dir repos/prismarine-bedrock run test:static` — bit-exact engine recordings (300+ tests) catch any behavior change.
2. `npx mocha test/static/physics/pathfinder-physics-shim.test.js` — shim-specific unit tests for the pathfinder integration surface.

End-to-end live tests against a running BDS server are tracked in a
follow-up PR (`pathfinder-e2e` branch) — they require auto-server
infrastructure and live world setup that intentionally lives outside
this PR's scope.

## Related work

- TASK-22: Initial pathfinder adapter review and physics-tick wiring.
- TASK-27: Real bedrock physics bridge for pathfinder's simulator.
