"use strict";

const assert = require("assert");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForSpawn(botState, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      botState.client.off("spawn", onSpawn);
      botState.client.off("close", onClose);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onSpawn = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onClose = () => fail(new Error("Bot disconnected before spawn"));
    const timeout = setTimeout(() => fail(new Error("Timeout waiting for spawn")), timeoutMs);

    botState.client.once("spawn", onSpawn);
    botState.client.once("close", onClose);
  });
}

function isBotConnected(botState) {
  return !!botState?.client && botState.client.status !== 0;
}

function assertBotConnected(botState, context = "live test") {
  assert(
    isBotConnected(botState),
    `${context} cannot continue because the bot is disconnected`,
  );
}

function safeJsonReplacer(_, value) {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) {
    return {
      type: "Buffer",
      length: value.length,
      hex: value.toString("hex"),
    };
  }
  return value;
}

async function waitUntil(label, predicate, timeoutMs = 30000, intervalMs = 250, options = null) {
  const botState = options?.botState || options;
  const start = Date.now();
  let lastValue;

  while (Date.now() - start < timeoutMs) {
    if (botState) assertBotConnected(botState, `waitUntil ${label}`);
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await sleep(intervalMs);
  }

  if (botState) assertBotConnected(botState, `waitUntil ${label}`);
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue, safeJsonReplacer)}`);
}

function findSlotByName(botState, name) {
  assertBotConnected(botState, `findSlotByName ${name}`);
  const slot = botState.inventory.slots.findIndex((item) => item?.name === name);
  assert.notStrictEqual(slot, -1, `Could not find ${name} in inventory`);
  return slot;
}

function countInventoryItem(botState, name) {
  return botState.inventory.slots.reduce((total, item) => {
    if (!item || item.name !== name) return total;
    return total + item.count;
  }, 0);
}

async function waitForInventoryCount(botState, name, count, timeoutMs = 8000) {
  await waitUntil(
    `${name} inventory count to become ${count}`,
    () => countInventoryItem(botState, name) === count,
    timeoutMs,
    250,
    botState,
  );
}

async function waitForBlockName(botState, pos, expectedName, timeoutMs = 8000) {
  return waitUntil(
    `block ${expectedName} at ${pos}`,
    async () => {
      const block = await botState.getBlock(pos);
      return block?.name === expectedName ? block : false;
    },
    timeoutMs,
    150,
    botState,
  );
}

async function markLocalBlock(botState, pos, block) {
  const name = block.replace(/^minecraft:/, "").split("[")[0];
  const stateId = botState.registry.blocksByName[name]?.defaultState;
  if (stateId == null || typeof botState.setBlockStateIdAt !== "function") return;
  await botState.setBlockStateIdAt(pos, stateId);
}

function assertHasApi(botState, name) {
  assert.strictEqual(typeof botState[name], "function", `Expected botState.${name} to exist`);
}

function captureQueuedPackets(botState, options = {}) {
  const suppress = new Set(options.suppress || []);
  const packets = [];
  const originalQueue = botState.client.queue.bind(botState.client);

  botState.client.queue = function queueWithCapture(name, packet) {
    packets.push({ name, packet, params: packet });
    if (suppress.has(name)) return undefined;
    return originalQueue(name, packet);
  };

  return {
    packets,
    queued: packets,
    restore() {
      botState.client.queue = originalQueue;
    },
  };
}

function observeQueuedPackets(client) {
  return captureQueuedPackets({ client });
}

function findQueuedPacket(packets, name, predicate = () => true) {
  return packets.find((entry) => entry.name === name && predicate(entry.packet ?? entry.params));
}

function itemSummary(item) {
  if (!item) return null;

  return {
    type: item.type,
    name: item.name,
    count: item.count,
    metadata: item.metadata,
    nbt: item.nbt,
    raw: item.raw
      ? {
          network_id: item.raw.network_id,
          metadata: item.raw.metadata,
          block_runtime_id: item.raw.block_runtime_id,
          extra: item.raw.extra,
        }
      : null,
  };
}

function itemSignature(item) {
  if (!item) return null;
  return JSON.stringify(itemSummary(item), safeJsonReplacer);
}

module.exports = {
  assertBotConnected,
  assertHasApi,
  captureQueuedPackets,
  countInventoryItem,
  findQueuedPacket,
  findSlotByName,
  isBotConnected,
  itemSignature,
  itemSummary,
  markLocalBlock,
  observeQueuedPackets,
  safeJsonReplacer,
  sleep,
  waitForBlockName,
  waitForInventoryCount,
  waitForSpawn,
  waitUntil,
};
