const { Vec3 } = require('vec3');
const { performance } = require('perf_hooks');
const { sameRuntimeId, sleep } = require('../../utils');
const { getConstants } = require('../physics-constants');
const { DEFAULT_BEDROCK_VERSION } = require('../../version');
const { createBedrockWorldAdapter } = require('./bedrock-world-adapter');
const { createNxgPhysicsAdapter, installBedrockMovementStateHandlers } = require('./nxg-physics-utils-adapter');
const { createBedrockPhysicsEngine } = require('./bedrock-physics-engine');
const { installControls, updateEyeDeltaAndTick } = require('./input-controls');
const { createMovementPacketSender } = require('./movement-packets');
const { snapGroundedMovementPosition, setSelfEyePosition, toFeetPosition, withSelfFeetPosition } = require('./position');

module.exports = function bedrockPhysicsPlugin(botState, options = {}) {
  if (options.physicsEnabled === false || botState.options?.physicsEnabled === false) return;
  if (options.worldDecodeEnabled === false || botState.options?.worldDecodeEnabled === false) {
    throw new Error('[physics] physicsEnabled requires worldDecodeEnabled: true');
  }

  const client = botState.client;
  const C = getConstants(botState.version || DEFAULT_BEDROCK_VERSION);
  const physicsOptions = { ...botState.options, ...options };
  const controls = installControls(botState, C);
  installBedrockMovementStateHandlers(botState);
  const world = createBedrockWorldAdapter(botState);
  const physicsEngine = physicsOptions.physicsEngine === 'nxg-org' ? 'nxg' : (physicsOptions.physicsEngine || 'native');
  const physics = physicsEngine === 'nxg'
    ? createNxgPhysicsAdapter(physicsOptions)
    : createBedrockPhysicsEngine(physicsOptions);
  const movementPackets = createMovementPacketSender(botState, C, physicsOptions);

  let tickInterval = null;
  let movementMode = 'server';
  let hasAuthoritativeMovementPosition = false;
  let tickInProgress = false;
  let startingTick = false;
  const tickMs = 50;
  const timerLeadMs = options.timerLeadMs ?? 16;
  const maxCatchUpTicks = options.maxCatchUpTicks ?? 4;

  const chunkWaitRadius = options.chunkWaitRadius ?? 1;
  const chunkWaitTimeoutMs = options.chunkWaitTimeoutMs ?? 10000;
  const chunkWaitVerticalSectionRadius = options.chunkWaitVerticalSectionRadius ?? 1;

  function isTeleportMove(mode) {
    return mode === 1 || mode === 2 || mode === 'teleport' || mode === 'pitch'
  }

  function rotationPitch(rotation) {
    const value = rotation?.x ?? rotation?.pitch;
    return Number.isFinite(value) ? value : 0;
  }

  function rotationYaw(rotation) {
    const value = rotation?.z ?? rotation?.y ?? rotation?.yaw;
    return Number.isFinite(value) ? value : 0;
  }

  function hasSupportingBlock() {
    const self = botState.self;
    if (!self?.position || !botState.world?.sync?.getBlock) return false;

    try {
      const feet = toFeetPosition(self.position, self, C);
      const below = botState.world.sync.getBlock(feet.offset(0, -0.1, 0).floored());
      return below?.boundingBox === 'block' || (Array.isArray(below?.shapes) && below.shapes.length > 0);
    } catch {
      return false;
    }
  }

  async function tickSimulation() {
    const self = botState.self;
    if (!self) return;

    controls.evaluateControls();

    withSelfFeetPosition(self, C, () => {
      physics.simulateSelf(botState, controls.getControlStateSnapshot(), world, C);
    });

    if (!self.verticalCollision && !self.onGround && hasSupportingBlock()) {
      self.verticalCollision = true;
      self.isCollidedVertically = true;
      self.onGround = true;
    }

    controls.setFlag('horizontal_collision', !!self.horizontalCollision);
    controls.setFlag('vertical_collision', !!(self.verticalCollision || self.onGround));

    updateEyeDeltaAndTick(self, C);
  }

  async function sendMovementTick() {
    botState.emit('physicsTickPre', {
      phase: 'pre',
      movementMode,
      tick: botState.self?.tick ?? 0n
    });

    await tickSimulation();

    const packet = movementMode !== 'client' ? 'player_auth_input' : 'move_player';
    if (movementMode !== 'client') movementPackets.sendPlayerAuthInput(tickMs / 1000);
    else movementPackets.sendMovePlayer(0, tickMs / 1000);

    botState.emit('physicsTick', {
      phase: 'post',
      movementMode,
      packet,
      tick: botState.self?.tick ?? 0n
    });
  }

  function yieldImmediate() {
    return new Promise(resolve => setImmediate(resolve));
  }

  async function waitUntil(deadline) {
    while (tickInterval) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      if (remaining > 2) await sleep(Math.max(0, remaining - 2));
      else await yieldImmediate();
    }
  }

  async function waitForChunksAroundSelf() {
    if (!botState.self?.position) return false;
    if (!botState.waitForChunksToLoad) return true;
    const radiusBlocks = chunkWaitRadius * 16;

    if (
      typeof botState.areChunksLoadedAround === 'function' &&
      botState.areChunksLoadedAround(
        radiusBlocks,
        botState.self.position,
        chunkWaitVerticalSectionRadius
      )
    ) {
      return true;
    }

    try {
      await botState.waitForChunksToLoad(
        radiusBlocks,
        botState.self.position,
        chunkWaitTimeoutMs,
        chunkWaitVerticalSectionRadius
      );
      return true;
    } catch (err) {
      botState.logger.warn('[physics] waiting for nearby chunks before physics:', err?.message || err);
      return false;
    }
  }

  async function startTick() {
    if (!hasAuthoritativeMovementPosition) return;
    if (tickInterval || startingTick) return;
    startingTick = true;

    try {
      const ready = await waitForChunksAroundSelf();
      if (!ready) {
        tickInterval = setTimeout(() => {
          tickInterval = null;
          void startTick();
        }, 1000);
        return;
      }
      if (tickInterval) return;

      let nextTickAt = performance.now() + tickMs;
      if (botState.self) botState.self._prevEye = null;

      async function runTickLoop() {
        if (!tickInterval) return;
        if (tickInProgress) {
          tickInterval = setTimeout(runTickLoop, 1);
          return;
        }
        tickInProgress = true;

        try {
          await waitUntil(nextTickAt);
          if (!tickInterval) return;

          const workStart = performance.now();
          await sendMovementTick();
          let workEnd = performance.now();
          const workOverranTick = workEnd - workStart >= tickMs;

          nextTickAt += tickMs;

          if (workOverranTick) {
            let catchUpTicks = 0;
            while (tickInterval && nextTickAt <= workEnd && catchUpTicks < maxCatchUpTicks) {
              await sendMovementTick();
              nextTickAt += tickMs;
              catchUpTicks++;
              workEnd = performance.now();
            }
          } else if (nextTickAt <= workEnd) {
            nextTickAt = workEnd + tickMs;
          }
        } catch (err) {
          botState.logger.warn('[physics] tick error:', err?.stack || err);
        } finally {
          tickInProgress = false;
          if (tickInterval) {
            if (nextTickAt <= performance.now() - tickMs) {
              nextTickAt = performance.now() + tickMs;
            }

            tickInterval = setTimeout(
              runTickLoop,
              Math.max(0, nextTickAt - performance.now() - timerLeadMs)
            );
          }
        }
      }

      tickInterval = setTimeout(runTickLoop, Math.max(0, tickMs - timerLeadMs));
    } finally {
      startingTick = false;
    }
  }

  function stopTick() {
    if (tickInterval) clearTimeout(tickInterval);
    tickInterval = null;
    tickInProgress = false;
    startingTick = false;
  }

  botState.applyMovement = tickSimulation;

  function isUsableMovementPosition (position) {
    if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y) || !Number.isFinite(position?.z)) return false;
    const minY = botState.worldSettings?.minY ?? -64;
    const height = botState.worldSettings?.height ?? 384;
    return position.y >= minY - C.EYE_HEIGHT && position.y <= minY + height + C.EYE_HEIGHT;
  }

  function setAuthoritativeMovementPosition (position) {
    if (!isUsableMovementPosition(position)) return false;
    if (!botState.self) return false;

    setSelfEyePosition(botState.self, position, C);
    botState.self.velocity.set(0, 0, 0);
    botState.self.unvalidatedPosition = botState.self.position.clone();
    botState.self._prevEye = null;
    botState.authoritativeMovementFeetPosition = toFeetPosition(botState.self.position, botState.self, C);
    botState.canSendPlayerAuthInput = true;
    hasAuthoritativeMovementPosition = true;
    return true;
  }

  function clearAuthoritativeMovementPosition () {
    hasAuthoritativeMovementPosition = false;
    botState.canSendPlayerAuthInput = false;
    botState.authoritativeMovementFeetPosition = null;
  }

  botState.setPosition = (x, y, z) => {
    if (botState.self) botState.self.position.set(x, y, z);
  };

  botState.look = movementPackets.look;
  botState.lookAt = movementPackets.lookAt;
  botState.waitForLookComplete = movementPackets.waitForLookComplete;
  botState.syncLook = movementPackets.syncLook;

  client.on('start_game', (pkt) => {
    if (!botState.self) return;

    setSelfEyePosition(botState.self, pkt.player_position, C);

    botState.self.pitch = rotationPitch(pkt.rotation);
    botState.self.yaw = rotationYaw(pkt.rotation);
    botState.self.headYaw = botState.self.yaw;
    botState.self.velocity.set(0, 0, 0);
    botState.self.unvalidatedPosition = botState.self.position.clone();
    clearAuthoritativeMovementPosition();

    movementPackets.resetRotation();
    botState.self._prevEye = null;
  });

  client.on('set_spawn_position', () => {
    botState.clearControlStates();
    movementPackets.resetRotation();
    if (botState.self) botState.self._prevEye = null;
  });

  client.on('move_player', (pkt) => {
    if (!botState.self || !sameRuntimeId(pkt.runtime_id, client.entityId)) return;
    if (!isUsableMovementPosition(pkt.position)) return;

    setSelfEyePosition(botState.self, snapGroundedMovementPosition(pkt.position, botState.self, C, pkt.on_ground), C);

    botState.self.pitch = pkt.pitch;
    botState.self.yaw = pkt.yaw;
    botState.self.headYaw = pkt.head_yaw;
    botState.self.onGround = !!pkt.on_ground;

    if (isTeleportMove(pkt.mode)) {
      botState.self.velocity.set(0, 0, 0);
      botState.self.unvalidatedPosition = botState.self.position.clone();
      botState.self._handledTeleportPending = true;
    }

    movementPackets.resetRotation();
    botState.self._prevEye = null;
    hasAuthoritativeMovementPosition = true;
    botState.canSendPlayerAuthInput = true;
    botState.authoritativeMovementFeetPosition = toFeetPosition(botState.self.position, botState.self, C);
    void startTick();
  });

  client.on('respawn', (pkt) => {
    if (!botState.self || !(pkt.state === 0 || pkt.state === 1 || pkt.state === 2)) return;

    stopTick();
    clearAuthoritativeMovementPosition();

    if (pkt.state === 1 || pkt.state === 2) {
      if (setAuthoritativeMovementPosition(pkt.position)) void startTick();
    }
  });

  client.on('correct_player_move_prediction', (pkt) => {
    if (!botState.self) return;
    if (!isUsableMovementPosition(pkt.position)) return;

    setSelfEyePosition(botState.self, snapGroundedMovementPosition(pkt.position, botState.self, C, pkt.on_ground), C);

    if (pkt.prediction_type === 'vehicle') {
      botState.self.pitch = rotationPitch(pkt.rotation);
      botState.self.yaw = rotationYaw(pkt.rotation);
      botState.self.headYaw = botState.self.yaw;
    }

    botState.self.onGround = !!pkt.on_ground;
    botState.self.velocity.set(0, 0, 0);
    botState.self.unvalidatedPosition = botState.self.position.clone();

    controls.setFlag('received_server_data', true);
    botState.self._prevEye = null;
    hasAuthoritativeMovementPosition = true;
    botState.canSendPlayerAuthInput = true;
    botState.authoritativeMovementFeetPosition = toFeetPosition(botState.self.position, botState.self, C);
    void startTick();
  });

  client.on('motion_prediction_hints', (pkt) => {
    if (!botState.self) return;
    botState.self.uncertainVelocity = new Vec3(pkt.velocity.x, pkt.velocity.y, pkt.velocity.z);
  });

  client.on('set_entity_motion', (pkt) => {
    if (botState.self && sameRuntimeId(pkt.runtime_entity_id, client.entityId)) {
      botState.self.velocity.set(pkt.velocity.x, pkt.velocity.y, pkt.velocity.z);
    }
  });

  client.on('set_movement_authority', (pkt) => {
    movementMode = pkt.movement_authority === 0 ? 'client' : 'server';
  });

  client.on('close', stopTick);

  if (botState.self && botState.self.position) void startTick();
};
