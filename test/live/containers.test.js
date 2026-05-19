"use strict";

const assert = require("assert");
const { Vec3 } = require("vec3");
const BotState = require("../../src/state");
const { clearPlayer, givePlayer, setBlockIfNeeded, setPlayerGamemode, teleportPlayer } = require("../helpers/commands");
const { HOST, PORT, USERNAME, OFFLINE, VERSION, SETUP_DELAY_MS } = require("../helpers/test-env");
const { assertSlot } = require("../helpers/shared");
const {
  assertBotConnected,
  findSlotByName,
  isBotConnected,
  itemSignature,
  itemSummary,
  markLocalBlock,
  safeJsonReplacer,
  sleep,
  waitForBlockName,
  waitForSpawn,
  waitUntil,
} = require("../helpers/live");

const CHEST_POS = new Vec3(2, 65, 0);
const DOUBLE_CHEST_POS = new Vec3(4, 65, 0);
const FURNACE_POS = new Vec3(6, 65, 0);
const BREWING_POS = new Vec3(8, 65, 0);
const AFTER_ACTION_DELAY_MS = Number(process.env.AFTER_ACTION_DELAY_MS || 700);

function giveSetupItem(botState, item) {
  assertBotConnected(botState, "give setup item");
  const count = item.count ?? 1;
  const target = item.item || item.commandItem || item.name;
  assert(target, `setupContainerArea item is missing name/item: ${JSON.stringify(item)}`);
  givePlayer(botState, USERNAME, target, count);
}

async function setupContainerArea(botState, blocks, items = []) {
  assertBotConnected(botState, "setupContainerArea");
  setPlayerGamemode(botState, USERNAME, "creative");
  await sleep(SETUP_DELAY_MS);
  assertBotConnected(botState, "setupContainerArea after creative gamemode");

  clearPlayer(botState, USERNAME);
  await sleep(SETUP_DELAY_MS);
  assertBotConnected(botState, "setupContainerArea after clear");

  for (const { pos } of blocks) {
    await setBlockIfNeeded(botState, pos.offset(0, -1, 0), "minecraft:stone");
    await setBlockIfNeeded(botState, pos, "minecraft:air");
    await setBlockIfNeeded(botState, pos.offset(0, 1, 0), "minecraft:air");
  }

  const first = blocks[0].pos;
  const teleportFloor = first.offset(0, 0, 3);
  await setBlockIfNeeded(botState, teleportFloor, "minecraft:stone");
  await setBlockIfNeeded(botState, teleportFloor.offset(0, 1, 0), "minecraft:air");
  await setBlockIfNeeded(botState, teleportFloor.offset(0, 2, 0), "minecraft:air");
  await waitForBlockName(botState, teleportFloor, "stone");

  teleportPlayer(botState, USERNAME, first.x + 0.5, first.y + 1, first.z + 3.5);
  await sleep(SETUP_DELAY_MS);
  assertBotConnected(botState, "setupContainerArea after teleport");

  for (const { pos, block } of blocks) {
    await setBlockIfNeeded(botState, pos, block);
    await markLocalBlock(botState, pos, block);
  }

  for (const { pos, expectedName } of blocks) {
    await waitForBlockName(botState, pos, expectedName);
  }

  for (const item of items) {
    giveSetupItem(botState, item);
  }

  await sleep(SETUP_DELAY_MS);
  assertBotConnected(botState, "setupContainerArea after item setup");

  setPlayerGamemode(botState, USERNAME, "survival");
  await sleep(SETUP_DELAY_MS);
  assertBotConnected(botState, "setupContainerArea after survival gamemode");
}

