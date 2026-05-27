const { Vec3 } = require('vec3');
const { ControlStateHandler, PlayerPoses, convInpToAxes } = require('@nxg-org/mineflayer-physics-util');
const { normalizePhysicsGameMode, normalizePhysicsPose } = require('../../utils');

// ################################################################################
// Helper functions (same as in the full adapter)
// ################################################################################

const normalizeGameMode = normalizePhysicsGameMode;

function normalizePose(pose) {
  return normalizePhysicsPose(pose, PlayerPoses);
}

// Map Bedrock attribute names to full names used by the engine
const BEDROCK_ATTR_MAP = {
  'movement': 'minecraft:movement_speed',
  'movement_speed': 'minecraft:movement_speed',
  'minecraft:movement': 'minecraft:movement_speed',
  'minecraft:movement_speed': 'minecraft:movement_speed',
  'jump_strength': 'minecraft:jump_strength',
  'step_height': 'minecraft:step_height',
  'water_movement_efficiency': 'minecraft:water_movement_efficiency',
  'underwater_movement': 'minecraft:underwater_movement',
  'minecraft:jump_strength': 'minecraft:jump_strength',
  'minecraft:step_height': 'minecraft:step_height',
  'minecraft:water_movement_efficiency': 'minecraft:water_movement_efficiency',
  'minecraft:underwater_movement': 'minecraft:underwater_movement',
};

// Effect ID → state key
const BEDROCK_EFFECT_TO_STATE_KEY = {
  1: 'speed',
  2: 'slowness',
  8: 'jumpBoost',
  15: 'blindness',
  25: 'levitation',
  28: 'slowFalling',
  30: 'dolphinsGrace',
};

// ################################################################################
// SelfEntityProxy – now a proper Bot proxy
// ################################################################################

class SelfEntityProxy {
  /**
   * @param {import('../state')} botState - The full BotState instance
   * @param {object} engine - a BotcraftPhysics instance (for enchantment lookups)
   */
  constructor(botState, engine) {
    this._bot = botState;
    this._engine = engine;

    // The raw self entity object (prismarine-entity) – we use it as the .entity
    // PlayerState.update() will read/write position, velocity, attributes, etc.
    // through this.entity.
    this._self = botState.self;
    if (!this._self) {
      throw new Error('SelfEntityProxy: botState.self must exist before constructing the proxy');
    }

    // Ensure the entity has all fields PlayerState.update() expects
    this._ensureEntityShape();
    // Ensure the bot-level fields exist
    this._ensureBotLevelFields();
  }

  // ──────────────────────────────────────────────
  //  Internal helpers
  // ──────────────────────────────────────────────

  _ensureEntityShape() {
    const e = this._self;
    // position / velocity are already Vec3 from entities.js
    if (!(e.position instanceof Vec3)) e.position = new Vec3(0, 0, 0);
    if (!(e.velocity instanceof Vec3)) e.velocity = new Vec3(0, 0, 0);

    // Attributes – PlayerState.update() reads bot.entity.attributes
    e.attributes = e.attributes || {};
    this._ensureDefaultAttributes(e.attributes);

    e.effects = e.effects && typeof e.effects === 'object' ? e.effects : {};
    e.rawEffects = e.rawEffects && typeof e.rawEffects === 'object' ? e.rawEffects : {};
    if (!Array.isArray(e.metadata)) {
      if (e.metadata && typeof e.metadata === 'object') e.bedrockMetadata = e.metadata;
      e.metadata = [];
    }

    // equipment array – used for depth strider / swift sneak
    if (!Array.isArray(e.equipment)) {
      e.equipment = [null, null, null, null, null, null]; // 0=main, 1=off, 2=??? (head), 3=legs, 4=chest, 5=feet
    }

    // Other boolean flags that PlayerState.update() casts from
    e.swimming = e.swimming || false;
    e.sprinting = e.sprinting || false;
    e.crouching = e.crouching || false;
    e.fallFlying = e.fallFlying || false;
    e.elytraFlying = e.elytraFlying || false;
    e.flying = e.flying || false;
    e.onGround = !!e.onGround;
    e.lastOnGround = e.lastOnGround !== undefined ? e.lastOnGround : e.onGround;
    e.onClimbable = e.onClimbable || false;
    e.isInWater = e.isInWater || false;
    e.isUnderWater = e.isUnderWater || false;
    e.isInLava = e.isInLava || false;
    e.isUnderLava = e.isUnderLava || false;
    e.isInWeb = e.isInWeb || false;
    e.isCollidedHorizontally = e.isCollidedHorizontally || false;
    e.isCollidedHorizontallyMinor = e.isCollidedHorizontallyMinor || false;
    e.isCollidedVertically = e.isCollidedVertically || false;
    e.supportingBlockPos = e.supportingBlockPos || null;
    e.lastOnGround = e.lastOnGround !== undefined ? e.lastOnGround : e.onGround;
  }

