'use strict'

const assert = require('assert')
const { Vec3 } = require('vec3')
const { createPathfinderPhysicsShim } = require('../../../src/builtins/physics/pathfinder-physics-shim')
const { getConstants } = require('../../../src/builtins/physics-constants')

const C = getConstants('1.21.111')

const STONE_SHAPE = [[0, 0, 0, 1, 1, 1]]
const AIR = { name: 'air', boundingBox: 'empty', shapes: [] }

function blockAt (name, shapes = STONE_SHAPE) {
  return { name, boundingBox: 'block', shapes }
}

function flatWorld (floorY = 63, floorName = 'stone') {
  return {
    getBlock (p) {
      if (p.y <= floorY) return blockAt(floorName)
      return AIR
    }
  }
}

function ladderWorld (floorY = 63, ladderColumn = { x: 0, z: 0 }, ladderFromY = floorY + 1, ladderToY = floorY + 5) {
  return {
    getBlock (p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if (y <= floorY) return blockAt('stone')
      if (x === ladderColumn.x && z === ladderColumn.z && y >= ladderFromY && y <= ladderToY) {
        return { name: 'ladder', boundingBox: 'empty', shapes: [] }
      }
      return AIR
    }
  }
}

function scaffoldWorld (floorY = 63, col = { x: 0, z: 0 }, fromY = floorY + 1, toY = floorY + 5) {
  return {
    getBlock (p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if (y <= floorY) return blockAt('stone')
      if (x === col.x && z === col.z && y >= fromY && y <= toY) {
        return { name: 'scaffolding', boundingBox: 'empty', shapes: [] }
      }
      return AIR
    }
  }
}

function waterWorld (floorY = 63, surfaceY = floorY + 2) {
  return {
    getBlock (p) {
      const y = Math.floor(p.y)
      if (y <= floorY) return blockAt('stone')
      if (y <= surfaceY) return { name: 'water', boundingBox: 'empty', shapes: [] }
      return AIR
    }
  }
}

function makeState (overrides = {}) {
  return {
    pos: overrides.pos || new Vec3(0.5, 64, 0.5),
    vel: overrides.vel || new Vec3(0, 0, 0),
    yaw: overrides.yaw ?? Math.PI,
    pitch: overrides.pitch ?? 0,
    onGround: overrides.onGround ?? true,
    isInWater: overrides.isInWater ?? false,
    isInLava: overrides.isInLava ?? false,
    control: Object.assign(
      { forward: false, back: false, left: false, right: false, jump: false, sneak: false, sprint: false, swim: false },
      overrides.control || {}
    )
  }
}

