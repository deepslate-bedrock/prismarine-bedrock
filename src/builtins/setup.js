const { logAction, sameRuntimeId } = require('../utils');
const { Vec3 } = require('vec3');
const buildIndexFromArray = require('prismarine-registry/lib/indexer');

function plainNbtValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('type' in value && 'value' in value) return plainNbtValue(value.value);
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, plainNbtValue(child)])
    );
  }

  return value;
}

function plainBlockStates(states = {}) {
  return Object.fromEntries(
    Object.entries(states).map(([key, value]) => [key, plainNbtValue(value)])
  );
}

function latencyTimestampToBigInt(timestamp) {
  if (typeof timestamp === 'bigint') return timestamp;
  return BigInt(timestamp);
}

function networkStackLatencyResponseTimestamp(timestamp) {
  const signedTimestamp = BigInt.asIntN(64, latencyTimestampToBigInt(timestamp));
  const responseTimestamp = signedTimestamp >= -5000000n && signedTimestamp <= 5000000n
    ? signedTimestamp * 1000000n
    : signedTimestamp;

  return BigInt.asUintN(64, responseTimestamp);
}

/**
 * Unified plugin: handles initial login sequence AND respawn after death.
 * @param {import('../state')} botState
 * @param {object} options
 */
module.exports = (botState, options) => {
  const client = botState.client;
  const registry = botState.registry;

  botState.lifecycle ??= {};
  botState.playerState ??= {};
  botState.protocolState ??= {};
  botState.game ??= {};

  // ── Shared state for respawn ──
  botState.lifecycle.isDead = false;
  botState.lifecycle.respawnTimeout = null;
  botState.playerState.health = null;
  botState.playerState.experience = 0;
  botState.playerState.experienceLevel = 0;
  botState.bedrockCraftingRecipes = [];
  botState.blockRuntimeIdsByName = {};

  // -- required because p-registry is bugged.
  function loadItemStates(itemStates) {
    const items = [];
    for (const item of itemStates) {
      const name = item.name.replace('minecraft:', '');
      items.push({ ...registry.itemsByName[name], name, id: item.runtime_id });
    }
    registry.itemsArray = items;
    registry.items = buildIndexFromArray(registry.itemsArray, 'id');
    registry.itemsByName = buildIndexFromArray(registry.itemsArray, 'name');
  }

  registry.loadItemStates = loadItemStates;

  function blockFromNetworkState(name, states) {
    try {
      const block = botState.blockClass.fromProperties(
        String(name).replace(/^minecraft:/, ''),
        plainBlockStates(states),
        0
      );
      if (block?.stateId != null) return block;
      if (block?.defaultState != null) return { ...block, stateId: block.defaultState };
      return block;
    } catch (err) {
      return null;
    }
  }

  function setRuntimeBlock(runtimeId, block) {
    if (!Number.isFinite(runtimeId) || block?.stateId == null) return;

    const registryBlock = registry.blocksByStateId?.[block.stateId];
    registry.blocksByRuntimeId[runtimeId] = {
      ...registryBlock,
      name: registryBlock?.name ?? block.name,
      stateId: block.stateId
    };
    registry.blockNetworkRuntimeIdsByStateId[block.stateId] = runtimeId;
  }

  function loadVersionedBlockRuntimeIds(useHashes) {
    for (let runtimeId = 0; runtimeId < (registry.blockStates?.length ?? 0); runtimeId++) {
      const networkState = registry.blockStates[runtimeId];
      if (!networkState?.name) continue;

      const block = blockFromNetworkState(networkState.name, networkState.states);
      const networkRuntimeId = useHashes
        ? botState.blockClass.getHash(networkState.name, networkState.states ?? {})
        : runtimeId;

      setRuntimeBlock(networkRuntimeId, block);
    }
  }

  function loadLocalStateBlockRuntimeIds() {
    for (const [stateIdKey, block] of Object.entries(registry.blocksByStateId ?? {})) {
      const stateId = Number(stateIdKey);
      setRuntimeBlock(stateId, { ...block, stateId });
    }
  }

  function loadLiveBlockRuntimeIds(blockProperties, useHashes) {
    if (!Array.isArray(blockProperties)) return;

    for (let runtimeId = 0; runtimeId < blockProperties.length; runtimeId++) {
      const entry = blockProperties[runtimeId];
      if (!entry?.name) continue;

      const states = entry.state?.value ?? entry.state ?? {};
      const block = blockFromNetworkState(entry.name, states);
      const networkRuntimeId = useHashes
        ? botState.blockClass.getHash(entry.name, states)
        : runtimeId;

      setRuntimeBlock(networkRuntimeId, block);
    }
  }

  function loadBlockNetworkRuntimeIds(packet) {
    const useHashes = !!packet.block_network_ids_are_hashes;
    const hasLiveRuntimePalette = Array.isArray(packet.block_properties) && packet.block_properties.length > 0;
    const idsAreLocalStateIds = !useHashes && !hasLiveRuntimePalette;

    botState.protocolState.hasLiveBlockRuntimePalette = hasLiveRuntimePalette;
    botState.protocolState.blockNetworkRuntimeIdsAreStateIds = idsAreLocalStateIds;
    registry.blockNetworkRuntimeIdsAreStateIds = idsAreLocalStateIds;
    registry.blocksByRuntimeId = {};
    registry.blockNetworkRuntimeIdsByStateId = {};
    if (idsAreLocalStateIds) {
      loadLocalStateBlockRuntimeIds();
    } else {
      loadVersionedBlockRuntimeIds(useHashes);
    }
    loadLiveBlockRuntimeIds(packet.block_properties, useHashes);
  }

  // ── Initial connection ──
  function queueAvailableCommandsReadyPackets() {
    if (botState.protocolState.sentAvailableCommandsReadyPackets) return;
    botState.protocolState.sentAvailableCommandsReadyPackets = true;

    client.queue('serverbound_loading_screen', { type: 1 });
    client.queue('serverbound_loading_screen', { type: 2 });
    client.queue('interact', {
      action_id: 'mouse_over_entity',
      target_entity_id: 0n,
      has_position: false,
    });
    client.queue('set_local_player_as_initialized', {
      runtime_entity_id: client.entityId,
    });

    logAction('[->]', 'available_commands ready handshake', {
      runtime_entity_id: String(client.entityId),
    });
  }

  client.on('connect_allowed', () => {
    logAction('[→]', 'connect', { host: options.host, port: options.port });
  });

  client.on('network_stack_latency', (packet) => {
    if (!packet.needs_response && !packet.needsResponse) return;

    client.queue('network_stack_latency', {
      timestamp: networkStackLatencyResponseTimestamp(packet.timestamp),
      needs_response: 0,
    });
  });

  // ── Start Game ──
  client.on('start_game', (pkt) => {
    // Current Bedrock protocol: start_game carries spawn info but NOT itemstates/block_states.
    botState.playerState.spawnPosition = new Vec3(
      pkt.player_position.x, pkt.player_position.y, pkt.player_position.z
    );
    botState.playerState.spawnRotation = pkt.rotation;
    botState.game.gameMode = pkt.player_gamemode;
    botState.setDimension(pkt.dimension);
    botState.protocolState.blockNetworkIdsAreHashes = !!pkt.block_network_ids_are_hashes;
    botState.playerState.health = 20;
    botState.lifecycle.isDead = false;

    pkt.itemstates ??= [];
    registry.handleStartGame(pkt);
    loadBlockNetworkRuntimeIds(pkt);

    logAction('[←]', 'start_game', {
      entity_id: String(pkt.entity_id),
      runtime_entity_id: String(pkt.runtime_entity_id),
      pos: botState.playerState.spawnPosition,
      rotation: botState.playerState.spawnRotation,
      gamemode: botState.game.gameMode,
      block_network_ids_are_hashes: !!pkt.block_network_ids_are_hashes,
      block_properties: pkt.block_properties?.length ?? 0,
      server_authoritative_inventory: !!pkt.server_authoritative_inventory,
    });
  });

  // ── Item Registry ──
  client.on('item_registry', (packet) => {
    logAction('[←]', 'item_registry', { count: packet.itemstates.length });
    registry.loadItemStates(packet.itemstates);
  });

  // ── Creative Content ──
  client.on('creative_content', (packet) => {
    logAction('[←]', 'creative_content', {
      groups: packet.groups.length,
      items: packet.items.length,
    });
    botState.creativeItems = packet.items;
    for (const entry of packet.items || []) {
      const item = entry.item ?? entry;
      const id = item?.network_id ?? item?.id;
      const name = registry.items?.[id]?.name ?? item?.name;
      const runtimeId = item?.block_runtime_id ?? item?.blockRuntimeId;
      if (name && Number.isFinite(runtimeId) && runtimeId !== 0) {
        botState.blockRuntimeIdsByName[String(name).replace(/^minecraft:/, '')] = runtimeId;
      }
    }
  });

  // ── Biome Definition List ──
  client.on('biome_definition_list', (packet) => {
    logAction('[←]', 'biome_definition_list', {
      count: packet.biome_definitions.length,
    });
    // Store if needed: botState.biomeStringList = packet.string_list;
  });

  // Bedrock clients acknowledge command availability during the initial loading/client-ready sequence.
  client.on('available_commands', () => {
    queueAvailableCommandsReadyPackets();
  });

  // Bedrock server-authoritative recipes used by crafting/trading packet senders.
  client.on('crafting_data', packet => {
    const recipes = packet.recipes || [];
    botState.bedrockCraftingRecipes.push(...recipes);
    for (const entry of recipes) {
      const recipe = entry?.recipe || entry;
      const outputs = Array.isArray(recipe?.output)
        ? recipe.output
        : recipe?.output
          ? [recipe.output]
          : [];

      for (const output of outputs) {
        const id = output?.network_id ?? output?.id;
        const name = registry.items?.[id]?.name ?? output?.name;
        const runtimeId = output?.block_runtime_id ?? output?.blockRuntimeId;
        if (name && Number.isFinite(runtimeId) && runtimeId !== 0) {
          botState.blockRuntimeIdsByName[String(name).replace(/^minecraft:/, '')] = runtimeId;
        }
      }
    }
    if (!options.quietCraftingDataLog) {
      logAction('[craft]', 'crafting_data', { recipes: botState.bedrockCraftingRecipes.length });
    }
  });

  // ── Play Status (player_spawn → request_chunk_radius + set_local_player_as_initialized) ──
  client.on('play_status', (packet) => {
    if (packet.status === 'player_spawn') {
      logAction('[←]', 'play_status', { status: 'player_spawn' });

      if (options.worldDecodeEnabled !== false) {
        // Tell the server our desired view radius (must be sent before or after spawn)
        // The server will respond with chunks around the player.
        client.queue('request_chunk_radius', {
          chunk_radius: options.chunkRadius ?? 6,
          max_radius: 0, // ignored by server
        });
      }

      // Mark client as initialized
      client.queue('set_local_player_as_initialized', {
        runtime_entity_id: client.entityId,
      });
    }
  });

  // ── Health updates (from any source, including respawn) ──
  client.on('set_health', (packet) => {
    botState.playerState.health = packet.health;
    logAction('[←]', 'set_health', {
      health: botState.playerState.health,
      isDead: botState.lifecycle.isDead,
    });
    if (botState.playerState.health > 0 && botState.lifecycle.isDead) {
      botState.lifecycle.isDead = false;
      logAction('[→]', 'set_health -> alive');
    }
  });

  client.on('game_rules_changed', (packet) => {
    botState.game.gamerules = packet.gamerules ?? packet.rules ?? packet;
  });

  client.on('change_dimension', (packet) => {
    botState.setDimension(packet.dimension);
  });

  client.on('update_attributes', (packet) => {
    if (!sameRuntimeId(packet.runtime_entity_id, client.entityId)) return;

    for (const attr of packet.attributes || []) {
      if (attr.name === 'minecraft:player.experience') {
        botState.playerState.experience = attr.current ?? attr.value ?? 0;
      } else if (attr.name === 'minecraft:player.level') {
        botState.playerState.experienceLevel = attr.current ?? attr.value ?? 0;
      }
    }
  });

  // ── Death Info ──
  client.on('death_info', (packet) => {
    if (botState.lifecycle.isDead) return;
    botState.lifecycle.isDead = true;
    botState.playerState.health = 0;
    logAction('[←]', 'death_info', {
      cause: packet.cause,
      message: packet.messages?.[0],
    });
    scheduleRespawn(300);
  });

  // ── Respawn handshake ──
  client.on('respawn', (packet) => {
    logAction('[←]', 'respawn', { state: packet.state, position: packet.position });

    clearTimeout(botState.lifecycle.respawnTimeout);

    if (packet.state === 0) {
      // Server sent state 0 (dimension change or death response) – ack with state 1
      logAction('[→]', 'respawn(state=1 ack)');
      client.queue('respawn', {
        position: packet.position,
        state: 1,
        runtime_entity_id: client.entityId,
      });

      botState.lifecycle.respawnTimeout = setTimeout(() => {
        logAction('[→]', 'respawn(state=2) fallback after server state=0');
        client.queue('respawn', {
          position: packet.position,
          state: 2,
          runtime_entity_id: client.entityId,
        });
        client.queue('set_local_player_as_initialized', {
          runtime_entity_id: client.entityId,
        });
      }, 2000);
      return;
    }

    if (packet.state === 1) {
      clearTimeout(botState.lifecycle.respawnTimeout);
      logAction('[→]', 'respawn(state=2 ack) + set_local_player_as_initialized');
      client.queue('respawn', {
        position: packet.position,
        state: 2,
        runtime_entity_id: client.entityId,
      });
      client.queue('set_local_player_as_initialized', {
        runtime_entity_id: client.entityId,
      });
      return;
    }

    logAction('[←]', 'respawn', { msg: 'unknown state', state: packet.state });
  });

  // ── Spawn (indicates respawn completion) ──
  client.on('spawn', () => {
    if (botState.lifecycle.isDead) {
      logAction('[←]', 'spawn', { msg: 'respawn completed' });
      botState.lifecycle.isDead = false;
      botState.playerState.health = 20;
    } else {
      logAction('[←]', 'spawn', { msg: 'initial join' });
    }
  });

  // ── Error & close ──
  client.on('error', (err) => {
    console.error('Client error:', err);
  });

  client.on('close', () => {
    logAction('[→]', 'close', { msg: 'Connection closed' });
  });

  process.on('SIGINT', () => botState.disconnect('User interrupted'));
  process.on('SIGTERM', () => botState.disconnect('Process terminated'));

  // ── Internal helpers ──
  function scheduleRespawn(delay = 300) {
    clearTimeout(botState.lifecycle.respawnTimeout);
    botState.lifecycle.respawnTimeout = setTimeout(() => {
      if (!botState.lifecycle.isDead) {
        logAction('[→]', 'respawn', { msg: 'skipped – already alive' });
        return;
      }
      // Start respawn with state=0 (request to server)
      logAction('[→]', 'respawn(state=0) request');
      client.queue('respawn', {
        position: { x: 0, y: 0, z: 0 },
        state: 0,
        runtime_entity_id: client.entityId,
      });

      // Fallback: if no server reply within 1.5s, force state=2 + init
      botState.lifecycle.respawnTimeout = setTimeout(() => {
        if (!botState.lifecycle.isDead) return;
        logAction('[→]', 'respawn(state=2) fallback after no server state=1 response');
        client.queue('respawn', {
          position: { x: 0, y: 0, z: 0 },
          state: 2,
          runtime_entity_id: client.entityId,
        });
        client.queue('set_local_player_as_initialized', {
          runtime_entity_id: client.entityId,
        });
      }, 1500);
    }, delay);
  }
};
