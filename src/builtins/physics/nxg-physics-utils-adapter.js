// physics/nxg-physics-utils-adapter.js
//
// Refactored adapter for @nxg-org/mineflayer-physics-util
// Generic packet state is handled in entities.js. This adapter only keeps
// local movement/session state that is specific to the bot.
//
// Bedrock protocol specific:
// - Attribute name mapping: 'movement' → 'minecraft:movement_speed'
// - Effects by ID using the protocol constants
// - Abilities from update_abilities packet (including flySpeed, walkSpeed)
// - World settings tuned for Bedrock (defaultSlipperiness 0.6, etc.)
//
// The active export is installBedrockMovementStateHandlers(botState, options).
// createNxgPhysicsAdapter is kept only as a fail-fast legacy export.

const { Vec3 } = require('vec3');
const mcDataLoader = require('minecraft-data');
const {
  applyAttributes,
  ensureEntityState
} = require('../../entity-metadata');
const {
  degreesToRadians,
  normalizePhysicsGameMode,
  normalizePhysicsPose,
  safeJson,
  toBigIntSafe
} = require('../../utils');

const {
  BotcraftPhysics,
  PlayerState,
  EPhysicsCtx,
  ControlStateHandler,
  PlayerPoses,
} = require('@nxg-org/mineflayer-physics-util');

const { convInpToAxes } = require('@nxg-org/mineflayer-physics-util/dist/physics/states/playerState')
const SelfEntityProxy = require('./self-entity-proxy')

// ===================================================================
// Logger helper (same as original)
// ===================================================================
const DEFAULT_LOG_PREFIX = '[bedrock-physics-adapter]';

function createLogger(options = {}) {
  const enabled =
    options.debugBedrockPhysicsAdapter === true ||
    options.debugMovementPackets === true ||
    process.env.DEBUG_BEDROCK_PHYSICS_ADAPTER === 'true' ||
    process.env.DEBUG_PHYSICS_ADAPTER === 'true' ||
    process.env.DEBUG_PHYSICS === 'true';

  const prefix = options.debugPrefix || DEFAULT_LOG_PREFIX;

  if (!enabled) return noop;

  return function log(event, data) {
    if (data === undefined) {
      console.log(prefix, event);
      return;
    }
    console.log(prefix, event, safeJson(data, data, 2));
  };
}

function noop() {}

function stringifyBigInt(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && value.x !== undefined && value.y !== undefined && value.z !== undefined) {
    return { x: value.x, y: value.y, z: value.z };
  }
  return value;
}

function compactVec(value) {
  if (!value) return null;
  return {
    x: Number(value.x),
    y: Number(value.y),
    z: Number(value.z)
  };
}

function debugNxgState(phase, data) {
  if (process.env.BEDROCK_DEBUG_NXG_STATE !== '1') return;
  console.log('[nxg-state]', phase, JSON.stringify(data, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  ));
}

// ===================================================================
// Attribute name mapping from Bedrock packet names to engine keys
// ===================================================================
const BEDROCK_ATTR_MAP = {
  'movement': 'minecraft:movement_speed',
  'movement_speed': 'minecraft:movement_speed',
  'minecraft:movement': 'minecraft:movement_speed',
  'minecraft:movement_speed': 'minecraft:movement_speed', // passthrough
  'jump_strength': 'minecraft:jump_strength',
  'step_height': 'minecraft:step_height',
  'water_movement_efficiency': 'minecraft:water_movement_efficiency',
  'underwater_movement': 'minecraft:underwater_movement',
  'minecraft:jump_strength': 'minecraft:jump_strength',
  'minecraft:step_height': 'minecraft:step_height',
  'minecraft:water_movement_efficiency': 'minecraft:water_movement_efficiency',
  'minecraft:underwater_movement': 'minecraft:underwater_movement',
};

function mapBedrockAttributeName(rawName) {
  return BEDROCK_ATTR_MAP[rawName] || rawName;
}

