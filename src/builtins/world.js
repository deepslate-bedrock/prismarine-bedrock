const Vec3 = require('vec3').Vec3;
const nbt = require('prismarine-nbt');
const { getStateId, normalizeBlockPos, sameRuntimeId, withLayer } = require('../utils');

// ── Helper types for blob store ──
const BlobType = { ChunkSection: 0, Biomes: 1 };

/**
 * @param {import('../state')} botState
 * @param {object} [options]
 */
module.exports = (botState, options = {}) => {
  const client = botState.client;
  const registry = botState.registry;
  const ChunkColumn = botState.chunkColumn;
  botState.worldSettings ??= {};
  botState.chunkState ??= {};
  botState.protocolState ??= {};
  botState.game ??= {};
  botState.playerState ??= {};

  botState.resetWorld = () => {
    botState.world = new botState.worldClass(null);
    return botState.world;
  };

  botState.setDimension = (dimension, options = {}) => {
    const changed = botState.game.dimension !== dimension;
    botState.game.dimension = dimension;
    if (changed && options.resetWorld) botState.resetWorld();
    return changed;
  };

  if (options.worldDecodeEnabled === false || botState.options?.worldDecodeEnabled === false) return;

  // Bedrock modern overworld height.
  //
  // Note:
  // prismarine-chunk's Bedrock 1.18+ ChunkColumn already knows about minCY=-4
  // internally, but its networkDecodeNoCache path may still insert decoded
  // packet section 0 as absolute sectionY=0. We normalize after decode below.
  const WORLD_MIN_Y =
    options.minY ??
    options.worldMinY ??
    botState.worldSettings?.minY ??
    -64;

  const WORLD_HEIGHT =
    options.worldHeight ??
    botState.worldSettings?.height ??
    384;
  const WORLD_MIN_SECTION_Y = Math.floor(WORLD_MIN_Y / 16);
  const WORLD_MAX_SECTION_Y = Math.floor((WORLD_MIN_Y + WORLD_HEIGHT - 1) / 16);

  botState.worldSettings.minY = WORLD_MIN_Y;
  botState.worldSettings.height = WORLD_HEIGHT;
  botState.worldSettings.minSectionY = WORLD_MIN_SECTION_Y;
  botState.worldSettings.maxSectionY = WORLD_MAX_SECTION_Y;

  function createChunkColumn(cx, cz) {
    return new ChunkColumn({
      x: cx,
      z: cz,
      minY: WORLD_MIN_Y,
      worldHeight: WORLD_HEIGHT
    }, registry);
  }

  /**
   * Prismarine's Bedrock 1.18+ full level_chunk no-cache decoder can decode
   * packet subchunk index 0 into absolute sectionY=0.
   *
   * In a modern overworld, the bottom packet section should map to minCY:
   *
   *   packet section 0 -> sectionY=-4
   *   packet section 1 -> sectionY=-3
   *   packet section 2 -> sectionY=-2
   *   packet section 3 -> sectionY=-1
   *   packet section 4 -> sectionY=0
   *
   * CommonChunkColumn stores sectionY via:
   *
   *   sections[co + sectionY]
   *
   * so if co=4, a mistaken setSection(0, section) lands at sections[4].
   *
   * This function only corrects the clear broken case:
   *   - negative-Y chunk
   *   - bottom backing slot is empty
   *   - decoded data starts at index co
   */
  function normalizeBedrockFullChunkSections(chunk, sectionCount) {
    if (!chunk || !chunk.sections) return;
    if (sectionCount < 0) return;

    const minCY = chunk.minCY ?? Math.floor(WORLD_MIN_Y / 16);
    const co = chunk.co ?? Math.abs(minCY);

    if (minCY >= 0 || co <= 0) return;

    // Already correctly populated at bottom.
    if (chunk.sections[0]) return;

    // Broken full-chunk decode signature we observed:
    // decoded sectionY=0 exists at index co.
    if (!chunk.sections[co]) return;

    const shifted = new Array(chunk.sections.length).fill(null);

    for (let packetSectionIndex = 0; packetSectionIndex < sectionCount; packetSectionIndex++) {
      const sourceSectionY = packetSectionIndex;
      const sourceIndex = co + sourceSectionY;

      const targetSectionY = minCY + packetSectionIndex;
      const targetIndex = co + targetSectionY;

      if (
        sourceIndex < 0 ||
        sourceIndex >= chunk.sections.length ||
        targetIndex < 0 ||
        targetIndex >= shifted.length
      ) {
        continue;
      }

      const section = chunk.sections[sourceIndex] || null;

      if (section) {
        // Keep any downstream metadata-based lookups consistent.
        section.y = targetSectionY;
        section.chunkY = targetSectionY;
        section.sectionY = targetSectionY;
      }

      shifted[targetIndex] = section;
    }

    chunk.sections = shifted;
  }

  // ── Blob cache & pending requests ──
  if (!botState.blobCache) botState.blobCache = new Map(); // hash string → Buffer
  if (!botState.pendingBlobRequests) botState.pendingBlobRequests = new Map();
  if (!botState.networkChunks) botState.networkChunks = new Map();
  if (!botState.pendingSubchunkRequests) botState.pendingSubchunkRequests = new Map();

  // These track actual decoded block data, not merely column existence.
  if (!botState.loadedChunks) botState.loadedChunks = new Set(); // "cx,cz" after full chunk decode
  if (!botState.loadedChunkSections) botState.loadedChunkSections = new Map(); // "cx,cz" → Set<sectionY>

  function resetActiveWorldState(dimension) {
    botState.setDimension(dimension, { resetWorld: true });

    botState.blobCache.clear();
    botState.pendingBlobRequests.clear();
    botState.networkChunks.clear();
    botState.pendingSubchunkRequests.clear();
    botState.loadedChunks.clear();
    botState.loadedChunkSections.clear();
    botState.chunkState.count = 0;
    botState.chunkState.rawPublisherCenter = null;
    botState.chunkState.publisherCenter = null;
    botState.chunkState.publisherRadius = null;
  }

  botState.getBlock = async (...args) => {
    const pos = normalizeBlockPos(...args);
    return botState.world.getBlock(pos);
  };

  botState.getBlockStateIdAt = (...args) => {
    const pos = normalizeBlockPos(...args);
    return botState.world.getBlockStateId(pos);
  };

  botState.setBlockStateIdAt = async (...args) => {
    const stateId = args[args.length - 1];
    const pos = normalizeBlockPos(...args.slice(0, -1));

    await botState.world.setBlockStateId(pos, stateId);
    return true;
  };

  function chunkKey(cx, cz) {
    return `${cx},${cz}`;
  }

  function markFullChunkLoaded(cx, cz) {
    botState.loadedChunks.add(chunkKey(cx, cz));
  }

  function markChunkSectionLoaded(cx, cz, sectionY) {
    const key = chunkKey(cx, cz);
    let set = botState.loadedChunkSections.get(key);

    if (!set) {
      set = new Set();
      botState.loadedChunkSections.set(key, set);
    }

    set.add(sectionY);

    const pending = botState.pendingSubchunkRequests.get(key);
    if (!pending) return;

    pending.sectionYs.delete(sectionY);
    if (pending.sectionYs.size === 0) {
      botState.pendingSubchunkRequests.delete(key);
    }
  }

  function markChunkSectionsLoadedAbove(cx, cz, highestSectionY) {
    if (!Number.isInteger(highestSectionY)) return;

    for (let sectionY = highestSectionY + 1; sectionY <= WORLD_MAX_SECTION_Y; sectionY++) {
      markChunkSectionLoaded(cx, cz, sectionY);
    }
  }

  function isSubChunkSuccess(result) {
    return result === 1 || result === 'success';
  }

  function isSubChunkAllAir(result) {
    return result === 6 || result === 'success_all_air';
  }

  function zigZagDecode(value) {
    if (!Number.isInteger(value) || value < 0) return value;
    return value % 2 === 0 ? value / 2 : -((value + 1) / 2);
  }

  function normalizeNetworkChunkPublisherCoordinates(coordinates) {
    if (!coordinates) return coordinates;

    const rawY = coordinates.y;
    const decodedY = zigZagDecode(rawY);
    const rawSectionY = sectionYFromWorldY(rawY);
    const decodedSectionY = sectionYFromWorldY(decodedY);
    let y = decodedY;

    if (usesDirectNetworkChunkPublisherY() && rawSectionY !== undefined) {
      y = rawY;
    } else if (rawSectionY !== undefined && decodedSectionY === undefined) {
      y = rawY;
    }

    return {
      x: coordinates.x,
      y,
      z: coordinates.z
    };
  }

  function usesDirectNetworkChunkPublisherY() {
    const match = String(botState.version || '').match(/^1\.(\d+)\./);
    return match ? Number(match[1]) >= 26 : false;
  }

  function signedBlockCoordinateY(value) {
    if (typeof value === 'bigint') return Number(BigInt.asIntN(32, value));
    if (!Number.isFinite(value)) return value;
    if (value <= 0x7fffffff) return value;
    return Number(BigInt.asIntN(32, BigInt(Math.trunc(value))));
  }

  function chunkPublisherSectionY() {
    const y = botState.chunkState.publisherCenter?.y;
    return sectionYFromWorldY(y);
  }

  function readinessSectionY(center) {
    return chunkPublisherSectionY() ?? sectionYFromWorldY(center?.y) ?? WORLD_MIN_SECTION_Y;
  }

  function sectionYFromWorldY(y) {
    if (!Number.isFinite(y)) return undefined;

    const sectionY = Math.floor(y / 16);
    if (sectionY < WORLD_MIN_SECTION_Y || sectionY > WORLD_MAX_SECTION_Y) return undefined;

    return sectionY;
  }

  function isChunkBlockDataLoaded(cx, cz, requiredSectionYs = undefined) {
    const key = chunkKey(cx, cz);

    // Full chunk decode means all included sections for that column were decoded.
    if (botState.loadedChunks.has(key)) return true;

    const loadedSections = botState.loadedChunkSections.get(key);
    if (!loadedSections || loadedSections.size === 0) return false;

    // If no vertical section requirement was provided, at least one decoded
    // section proves this is not just an empty placeholder column.
    if (!requiredSectionYs || requiredSectionYs.length === 0) return true;

    for (const sectionY of requiredSectionYs) {
      if (!loadedSections.has(sectionY)) return false;
    }

    return true;
  }

  function chunkAreaLoadState(
    radius = 6,
    center = undefined,
    verticalSectionRadius = 1
  ) {
    const pos = center || (
      botState.playerState.spawnPosition
        ? new Vec3(
          botState.playerState.spawnPosition.x,
          botState.playerState.spawnPosition.y,
          botState.playerState.spawnPosition.z
        )
        : new Vec3(0, WORLD_MIN_Y, 0)
    );

    const minCX = Math.floor((pos.x - radius) / 16);
    const maxCX = Math.floor((pos.x + radius) / 16);
    const minCZ = Math.floor((pos.z - radius) / 16);
    const maxCZ = Math.floor((pos.z + radius) / 16);

    const centerSectionY = readinessSectionY(pos);
    const requiredSectionYs = [];

    for (let dy = -verticalSectionRadius; dy <= verticalSectionRadius; dy++) {
      const sectionY = centerSectionY + dy;

      if (sectionY >= WORLD_MIN_SECTION_Y && sectionY <= WORLD_MAX_SECTION_Y) {
        requiredSectionYs.push(sectionY);
      }
    }

    const required = new Set();

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        required.add(chunkKey(cx, cz));
      }
    }

    const missing = [];

    for (const key of required) {
      const [cxRaw, czRaw] = key.split(',');
      const cx = Number(cxRaw);
      const cz = Number(czRaw);

      if (!isChunkBlockDataLoaded(cx, cz, requiredSectionYs)) {
        missing.push(key);
      }
    }

    return {
      loaded: missing.length === 0,
      missing,
      required
    };
  }

  function requestChunkRadius() {
    client.queue('request_chunk_radius', {
      chunk_radius: options.chunkRadius ?? 6,
      max_radius: 0
    });
  }

  function requestChunkDataAround(center, radius = options.chunkRefreshRadius ?? options.chunkRadius ?? 6, verticalSectionRadius = 1) {
    if (!center) return;

    requestChunkRadius();

    if (!botState.protocolState.blockNetworkIdsAreHashes && !options.teleportSubchunkRequests) return;

    const minCX = Math.floor((center.x - radius) / 16);
    const maxCX = Math.floor((center.x + radius) / 16);
    const minCZ = Math.floor((center.z - radius) / 16);
    const maxCZ = Math.floor((center.z + radius) / 16);
    const originSectionY = sectionYFromWorldY(center.y) ?? subchunkOriginSectionY();
    const sectionYs = subchunkSectionYsAround(originSectionY, verticalSectionRadius);
    const dimension = botState.game.dimension ?? 0;

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        const missingSectionYs = sectionYs.filter(sectionY => !isChunkBlockDataLoaded(cx, cz, [sectionY]));
        if (missingSectionYs.length === 0) continue;

        rememberSubchunkRequest(cx, cz, dimension, originSectionY, missingSectionYs);
        queueSubchunkRequest(cx, cz, dimension, missingSectionYs, originSectionY);
      }
    }
  }

  // ── Apply blob data to a pending chunk or subchunk ──
  function dispatchBlobReceived(hash, payload) {
    const key = hash.toString();
    botState.blobCache.set(key, payload);

    const pending = botState.pendingBlobRequests.get(key);
    if (!pending) return;

    const { type, cx, cz, sectionY, extraBlobs } = pending;

    if (type === 'level_chunk') {
      const allPresent = extraBlobs.every(b => botState.blobCache.has(b.toString()));
      if (!allPresent) return;

      let chunk = botState.networkChunks.get(chunkKey(cx, cz));
      if (!chunk) {
        chunk = createChunkColumn(cx, cz);
      }

      const blobStore = {
        has: (h) => botState.blobCache.has(h.toString()),
        get: (h) => ({
          buffer: botState.blobCache.get(h.toString()),
          type: BlobType.ChunkSection,
          x: cx,
          z: cz
        })
      };

      const blobs = extraBlobs;
      const payloadBuf = pending.payloadBuffer;

      botState.networkChunks.set(chunkKey(cx, cz), chunk);

      chunk.networkDecode(blobs, blobStore, payloadBuf)
        .then(async misses => {
          if (misses.length > 0) {
            requestMissingBlobs(misses);
          } else {
            await botState.world.setColumn(cx, cz, chunk);
            markFullChunkLoaded(cx, cz);
          }
        })
        .catch(err => console.error('level_chunk blob decode error:', err));
    } else if (type === 'subchunk') {
      const allPresent = extraBlobs.every(b => botState.blobCache.has(b.toString()));
      if (!allPresent) return;

      let chunk = botState.networkChunks.get(chunkKey(cx, cz));
      if (!chunk) {
        chunk = createChunkColumn(cx, cz);
        botState.networkChunks.set(chunkKey(cx, cz), chunk);
      }

      const blobStore = {
        has: (h) => botState.blobCache.has(h.toString()),
        get: (h) => ({
          buffer: botState.blobCache.get(h.toString()),
          type: BlobType.ChunkSection,
          x: cx,
          z: cz
        })
      };

      chunk.networkDecodeSubChunk(extraBlobs, blobStore, pending.payloadBuffer)
        .then(async misses => {
          if (misses.length > 0) {
            requestMissingBlobs(misses);
          } else {
            await botState.world.setColumn(cx, cz, chunk);
            markChunkSectionLoaded(cx, cz, sectionY);
          }
        })
        .catch(err => console.error('subchunk blob decode error:', err));
    }

    botState.pendingBlobRequests.delete(key);
  }

  // ── Send ClientCacheBlobStatus for missing blobs ──
  function requestMissingBlobs(missingHashes) {
    if (missingHashes.length === 0) return;

    client.queue('client_cache_blob_status', {
      misses: missingHashes.length,
      haves: 0,
      missing: missingHashes,
      have: []
    });
  }

  function subchunkOriginSectionY() {
    return (
      chunkPublisherSectionY() ??
      sectionYFromWorldY(botState.self?.position?.y) ??
      WORLD_MIN_SECTION_Y
    );
  }

  function subchunkSectionYsAround(originSectionY, verticalSectionRadius = 1) {
    const sectionYs = [];

    for (let dy = -verticalSectionRadius; dy <= verticalSectionRadius; dy++) {
      const sectionY = originSectionY + dy;

      if (sectionY >= WORLD_MIN_SECTION_Y && sectionY <= WORLD_MAX_SECTION_Y) {
        sectionYs.push(sectionY);
      }
    }

    return sectionYs;
  }

  function subchunkSectionYsThroughHighest(highestSectionY) {
    const sectionYs = [];
    const highest = Math.min(highestSectionY, WORLD_MAX_SECTION_Y);

    for (let sectionY = WORLD_MIN_SECTION_Y; sectionY <= highest; sectionY++) {
      sectionYs.push(sectionY);
    }

    return sectionYs;
  }

  function levelChunkPollingSectionYs(packet, originSectionY) {
    if (
      packet.sub_chunk_count === -2 &&
      Number.isInteger(packet.highest_subchunk_count)
    ) {
      return subchunkSectionYsThroughHighest(packet.highest_subchunk_count);
    }

    return subchunkSectionYsAround(originSectionY);
  }

  function queueSubchunkRequest(cx, cz, dimension, sectionYs = undefined, originSectionY = undefined) {
    originSectionY ??= subchunkOriginSectionY();
    const requestOffsets = [];

    const requestedSectionYs = sectionYs?.length
      ? sectionYs
      : subchunkSectionYsAround(originSectionY);

    for (const sectionY of requestedSectionYs) {
      requestOffsets.push({ dx: 0, dy: sectionY - originSectionY, dz: 0 });
    }

    client.queue('subchunk_request', {
      dimension,
      origin: {
        x: cx,
        y: originSectionY,
        z: cz
      },
      requests: requestOffsets
    });
  }

  function rememberSubchunkRequest(cx, cz, dimension, originSectionY, sectionYs) {
    botState.pendingSubchunkRequests.set(chunkKey(cx, cz), {
      cx,
      cz,
      dimension,
      originSectionY,
      sectionYs: new Set(sectionYs)
    });
  }

  function retryPendingSubchunkRequests() {
    for (const request of botState.pendingSubchunkRequests.values()) {
      const missingSectionYs = [...request.sectionYs]
        .filter(sectionY => !isChunkBlockDataLoaded(request.cx, request.cz, [sectionY]));

      if (missingSectionYs.length === 0) {
        botState.pendingSubchunkRequests.delete(chunkKey(request.cx, request.cz));
        continue;
      }

      queueSubchunkRequest(request.cx, request.cz, request.dimension, missingSectionYs, request.originSectionY);
    }
  }

  // ── level_chunk (0x3a) ──
  client.on('level_chunk', async (packet) => {
    const cx = packet.x;
    const cz = packet.z;
    const sectionCount = packet.sub_chunk_count;
    const dimension = packet.dimension ?? botState.game.dimension ?? 0;

    let chunk = botState.networkChunks.get(chunkKey(cx, cz));
    if (!chunk) chunk = createChunkColumn(cx, cz);

    try {
      if (sectionCount >= 0 && !packet.cache_enabled) {
        // Non-cached full chunk.
        chunk.networkDecodeNoCache(packet.payload, sectionCount);
        normalizeBedrockFullChunkSections(chunk, sectionCount);

        await botState.world.setColumn(cx, cz, chunk);
        botState.networkChunks.set(chunkKey(cx, cz), chunk);
        markFullChunkLoaded(cx, cz);
      } else if (sectionCount >= 0 && packet.cache_enabled) {
        // Cached chunk
        const blobs = packet.blobs?.hashes || [];
        const payloadWithoutBlobs = packet.payload;

        const missing = blobs.filter(h => !botState.blobCache.has(h.toString()));

        if (missing.length > 0) {
          for (const h of missing) {
            botState.pendingBlobRequests.set(h.toString(), {
              type: 'level_chunk',
              cx,
              cz,
              sectionY: null,
              extraBlobs: blobs,
              payloadBuffer: payloadWithoutBlobs
            });
          }

          requestMissingBlobs(missing);
        } else {
          const blobStore = {
            has: (h) => botState.blobCache.has(h.toString()),
            get: (h) => ({
              buffer: botState.blobCache.get(h.toString()),
              type: BlobType.ChunkSection,
              x: cx,
              z: cz
            })
          };

          const misses = await chunk.networkDecode(blobs, blobStore, payloadWithoutBlobs);

          if (misses.length > 0) {
            requestMissingBlobs(misses);
          } else {
            await botState.world.setColumn(cx, cz, chunk);
            botState.networkChunks.set(chunkKey(cx, cz), chunk);
            markFullChunkLoaded(cx, cz);
          }
        }
      } else if (sectionCount < 0) {
        // Negative count: subchunk polling mode.
        // This creates a placeholder column, but does NOT mark it loaded.
        if (!chunk.sections.length) {
          await botState.world.setColumn(cx, cz, chunk);
        }

        const originSectionY = subchunkOriginSectionY();
        const sectionYs = levelChunkPollingSectionYs(packet, originSectionY);
        if (packet.sub_chunk_count === -2) {
          markChunkSectionsLoadedAbove(cx, cz, packet.highest_subchunk_count);
        }
        rememberSubchunkRequest(cx, cz, dimension, originSectionY, sectionYs);
        queueSubchunkRequest(cx, cz, dimension, sectionYs, originSectionY);

        botState.networkChunks.set(chunkKey(cx, cz), chunk);
      } else {
        console.warn(`level_chunk unknown mode: count=${sectionCount}, cache=${packet.cache_enabled}`);
      }

      botState.chunkState.count = botState.networkChunks.size;
    } catch (err) {
      console.error('level_chunk decode error:', err);
    }
  });

  // ── subchunk (0xae) ──
  client.on('subchunk', async (pkt) => {
    const originSectionX = pkt.origin.x;
    const originSectionY = pkt.origin.y;
    const originSectionZ = pkt.origin.z;

    for (const entry of pkt.entries) {
      if (!isSubChunkSuccess(entry.result) && !isSubChunkAllAir(entry.result)) continue;

      const cx = originSectionX + entry.dx;
      const sectionY = originSectionY + entry.dy;
      const cz = originSectionZ + entry.dz;

      let chunk = botState.networkChunks.get(chunkKey(cx, cz));

      if (!chunk) {
        chunk = createChunkColumn(cx, cz);
        await botState.world.setColumn(cx, cz, chunk);
        botState.networkChunks.set(chunkKey(cx, cz), chunk);
      }

      if (isSubChunkAllAir(entry.result)) {
        markChunkSectionLoaded(cx, cz, sectionY);
        continue;
      }

      if (!pkt.cache_enabled) {
        // Non-cached subchunk
        await chunk.networkDecodeSubChunkNoCache(sectionY, entry.payload);
        await botState.world.setColumn(cx, cz, chunk);
        botState.networkChunks.set(chunkKey(cx, cz), chunk);
        markChunkSectionLoaded(cx, cz, sectionY);
      } else {
        // Cached subchunk
        const blobHash = entry.blob_id;

        if (blobHash == null) {
          console.warn('subchunk cached entry without blob_id');
          continue;
        }

        const hashKey = blobHash.toString();

        if (botState.blobCache.has(hashKey)) {
          const blobStore = {
            has: (h) => botState.blobCache.has(h.toString()),
            get: (h) => ({
              buffer: botState.blobCache.get(h.toString()),
              type: BlobType.ChunkSection,
              x: cx,
              z: cz
            })
          };

          const misses = await chunk.networkDecodeSubChunk(
            [blobHash],
            blobStore,
            entry.payload
          );

          if (misses.length > 0) {
            requestMissingBlobs(misses);
          } else {
            await botState.world.setColumn(cx, cz, chunk);
            botState.networkChunks.set(chunkKey(cx, cz), chunk);
            markChunkSectionLoaded(cx, cz, sectionY);
          }
        } else {
          botState.pendingBlobRequests.set(hashKey, {
            type: 'subchunk',
            cx,
            cz,
            sectionY,
            extraBlobs: [blobHash],
            payloadBuffer: entry.payload
          });

          requestMissingBlobs([blobHash]);
        }
      }
    }
  });

  // ── client_cache_miss_response (0x88) ──
  client.on('client_cache_miss_response', (pkt) => {
    for (const blob of pkt.blobs) {
      dispatchBlobReceived(blob.hash, blob.payload);
    }
  });

  // ── Single block updates ──
  function blockUpdateStateId(blockRuntimeId) {
    if (
      !botState.protocolState.blockNetworkIdsAreHashes &&
      !botState.protocolState.hasLiveBlockRuntimePalette &&
      registry.blocksByStateId?.[blockRuntimeId]
    ) {
      // Geyser may omit start_game.block_properties while still sending
      // non-hash block_runtime_id values in update_block packets. Those
      // values describe Geyser's own Java-translated Bedrock palette, which
      // can drift from this package's installed minecraft-data blockStates
      // order. Without a live palette, remapping through blocksByRuntimeId can
      // shift IDs by a state or more (stone became smooth_sandstone_slab in
      // the container trace). The only stable local value available in this
      // mode is the numeric state ID already carried by the packet.
      return blockRuntimeId;
    }

    return getStateId(registry, blockRuntimeId);
  }

  async function applySingleBlockUpdate(position, blockRuntimeId) {
    const stateId = blockUpdateStateId(blockRuntimeId);

    if (stateId === undefined) {
      console.warn(`Unknown block runtime id ${blockRuntimeId}, skipping`);
      return;
    }

    const pos = withLayer(new Vec3(
      position.x,
      signedBlockCoordinateY(position.y),
      position.z
    ));
    const chunk = await botState.world.getColumnAt(pos);

    if (!chunk) {
      console.warn(`Chunk not loaded at ${pos}, cannot apply block update`);
      return;
    }

    await botState.setBlockStateIdAt(pos.x, pos.y, pos.z, stateId);
  }

  client.on('update_block', async (pkt) => {
    if (pkt.layer !== 0) return;
    await applySingleBlockUpdate(pkt.position, pkt.block_runtime_id);
  });

  client.on('update_block_synced', async (pkt) => {
    if (pkt.layer !== 0) return;
    await applySingleBlockUpdate(pkt.position, pkt.block_runtime_id);
  });

  client.on('update_subchunk_blocks', async (pkt) => {
    for (const entry of pkt.blocks) {
      await applySingleBlockUpdate(entry.position, entry.runtime_id);
    }
  });

  // ── block_entity_data (0x38) ──
  client.on('block_entity_data', async (pkt) => {
    const pos = new Vec3(pkt.position.x, pkt.position.y, pkt.position.z);
    const localPos = new Vec3(pos.x & 15, pos.y, pos.z & 15);
    const chunk = await botState.world.getColumnAt(pos);

    if (!chunk) return;

    chunk.setBlockEntity(localPos, pkt.nbt);
    botState.world.saveAt(pos);
  });

  // ── network_chunk_publisher_update (0x79) ──
  client.on('network_chunk_publisher_update', (packet) => {
    botState.chunkState.rawPublisherCenter = packet.coordinates;
    botState.chunkState.publisherCenter = normalizeNetworkChunkPublisherCoordinates(packet.coordinates);
    botState.chunkState.publisherRadius = packet.radius;
  });

  client.on('change_dimension', (packet) => {
    resetActiveWorldState(packet.dimension);
  });

  client.on('move_player', (packet) => {
    if (!sameRuntimeId(packet.runtime_id, client.entityId)) return;
    if (!(packet.mode === 1 || packet.mode === 2 || packet.mode === 'reset' || packet.mode === 'teleport')) return;

    requestChunkDataAround(new Vec3(
      packet.position.x,
      packet.position.y,
      packet.position.z
    ));
  });

  client.on('play_status', (packet) => {
    if (packet.status === 'player_spawn') {
      setTimeout(retryPendingSubchunkRequests, 250);
      setTimeout(retryPendingSubchunkRequests, 1000);
    }
  });

  const subchunkRetryInterval = setInterval(retryPendingSubchunkRequests, 1000);
  subchunkRetryInterval.unref?.();

  client.on('close', () => {
    clearInterval(subchunkRetryInterval);
  });

  // ── waitForChunksToLoad ──
  /**
   * Waits until chunk block data has decoded, not merely until placeholder
   * chunk columns exist.
   *
   * @param {number} [radius=6] block-radius in x/z
   * @param {Vec3} [center] defaults to spawnPosition or 0,0,0
   * @param {number} [timeout=10000] timeout in ms
   * @param {number} [verticalSectionRadius=1] number of section layers above/below center section to require
   * @returns {Promise<void>}
   */
  botState.areChunksLoadedAround = function areChunksLoadedAround(
    radius = 6,
    center = undefined,
    verticalSectionRadius = 1
  ) {
    return chunkAreaLoadState(radius, center, verticalSectionRadius).loaded;
  };

  botState.waitForChunksToLoad = function waitForChunksToLoad(
    radius = 6,
    center = undefined,
    timeout = 10000,
    verticalSectionRadius = 1
  ) {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      const interval = setInterval(() => {
        const { loaded, missing, required } = chunkAreaLoadState(
          radius,
          center,
          verticalSectionRadius
        );

        if (loaded) {
          clearInterval(interval);
          resolve();
          return;
        }

        if (Date.now() - start >= timeout) {
          clearInterval(interval);

          reject(new Error(
            `waitForChunksToLoad timed out after ${timeout}ms ` +
            `(missing block data for ${missing.length} of ${required.size} chunks: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', ...' : ''})`
          ));
        }
      }, 200);
    });
  };
};