  _ensureDefaultAttributes(attrs) {
    const defaults = {
      'minecraft:movement_speed': { value: 0.1, min: 0, max: 1024, default: 0.1, modifiers: [] },
      'minecraft:jump_strength':   { value: 0.42, min: 0, max: 1024, default: 0.42, modifiers: [] },
      'minecraft:step_height':     { value: 0.6, min: 0, max: 1024, default: 0.6, modifiers: [] },
    };
    for (const [k, v] of Object.entries(defaults)) {
      if (!attrs[k]) attrs[k] = { ...v };
    }
  }

  _ensureBotLevelFields() {
    const self = this._bot;
    self.jumpTicks = self.jumpTicks || 0;
    self.jumpQueued = self.jumpQueued || false;
    self.flyJumpTriggerTime = self.flyJumpTriggerTime || 0;
    self.sprintTriggerTime = self.sprintTriggerTime || 0;
    self.fireworkRocketDuration = self.fireworkRocketDuration || 0;
    self.controlState = self.controlState || ControlStateHandler.DEFAULT();
    self.usingHeldItem = self.usingHeldItem || false;
    self.inventory = self.inventory || { slots: [] };
    self.game = self.game || { gameMode: 'survival' };
    self.food = self.food || 20;
    // rawEffects is separate for effect lookups
    self.rawEffects = self.rawEffects || {};
    self.bedrockAttributes = self.bedrockAttributes || {};
    self.movementEffects = self.movementEffects || {};
    self.metadata = self.metadata || {};
    self.prevControl = self.prevControl || ControlStateHandler.DEFAULT().clone();
    self.prevHeading = self.prevHeading || { forward: 0, strafe: 0 };
  }

  // ──────────────────────────────────────────────
  //  Properties required by PlayerState.update()
  //  (bot.entity read through `this.entity`)
  // ──────────────────────────────────────────────

  /**
   * The entity object – PlayerState.update() accesses bot.entity.*
   */
  get entity() {
    return this._self;
  }

  set entity(val) {
    // read-only; the underlying self is the entity
    throw new Error('SelfEntityProxy.entity is read‑only');
  }

  // ──────────────────────────────────────────────
  //  Bot‑level fields
  // ──────────────────────────────────────────────

  getControlState(val) {
    return this._bot.controlState[val] ?? false
  }

  get controlState() {
    return this._bot.controlState;
  }
  set controlState(val) {
    this._bot.controlState = val;
  }

  get effects() {
    return this._self.effects
  }

  get jumpTicks() {
    return this._bot.jumpTicks;
  }
  set jumpTicks(v) {
    this._bot.jumpTicks = v;
  }

  get jumpQueued() {
    return this._bot.jumpQueued;
  }
  set jumpQueued(v) {
    this._bot.jumpQueued = v;
  }

  get flyJumpTriggerTime() {
    return this._bot.flyJumpTriggerTime;
  }
  set flyJumpTriggerTime(v) {
    this._bot.flyJumpTriggerTime = v;
  }

  get sprintTriggerTime() {
    return this._bot.sprintTriggerTime;
  }
  set sprintTriggerTime(v) {
    this._bot.sprintTriggerTime = v;
  }

  get fireworkRocketDuration() {
    return this._bot.fireworkRocketDuration;
  }
  set fireworkRocketDuration(v) {
    this._bot.fireworkRocketDuration = v;
  }

  get usingHeldItem() {
    return this._bot.usingHeldItem;
  }
  set usingHeldItem(v) {
    this._bot.usingHeldItem = v;
  }

  get inventory() {
    return this._bot.inventory;
  }
  set inventory(v) {
    this._bot.inventory = v;
  }

  get game() {
    return {
      ...this._bot.game,
      gameMode: normalizeGameMode(this._bot.game?.gameMode || this._self.gamemode || 'survival')
    };
  }
  set game(v) {
    this._bot.game = v;
  }

