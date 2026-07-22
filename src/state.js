const bedrock = require('bedrock-protocol');
const Vec3 = require('vec3').Vec3;
const { createActionLogger } = require('./utils');
const { EventEmitter } = require('stream');
const { bedrockRegistryName, normalizeBedrockVersion } = require('./version');
const pluginLoader = require('./plugin-loader');

function normalizeBooleanOption(value, name) {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;

  const normalized = String(value).toLowerCase();
  if (normalized === 'true' || normalized === 'on' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === 'off' || normalized === 'no') return false;

  throw new Error(`[bot] ${name} must be a boolean`);
}

function normalizeRuntimeOptions(options = {}) {
  const loggingEnabled =
    normalizeBooleanOption(options.loggingEnabled, 'loggingEnabled') ??
    true;

  const worldDecodeEnabled =
    normalizeBooleanOption(options.worldDecodeEnabled, 'worldDecodeEnabled') ??
    true;

  const physicsEnabled =
    normalizeBooleanOption(options.physicsEnabled, 'physicsEnabled') ??
    worldDecodeEnabled;

  if (!worldDecodeEnabled && physicsEnabled) {
    throw new Error('[bot] physicsEnabled requires worldDecodeEnabled: true');
  }

  // currently env since debugging, eventually will be phased out.
  const physicsEngine = options.physicsEngine ?? process.env.BEDROCK_PHYSICS_ENGINE ?? 'native';
  if (!['native', 'nxg', 'nxg-org'].includes(physicsEngine)) {
    throw new Error('[bot] physicsEngine must be "native" or "nxg"');
  }

  return {
    ...options,
    loggingEnabled,
    worldDecodeEnabled,
    physicsEnabled,
    physicsEngine: physicsEngine === 'nxg-org' ? 'nxg' : physicsEngine
  };
}

class BotState extends EventEmitter {
  constructor (options = {}) {
    super();
    this.options = normalizeRuntimeOptions({
      ...options,
      version: normalizeBedrockVersion(options.version)
    });
    this.logAction = createActionLogger(this.options.loggingEnabled);
    const registry = require('prismarine-registry')(bedrockRegistryName(this.options.version));

    this.registry = registry;
    this.version = this.options.version;

    this.client = null;

    this.lifecycle = {
      isDead: false,
      respawnTimeout: null
    };
    this.playerState = {
      health: null,
      experience: 0,
      experienceLevel: 0,
      spawnPosition: null,
      spawnRotation: null
    };
    this.game = {
      gameMode: null,
      dimension: 0,
      gamerules: null
    };
    this.worldSettings = {
      minY: -64,
      height: 384,
      minSectionY: -4,
      maxSectionY: 19
    };
    this.chunkState = {
      count: 0,
      rawPublisherCenter: null,
      publisherCenter: null,
      publisherRadius: null
    };
    this.protocolState = {
      blockNetworkIdsAreHashes: false,
      sentAvailableCommandsReadyPackets: false
    };
    this.currentTargetBlock = null;
    this.targetStateIds = null;

    pluginLoader.ensureState(this);

    // ── Normalized prismarine‑X instantiations ──
    this.entityClass = require('prismarine-entity')(registry);
    this.itemClass = require('prismarine-item')(registry);
    this.blockClass = require('prismarine-block')(registry);
    this.chatMessageClass = require('prismarine-chat')(registry);
    this.windowFactory = require('prismarine-windows')(registry);
    this.chunkColumn = require('prismarine-chunk')(registry);
    this.worldClass = require('prismarine-world')(registry);

    this.world = new this.worldClass(null);

    // Live entity storage, keyed by Bedrock runtime entity id.
    // `entities` is for non-player actors; `playerEntities` is for the bot's
    // own player entity plus other spawned player entities.
    this.entities = new Map();
    this.playerEntities = new Map();
    Object.defineProperty(this, 'players', {
      configurable: true,
      enumerable: false,
      get: () => this.playerEntities,
      set: value => { this.playerEntities = value }
    });

    // Online player-list profile records from player_list packets. These are
    // not live entities; they are identity/profile records keyed for lookup.
    this.playerList = new Map();
    this.playerListByUuid = new Map();
    this.self = null;
  }

  start () {
    const clientOptions = { ...this.options };
    this.client = bedrock.createClient({ ...clientOptions, delayedInit: true });
    this.client.registry = this.registry;

    pluginLoader.injectAll(this);
  }

  disconnect (reason = 'Client shutting down') {
    this.logAction('[→]', 'disconnect', { reason });
    if (this.client.status !== 0) {
      this.client.disconnect(reason);
    } else {
      this.client.close();
    }
  }

}

BotState.normalizeRuntimeOptions = normalizeRuntimeOptions;

module.exports = BotState;