async function setupDoubleChestArea(botState) {
  assertBotConnected(botState, "setupDoubleChestArea");
  setPlayerGamemode(botState, USERNAME, "creative");
  await sleep(SETUP_DELAY_MS);
  assertBotConnected(botState, "setupDoubleChestArea after creative gamemode");

  clearPlayer(botState, USERNAME);
  await sleep(SETUP_DELAY_MS);
  assertBotConnected(botState, "setupDoubleChestArea after clear");

  const rightChestPos = DOUBLE_CHEST_POS.offset(1, 0, 0);
  for (const pos of [DOUBLE_CHEST_POS, rightChestPos]) {
    await setBlockIfNeeded(botState, pos.offset(0, -1, 0), "minecraft:stone");
    await setBlockIfNeeded(botState, pos, "minecraft:air");
    await setBlockIfNeeded(botState, pos.offset(0, 1, 0), "minecraft:air");
  }

  const teleportFloor = DOUBLE_CHEST_POS.offset(0, 0, 3);
  await setBlockIfNeeded(botState, teleportFloor, "minecraft:stone");
  await setBlockIfNeeded(botState, teleportFloor.offset(0, 1, 0), "minecraft:air");
  await setBlockIfNeeded(botState, teleportFloor.offset(0, 2, 0), "minecraft:air");
  await waitForBlockName(botState, teleportFloor, "stone");

  teleportPlayer(botState, USERNAME, DOUBLE_CHEST_POS.x + 0.5, DOUBLE_CHEST_POS.y + 1, DOUBLE_CHEST_POS.z + 3.5);
  await sleep(SETUP_DELAY_MS);
  assertBotConnected(botState, "setupDoubleChestArea after teleport");

  givePlayer(botState, USERNAME, "chest", 2);
  givePlayer(botState, USERNAME, "diamond", 4);
  await sleep(SETUP_DELAY_MS);
  assertBotConnected(botState, "setupDoubleChestArea after item setup");

  setPlayerGamemode(botState, USERNAME, "survival");
  await sleep(SETUP_DELAY_MS);
  assertBotConnected(botState, "setupDoubleChestArea after survival gamemode");

  const chestSlot = findSlotByName(botState, "chest");
  await botState.equipItem(chestSlot);

  await botState.placeBlock(DOUBLE_CHEST_POS.offset(0, -1, 0), 1);
  await sleep(SETUP_DELAY_MS);
  await waitForBlockName(botState, DOUBLE_CHEST_POS, "chest");

  await botState.placeBlock(rightChestPos.offset(0, -1, 0), 1);
  await sleep(SETUP_DELAY_MS);
  await waitForBlockName(botState, rightChestPos, "chest");
}

function chestBlock(pos) {
  return { pos, block: "minecraft:chest", expectedName: "chest" };
}

function furnaceBlock(pos) {
  return { pos, block: "minecraft:furnace", expectedName: "furnace" };
}

function brewingBlock(pos) {
  return { pos, block: "minecraft:brewing_stand", expectedName: "brewing_stand" };
}

async function assertContainerActionProducesPackets(botState, actionName, fn) {
  assertBotConnected(botState, actionName);
  const seen = {
    request: false,
    response: false,
  };

  function onRequest(request) {
    seen.request = true;
    console.log("[test] outbound container item_stack_request", {
      request_id: request.request_id,
      actions: request.actions?.map((action) => action.type_id),
    });
  }

  function onResponse(response) {
    seen.response = true;
    console.log("[test] inbound container item_stack_response", response);
  }

  botState.on("inventory_action_request", onRequest);
  botState.on("item_stack_response", onResponse);

  try {
    const result = await fn();
    assertBotConnected(botState, `${actionName} after action`);
    await sleep(AFTER_ACTION_DELAY_MS);
    assertBotConnected(botState, `${actionName} after packet wait`);

    assert.strictEqual(seen.request, true, `${actionName} did not send item_stack_request`);
    assert.strictEqual(seen.response, true, `${actionName} did not receive item_stack_response`);
    return result;
  } finally {
    botState.off("inventory_action_request", onRequest);
    botState.off("item_stack_response", onResponse);
  }
}

async function waitForContainerSlotName(container, slot, expectedName, timeoutMs = 30000) {
  return waitUntil(
    `${container.type} slot ${slot} to become ${expectedName}`,
    () => {
      const item = container.window.slots[slot];
      return item?.name === expectedName ? item : false;
    },
    timeoutMs,
    250,
    container.botState,
  );
}

function requireProgressApi(container, methodName) {
  assert.strictEqual(
    typeof container[methodName],
    "function",
    `${container.type} is missing ${methodName}; update the specialized container file`,
  );

  const progress = container[methodName]();
  assert(progress, `${methodName} returned no progress object`);
  return progress;
}