  get food() {
    return this._bot.food;
  }
  set food(v) {
    this._bot.food = v;
  }

  /**
   * Delegates to botState.client.entityId for the torso slot.
   * This is a rough mapping – in a full Bot, this would return the
   * equipment slot index for 'torso'.  The value 4 corresponds to chestplate.
   */
  getEquipmentDestSlot() {
    return 4; // torso slot in prismarine-entity equipment array
  }

  // ──────────────────────────────────────────────
  //  Convenience effect access (for the engine's effect‑level lookups)
  //  These are used by the adapter but not directly by PlayerState.update()
  // ──────────────────────────────────────────────

  get speed()            { return this._getEffectLevel(1); }
  set speed(v)           { this._setEffectLevel(1, v); }
  get slowness()         { return this._getEffectLevel(2); }
  set slowness(v)        { this._setEffectLevel(2, v); }
  get jumpBoost()        { return this._getEffectLevel(8); }
  set jumpBoost(v)       { this._setEffectLevel(8, v); }
  get blindness()        { return this._getEffectLevel(15); }
  set blindness(v)       { this._setEffectLevel(15, v); }
  get levitation()       { return this._getEffectLevel(25); }
  set levitation(v)      { this._setEffectLevel(25, v); }
  get slowFalling()      { return this._getEffectLevel(28); }
  set slowFalling(v)     { this._setEffectLevel(28, v); }
  get dolphinsGrace()    { return this._getEffectLevel(30); }
  set dolphinsGrace(v)   { this._setEffectLevel(30, v); }

  _getEffectLevel(effectId) {
    const eff = this._bot.rawEffects[effectId];
    if (!eff) return 0;
    return (eff.amplifier != null ? eff.amplifier + 1 : 1) || 0;
  }

  _setEffectLevel(effectId, level) {
    if (!this._bot.rawEffects[effectId]) {
      this._bot.rawEffects[effectId] = {
        id: effectId,
        amplifier: Math.max(0, level - 1),
        duration: 200,
        ambient: false,
        particles: false,
      };
    } else {
      this._bot.rawEffects[effectId].amplifier = Math.max(0, level - 1);
    }
  }

  /**
   * Delegate to the engine for enchantment lookups
   */
  getEnchantmentLevel(enchantCheap, enchantments) {
    return this._engine.getEnchantmentLevel(enchantCheap, enchantments);
  }

  // ──────────────────────────────────────────────
  //  Other fields required by the engine for simulation
  //  (these are accessed on the proxy, not through bot.entity)
  // ──────────────────────────────────────────────

