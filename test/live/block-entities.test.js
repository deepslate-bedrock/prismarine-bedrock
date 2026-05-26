"use strict";

const assert = require("assert");
const { Vec3 } = require("vec3");
const BotState = require("../../src/state");
const { nbtValue } = require("../../src/utils");
const { sendCommand, teleportPlayer } = require("../helpers/commands");
const { HOST, PORT, USERNAME, OFFLINE, VERSION, SETUP_DELAY_MS } = require("../helpers/test-env");
const {
  safeJsonReplacer,
  sleep,
  waitForBlockName,
  waitForSpawn,
  waitUntil,
} = require("../helpers/live");

const SIGN_POS = new Vec3(
  Number(process.env.BLOCK_ENTITY_TEST_X || 32),
  Number(process.env.BLOCK_ENTITY_TEST_Y || 80),
  Number(process.env.BLOCK_ENTITY_TEST_Z || 32),
);
const ENCHANT_POS = SIGN_POS.offset(2, 0, 0);

function readEntityValue(blockOrEntity) {
  return nbtValue(blockOrEntity?.entity ?? blockOrEntity);
}

async function waitForBlockEntity(botState, pos, predicate, label, timeoutMs = 10000) {
  return waitUntil(
    label,
    async () => {
      const entity = await botState.getBlockEntity(pos);
      const value = readEntityValue(entity);
      return value && predicate(value) ? entity : false;
    },
    timeoutMs,
    250,
    botState,
  );
}

async function setupBlockEntityArea(botState) {
  const { x, y, z } = SIGN_POS;

  sendCommand(botState, `fill ${x - 1} ${y - 1} ${z - 1} ${x + 4} ${y - 1} ${z + 1} minecraft:stone`);
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `fill ${x - 1} ${y} ${z - 1} ${x + 4} ${y + 2} ${z + 1} minecraft:air`);
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `setblock ${SIGN_POS.x} ${SIGN_POS.y} ${SIGN_POS.z} minecraft:standing_sign`);
  await sleep(SETUP_DELAY_MS);
  sendCommand(botState, `setblock ${ENCHANT_POS.x} ${ENCHANT_POS.y} ${ENCHANT_POS.z} minecraft:enchanting_table`);
  await sleep(SETUP_DELAY_MS);

  teleportPlayer(botState, USERNAME, x + 0.5, y, z + 1.5);
  await sleep(SETUP_DELAY_MS);

  if (typeof botState.waitForChunksToLoad === "function") {
    await botState.waitForChunksToLoad(2, SIGN_POS, 10000);
  }

  await waitForBlockName(botState, SIGN_POS, "standing_sign");
  await waitForBlockName(botState, ENCHANT_POS, "enchanting_table");
}

describe("live block entity data integration", function () {
  this.timeout(90000);

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
  });

  after(async function () {
    if (!botState?.client) return;

    try {
      if (spawned) {
        const { x, y, z } = SIGN_POS;
        sendCommand(botState, `fill ${x - 1} ${y} ${z - 1} ${x + 4} ${y + 2} ${z + 1} minecraft:air`);
        await sleep(SETUP_DELAY_MS);
      }
    } catch {}

    botState.disconnect("Block entity mocha test complete");
  });

  it("reads text fields from sign block entity data", async function () {
    await setupBlockEntityArea(botState);

    const entity = await waitForBlockEntity(
      botState,
      SIGN_POS,
      value => value.id === "Sign" && typeof value.FrontText?.Text === "string" && typeof value.BackText?.Text === "string",
      "sign block entity text fields to be readable",
    );
    const value = readEntityValue(entity);
    const block = await botState.getBlock(SIGN_POS);

    assert.strictEqual(block.name, "standing_sign");
    assert.strictEqual(value.id, "Sign", JSON.stringify(value, safeJsonReplacer, 2));
    assert.strictEqual(readEntityValue(block).FrontText.Text, value.FrontText.Text);
    assert.strictEqual(readEntityValue(block).BackText.Text, value.BackText.Text);
  });

  it("edits sign text through the sign block entity API", async function () {
    if (process.env.SIGN_EDIT_LIVE !== "1") {
      this.skip();
    }

    await setupBlockEntityArea(botState);

    const expectedText = "Bot edited\nsign text";
    const updated = await botState.editSign(SIGN_POS, expectedText, {
      timeoutMs: 15000,
    });

    assert.strictEqual(updated.frontText, expectedText);

    const entity = await waitForBlockEntity(
      botState,
      SIGN_POS,
      value => value.id === "Sign" && value.FrontText?.Text === expectedText,
      "edited sign block entity text to be readable",
      15000,
    );

    assert.strictEqual(readEntityValue(entity).FrontText.Text, expectedText);
  });

  it("reads NBT from enchanting table block entity data", async function () {
    await setupBlockEntityArea(botState);

    const entity = await waitForBlockEntity(
      botState,
      ENCHANT_POS,
      value => value.id === "EnchantTable" && value.x === ENCHANT_POS.x && value.y === ENCHANT_POS.y && value.z === ENCHANT_POS.z,
      "enchanting table block entity NBT to be readable",
      15000,
    );
    const value = readEntityValue(entity);
    const block = await botState.getBlock(ENCHANT_POS);

    assert.strictEqual(block.name, "enchanting_table");
    assert.strictEqual(value.id, "EnchantTable", JSON.stringify(value, safeJsonReplacer, 2));
    assert.strictEqual(readEntityValue(block).id, "EnchantTable");
  });
});