describe("real chest containers", function () {
  this.timeout(180000);

  let botState;
  let disconnectedAt = null;

  before(async function () {
    botState = new BotState({
      host: HOST,
      port: PORT,
      username: USERNAME,
      offline: OFFLINE,
      version: VERSION,
    });

    botState.start();
    botState.client.once("close", () => {
      disconnectedAt = new Date();
    });
    await waitForSpawn(botState);

    botState.setInventoryActionResponseTimeout?.(10000);
  });

  beforeEach(function () {
    assert(
      isBotConnected(botState),
      disconnectedAt
        ? `Bot disconnected at ${disconnectedAt.toISOString()}; failing this test immediately instead of cascading setup errors`
        : "Bot is not connected; failing this test immediately instead of cascading setup errors",
    );
  });

  after(async function () {
    if (!botState?.client) return;

    try {
      await setBlockIfNeeded(botState, CHEST_POS, "minecraft:air", 250);
      await setBlockIfNeeded(botState, DOUBLE_CHEST_POS, "minecraft:air", 250);
      await setBlockIfNeeded(botState, DOUBLE_CHEST_POS.offset(1, 0, 0), "minecraft:air", 250);
      await setBlockIfNeeded(botState, FURNACE_POS, "minecraft:air", 250);
      await setBlockIfNeeded(botState, BREWING_POS, "minecraft:air", 250);
    } catch {}

    botState.disconnect("Chest container mocha test complete");
  });

  it("auto-loads generic container helpers", function () {
    assert.strictEqual(typeof botState.openContainer, "function");
    assert.strictEqual(typeof botState.waitForContainerOpen, "function");
    assert.strictEqual(typeof botState.wrapContainerWindow, "function");
  });

  it("opens a chest, puts inventory items in, and takes them back out", async function () {
    await setupContainerArea(
      botState,
      [chestBlock(CHEST_POS)],
      [
        { name: "diamond", count: 3 },
        { name: "stick", count: 4 },
      ],
    );

    const diamondSlot = findSlotByName(botState, "diamond");

    const chest = await botState.openContainer(CHEST_POS, {
      type: "container",
      face: 1,
      contentTimeoutMs: 3000,
    });

    assert.strictEqual(chest.type, "container");
    assert.strictEqual(chest.containerSlotCount, 27);

    await assertContainerActionProducesPackets(botState, "putInventorySlot", () => {
      return chest.putInventorySlot(diamondSlot, 0, 2);
    });

    assertSlot(botState.inventory, diamondSlot, "diamond", 1);
    assertSlot(chest.window, 0, "diamond", 2);

    const emptySlot = chest.firstEmptyInventorySlot();
    assert.notStrictEqual(emptySlot, -1, "Expected an empty inventory slot");

    await assertContainerActionProducesPackets(botState, "takeContainerSlot one item", () => {
      return chest.takeContainerSlot(0, emptySlot, 1);
    });

    assertSlot(chest.window, 0, "diamond", 1);
    assertSlot(botState.inventory, emptySlot, "diamond", 1);

    await assertContainerActionProducesPackets(botState, "takeContainerSlot merge", () => {
      return chest.takeContainerSlot(0, diamondSlot, 1);
    });

    assertSlot(chest.window, 0, null, 0);
    assertSlot(botState.inventory, diamondSlot, "diamond", 2);

    chest.close();
  });

  it("opens a double chest and uses slots across the full 54-slot container", async function () {
    await setupDoubleChestArea(botState);

    const diamondSlot = findSlotByName(botState, "diamond");
    const chest = await botState.openContainer(DOUBLE_CHEST_POS, {
      type: "container",
      face: 1,
      contentTimeoutMs: 3000,
    });

    assert.strictEqual(chest.type, "container");
    assert.strictEqual(chest.containerSlotCount, 54);

    await assertContainerActionProducesPackets(botState, "double chest putInventorySlot", () => {
      return chest.putInventorySlot(diamondSlot, 53, 3);
    });

    assertSlot(botState.inventory, diamondSlot, "diamond", 1);
    assertSlot(chest.window, 53, "diamond", 3);

    await assertContainerActionProducesPackets(botState, "double chest takeContainerSlot", () => {
      return chest.takeContainerSlot(53, diamondSlot, 3);
    });

    assertSlot(chest.window, 53, null, 0);
    assertSlot(botState.inventory, diamondSlot, "diamond", 4);

    chest.close();
  });

  it("opens a furnace, smelts raw iron, tracks progress, and takes the output", async function () {
    await setupContainerArea(
      botState,
      [furnaceBlock(FURNACE_POS)],
      [
        { name: "raw_iron", count: 1 },
        { name: "coal", count: 1 },
      ],
    );

    const furnace = await botState.openContainer(FURNACE_POS, {
      type: "furnace",
      face: 3,
      contentTimeoutMs: 3000,
    });

    assert.strictEqual(furnace.type, "furnace");
    assert.strictEqual(furnace.containerSlotCount, 3);
    assert.strictEqual(typeof furnace.putFuel, "function");
    assert.strictEqual(typeof furnace.putInput, "function");
    assert.strictEqual(typeof furnace.takeOutput, "function");

    const initialProgress = requireProgressApi(furnace, "getFurnaceProgress");
    assert.strictEqual(initialProgress.isBurning, false);
    assert.strictEqual(initialProgress.isCooking, false);

    const rawIronSlot = findSlotByName(botState, "raw_iron");
    await assertContainerActionProducesPackets(botState, "furnace putInput raw_iron", () => {
      return furnace.putInput(rawIronSlot, 1);
    });

    assertSlot(furnace.window, 0, "raw_iron", 1);

    const coalSlot = findSlotByName(botState, "coal");
    await assertContainerActionProducesPackets(botState, "furnace putFuel coal", () => {
      return furnace.putFuel(coalSlot, 1);
    });

    await waitUntil(
      "furnace to start burning/cooking",
      () => {
        const progress = furnace.getFurnaceProgress();
        return progress.isBurning || progress.isCooking || progress.litTime > 0 || progress.tickCount > 0 ? progress : false;
      },
      15000,
      250,
      botState,
    );

    const startedProgress = furnace.getFurnaceProgress();
    assert(
      startedProgress.litTime > 0 || startedProgress.tickCount > 0,
      `Expected furnace progress to update, got ${JSON.stringify(startedProgress, safeJsonReplacer, 2)}`,
    );

    const output = await waitForContainerSlotName(furnace, 2, "iron_ingot", 45000);
    assert.strictEqual(output.count, 1);

    const finalProgress = furnace.getFurnaceProgress();
    assert(
      typeof finalProgress.cookProgress === "number" && typeof finalProgress.burnProgress === "number",
      `Expected readable final furnace progress, got ${JSON.stringify(finalProgress, safeJsonReplacer, 2)}`,
    );

    const emptySlot = furnace.firstEmptyInventorySlot();
    assert.notStrictEqual(emptySlot, -1, "Expected an empty inventory slot for iron ingot output");

    await assertContainerActionProducesPackets(botState, "furnace takeOutput iron_ingot", () => {
      return furnace.takeOutput(emptySlot, 1);
    });

    assertSlot(furnace.window, 2, null, 0);
    assertSlot(botState.inventory, emptySlot, "iron_ingot", 1);

    furnace.close();
  });

  it("opens a brewing stand, brews water bottles with nether wart, tracks progress, and keeps brewed bottles", async function () {
    await setupContainerArea(
      botState,
      [brewingBlock(BREWING_POS)],
      [
        {
          name: "potion",
          item: 'minecraft:potion[minecraft:potion_contents={potion:"minecraft:water"}]',
          count: 3,
        },
        { name: "nether_wart", count: 1 },
        { name: "blaze_powder", count: 1 },
      ],
    );

    const brewing = await botState.openContainer(BREWING_POS, {
      type: "brewing_stand",
      face: 3,
      contentTimeoutMs: 3000,
    });

    assert.strictEqual(brewing.type, "brewing_stand");
    assert.strictEqual(brewing.containerSlotCount, 5);
    assert.strictEqual(typeof brewing.putFuel, "function");
    assert.strictEqual(typeof brewing.putIngredient, "function");
    assert.strictEqual(typeof brewing.putBottle, "function");
    assert.strictEqual(typeof brewing.takeBottle, "function");

    const initialProgress = requireProgressApi(brewing, "getBrewingProgress");
    assert.strictEqual(initialProgress.isBrewing, false);

    const blazeSlot = findSlotByName(botState, "blaze_powder");
    await assertContainerActionProducesPackets(botState, "brewing putFuel blaze_powder", () => {
      return brewing.putFuel(blazeSlot, 1);
    });

    await waitUntil(
      "brewing stand to load fuel",
      () => {
        const progress = brewing.getBrewingProgress();
        return progress.hasFuel || progress.fuelAmount > 0 ? progress : false;
      },
      15000,
      250,
      botState,
    );

    assertSlot(brewing.window, 4, null, 0);

    for (let bottle = 0; bottle < 3; bottle++) {
      const potionSlot = findSlotByName(botState, "potion");
      await assertContainerActionProducesPackets(botState, `brewing putBottle ${bottle}`, () => {
        return brewing.putBottle(potionSlot, bottle, 1);
      });

      const placedBottle = brewing.getBottle(bottle);
      assert(
        placedBottle?.name === "potion" && placedBottle.count === 1,
        `expected bottle ${bottle} to contain potion x1, got ${JSON.stringify(itemSummary(placedBottle), safeJsonReplacer, 2)}`,
      );
    }

    const beforeBottleSignatures = [0, 1, 2].map((i) => itemSignature(brewing.getBottle(i)));
    const beforeBottleSummaries = [0, 1, 2].map((i) => itemSummary(brewing.getBottle(i)));

    const wartSlot = findSlotByName(botState, "nether_wart");
    await assertContainerActionProducesPackets(botState, "brewing putIngredient nether_wart", () => {
      return brewing.putIngredient(wartSlot, 1);
    });

     const netherWart = brewing.getIngredient();
      assert(
        netherWart?.name === "nether_wart" && netherWart.count === 1,
        `expected slot 0 to contain nether wart x1, got ${JSON.stringify(itemSummary(netherWart), safeJsonReplacer, 2)}`,
      );
    await waitUntil(
      "brewing stand to start brewing",
      () => {
        const progress = brewing.getBrewingProgress();
        return progress.isBrewing || progress.brewTime > 0 ? progress : false;
      },
      15000,
      250,
      botState,
    );

    const startedProgress = brewing.getBrewingProgress();
    assert(
      startedProgress.brewTime > 0,
      `Expected brewing progress to update, got ${JSON.stringify(startedProgress, safeJsonReplacer, 2)}`,
    );

    await waitUntil(
      "brewing stand to finish and update bottle data",
      () => {
        const progress = brewing.getBrewingProgress();
        const currentSignatures = [0, 1, 2].map((i) => itemSignature(brewing.getBottle(i)));
        const bottlesStillPresent = [0, 1, 2].every((i) => brewing.getBottle(i)?.name === "potion");

        const bottleDataChanged = currentSignatures.some((signature, index) => {
          return signature && beforeBottleSignatures[index] && signature !== beforeBottleSignatures[index];
        });

        return bottlesStillPresent && !progress.isBrewing && progress.brewTime === 0 && bottleDataChanged
          ? { progress, currentSignatures }
          : false;
      },
      60000,
      250,
      botState,
    );

    for (let i = 0; i < 3; i++) {
      assert.strictEqual(brewing.getBottle(i)?.name, "potion");
      assert.strictEqual(brewing.getBottle(i)?.count, 1);
    }

    const afterBottleSummaries = [0, 1, 2].map((i) => itemSummary(brewing.getBottle(i)));
    const afterBottleSignatures = [0, 1, 2].map((i) => itemSignature(brewing.getBottle(i)));
    assert(
      afterBottleSignatures.some((signature, index) => signature !== beforeBottleSignatures[index]),
      [
        "Expected brewed potion bottle data to differ from water bottle data.",
        "Before:",
        JSON.stringify(beforeBottleSummaries, safeJsonReplacer, 2),
        "After:",
        JSON.stringify(afterBottleSummaries, safeJsonReplacer, 2),
      ].join("\n"),
    );

    const emptySlot = brewing.firstEmptyInventorySlot();
    assert.notStrictEqual(emptySlot, -1, "Expected an empty inventory slot for brewed potion output");

    await assertContainerActionProducesPackets(botState, "brewing takeBottle 0", () => {
      return brewing.takeBottle(0, emptySlot, 1);
    });

    assertSlot(brewing.window, 0, null, 0);
    assertSlot(botState.inventory, emptySlot, "potion", 1);

    brewing.close();
  });
});
