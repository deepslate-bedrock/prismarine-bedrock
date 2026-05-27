// Real bedrock physics bridged into the prismarine-physics `simulatePlayer`
// shape that mineflayer-pathfinder consumes. Pathfinder calls
// `bot.physics.simulatePlayer(state, world)` ~200 times per planning step
// across `canStraightLine` / `canSprintJump` / `canWalkJump`. With the
// previous heuristic shim, those simulations diverged from the real engine
// (no collisions, no step-up, no sprint/jump physics) which produced
// incorrect "this path is impassable" verdicts.
//
// Design constraints:
//   1. NEVER mutate `botState.self` — pathfinder runs hypotheticals.
//   2. Persist per-state internal flags (_aabb, _prev*Down, inputState) so
//      multi-tick simulations behave like the real per-tick engine.
//   3. Cheap allocation per pathfinder simulation: pathfinder reuses the
//      same `state` object across all 200 ticks of one `simulateUntil`,
//      so we key our synthetic self by that state via WeakMap.

const { Vec3 } = require('vec3')
const { createBedrockPhysicsEngine } = require('./bedrock-physics-engine')
const { javaYawRadiansToBedrockDegrees, radiansToDegrees } = require('../../utils')

// Pathfinder's yaw follows the Java atan2(-dx,-dz) convention (south=0).
// Bedrock degrees count clockwise from south too, but offset by π. The
// existing mineflayer-compat.look() uses the same conversion.
function pathfinderYawToBedrockDegrees (rad) {
  return javaYawRadiansToBedrockDegrees(rad)
}

function makeSyntheticSelf (state, C, liveSelf) {
  const pos = state.pos
  const vel = state.vel || { x: 0, y: 0, z: 0 }
  const yawDeg = pathfinderYawToBedrockDegrees(state.yaw)

  // Inherit slow-moving/persistent fields from the live botState.self so
  // the simulator starts at the same configuration the wire physics
  // tick is in — attributes (movement_speed), effects (speed/jump-boost/
  // slowness/levitation), armor (leather-boots freeze immunity),
  // ground slipperiness, and recent sprint/swim flags. Without this the
  // planner under- or over-estimates speed and `canStraightLine` gives
  // verdicts that don't match what the bot actually does → pathfinder
  // re-plans aggressively under load.
  const attributes = liveSelf?.attributes
    ? { ...liveSelf.attributes }
    : { 'minecraft:movement_speed': { value: 0.1 } }
  if (!attributes['minecraft:movement_speed']) {
    attributes['minecraft:movement_speed'] = { value: 0.1 }
  }

  return {
    // Both pathfinder's state.pos.y and the bedrock engine's self.position.y
    // store the feet y (= bounding box minY). The engine's set/get helpers
    // in physics/position.js use the name "eye" but ultimately treat
    // self.position as feet — see ensureSelfShape, which sets aabb.minY =
    // self.position.y.
    position: new Vec3(pos.x, pos.y, pos.z),
    velocity: new Vec3(vel.x || 0, vel.y || 0, vel.z || 0),
    yaw: yawDeg,
    pitch: radiansToDegrees(state.pitch || 0),
    headYaw: yawDeg,
    onGround: !!state.onGround,
    isInWater: !!state.isInWater,
    isInLava: !!state.isInLava,
    isCollidedHorizontally: !!state.isCollidedHorizontally,
    isCollidedVertically: !!state.isCollidedVertically,
    horizontalCollision: false,
    verticalCollision: !!state.onGround,
    sprinting: !!(state.control?.sprint || liveSelf?.sprinting),
    sneaking: !!(state.control?.sneak || liveSelf?.sneaking),
    swimming: !!liveSelf?.swimming,
    gliding: !!liveSelf?.gliding,
    height: C.PLAYER_HEIGHT,
    width: C.PLAYER_WIDTH,
    halfWidth: C.PLAYER_WIDTH / 2,
    eyeHeight: C.EYE_HEIGHT,
    groundSlipperiness: liveSelf?.groundSlipperiness ?? C.DEFAULT_SLIPPERINESS,
    attributes,
    effects: liveSelf?.effects ? { ...liveSelf.effects } : {},
    armor: liveSelf?.armor ? { ...liveSelf.armor } : {},
    inputState: {
      prevButtons: {
        forward: false, back: false, left: false, right: false,
        sprint: false,
        jump: { current: false },
        sneak: { current: false }
      }
    },
    // The engine's first ensureSelfShape() call will build _aabb from
    // position because _aabb is missing; subsequent ticks keep it stable
    // unless the controller jumps `position` externally.
    _aabb: null,
    _flagSneaking: !!state.control?.sneak,
    _flagSprintingPrev: !!(state.control?.sprint || liveSelf?.sprinting),
    _prevSneakDown: !!state.control?.sneak,
    _prevSprintDown: !!state.control?.sprint,
    _prevJumpDown: !!state.control?.jump,
    _sprintActive: !!liveSelf?.sprinting,
    _sprintForSpeed: !!liveSelf?.sprinting,
    _ticksFrozen: liveSelf?._ticksFrozen | 0,
    _freezeRatio: Number(liveSelf?._freezeRatio) || 0
  }
}

