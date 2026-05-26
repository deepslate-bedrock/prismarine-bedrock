const { logAction, normalizeBedrockUuid, sameRuntimeId } = require('../utils');
const { Vec3 } = require('vec3');
const { applyEntityMetadata, applyHealth, flagsToBigInt, METADATA_FLAGS } = require('../entity-metadata');

/**
 * @param {import('../state')} botState
 * @param {object} options
 */
module.exports = (botState, options) => {
  const registry = botState.registry;
  const Item = botState.itemClass;

  botState.playerEntities ??= botState.players ?? new Map();

  // Player dimensions (same as mineflayer's constants)
  const PLAYER_HEIGHT = 1.8;
  const CROUCH_HEIGHT = 1.5;
  const PLAYER_WIDTH = 0.6;
  const PLAYER_EYEHEIGHT = Math.fround(1.62);
  const CROUCH_EYEHEIGHT = Math.fround(1.27);

  function ensurePlayerListMaps () {
    botState.playerList ??= new Map();
    botState.playerListByUuid ??= new Map();
  }

  // Player list records are identity/profile data from the server tab-list.
  // They are separate from botState.playerEntities, which stores live spawned
  // player Entity instances keyed by runtime entity id.
  botState.client.on('player_list', (packet) => {
    // packet.records is a PlayerRecords struct with { type, records_count, records, verified }
    const recordsContainer = packet.records;
    if (!recordsContainer || !Array.isArray(recordsContainer.records)) return;

    ensurePlayerListMaps();

    if (recordsContainer.type === 1 || recordsContainer.type === 'remove') {
      for (const record of recordsContainer.records) {
        const uuid = normalizeBedrockUuid(record.uuid);
        const listed = botState.playerListByUuid.get(uuid);
        if (listed?.username) botState.playerList.delete(listed.username);
        botState.playerListByUuid.delete(uuid);
      }
      return;
    }

    // Only 'add' records contain entity_unique_id and username.
    if (recordsContainer.type !== 0 && recordsContainer.type !== 'add') return;

    for (const record of recordsContainer.records) {
      const uuid = normalizeBedrockUuid(record.uuid);
      const listed = {
        uuid,
        rawUuid: record.uuid,
        username: record.username,
        displayName: record.username,
        entityUniqueId: record.entity_unique_id,
        xuid: record.xbox_user_id ?? record.xuid ?? '',
        platformChatId: record.platform_chat_id ?? '',
        buildPlatform: record.build_platform
      };

      botState.playerList.set(record.username, listed);
      botState.playerListByUuid.set(uuid, listed);
    }
  });

  // ========== Movement ==========
  botState.client.on('move_player', (packet) => {
    const entity = botState.playerEntities.get(packet.runtime_id);
    if (!entity) return;
    entity.position.set(packet.position.x, packet.position.y, packet.position.z);
    entity.yaw = packet.yaw;
    entity.pitch = packet.pitch;
    entity.onGround = packet.on_ground;
  });

  // Health (mirrors mineflayer's health.js pattern)
  botState.client.on('set_health', (packet) => {
    if (botState.self) applyHealth(botState.self, packet);
    logAction('[→]', 'set_health', { health: packet.health });
    botState.emit('health');
    if (packet.health <= 0) botState.emit('death');
  });

  // Respawn (update position after respawn)
  botState.client.on('respawn', (packet) => {
    if (botState.self && sameRuntimeId(packet.runtime_entity_id, botState.self.runtimeId)) return;
    const entity = botState.playerEntities.get(packet.runtime_entity_id);
    if (entity) {
      entity.position.set(packet.position.x, packet.position.y, packet.position.z);
      logAction('[→]', 'respawn', { id: packet.runtime_entity_id });
    }
  });

  // Spawn point (mirrors mineflayer's spawn_point.js)
  botState.client.on('set_spawn_position', (packet) => {
    botState.playerState ??= {};
    if (!botState.playerState.spawnPosition) botState.playerState.spawnPosition = new Vec3(0, 0, 0);
    botState.playerState.spawnPosition.set(packet.player_position.x, packet.player_position.y, packet.player_position.z);
    logAction('[→]', 'set_spawn_position', { pos: botState.playerState.spawnPosition });
    botState.emit('game');
  });

  // Equipment updates
  botState.client.on('mob_equipment', (packet) => {
    const entity = botState.playerEntities.get(packet.runtime_entity_id);
    if (!entity) return;
    entity.heldItem = Item.fromNotch(packet.item);
  });

  botState.client.on('mob_armor_equipment', (packet) => {
    const entity = botState.playerEntities.get(packet.runtime_entity_id);
    if (!entity) return;
    entity.equipment = [
      Item.fromNotch(packet.helmet),
      Item.fromNotch(packet.chestplate),
      Item.fromNotch(packet.leggings),
      Item.fromNotch(packet.boots),
      Item.fromNotch(packet.body)
    ];
  });

  // Animation
  botState.client.on('animate', (packet) => {
    const entity = botState.playerEntities.get(packet.runtime_entity_id);
    if (entity) botState.emit('playerAnimate', entity, packet.action_id);
  });

  // Crouch / uncrouch via metadata
  botState.client.on('set_entity_data', (packet) => {
    const entity = botState.playerEntities.get(packet.runtime_entity_id);
    if (!entity) return;
    applyEntityMetadata(entity, packet.metadata);
    const meta = packet.metadata;
    const flagMeta = Array.isArray(meta) ? meta.find(m => m.key === 0 || m.key === 'flags') : null;
    if (flagMeta) {
      const flags = flagsToBigInt(flagMeta.value, METADATA_FLAGS) ?? 0n;
      if (flags & 2n) {
        entity.eyeHeight = CROUCH_EYEHEIGHT;
        entity.height = CROUCH_HEIGHT;
        botState.emit('entityCrouch', entity);
      } else if (entity.eyeHeight !== PLAYER_EYEHEIGHT) {
        entity.eyeHeight = PLAYER_EYEHEIGHT;
        entity.height = PLAYER_HEIGHT;
        botState.emit('entityUncrouch', entity);
      }
    }
  });

  // Cleanup is handled by entityHandler's close listener (shared maps)
};