// ===================================================================
// World settings tuned for the current Bedrock protocol target.
// ===================================================================
const BEDROCK_WORLD_SETTINGS = {
  playerSpeed: 0.1,
  sprintSpeed: 0.3,
  defaultSlipperiness: 0.6,
  soulsandSpeed: 0.4,
  honeyblockSpeed: 0.5,
  honeyblockJumpSpeed: 0.5,
  ladderMaxSpeed: 0.15,
  ladderClimbSpeed: 0.2,
  sneakSpeed: 0.3,
  autojumpCooldown: 10,
  usingItemSpeed: 0.2,
  outOfLiquidImpulse: 0.3,
  negligibleVelocity: 1e-5,
  slowFalling: 0.01,
  bubbleColumnSurfaceDrag: { maxDown: -0.3, down: 0.03, maxUp: 0.7, up: 0.06 },
  bubbleColumnDrag: { maxDown: -0.3, down: 0.03, maxUp: 0.7, up: 0.06 },
  flyJumpTriggerCooldown: 0,
  sprintTimeTriggerCooldown: 0,
  sprintingUUID: '662a6b8d-da3e-4c1c-8813-96ea6097278d',
};

// ===================================================================
// Effect ID → name mapping (Bedrock protocol constants)
// ===================================================================
const BEDROCK_EFFECT_NAMES = {
  1: 'speed',
  2: 'slowness',
  3: 'haste',
  4: 'miningFatigue',
  5: 'strength',
  6: 'instantHealth',
  7: 'instantDamage',
  8: 'jumpBoost',
  9: 'nausea',
  10: 'regeneration',
  11: 'resistance',
  12: 'fireResistance',
  13: 'waterBreathing',
  14: 'invisibility',
  15: 'blindness',
  16: 'nightVision',
  17: 'hunger',
  18: 'weakness',
  19: 'poison',
  20: 'wither',
  21: 'healthBoost',
  22: 'absorption',
  23: 'saturation',
  24: 'glowing',
  25: 'levitation',
  26: 'luck',
  27: 'unluck',
  28: 'slowFalling',
  29: 'conduitPower',
  30: 'dolphinsGrace',
  31: 'badOmen',
  32: 'heroOfTheVillage',
};

// Effect ID → state key for convenience
const BEDROCK_EFFECT_TO_STATE_KEY = {
  1: 'speed',
  2: 'slowness',
  8: 'jumpBoost',
  15: 'blindness',
  25: 'levitation',
  28: 'slowFalling',
  30: 'dolphinsGrace',
};


// ===================================================================
// Helper: ensure attribute object shape {value, min, max, default, modifiers}
// ===================================================================
function ensureAttributeShape(attributes) {
  for (const key of Object.keys(attributes)) {
    let attr = attributes[key];
    if (attr == null) {
      delete attributes[key];
      continue;
    }
    if (typeof attr === 'number') {
      attributes[key] = { value: attr, min: 0, max: 1024, default: attr, modifiers: [] };
    } else if (typeof attr === 'object' && !Array.isArray(attr)) {
      if (typeof attr.value !== 'number') {
        attr.value = Number(attr.value ?? attr.current ?? attr.default ?? 0.1);
      }
      if (typeof attr.min !== 'number') attr.min = 0;
      if (typeof attr.max !== 'number') attr.max = 1024;
      if (typeof attr.default !== 'number') attr.default = attr.value;
      if (!Array.isArray(attr.modifiers)) attr.modifiers = [];
    }
  }
}

// ===================================================================
// Normalize game mode string
// ===================================================================
const normalizeGameMode = normalizePhysicsGameMode;

// ===================================================================
// Normalize pose
// ===================================================================
function normalizePose(pose) {
  return normalizePhysicsPose(pose, PlayerPoses);
}

function bedrockYawToNxgYaw(yawDegrees) {
  // BotcraftPhysics uses Mineflayer-style radians and rotates with
  // `Math.PI - yaw`; Bedrock packets store yaw directly in degrees.
  return Math.PI - degreesToRadians(yawDegrees);
}