// Re-sync state → synSelf each tick. The engine owns position across ticks
// (it tracks AABB anchors internally), but when the controller warps
// state.pos externally (e.g. canStraightLineBetween resets pos to a node),
// we copy the new pos in. ensureSelfShape then detects the divergence
// via its `externallyMoved` check (comparing position to _aabbAnchorX/Y/Z)
// and rebuilds _aabb on the next simulate() call.
function applyStateToSelf (state, synSelf) {
  const dx = state.pos.x - synSelf.position.x
  const dy = state.pos.y - synSelf.position.y
  const dz = state.pos.z - synSelf.position.z

  if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6 || Math.abs(dz) > 1e-6) {
    synSelf.position.set(state.pos.x, state.pos.y, state.pos.z)
    if (state.vel) synSelf.velocity.set(state.vel.x || 0, state.vel.y || 0, state.vel.z || 0)
  }

  synSelf.yaw = pathfinderYawToBedrockDegrees(state.yaw)
  synSelf.headYaw = synSelf.yaw
  synSelf.pitch = radiansToDegrees(state.pitch || 0)
  synSelf.onGround = !!state.onGround
}

function applySelfToState (synSelf, state) {
  state.pos.x = synSelf.position.x
  state.pos.y = synSelf.position.y
  state.pos.z = synSelf.position.z
  if (state.vel) {
    state.vel.x = synSelf.velocity.x
    state.vel.y = synSelf.velocity.y
    state.vel.z = synSelf.velocity.z
  }
  state.onGround = !!synSelf.onGround
  state.isCollidedHorizontally = !!synSelf.horizontalCollision
  state.isCollidedVertically = !!synSelf.verticalCollision
  state.isInWater = !!synSelf.isInWater
  state.isInLava = !!synSelf.isInLava
}

function mapControls (state) {
  const c = state.control || {}
  return {
    forward: !!c.forward,
    back: !!c.back,
    left: !!c.left,
    right: !!c.right,
    jumpDown: !!c.jump,
    sneakDown: !!c.sneak,
    sprintDown: !!c.sprint,
    swimDown: !!c.swim
  }
}

// Cap on the per-state block-lookup cache. ~4k entries comfortably covers
// a 200-tick canStraightLine traversal: ~10-15 distinct blocks per tick
// × 200 ticks shares heavily because pathfinder re-walks the same path
// many times under different control regimes.
const BLOCK_CACHE_MAX = 4096

function blockKey (pos) {
  // 3D spatial hash — integer block coords. Stable across planning sessions
  // because we invalidate on update_block events.
  return ((pos.x | 0) * 73856093) ^ ((pos.y | 0) * 19349663) ^ ((pos.z | 0) * 83492791)
}

// Wrap a world adapter with a two-tier memoized getBlock. The state-level
// Map catches every lookup within one canStraightLine episode (200 ticks
// against the same PlayerState). The shim-level Map persists across
// planning sessions so rapid re-targeting doesn't cold-start the cache.
// Without this caching the engine's raw lookup count (~50/tick × 200 ticks
// × N planning questions) dominates planning latency and starves the
// viewer render loop — what shows up as "viewer slow after motion".
function withTwoTierBlockCache (world, stateCache, shimCache) {
  if (!world || typeof world.getBlock !== 'function') return world
  return {
    getBlock (pos) {
      const k = blockKey(pos)
      let block = stateCache.get(k)
      if (block !== undefined) return block
      block = shimCache.get(k)
      if (block !== undefined) {
        if (stateCache.size < BLOCK_CACHE_MAX) stateCache.set(k, block)
        return block
      }
      block = world.getBlock(pos)
      if (stateCache.size < BLOCK_CACHE_MAX) stateCache.set(k, block)
      if (shimCache.size < BLOCK_CACHE_MAX) shimCache.set(k, block)
      return block
    },
    sync: world.sync
  }
}

