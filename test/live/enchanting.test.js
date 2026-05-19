"use strict";

const assert = require("assert");
const { Vec3 } = require("vec3");
const BotState = require("../../src/state");
const { bedrockPlayerName, clearPlayer, givePlayer, sendCommand, setPlayerGamemode, teleportPlayer } = require("../helpers/commands");
const { HOST, PORT, USERNAME, OFFLINE, VERSION, SETUP_DELAY_MS } = require("../helpers/test-env");
const { assertSlot } = require("../helpers/shared");
const {
  findSlotByName,
  itemSignature,
  itemSummary,
  markLocalBlock,
  safeJsonReplacer,
  sleep,
  waitForBlockName,
  waitForInventoryCount,
  waitForSpawn,
  waitUntil,
} = require("../helpers/live");

const ENCHANT_POS = new Vec3(
  Number(process.env.ENCHANT_TEST_X || 24),
  Number(process.env.ENCHANT_TEST_Y || 80),
  Number(process.env.ENCHANT_TEST_Z || 24),
);

async function waitForExperienceLevel(botState, level, timeoutMs = 8000) {
  await waitUntil(
    `experience level to become at least ${level}`,
    () => botState.experienceLevel >= level ? botState.experienceLevel : false,
    timeoutMs,
  );
}

function bookshelfPositions() {
  const positions = [];
  const { x, y, z } = ENCHANT_POS;

  for (let dx = -2; dx <= 2; dx++) {
    positions.push(new Vec3(x + dx, y, z - 2));
    positions.push(new Vec3(x + dx, y, z + 2));
  }

  for (let dz = -1; dz <= 1; dz++) {
    positions.push(new Vec3(x - 2, y, z + dz));
    positions.push(new Vec3(x + 2, y, z + dz));
  }

  return positions.slice(0, 15);
}

async function setupEnchantingWorld(botState) {
  const { x, y, z } = ENCHANT_POS;
  const player = bedrockPlayerName(USERNAME);

  setPlayerGamemode(botState, USERNAME, "creative");
  await sleep(SETUP_DELAY_MS);

  clearPlayer(botState, USERNAME);
  await sleep(SETUP_DELAY_MS);

  sendCommand(botState, `fill ${x - 3} ${y - 1} ${z - 3} ${x + 3} ${y - 1} ${z + 4} minecraft:stone`);
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `fill ${x - 3} ${y} ${z - 3} ${x + 3} ${y + 1} ${z + 4} minecraft:air`);
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `setblock ${x} ${y} ${z} minecraft:enchanting_table`);
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `fill ${x - 2} ${y} ${z - 2} ${x + 2} ${y} ${z - 2} minecraft:bookshelf`);
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `fill ${x - 2} ${y} ${z + 2} ${x + 2} ${y} ${z + 2} minecraft:bookshelf`);
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `fill ${x - 2} ${y} ${z - 1} ${x - 2} ${y} ${z + 1} minecraft:bookshelf`);
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `fill ${x + 2} ${y} ${z - 1} ${x + 2} ${y} ${z + 1} minecraft:bookshelf`);
  await sleep(SETUP_DELAY_MS);

  await markLocalBlock(botState, ENCHANT_POS, "minecraft:enchanting_table");
  for (const pos of bookshelfPositions()) {
    await markLocalBlock(botState, pos, "minecraft:bookshelf");
  }

  teleportPlayer(botState, USERNAME, x + 0.5, y, z + 3.5);
  await sleep(SETUP_DELAY_MS);

  if (typeof botState.waitForChunksToLoad === "function") {
    await botState.waitForChunksToLoad(2, ENCHANT_POS, 10000);
  }

  await waitForBlockName(botState, ENCHANT_POS, "enchanting_table");

  givePlayer(botState, USERNAME, "diamond_sword", 1);
  givePlayer(botState, USERNAME, "lapis_lazuli", 3);
  await sleep(SETUP_DELAY_MS);

  setPlayerGamemode(botState, USERNAME, "survival");
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `experience set ${player} 30 levels`);
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `experience add ${player} 30 levels`);
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `xp 30L ${player}`);
  await sleep(SETUP_DELAY_MS);
  await waitForExperienceLevel(botState, 30);

  await waitForInventoryCount(botState, "diamond_sword", 1);
  await waitForInventoryCount(botState, "lapis_lazuli", 3);
}