  get halfWidth()               { return this._self.halfWidth || 0.3; }
  get height()                  { return this._self.height || 1.8; }
  get eyeHeight()               { return this._self.eyeHeight || 1.62; }
  get flying()                  { return !!this._self.flying; }
  set flying(v)                 { this._self.flying = v; }
  get mayFly()                  { return !!this._self.mayFly; }
  set mayFly(v)                 { this._self.mayFly = v; }
  get swimming()                { return !!this._self.swimming; }
  set swimming(v)               { this._self.swimming = v; }
  get sprinting()               { return !!this._self.sprinting; }
  set sprinting(v)              { this._self.sprinting = v; }
  get crouching()               { return !!this._self.crouching; }
  set crouching(v)              { this._self.crouching = v; }
  get fallFlying()              { return !!this._self.fallFlying; }
  set fallFlying(v)             { this._self.fallFlying = v; }
  get elytraFlying()            { return this.fallFlying; }
  set elytraFlying(v)           { this.fallFlying = v; }
  get isInWater()               { return !!this._self.isInWater; }
  set isInWater(v)              { this._self.isInWater = v; }
  get isUnderWater()            { return !!this._self.isUnderWater; }
  set isUnderWater(v)           { this._self.isUnderWater = v; }
  get isInLava()                { return !!this._self.isInLava; }
  set isInLava(v)               { this._self.isInLava = v; }
  get isUnderLava()             { return !!this._self.isUnderLava; }
  set isUnderLava(v)            { this._self.isUnderLava = v; }
  get isInWeb()                 { return !!this._self.isInWeb; }
  set isInWeb(v)                { this._self.isInWeb = v; }
  get isCollidedHorizontally()  { return !!this._self.isCollidedHorizontally; }
  set isCollidedHorizontally(v) { this._self.isCollidedHorizontally = v; }
  get isCollidedHorizontallyMinor() { return !!this._self.isCollidedHorizontallyMinor; }
  set isCollidedHorizontallyMinor(v) { this._self.isCollidedHorizontallyMinor = v; }
  get isCollidedVertically()    { return !!this._self.isCollidedVertically; }
  set isCollidedVertically(v)   { this._self.isCollidedVertically = v; }
  get isUsingItem()             { return !!this._self.isUsingItem; }
  set isUsingItem(v)            { this._self.isUsingItem = v; }
  get isUsingMainHand()         { return !!this._self.isUsingMainHand; }
  set isUsingMainHand(v)        { this._self.isUsingMainHand = v; }
  get isUsingOffHand()          { return !!this._self.isUsingOffHand; }
  set isUsingOffHand(v)         { this._self.isUsingOffHand = v; }
  get onClimbable()             { return !!this._self.onClimbable; }
  set onClimbable(v)            { this._self.onClimbable = v; }
  get validElytraEquipped()     { return !!this._self.elytraEquipped; }
  set validElytraEquipped(v)    { this._self.elytraEquipped = v; }
  get supportingBlockPos()      { return this._self.supportingBlockPos || null; }
  set supportingBlockPos(v)     { this._self.supportingBlockPos = v; }
  get stuckSpeedMultiplier()    { return this._self.stuckSpeedMultiplier || new Vec3(0, 0, 0); }
  set stuckSpeedMultiplier(v)   { this._self.stuckSpeedMultiplier = v; }
  get pose()                    { return normalizePose(this._self.pose); }
  set pose(v)                   { this._self.pose = normalizePose(v); }
  get gameMode()                { return normalizeGameMode(this._bot.game?.gameMode || this._self.gamemode || 'survival'); }
  set gameMode(v)               { this._bot.game = this._bot.game || {}; this._bot.game.gameMode = v; }
  get age()                     { return Number(this._bot.tick || 0n); }
  set age(v)                    { /* engine sets age on PlayerState, not proxy */ }
  get depthStrider()            { return this._self.depthStrider || 0; }
  set depthStrider(v)           { this._self.depthStrider = v; }
  get swiftSneak()              { return this._self.swiftSneak || 0; }
  set swiftSneak(v)             { this._self.swiftSneak = v; }
  get soulSpeed()               { return this._self.soulSpeed || 0; }
  set soulSpeed(v)              { this._self.soulSpeed = v; }
  get flySpeed()                { return Number(this._self.flySpeed ?? 0.05); }
  set flySpeed(v)               { this._self.flySpeed = v; }
  get verticalFlySpeed()        { return Number(this._self.verticalFlySpeed ?? this._self.flySpeed ?? 0.05); }
  set verticalFlySpeed(v)       { this._self.verticalFlySpeed = v; }
  get walkSpeed()               { return Number(this._self.walkSpeed ?? 0.1); }
  set walkSpeed(v)              { this._self.walkSpeed = v; }
  get lastOnGround()            { return !!this._self.lastOnGround; }
  set lastOnGround(v)           { this._self.lastOnGround = v; }
  get sneakCollision()          { return !!this._self.sneakCollision; }
  set sneakCollision(v)         { this._self.sneakCollision = v; }

  // ──────────────────────────────────────────────
  //  Interface for ControlStateHandler.COPY_BOT
  // ──────────────────────────────────────────────

  get control() {
    return this._bot.controlState || ControlStateHandler.DEFAULT();
  }
  set control(val) {
    this._bot.controlState = val;
  }

  get prevControl() {
    const pc = this._bot.prevControl;
    if (!pc) {
      const def = ControlStateHandler.DEFAULT().clone();
      this._bot.prevControl = def;
      return def;
    }
    return pc;
  }
  set prevControl(val) {
    this._bot.prevControl = val;
  }

  get heading() {
    return convInpToAxes(this);
  }

  get prevHeading() {
    return this._bot.prevHeading || { forward: 0, strafe: 0 };
  }
  set prevHeading(val) {
    this._bot.prevHeading = val;
  }

  // ──────────────────────────────────────────────
  //  Clone (used for snapshots)
  // ──────────────────────────────────────────────

  clone() {
    // Return a new proxy that shares the same botState and engine
    return new SelfEntityProxy(this._bot, this._engine);
  }
}

// ========================================================================
// Exports
// ========================================================================
module.exports = SelfEntityProxy;