describe('pathfinder physics shim', function () {
  it('simulates forward walking on flat ground', function () {
    const world = flatWorld()
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const state = makeState({ control: { forward: true } })
    for (let i = 0; i < 20; i++) shim.simulatePlayer(state, world)
    assert.ok(state.pos.z > 3, `expected z > 3 after 20 ticks of walking south, got ${state.pos.z}`)
    assert.strictEqual(state.onGround, true, 'walking on flat ground should keep onGround true')
    assert.strictEqual(state.pos.y, 64, 'walking on flat ground should not change y')
  })

  it('produces a single-jump arc on the rising edge', function () {
    const world = flatWorld()
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const state = makeState({ control: { jump: true } })
    let peakY = state.pos.y
    for (let i = 0; i < 20; i++) {
      shim.simulatePlayer(state, world)
      if (state.pos.y > peakY) peakY = state.pos.y
    }
    assert.ok(peakY > 65 && peakY < 66, `jump peak should be ~1.25 above start, got ${peakY}`)
    assert.strictEqual(state.onGround, true, 'should land back on ground within 20 ticks')
    assert.strictEqual(state.pos.y, 64, 'should land back at the starting feet y')
  })

  it('does not mutate botState.self across many simulations', function () {
    const world = flatWorld()
    const liveSelf = {
      position: new Vec3(999, 100, 999),
      velocity: new Vec3(1, 2, 3),
      yaw: 42, pitch: 7, onGround: false,
      _aabb: { minX: 1, minY: 2, minZ: 1, maxX: 3, maxY: 4, maxZ: 3 },
      _prevJumpDown: true,
      inputState: { prevButtons: { jump: { current: true } } }
    }
    const before = JSON.stringify(liveSelf, (k, v) => (typeof v === 'bigint' ? v.toString() : v))
    const shim = createPathfinderPhysicsShim({ self: liveSelf, world }, C)
    const state = makeState({ control: { forward: true, jump: true } })
    for (let i = 0; i < 50; i++) shim.simulatePlayer(state, world)
    const after = JSON.stringify(liveSelf, (k, v) => (typeof v === 'bigint' ? v.toString() : v))
    assert.strictEqual(after, before, 'botState.self must be untouched by the shim')
  })

  it('isolates two simultaneous pathfinder states', function () {
    const world = flatWorld()
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const a = makeState({ pos: new Vec3(0.5, 64, 0.5), yaw: Math.PI, control: { forward: true } })
    const b = makeState({ pos: new Vec3(5.5, 64, 5.5), yaw: 0, control: { forward: true } })
    for (let i = 0; i < 30; i++) { shim.simulatePlayer(a, world); shim.simulatePlayer(b, world) }
    assert.ok(a.pos.z > 4, `state A (yaw=PI) should walk +z, got pos.z=${a.pos.z}`)
    assert.ok(b.pos.z < 1, `state B (yaw=0) should walk -z, got pos.z=${b.pos.z}`)
    assert.notStrictEqual(a.pos.z.toFixed(3), b.pos.z.toFixed(3), 'states must not share position')
  })

  it('re-anchors AABB when the controller warps state.pos', function () {
    const world = flatWorld()
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const state = makeState({ control: { forward: true } })
    for (let i = 0; i < 10; i++) shim.simulatePlayer(state, world)
    const driftedZ = state.pos.z
    // canStraightLineBetween-style warp: jump pos to a different start node.
    state.pos.x = 10
    state.pos.y = 64
    state.pos.z = 10
    state.vel.set(0, 0, 0)
    state.onGround = true
    for (let i = 0; i < 10; i++) shim.simulatePlayer(state, world)
    assert.ok(state.pos.z > 10, `should walk forward from the warped pos, got z=${state.pos.z}`)
    assert.notStrictEqual(state.pos.z, driftedZ, 'engine must re-anchor instead of resuming the old trajectory')
  })

  it('ascends a ladder at the bedrock climb rate', function () {
    const world = ladderWorld(63, { x: 0, z: 0 }, 64, 70)
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const state = makeState({ pos: new Vec3(0.5, 64, 0.5), control: { jump: true } })
    const startY = state.pos.y
    for (let i = 0; i < 15; i++) shim.simulatePlayer(state, world)
    assert.ok(state.pos.y - startY >= 1.5, `ladder climb should raise y by at least 1.5 in 15 ticks, got ${state.pos.y - startY}`)
  })

  it('ascends scaffolding when jump is held', function () {
    const world = scaffoldWorld(63, { x: 0, z: 0 }, 64, 70)
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const state = makeState({ pos: new Vec3(0.5, 64, 0.5), control: { jump: true } })
    const startY = state.pos.y
    for (let i = 0; i < 15; i++) shim.simulatePlayer(state, world)
    assert.ok(state.pos.y - startY >= 1.2, `scaffolding climb should raise y by at least 1.2 in 15 ticks, got ${state.pos.y - startY}`)
  })

  it('lets a held jump rise out of water (regression for _bdsSwimCancel)', function () {
    const world = waterWorld(63, 66)
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    // Bot starts with feet just under the water surface, holding jump.
    const state = makeState({ pos: new Vec3(0.5, 65, 0.5), onGround: false, isInWater: true, control: { jump: true } })
    for (let i = 0; i < 40; i++) shim.simulatePlayer(state, world)
    assert.ok(state.pos.y > 65.5, `sustained jump in water should raise y above start, got ${state.pos.y}`)
  })

  it('control flags map: forward/back/left/right reach the engine', function () {
    const world = flatWorld()
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const left = makeState({ control: { left: true } })
    const right = makeState({ control: { right: true } })
    for (let i = 0; i < 20; i++) { shim.simulatePlayer(left, world); shim.simulatePlayer(right, world) }
    assert.notStrictEqual(left.pos.x.toFixed(3), right.pos.x.toFixed(3), 'left vs right should produce opposite x drift')
  })

  it('sprint walking is faster than plain walking', function () {
    const world = flatWorld()
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const walk = makeState({ control: { forward: true } })
    const sprint = makeState({ control: { forward: true, sprint: true } })
    for (let i = 0; i < 30; i++) { shim.simulatePlayer(walk, world); shim.simulatePlayer(sprint, world) }
    assert.ok(sprint.pos.z > walk.pos.z + 0.5, `sprint (z=${sprint.pos.z.toFixed(2)}) should outpace walk (z=${walk.pos.z.toFixed(2)})`)
  })

  it('sneak walking is slower than plain walking', function () {
    const world = flatWorld()
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const walk = makeState({ control: { forward: true } })
    const sneak = makeState({ control: { forward: true, sneak: true } })
    for (let i = 0; i < 30; i++) { shim.simulatePlayer(walk, world); shim.simulatePlayer(sneak, world) }
    assert.ok(sneak.pos.z < walk.pos.z, `sneak (z=${sneak.pos.z.toFixed(2)}) should lag walk (z=${walk.pos.z.toFixed(2)})`)
  })

  it('steps up onto a slab via stepHeight without jumping', function () {
    // World: floor at y=63, with a single full block at (5, 64, 0.5).
    const world = {
      getBlock (p) {
        if (p.y <= 63) return blockAt('stone')
        if (Math.floor(p.x) === 5 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0) return blockAt('stone', [[0, 0, 0, 1, 0.5, 1]])
        return AIR
      }
    }
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    // Java yaw atan2(-dx,-dz) convention: yaw=-π/2 faces +x.
    const state = makeState({ pos: new Vec3(0.5, 64, 0.5), yaw: -Math.PI / 2, control: { forward: true } })
    let maxY = state.pos.y
    for (let i = 0; i < 60; i++) {
      shim.simulatePlayer(state, world)
      if (state.pos.y > maxY) maxY = state.pos.y
    }
    assert.ok(state.pos.x > 4, `should walk to the slab, got x=${state.pos.x.toFixed(2)}`)
    assert.ok(maxY >= 64.4, `should step up onto the 0.5-high slab, got max y=${maxY.toFixed(3)}`)
  })

  it('sprint-jump covers more distance than walk-jump (parkour primitive)', function () {
    const world = flatWorld()
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const walkJump = makeState({ control: { forward: true, jump: true } })
    const sprintJump = makeState({ control: { forward: true, jump: true, sprint: true } })
    for (let i = 0; i < 20; i++) { shim.simulatePlayer(walkJump, world); shim.simulatePlayer(sprintJump, world) }
    assert.ok(sprintJump.pos.z > walkJump.pos.z + 0.5, `sprint-jump (z=${sprintJump.pos.z.toFixed(2)}) should travel further than walk-jump (z=${walkJump.pos.z.toFixed(2)})`)
  })

  it('horizontal collision stops the bot at a wall', function () {
    // Wall block at (0, 64, 3) — bot starts at (0.5, 64, 0.5) walking +z toward it.
    const world = {
      getBlock (p) {
        if (p.y <= 63) return blockAt('stone')
        if (Math.floor(p.x) === 0 && Math.floor(p.y) === 64 && Math.floor(p.z) === 3) return blockAt('stone')
        return AIR
      }
    }
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const state = makeState({ pos: new Vec3(0.5, 64, 0.5), yaw: Math.PI, control: { forward: true } })
    for (let i = 0; i < 60; i++) shim.simulatePlayer(state, world)
    assert.ok(state.pos.z < 3, `should not pass through wall block at z=3, got z=${state.pos.z.toFixed(3)}`)
    assert.ok(state.isCollidedHorizontally, 'isCollidedHorizontally should be true when pressed against a wall')
  })

  it('lava buoyancy: held jump in lava rises (slowly)', function () {
    // World: stone at y<=63, lava y=64..68, air above.
    const world = {
      getBlock (p) {
        const y = Math.floor(p.y)
        if (y <= 63) return blockAt('stone')
        if (y <= 68) return { name: 'lava', boundingBox: 'empty', shapes: [] }
        return AIR
      }
    }
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const state = makeState({ pos: new Vec3(0.5, 64, 0.5), onGround: false, isInLava: true, control: { jump: true } })
    const startY = state.pos.y
    for (let i = 0; i < 30; i++) shim.simulatePlayer(state, world)
    assert.ok(state.pos.y > startY, `lava buoyancy should raise the bot, got y=${state.pos.y.toFixed(3)} from start ${startY}`)
  })

  it('shares block-lookup cache across the same pathfinder state', function () {
    // Pathfinder reuses one PlayerState across the 200 ticks of a
    // simulateUntil. Standing still on flat terrain, every tick reads
    // the same handful of neighbor blocks. With the per-state cache,
    // the world's getBlock should be hit only on the first few ticks
    // and then approach zero new lookups while the bot stays in the
    // same chunk.
    let calls = 0
    const counting = {
      getBlock () {
        calls++
        return AIR // doesn't matter; we count, not validate motion
      }
    }
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const state = makeState({ control: {} }) // no motion: same neighbors every tick
    // Warm the cache.
    shim.simulatePlayer(state, counting)
    const afterFirst = calls
    // 30 more ticks against the same state — every neighbor should hit
    // the cache; few or zero new world reads expected.
    for (let i = 0; i < 30; i++) shim.simulatePlayer(state, counting)
    const after31 = calls
    const newLookups = after31 - afterFirst
    assert.ok(afterFirst > 0, 'first tick should hit the world')
    assert.ok(newLookups < afterFirst * 0.5,
      `subsequent 30 ticks against same state should mostly hit cache: ` +
      `first=${afterFirst}, next-30-new=${newLookups}`)
  })

  it('inherits attributes/effects/sprint from live botState.self', function () {
    const world = flatWorld()
    // Live bot has a speed buff that the planner needs to see, otherwise
    // canStraightLine under-estimates how far the bot can walk per tick.
    const liveSelf = {
      attributes: { 'minecraft:movement_speed': { value: 0.2 } },
      effects: { 1: { amplifier: 0 } }, // speed I
      armor: {},
      sprinting: true,
      groundSlipperiness: 0.6
    }
    const buffedShim = createPathfinderPhysicsShim({ self: liveSelf }, C)
    const baselineShim = createPathfinderPhysicsShim({ self: null }, C)
    const buffedState = makeState({ control: { forward: true } })
    const baselineState = makeState({ control: { forward: true } })
    for (let i = 0; i < 30; i++) {
      buffedShim.simulatePlayer(buffedState, world)
      baselineShim.simulatePlayer(baselineState, world)
    }
    assert.ok(buffedState.pos.z > baselineState.pos.z + 0.3,
      `buffed bot should walk further: buffed=${buffedState.pos.z.toFixed(2)} baseline=${baselineState.pos.z.toFixed(2)}`)
  })

  it('preview-world scenario: bot in ladder column pushing into wall ascends', function () {
    // Mirrors the preview test world's ladder1 column geometry:
    //   - Stone wall at x=6 from y=64..67 (4 blocks tall).
    //   - Ladder block on the -x face of the wall (x=5, y=64..67),
    //     occupying the same column the bot stands in.
    //   - Floor at y=63 everywhere.
    // Bot is placed in the ladder column at the base, facing +x into
    // the wall. The engine's climbViaInput predicate fires when
    // `input.x/z !== 0 && self.horizontalCollision`, which is what
    // happens when the player pushes into the wall behind the ladder —
    // this is the actual "user holds W facing the ladder" gameplay.
    const WALL_X = 6
    const LADDER_X = 5
    const COL_Z = 0
    const TOP_Y = 67
    const FLOOR_Y = 63
    const world = {
      getBlock (p) {
        const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
        if (y <= FLOOR_Y) return blockAt('stone')
        if (x === WALL_X && z === COL_Z && y >= FLOOR_Y + 1 && y <= TOP_Y) return blockAt('stone')
        if (x === LADDER_X && z === COL_Z && y >= FLOOR_Y + 1 && y <= TOP_Y) {
          return { name: 'ladder', boundingBox: 'empty', shapes: [] }
        }
        return AIR
      }
    }
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const state = makeState({
      pos: new Vec3(LADDER_X + 0.5, FLOOR_Y + 1, COL_Z + 0.5),
      // Java atan2 yaw: -π/2 faces +x (into the wall behind the ladder).
      yaw: -Math.PI / 2,
      control: { forward: true, jump: true }
    })

    const startY = state.pos.y
    let topReached = false
    for (let i = 0; i < 60; i++) {
      shim.simulatePlayer(state, world)
      if (state.pos.y >= TOP_Y) { topReached = true; break }
    }
    assert.ok(topReached,
      `bot should ascend ladder while pushing into wall; ` +
      `start=${startY.toFixed(2)} end=${state.pos.y.toFixed(2)} target=${TOP_Y}`)
  })

  it('replays a multi-node path: walks each segment, reaches the end', function () {
    // Build a flat-floor world and a 4-node straight path. Drive the
    // shim the way pathfinder's controller does (forward + yaw toward
    // next node) and assert each waypoint is reached without the bot
    // getting stuck mid-segment. This catches "shim loses state across
    // simulateUntil ticks" regressions that the simpler walk-forward
    // test would miss.
    const world = flatWorld(63)
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const state = makeState({
      pos: new Vec3(0.5, 64, 0.5),
      control: { forward: true }
    })
    const path = [
      new Vec3(0.5, 64, 3.5),
      new Vec3(0.5, 64, 6.5),
      new Vec3(0.5, 64, 9.5)
    ]
    let reachedCount = 0
    for (const target of path) {
      let ticks = 0
      while (ticks < 200) {
        const dx = target.x - state.pos.x
        const dz = target.z - state.pos.z
        if (Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35) { reachedCount++; break }
        state.yaw = Math.atan2(-dx, -dz)
        shim.simulatePlayer(state, world)
        ticks++
      }
      assert.ok(ticks < 200, `path node (${target.x},${target.y},${target.z}) reached within 200 ticks`)
    }
    assert.strictEqual(reachedCount, path.length, `expected to reach all ${path.length} nodes; reached ${reachedCount}`)
  })

  it('survives engine errors without poisoning the state', function () {
    // World that throws every other getBlock call — engine will encounter
    // missing data and may throw internally.
    let calls = 0
    const flaky = {
      getBlock (p) {
        if ((++calls) % 7 === 0) throw new Error('synthetic flake')
        return p.y <= 63 ? blockAt('stone') : AIR
      }
    }
    const shim = createPathfinderPhysicsShim({ self: null }, C)
    const state = makeState({ control: { forward: true } })
    let lastValidZ = state.pos.z
    for (let i = 0; i < 20; i++) {
      shim.simulatePlayer(state, flaky)
      assert.ok(Number.isFinite(state.pos.z), 'state.pos.z must remain finite even if engine throws')
      lastValidZ = state.pos.z
    }
    assert.ok(lastValidZ >= 0, `state should remain in a usable range, got z=${lastValidZ}`)
  })
})