describe("live enchanting integration", function () {
  this.timeout(180000);

  let botState;
  let spawned = false;

  before(async function () {
    botState = new BotState({
      host: HOST,
      port: PORT,
      username: USERNAME,
      offline: OFFLINE,
      version: VERSION,
    });

    botState.start();
    await waitForSpawn(botState);
    spawned = true;

    botState.setInventoryActionResponseTimeout?.(10000);
    botState.setInventoryActionUpdateTimeout?.(5000);
  });

  after(async function () {
    if (!botState?.client) return;

    try {
      if (spawned) {
        const { x, y, z } = ENCHANT_POS;
        sendCommand(botState, `fill ${x - 2} ${y} ${z - 2} ${x + 2} ${y} ${z + 2} minecraft:air`);
        await sleep(SETUP_DELAY_MS);
      }
    } catch {}

    botState.disconnect("Enchanting mocha test complete");
  });

  it("reads enchantment table options and applies a level 30 enchant to a diamond sword", async function () {
    await setupEnchantingWorld(botState);

    const enchanting = await botState.openContainer(ENCHANT_POS, {
      type: "enchantment",
      face: 3,
      contentTimeoutMs: 3000,
    });

    assert.strictEqual(enchanting.type, "enchantment");
    assert.strictEqual(enchanting.containerSlotCount, 2);
    assert.strictEqual(typeof enchanting.getEnchantOptions, "function");
    assert.strictEqual(typeof enchanting.selectEnchantOption, "function");

    botState.selectHotbarSlot(8);
    await sleep(SETUP_DELAY_MS);

    const swordSlot = findSlotByName(botState, "diamond_sword");
    await enchanting.putInput(swordSlot, 1);
    assertSlot(enchanting.window, 0, "diamond_sword", 1);

    const lapisSlot = findSlotByName(botState, "lapis_lazuli");
    await enchanting.putLapis(lapisSlot, 3);
    assertSlot(enchanting.window, 1, "lapis_lazuli", 3);
    await sleep(SETUP_DELAY_MS * 2);

    const options = await enchanting.waitForEnchantOptions(
      currentOptions => currentOptions.some(option => option.cost === 30 && option.optionId !== 0),
      15000,
    );
    const level30Option = options.find(option => option.cost === 30 && option.optionId !== 0);

    assert(level30Option, `Expected a level 30 enchant option, got ${JSON.stringify(options, safeJsonReplacer, 2)}`);
    assert(
      level30Option.heldEnchants.length > 0 || level30Option.equipEnchants.length > 0 || level30Option.selfEnchants.length > 0,
      `Expected visible enchant data on level 30 option, got ${JSON.stringify(level30Option, safeJsonReplacer, 2)}`,
    );

    const swordBefore = itemSignature(enchanting.getItem(0));
    await enchanting.selectEnchantOption(level30Option);

    await waitUntil(
      "diamond sword to gain enchantment data",
      () => {
        const sword = enchanting.getItem(0);
        return sword?.name === "diamond_sword" && itemSignature(sword) !== swordBefore ? sword : false;
      },
      15000,
    );

    await waitUntil(
      "enchanting lapis slot to consume three items",
      () => {
        const lapis = enchanting.getItem(1);
        return lapis == null ? true : false;
      },
      15000,
    );

    const enchantedSword = enchanting.getItem(0);
    assert.strictEqual(enchantedSword.name, "diamond_sword");
    assert.notStrictEqual(itemSignature(enchantedSword), swordBefore, [
      "Expected sword item data to change after enchanting.",
      "Before:",
      swordBefore,
      "After:",
      JSON.stringify(itemSummary(enchantedSword), safeJsonReplacer, 2),
      "Selected option:",
      JSON.stringify(level30Option, safeJsonReplacer, 2),
    ].join("\n"));

    enchanting.close();
  });
});