function createPathfinderPhysicsShim (botState, C) {
  const engine = createBedrockPhysicsEngine({ stepHeight: 0.6 })
  const selfByState = new WeakMap()
  // Two-tier block cache:
  //   - shimLevel: persists across planning sessions for this shim instance.
  //     Helps the "user keeps clicking new goals around the same area"
  //     case where each new PlayerState would otherwise cold-start a
  //     per-state cache. Invalidated wholesale on `update_block` /
  //     `update_subchunk_blocks` events when those bridges fire.
  //   - per-state: scoped to one canStraightLine episode, layered on
  //     top, so a sequence of 200 simulator ticks for the same state
  //     never repeats a lookup.
  const shimBlockCache = new Map()
  const blockCacheByState = new WeakMap()

  // Listen for world updates so the shim-level cache doesn't go stale.
  // Bridges are best-effort: if botState doesn't expose them, the cache
  // is still safe — it just trades stale-data risk against re-warm cost.
  if (typeof botState?.on === 'function') {
    const flush = () => shimBlockCache.clear()
    botState.on('update_block', flush)
    botState.on('update_subchunk_blocks', flush)
    botState.on('blockUpdate', flush) // Mineflayer-shaped alias
  }

  // Cache the previous jump-press state per `state` so jumpPressed (edge
  // trigger) fires once on transition from false→true. Pathfinder's
  // controller holds state.control.jump = true for the full 20-tick
  // simulation, so without this gating the engine would re-fire on every
  // tick.
  //
  // KNOWN GAP vs real BDS: when the player holds jump on real Bedrock,
  // the client re-presses each time the player lands (auto-jump-on-land).
  // This codebase doesn't model that today — pai-synth's
  // `jump.pressed = curr && !prev` produces exactly one StartJumping
  // bit per real press, and the engine gates ground re-jump on
  // `jumpPressed && _noJumpDelay===0`. Mirroring the engine's current
  // single-edge behavior here keeps the simulator's verdict consistent
  // with what the live bot actually does. Re-firing on landing in the
  // shim alone (without also fixing pai-synth + the engine) would make
  // canWalkJump validate paths the live bot can't follow. If/when
  // auto-jump-on-land lands in the engine + input layer, this edge
  // gating should be re-evaluated together with that change.
  const prevJumpByState = new WeakMap()

  return {
    simulatePlayer (state, world) {
      if (!state?.pos || !world) return state

      let synSelf = selfByState.get(state)
      if (!synSelf) {
        // Inherit attributes/effects/armor/sprint from the live bot so
        // the simulator starts in the same configuration the wire physics
        // is in — buffs, slipperiness, recent sprint state all carry over.
        synSelf = makeSyntheticSelf(state, C, botState?.self)
        selfByState.set(state, synSelf)
      } else {
        applyStateToSelf(state, synSelf)
      }

      const controls = mapControls(state)
      const prevJump = prevJumpByState.get(state) === true
      controls.jumpPressed = controls.jumpDown && !prevJump
      controls.jumpPressedRaw = controls.jumpPressed
      // Note: prevJumpByState.set is deferred until after a successful
      // engine.simulateSelf call so a thrown simulator (returning early
      // below) doesn't poison the next tick's edge detection.
      controls.jumpReleasedRaw = !controls.jumpDown && prevJump

      // Two-tier block cache wiring. Per-state cache catches every
      // lookup within one canStraightLine episode (200 ticks against
      // the same PlayerState). On miss it falls through to the shim-
      // level cache that persists across planning sessions, so rapid
      // re-targeting in the same area (e.g., user clicking around the
      // viewer) doesn't re-cold-start the cache on every new goal.
      let stateCache = blockCacheByState.get(state)
      if (!stateCache) {
        stateCache = new Map()
        blockCacheByState.set(state, stateCache)
      }
      const cachedWorld = withTwoTierBlockCache(world, stateCache, shimBlockCache)
      const synBotState = { self: synSelf, world: cachedWorld }
      try {
        engine.simulateSelf(synBotState, controls, cachedWorld, C)
      } catch (err) {
        return state
      }

      // Snap-into-position write of consumed jump press happens here so
      // the per-state edge is consistent with what the engine actually
      // saw this tick.
      prevJumpByState.set(state, controls.jumpDown)
      applySelfToState(synSelf, state)
      return state
    }
  }
}

module.exports = { createPathfinderPhysicsShim }
