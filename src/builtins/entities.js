const Vec3 = require('vec3');
const { findEntityByRuntimeId, sameRuntimeId } = require('../utils');
const {
  applyAbilities,
  applyAdventureSettings,
  applyAttributes,
  applyEntityMetadata,
  applyHealth,
  applyMobEffect,
  ensureEntityState,
  isSpectatorGameMode,
  normalizeGameMode
} = require('../entity-metadata');

/**
 * @param {import('../state')} botState
 * @param {object} options
 */
module.exports = (botState, options) => {
  const registry = botState.registry;
  const EntityClass = botState.entityClass;
  const Item = botState.itemClass;

  // Live entities are split by actor kind but share Bedrock runtime ids:
  // - entities: non-player actors, dropped items, mobs, vehicles, etc.
  // - playerEntities: the local player plus remote players from add_player.
  botState.entities ??= new Map();
  botState.playerEntities ??= botState.players ?? new Map();

  // Build a name → entity data map from the registry
  const entityDataByName = {};
  if (registry.entitiesArray) {
    for (const e of registry.entitiesArray) {
      entityDataByName[e.name] = e;
      entityDataByName[`minecraft:${e.name}`] = e;
    }
  }

  function lookupEntityData (entityTypeStr) {
    return entityDataByName[entityTypeStr] || entityDataByName[entityTypeStr.replace('minecraft:', '')] || null;
  }

  function flightSnapshot (entity) {
    if (!entity) return null;
    return {
      canFly: !!(entity.mayFly || entity.allowFlight),
      flying: !!entity.flying,
      spectator: !!entity.spectator || isSpectatorGameMode(entity.gamemode),
      noClip: !!entity.noClip,
      flySpeed: entity.flySpeed,
      verticalFlySpeed: entity.verticalFlySpeed,
      walkSpeed: entity.walkSpeed
    };
  }

  function emitFlightChanged (entity, previous, reason, packet) {
    const current = flightSnapshot(entity);
    if (!previous || !current) return;

    const changed = previous.canFly !== current.canFly ||
      previous.flying !== current.flying ||
      previous.spectator !== current.spectator ||
      previous.noClip !== current.noClip ||
      previous.flySpeed !== current.flySpeed ||
      previous.verticalFlySpeed !== current.verticalFlySpeed ||
      previous.walkSpeed !== current.walkSpeed;

    if (changed) {
      botState.emit('flightChanged', { ...current, previous, entity, reason, packet });
    }
  }

  // ========== Self player entity (from start_game) ==========
  botState.client.on('start_game', (packet) => {
    const entity = new EntityClass(packet.entity_id);
    entity.runtimeId = packet.runtime_entity_id;          // varint64 → BigInt
    entity.position.set(packet.player_position.x, packet.player_position.y, packet.player_position.z);
    entity.yaw = packet.rotation.z;
    entity.pitch = packet.rotation.x;
    entity.onGround = true;
    entity.type = 'player';
    entity.name = 'player';
    entity.displayName = 'self';
    entity.gamemode = packet.player_gamemode;
    ensureEntityState(entity);
    applyAttributes(entity, packet.attributes);
    applyAbilities(entity, packet.abilities);

    botState.self = entity;
    botState.playerEntities.set(packet.runtime_entity_id, entity);

    botState.logAction?.('[→]', 'start_game (self)', { id: packet.runtime_entity_id, pos: botState.self.position });
  });

  // ========== Remote player entities (from add_player) ==========
  botState.client.on('add_player', (packet) => {
    const entity = new EntityClass(packet.unique_id);
    entity.runtimeId = packet.runtime_id;                  // varint64 → BigInt
    entity.username = packet.username;
    entity.position.set(packet.position.x, packet.position.y, packet.position.z);
    entity.velocity.set(packet.velocity.x, packet.velocity.y, packet.velocity.z);
    entity.yaw = packet.yaw;
    entity.pitch = packet.pitch;
    entity.onGround = false;
    entity.type = 'player';
    entity.name = 'player';
    entity.displayName = packet.username;
    entity.gamemode = packet.gamemode;
    entity.heldItem = packet.held_item ? Item.fromNotch(packet.held_item) : null;
    applyEntityMetadata(entity, packet.metadata);
    entity.permissionLevel = packet.permission_level;
    entity.commandPermission = packet.command_permission;
    entity.deviceOS = packet.device_os;
    entity.deviceId = packet.device_id;
    entity.platformChatId = packet.platform_chat_id;
    entity.abilities = packet.abilities;

    botState.playerEntities.set(packet.runtime_id, entity);
    botState.logAction?.('[→]', 'add_player', { id: packet.runtime_id, username: packet.username });
    botState.emit('playerSpawned', entity);
  });

  // ========== Non-player entity spawn ==========
  botState.client.on('add_entity', (packet) => {
    const ed = lookupEntityData(packet.entity_type);

    const entity = new EntityClass(packet.unique_id);
    entity.runtimeId = packet.runtime_id;                  // varint64 → BigInt
    entity.position.set(packet.position.x, packet.position.y, packet.position.z);
    entity.velocity.set(packet.velocity.x, packet.velocity.y, packet.velocity.z);
    entity.yaw = packet.yaw;
    entity.pitch = packet.pitch;
    entity.onGround = false;

    if (ed) {
      entity.type = ed.type || 'mob';
      entity.displayName = ed.displayName;
      entity.name = ed.name;
      entity.kind = ed.category || 'mob';
      entity.height = ed.height;
      entity.width = ed.width;
      entity.entityType = ed.id;
    } else {
      entity.type = 'mob';
      entity.name = packet.entity_type.replace('minecraft:', '');
      entity.displayName = entity.name;
      entity.kind = 'mob';
    }

    applyEntityMetadata(entity, packet.metadata);
    applyAttributes(entity, packet.attributes);

    botState.entities.set(packet.runtime_id, entity);
    botState.logAction?.('[→]', 'add_entity', { id: packet.runtime_id, type: entity.name, pos: entity.position });
    botState.emit('entitySpawned', entity);
  });

  // ========== Item entity spawn ==========
  botState.client.on('add_item_entity', (packet) => {
    const entity = new EntityClass(packet.entity_id_self);
    entity.runtimeId = packet.runtime_entity_id;           // varint64 → BigInt
    entity.position.set(packet.position.x, packet.position.y, packet.position.z);
    entity.velocity.set(packet.velocity.x, packet.velocity.y, packet.velocity.z);
    entity.type = 'object';
    entity.kind = 'object';
    entity.name = 'item';
    entity.displayName = 'Item';
    applyEntityMetadata(entity, packet.metadata);
    entity.isFromFishing = packet.is_from_fishing;

    const item = Item.fromNotch(packet.item);
    if (item) {
      entity.item = item;
      entity.displayName = item.displayName || 'Item';
    }

    botState.entities.set(packet.runtime_entity_id, entity);
    botState.logAction?.('[→]', 'add_item_entity', { id: packet.runtime_entity_id, item: entity.displayName });
    botState.emit('entitySpawned', entity);
  });

  // ========== Remove entity ==========
  botState.client.on('remove_entity', (packet) => {
    // packet.entity_id_self is zigzag64, safe to treat as BigInt
    const key = typeof packet.entity_id_self === 'bigint' ? packet.entity_id_self : BigInt(packet.entity_id_self);
    const entity = botState.entities.get(key) || botState.playerEntities.get(key);
    if (entity) {
      entity.isValid = false;
      botState.entities.delete(key);
      botState.playerEntities.delete(key);
      if (botState.self === entity) {
        botState.self = null;
      }
      botState.logAction?.('[→]', 'remove_entity', { id: key });
      botState.emit('entityRemoved', entity);
    }
  });

  // ========== Item pickup ==========
  botState.client.on('take_item_entity', (packet) => {
    const entity = findEntityByRuntimeId(botState, packet.runtime_entity_id);
    if (!entity) return;
    botState.logAction?.('[→]', 'take_item_entity', { id: packet.runtime_entity_id, collector: packet.target });
    const isSelf = sameRuntimeId(packet.target, botState.client.entityId);
    botState.emit('itemPickup', {
      itemEntity: entity,
      itemEntityId: packet.runtime_entity_id,
      collector: packet.target,
      isSelf
    });
  });

  // ──── Movement handlers ──────────────────────────────────────────

  // MoveActorAbsolute – for non‑player and player entities
  botState.client.on('move_entity', (packet) => {
    const entity = findEntityByRuntimeId(botState, packet.runtime_entity_id);
    if (!entity) return;
    entity.position.set(packet.position.x, packet.position.y, packet.position.z);
    if (packet.rotation) {
      entity.yaw = packet.rotation.yaw;
      entity.pitch = packet.rotation.pitch;
      if (packet.rotation.head_yaw !== undefined) entity.headYaw = packet.rotation.head_yaw;
    }
    entity.onGround = !!(packet.flags & 0x40);
  });

  // MovePlayer – runtime_id is varint (number), must convert to BigInt
  botState.client.on('move_player', (packet) => {
    const runtimeId = typeof packet.runtime_id === 'bigint' ? packet.runtime_id : BigInt(packet.runtime_id);
    const entity = findEntityByRuntimeId(botState, runtimeId);
    if (!entity) return;
    entity.position.set(packet.position.x, packet.position.y, packet.position.z);
    entity.pitch = packet.pitch;
    entity.yaw = packet.yaw;
    entity.headYaw = packet.head_yaw;
    entity.onGround = packet.on_ground;
  });

  // MoveActorDelta – efficient delta update
  botState.client.on('move_entity_delta', (packet) => {
    const entity = findEntityByRuntimeId(botState, packet.runtime_entity_id);
    if (!entity) return;
    if (packet.flags.has_x) entity.position.x += packet.x;
    if (packet.flags.has_y) entity.position.y += packet.y;
    if (packet.flags.has_z) entity.position.z += packet.z;
    if (packet.flags.has_rot_x) entity.pitch = (packet.rot_x / 255) * 360;
    if (packet.flags.has_rot_y) entity.yaw = (packet.rot_y / 255) * 360;
    if (packet.flags.has_rot_z) entity.headYaw = (packet.rot_z / 255) * 360;
    if (packet.flags.on_ground) entity.onGround = true;
  });

  // MotionPredictionHints – velocity update from server
  botState.client.on('motion_prediction_hints', (packet) => {
    const entity = findEntityByRuntimeId(botState, packet.entity_runtime_id);
    if (!entity) return;
    entity.velocity.set(packet.velocity.x, packet.velocity.y, packet.velocity.z);
    entity.onGround = packet.on_ground;
  });

  // CorrectPlayerMovePrediction – only for the bot itself (rewind mode)
  botState.client.on('correct_player_move_prediction', (packet) => {
    if (!botState.self) return;
    botState.self.position.set(packet.position.x, packet.position.y, packet.position.z);
    if (packet.prediction_type === 'vehicle') {
      botState.self.pitch = packet.rotation.x;
      botState.self.yaw = packet.rotation.z;
      botState.self.headYaw = packet.rotation.z;
    }
    botState.self.onGround = packet.on_ground;
    // delta and tick are available but not stored by default
  });

  botState.client.on('change_dimension', (packet) => {
    const entity = botState.self;
    if (!entity) return;
    if (packet.position) entity.position.set(packet.position.x, packet.position.y, packet.position.z);
    entity.velocity.set(0, 0, 0);
    entity.supportingBlockPos = null;
    entity.onGround = false;
  });

  // ========== Data & Motion ==========
  botState.client.on('set_entity_data', (packet) => {
    const entity = findEntityByRuntimeId(botState, packet.runtime_entity_id);
    if (!entity) return;
    applyEntityMetadata(entity, packet.metadata);
  });

  botState.client.on('set_entity_motion', (packet) => {
    const entity = findEntityByRuntimeId(botState, packet.runtime_entity_id);
    if (!entity) return;
    entity.velocity.set(packet.velocity.x, packet.velocity.y, packet.velocity.z);
  });

  botState.client.on('entity_event', (packet) => {
    const entity = findEntityByRuntimeId(botState, packet.runtime_entity_id);
    if (!entity) return;
    botState.logAction?.('[→]', 'entity_event', { id: packet.runtime_entity_id, event: packet.event_id });
    botState.emit('entityEvent', entity, packet.event_id, packet.data);
  });

  botState.client.on('player_action', (packet) => {
    const runtimeId = packet.runtime_entity_id ?? packet.runtime_id;
    const entity = runtimeId === undefined ? botState.self : findEntityByRuntimeId(botState, runtimeId);
    if (!entity) return;

    switch (packet.action) {
      case 'start_sprint':
        entity.serverSprinting = true;
        entity.sprinting = true;
        break;
      case 'stop_sprint':
        entity.serverSprinting = false;
        entity.sprinting = false;
        break;
      case 'start_sneak':
        entity.serverSneaking = true;
        entity.sneaking = true;
        entity.inferredPose = 'sneaking';
        if (!entity.pose || entity.pose === 'standing') entity.pose = 'sneaking';
        break;
      case 'stop_sneak':
        entity.serverSneaking = false;
        entity.sneaking = false;
        entity.inferredPose = 'standing';
        if (entity.pose === 'sneaking') entity.pose = 'standing';
        break;
      case 'start_swimming':
        entity.swimming = true;
        entity.inferredPose = 'swimming';
        entity.pose = 'swimming';
        break;
      case 'stop_swimming':
        entity.swimming = false;
        entity.inferredPose = 'standing';
        if (entity.pose === 'swimming') entity.pose = 'standing';
        break;
      case 'start_glide':
        entity.gliding = true;
        entity.fallFlying = true;
        entity.inferredPose = 'fall_flying';
        entity.pose = 'fall_flying';
        break;
      case 'stop_glide':
        entity.gliding = false;
        entity.fallFlying = false;
        entity.inferredPose = 'standing';
        if (entity.pose === 'fall_flying') entity.pose = 'standing';
        break;
      case 'start_flying':
        entity.flying = true;
        break;
      case 'stop_flying':
        entity.flying = false;
        break;
      case 'jump':
        entity.jumpQueued = true;
        break;
      default:
        break;
    }

    botState.emit('entityAction', entity, packet.action, packet);
  });

  botState.client.on('update_attributes', (packet) => {
    const entity = findEntityByRuntimeId(botState, packet.runtime_entity_id);
    if (!entity) return;
    applyAttributes(entity, packet.attributes);
  });

  botState.client.on('update_abilities', (packet) => {
    if (!botState.self) return;
    const previous = flightSnapshot(botState.self);
    applyAbilities(botState.self, packet.abilities);
    emitFlightChanged(botState.self, previous, 'update_abilities', packet);
  });

  botState.client.on('adventure_settings', (packet) => {
    if (!botState.self) return;
    const previous = flightSnapshot(botState.self);
    applyAdventureSettings(botState.self, packet);
    emitFlightChanged(botState.self, previous, 'adventure_settings', packet);
  });

  botState.client.on('update_player_game_type', (packet) => {
    if (!botState.self) return;
    const previous = flightSnapshot(botState.self);
    botState.self.gamemode = packet.gamemode;
    botState.self.spectator = isSpectatorGameMode(packet.gamemode);
    if (botState.self.spectator) {
      botState.self.mayFly = true;
      botState.self.allowFlight = true;
      botState.self.flying = true;
    }
    botState.game.gameMode = normalizeGameMode(packet.gamemode);
    emitFlightChanged(botState.self, previous, 'update_player_game_type', packet);
  });

  botState.client.on('mob_effect', (packet) => {
    const entity = findEntityByRuntimeId(botState, packet.runtime_entity_id);
    if (!entity) return;
    applyMobEffect(entity, packet);
    botState.emit('entityEffect', entity, packet);
  });

  botState.client.on('movement_effect', (packet) => {
    const runtimeId = packet.runtime_id ?? packet.runtime_entity_id;
    const entity = findEntityByRuntimeId(botState, runtimeId);
    if (!entity) return;

    ensureEntityState(entity);
    entity.movementEffects[packet.effect_type] = {
      type: packet.effect_type,
      duration: Number(packet.effect_duration || 0),
      tick: packet.tick
    };

    if (isLikelyFireworkMovementEffect(packet.effect_type)) {
      entity.fireworkRocketDuration = Number(packet.effect_duration || 0);
    }

    botState.emit('entityMovementEffect', entity, packet);
  });

  botState.client.on('set_health', (packet) => {
    if (!botState.self) return;
    applyHealth(botState.self, packet);
  });

  botState.client.on('set_entity_link', (packet) => {
    const link = packet.link;
    const rider = findEntityByRuntimeId(botState, link.rider_entity_id);
    const vehicle = findEntityByRuntimeId(botState, link.ridden_entity_id);
    if (rider) rider.vehicle = vehicle || null;
    if (vehicle) {
      vehicle.passengers = vehicle.passengers || [];
      if (rider && !vehicle.passengers.includes(rider)) vehicle.passengers.push(rider);
    }
  });

  // Cleanup
  botState.client.on('close', () => {
    botState.entities.clear();
    botState.playerEntities.clear();
    botState.self = null;
  });

  // ========== Utility: nearestEntity ==========
  /**
   * Find the nearest entity to the bot that passes an optional filter.
   * @param {function} [filter=(entity) => true] - Called for each entity except botState.self.
   *   Should return true to consider the entity.
   * @returns {object|null} The nearest matching Entity, or null if none found
   *   or if the bot's own position is not known.
   */
  botState.nearestEntity = (filter = (entity) => true) => {
    if (!botState.self || !botState.self.position) return null;

    let best = null;
    let bestDistance = Number.MAX_VALUE;

    for (const [, entity] of botState.entities) {
      if (entity === botState.self || !filter(entity)) continue;
      const dist = botState.self.position.distanceSquared(entity.position);
      if (dist < bestDistance) {
        best = entity;
        bestDistance = dist;
      }
    }

    for (const [, player] of botState.playerEntities) {
      if (player === botState.self || !filter(player)) continue;
      const dist = botState.self.position.distanceSquared(player.position);
      if (dist < bestDistance) {
        best = player;
        bestDistance = dist;
      }
    }

    return best;
  };

  function isLikelyFireworkMovementEffect(effectType) {
    const s = String(effectType).toLowerCase();
    return s.includes('firework') || s.includes('rocket') || effectType === 0;
  }
};