// ===================================================================
// Create the physics adapter
// ===================================================================
function createNxgPhysicsAdapter(options = {}) {
  const dataVersion = options.physicsDataVersion || '1.21.1';
  const mcData = options.mcData || mcDataLoader(dataVersion);

  // Load engine's static data
  EPhysicsCtx.loadData(mcData);

  // Instantiate BotcraftPhysics
  const engine = new BotcraftPhysics(mcData);

  // Find player entity type
  const playerEntityType =
    mcData.entitiesByName?.player ||
    mcData.entitiesByName?.Player ||
    Object.values(mcData.entitiesByName || {}).find((entity) => entity.name === 'player');

  if (!playerEntityType) {
    throw new Error(`[physics] Could not find player entity data in minecraft-data ${dataVersion}`);
  }

  /**
   * Simulate one tick for the self entity.
   *
   * @param {object} botState - the full BotState instance (must have botState.self set)
   * @param {object} controls - { forward: bool, back: bool, left: bool, right: bool, jump: bool, sprint: bool, sneak: bool }
   * @param {object} world - world object with getBlock method
   * @param {object} [simOptions] - optional overrides (e.g., worldSettings)
   * @returns {object} the simulated state with position, velocity, onGround, horizontalCollision, etc. applied to self
   */
  function simulateSelf(botState, controls, world, simOptions = {}) {
    const self = botState.self;
    if (!self) {
      throw new Error('[physics] Cannot simulate without botState.self being set');
    }

    self.attributes = self.attributes || {};

    // Build the proxy from the full botState instance
    const proxy = new SelfEntityProxy(botState, engine);

    // Ensure attribute shape on the raw object (in case not done by listeners)
    ensureAttributeShape(self.attributes);

    // Build ControlStateHandler from the controls object
    const control = new ControlStateHandler(
      !!controls.forward,
      !!controls.back,
      !!controls.left,
      !!controls.right,
      !!controls.jump,
      !!controls.sprint,
      !!controls.sneak
    );

    // Clone previous control (must be stored on self beforehand)
    const prevControl = proxy.prevControl ? proxy.prevControl.clone() : control.clone();

    const playerState = new PlayerState(engine, proxy)

    // Now fill in all the fields that BotcraftPhysics reads
    playerState.attributes = self.attributes; // use the same mutable object
    playerState.effects = proxy.effects;
    playerState.jumpBoost = proxy.jumpBoost;
    playerState.speed = proxy.speed;
    playerState.slowness = proxy.slowness;
    playerState.dolphinsGrace = proxy.dolphinsGrace;
    playerState.slowFalling = proxy.slowFalling;
    playerState.levitation = proxy.levitation;
    playerState.blindness = proxy.blindness;
    playerState.depthStrider = proxy.depthStrider;
    playerState.swiftSneak = proxy.swiftSneak;
    playerState.soulSpeed = proxy.soulSpeed;
    playerState.validElytraEquipped = proxy.validElytraEquipped;
    playerState.fireworkRocketDuration = proxy.fireworkRocketDuration;
    playerState.isInWater = proxy.isInWater;
    playerState.isUnderWater = proxy.isUnderWater;
    playerState.isInLava = proxy.isInLava;
    playerState.isUnderLava = proxy.isUnderLava;
    playerState.isInWeb = proxy.isInWeb;
    playerState.isCollidedHorizontally = proxy.isCollidedHorizontally;
    playerState.isCollidedHorizontallyMinor = proxy.isCollidedHorizontallyMinor;
    playerState.isCollidedVertically = proxy.isCollidedVertically;
    playerState.supportingBlockPos = proxy.supportingBlockPos;
    playerState.stuckSpeedMultiplier = proxy.stuckSpeedMultiplier;
    playerState.jumpTicks = proxy.jumpTicks;
    playerState.jumpQueued = proxy.jumpQueued;
    playerState.onClimbable = proxy.onClimbable;
    playerState.pose = normalizePose(proxy.pose);
    playerState.gameMode = proxy.gameMode;
    playerState.flying = proxy.flying;
    playerState.mayFly = proxy.mayFly;
    playerState.swimming = proxy.swimming;
    playerState._sprinting = proxy.sprinting;
    playerState.crouching = proxy.crouching;
    playerState.fallFlying = proxy.fallFlying;
    playerState.flySpeed = proxy.flySpeed;
    playerState.sneakCollision = proxy.sneakCollision;
    playerState.isUsingItem = proxy.isUsingItem;
    playerState.isUsingMainHand = proxy.isUsingMainHand;
    playerState.isUsingOffHand = proxy.isUsingOffHand;
    playerState.sprintTriggerTime = 0;
    playerState.flyJumpTriggerTime = 0;
    playerState.age = proxy.age;
    playerState.yaw = bedrockYawToNxgYaw(self.yaw);
    playerState.pitch = degreesToRadians(self.pitch);
    playerState.control = control;
    playerState.prevControl = prevControl;
    const heading = convInpToAxes(playerState);
    playerState.heading = heading;
    playerState.prevHeading = proxy.prevHeading || { forward: 0, strafe: 0 };

    // Create the entity physics context
    const ctx = EPhysicsCtx.FROM_ENTITY_STATE(engine, playerState, playerEntityType);
    Object.assign(ctx.worldSettings, options.worldSettings || simOptions.worldSettings || BEDROCK_WORLD_SETTINGS);

    // Run simulation
    const result = engine.simulate(ctx, world);

    if (controls.sneak || self.sneaking || playerState.crouching || result.crouching) {
      debugNxgState('simulate', {
        tick: stringifyBigInt(self.tick || 0n),
        controls: {
          forward: !!controls.forward,
          back: !!controls.back,
          left: !!controls.left,
          right: !!controls.right,
          jump: !!controls.jump,
          sprint: !!controls.sprint,
          sneak: !!controls.sneak
        },
        before: {
          position: compactVec(self.position),
          velocity: compactVec(self.velocity),
          onGround: !!self.onGround,
          sneaking: !!self.sneaking,
          crouching: !!self.crouching,
          pose: self.pose,
          horizontalCollision: !!self.horizontalCollision,
          verticalCollision: !!self.verticalCollision
        },
        playerState: {
          pose: playerState.pose,
          crouching: !!playerState.crouching,
          sneakCollision: !!playerState.sneakCollision,
          onGround: !!playerState.onGround,
          isCollidedHorizontally: !!playerState.isCollidedHorizontally,
          isCollidedVertically: !!playerState.isCollidedVertically,
          heading,
          control: {
            forward: control.forward,
            back: control.back,
            left: control.left,
            right: control.right,
            jump: control.jump,
            sprint: control.sprint,
            sneak: control.sneak
          }
        },
        result: {
          position: compactVec(result.pos),
          velocity: compactVec(result.vel),
          onGround: !!result.onGround,
          crouching: !!result.crouching,
          sprinting: !!result.sprinting,
          swimming: !!result.swimming,
          flying: !!result.flying,
          fallFlying: !!result.fallFlying,
          isCollidedHorizontally: !!result.isCollidedHorizontally,
          isCollidedHorizontallyMinor: !!result.isCollidedHorizontallyMinor,
          isCollidedVertically: !!result.isCollidedVertically,
          supportingBlockPos: compactVec(result.supportingBlockPos)
        }
      });
    }

    // Write back results to self via proxy
    self.position = result.pos.clone();
    self.velocity = result.vel.clone();
    self.onGround = result.onGround;
    self.lastOnGround = playerState.lastOnGround;
    self.horizontalCollision = result.isCollidedHorizontally;
    self.isCollidedHorizontally = result.isCollidedHorizontally;
    self.isCollidedHorizontallyMinor = result.isCollidedHorizontallyMinor;
    self.verticalCollision = result.isCollidedVertically;
    self.isCollidedVertically = result.isCollidedVertically;
    self.onClimbable = result.onClimbable;
    self.touchingWater = result.isInWater;
    self.isInWater = result.isInWater;
    self.isUnderWater = result.isUnderWater;
    self.inLava = result.isInLava;
    self.isUnderLava = result.isUnderLava;
    self.isInWeb = result.isInWeb;
    self.supportingBlockPos = result.supportingBlockPos;
    self.jumpTicks = result.jumpTicks;
    self.jumpQueued = false;
    self.fireworkRocketDuration = result.fireworkRocketDuration;
    self.stuckSpeedMultiplier = result.stuckSpeedMultiplier;

    // Update sprinting/crouching/gliding from engine result
    self.sprinting = result.sprinting;
    self.sneaking = result.crouching;
    self.gliding = result.fallFlying;
    self.fallFlying = result.fallFlying;
    self.swimming = result.swimming;
    self.flying = result.flying;

    // Store prevControl for next tick
    self.prevControl = control.clone();
    botState.prevControl = control.clone();
    self.prevHeading = { forward: heading.forward, strafe: heading.strafe };
    botState.prevHeading = { forward: heading.forward, strafe: heading.strafe };
    self.prevJump = !!controls.jump;
    self.prevSneak = !!controls.sneak;

    return {
      position: self.position,
      velocity: self.velocity,
      requestedMove: result.vel,
      appliedMove: result.vel,
      onGround: self.onGround,
      horizontalCollision: self.horizontalCollision,
      verticalCollision: self.verticalCollision,
    };
  }

  return {
    engine,
    mcData,
    simulateSelf,
  };
}

// ===================================================================
// Install Bedrock movement state handlers (packet listeners)
// ===================================================================
function installBedrockMovementStateHandlers(botState, options = {}) {
  const client = botState.client;

  if (!client) {
    throw new Error('[physics] Cannot install Bedrock movement handlers without botState.client');
  }
}

// ===================================================================
// Exports
// ===================================================================
module.exports = {
  createNxgPhysicsAdapter,
  installBedrockMovementStateHandlers,
  BEDROCK_WORLD_SETTINGS,
};
