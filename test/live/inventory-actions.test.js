const assert = require("assert");
const BotState = require("../../src/state");
const { clearPlayer, givePlayer, setPlayerGamemode } = require("../helpers/commands");
const {
  HOST,
  PORT,
  USERNAME,
  OFFLINE,
  VERSION,
  SETUP_DELAY_MS
} = require("../helpers/test-env");
const {
  assertSlot
} = require('../helpers/shared')
const {
  findSlotByName,
  sleep,
  waitForSpawn
} = require("../helpers/live");


const AFTER_ACTION_DELAY_MS = Number(process.env.AFTER_ACTION_DELAY_MS || 1000);

async function setupInventory(botState) {
//   const listener = (packet) => {
//     console.log("[command text response]", packet);
//   };

//   botState.client.on("text", listener);

  clearPlayer(botState, USERNAME);
  await sleep(SETUP_DELAY_MS);

  givePlayer(botState, USERNAME, "diamond", 3);
  givePlayer(botState, USERNAME, "stick", 5);
  givePlayer(botState, USERNAME, "dirt", 7);
  await sleep(SETUP_DELAY_MS);

//   botState.client.off("text", listener);
}

function itemAt(botState, slot) {
  return botState.inventory.slots[slot];
}

function emptySlots(botState) {
  return botState.inventory.slots
    .map((item, slot) => (item == null ? slot : -1))
    .filter((slot) => slot !== -1);
}

function firstEmptySlot(botState) {
  const slot = emptySlots(botState)[0];
  assert.notStrictEqual(slot, undefined, "Could not find empty inventory slot");
  return slot;
}

function snapshotNonEmpty(botState) {
  return botState.inventory.slots
    .map((item, slot) => item ? { slot, name: item.name, count: item.count, stack_id: item.stack_id } : null)
    .filter(Boolean);
}

function logInventory(botState, label) {
  console.log(`\n${label}`);
  console.table(snapshotNonEmpty(botState));
}

async function assertActionProducesPackets(botState, actionName, fn) {
  const seen = {
    itemStackRequest: false,
    responses: [],
    inventorySlots: [],
    inventoryContent: 0,
    localUpdates: []
  };

  function onItemStackRequest(request) {
    seen.itemStackRequest = true;
    console.log("[test] outbound item_stack_request", {
      request_id: request.request_id,
      actions: request.actions?.map((action) => action.type_id)
    });
  }

  function onResponse(packet) {
    seen.responses.push(packet);
    console.log("[test] inbound item_stack_response", packet);
  }

  function onInventorySlot(packet) {
    if (packet.window_id === 0 || packet.window_id === "inventory") {
      seen.inventorySlots.push(packet.slot);
      console.log("[test] inbound inventory_slot", {
        slot: packet.slot,
        item: packet.item
      });
    }
  }

  function onInventoryContent(packet) {
    if (packet.window_id === 0 || packet.window_id === "inventory") {
      seen.inventoryContent++;
      console.log("[test] inbound inventory_content", {
        slots: packet.input?.length
      });
    }
  }

  function onLocalUpdate(slot) {
    seen.localUpdates.push(slot);
  }

  botState.on("inventory_action_request", onItemStackRequest);
  botState.client.on("item_stack_response", onResponse);
  botState.client.on("inventory_slot", onInventorySlot);
  botState.client.on("inventory_content", onInventoryContent);
  botState.inventory.on("updateSlot", onLocalUpdate);

  try {
    const result = await fn();
    await sleep(AFTER_ACTION_DELAY_MS);

    assert.strictEqual(
      seen.itemStackRequest,
      true,
      `${actionName} did not send an item_stack_request`
    );

    assert(
      seen.responses.length > 0,
      `${actionName} did not receive item_stack_response`
    );

    assert(
      seen.inventorySlots.length > 0 || seen.inventoryContent > 0 || seen.localUpdates.length > 0,
      `${actionName} did not receive or apply an inventory update`
    );

    return result;
  } finally {
    botState.off("inventory_action_request", onItemStackRequest);
    botState.client.off("item_stack_response", onResponse);
    botState.client.off("inventory_slot", onInventorySlot);
    botState.client.off("inventory_content", onInventoryContent);
    botState.inventory.off("updateSlot", onLocalUpdate);
  }
}

describe("real inventory actions", function () {
  this.timeout(180000);

  let botState;

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

    botState.setInventoryActionResponseTimeout?.(10000);
    botState.setInventoryActionUpdateTimeout?.(10000);
  });

  beforeEach(async function () {
    await setupInventory(botState);
    logInventory(botState, "Inventory reset");
  });

  after(function () {
    if (botState?.client) {
      botState.disconnect("Inventory actions mocha test complete");
    }
  });

  it("swaps two occupied inventory slots using item_stack_request", async function () {
    const diamondSlot = findSlotByName(botState, "diamond");
    const stickSlot = findSlotByName(botState, "stick");

    await assertActionProducesPackets(botState, "swapInventorySlots", () => {
      return botState.swapInventorySlots(diamondSlot, stickSlot);
    });

    assertSlot(botState.inventory, diamondSlot, "stick", 5);
    assertSlot(botState.inventory, stickSlot, "diamond", 3);
  });

  it("moves an occupied slot into an empty slot using item_stack_request", async function () {
    const dirtSlot = findSlotByName(botState, "dirt");
    const emptySlot = firstEmptySlot(botState);

    await assertActionProducesPackets(botState, "moveInventorySlot", () => {
      return botState.moveInventorySlot(dirtSlot, emptySlot);
    });

    assertSlot(botState.inventory, dirtSlot, null, 0);
    assertSlot(botState.inventory, emptySlot, "dirt", 7);
  });

  it("swaps an occupied slot with an empty slot using item_stack_request", async function () {
    const diamondSlot = findSlotByName(botState, "diamond");
    const emptySlot = firstEmptySlot(botState);

    await assertActionProducesPackets(botState, "swapInventorySlots occupied-empty", () => {
      return botState.swapInventorySlots(diamondSlot, emptySlot);
    });

    assertSlot(botState.inventory, diamondSlot, null, 0);
    assertSlot(botState.inventory, emptySlot, "diamond", 3);
  });

  it("splits a stack into an empty slot using item_stack_request", async function () {
    const dirtSlot = findSlotByName(botState, "dirt");
    const emptySlot = firstEmptySlot(botState);

    await assertActionProducesPackets(botState, "splitInventorySlot", () => {
      return botState.splitInventorySlot(dirtSlot, emptySlot);
    });

    assertSlot(botState.inventory, dirtSlot, "dirt", 3);
    assertSlot(botState.inventory, emptySlot, "dirt", 4);
  });

  it("merges compatible stacks using item_stack_request", async function () {
    const dirtSlot = findSlotByName(botState, "dirt");
    const emptySlot = firstEmptySlot(botState);

    await assertActionProducesPackets(botState, "splitInventorySlot before merge", () => {
      return botState.splitInventorySlot(dirtSlot, emptySlot);
    });

    assertSlot(botState.inventory, dirtSlot, "dirt", 3);
    assertSlot(botState.inventory, emptySlot, "dirt", 4);

    await assertActionProducesPackets(botState, "mergeInventorySlots", () => {
      return botState.mergeInventorySlots(dirtSlot, emptySlot);
    });

    assertSlot(botState.inventory, dirtSlot, null, 0);
    assertSlot(botState.inventory, emptySlot, "dirt", 7);
  });

  it("batches chained direct player inventory actions into one item_stack_request", async function () {
    setPlayerGamemode(botState, USERNAME, "survival");
    await sleep(SETUP_DELAY_MS);

    const dirtSlot = findSlotByName(botState, "dirt");
    const emptySlot = firstEmptySlot(botState);
    const requests = [];

    function onRequest(packet) {
      requests.push(packet);
    }

    let result;
    botState.on("inventory_action_request", onRequest);
    try {
      result = await assertActionProducesPackets(botState, "inventory action batch", () => {
        return botState.inventory.actions.batch((inventory) => {
          inventory.split(dirtSlot, emptySlot);
          inventory.merge(dirtSlot, emptySlot);
        });
      });
    } finally {
      botState.off("inventory_action_request", onRequest);
    }

    assert.strictEqual(requests.length, 1, "batch should coalesce the rejected split-then-merge shape");
    assert.strictEqual(result.requests.length, 1, "batch result should expose the coalesced request entry");
    assert.deepStrictEqual(requests[0].actions.map((action) => action.type_id), ["take"]);
    assert.strictEqual(requests[0].actions[0].count, 7);
    assertSlot(botState.inventory, dirtSlot, null, 0);
    assertSlot(botState.inventory, emptySlot, "dirt", 7);
    assert.strictEqual(botState.inventory.cursor, null);
  });

  it("predicts cursor pickup and placement across accepted item_stack_requests", async function () {
    setPlayerGamemode(botState, USERNAME, "survival");
    await sleep(SETUP_DELAY_MS);

    const dirtSlot = findSlotByName(botState, "dirt");
    const emptySlot = firstEmptySlot(botState);

    await botState.pickupInventorySlot(dirtSlot, 3);

    assertSlot(botState.inventory, dirtSlot, "dirt", 7);
    assertSlot({ slots: botState.inventory.predicted }, dirtSlot, "dirt", 4);
    assert(botState.inventory.cursor, "expected predicted cursor after pickup");
    assert.strictEqual(botState.inventory.cursor.name, "dirt");
    assert.strictEqual(botState.inventory.cursor.count, 3);

    await assertActionProducesPackets(botState, "placeCursorItem", () => {
      return botState.placeCursorItem(emptySlot);
    });

    assertSlot(botState.inventory, dirtSlot, "dirt", 4);
    assertSlot(botState.inventory, emptySlot, "dirt", 3);
    assert.strictEqual(botState.inventory.cursor, null);
  });

  it("moves one item from a stack into an empty slot using item_stack_request", async function () {
    const dirtSlot = findSlotByName(botState, "dirt");
    const emptySlot = firstEmptySlot(botState);

    await assertActionProducesPackets(botState, "moveOneInventoryItem to empty", () => {
      return botState.moveOneInventoryItem(dirtSlot, emptySlot);
    });

    assertSlot(botState.inventory, dirtSlot, "dirt", 6);
    assertSlot(botState.inventory, emptySlot, "dirt", 1);
  });

  it("moves one item onto a compatible stack using item_stack_request", async function () {
    const dirtSlot = findSlotByName(botState, "dirt");
    const emptySlot = firstEmptySlot(botState);

    await assertActionProducesPackets(botState, "splitInventorySlot before moveOne", () => {
      return botState.splitInventorySlot(dirtSlot, emptySlot);
    });

    assertSlot(botState.inventory, dirtSlot, "dirt", 3);
    assertSlot(botState.inventory, emptySlot, "dirt", 4);

    await assertActionProducesPackets(botState, "moveOneInventoryItem compatible", () => {
      return botState.moveOneInventoryItem(dirtSlot, emptySlot);
    });

    assertSlot(botState.inventory, dirtSlot, "dirt", 2);
    assertSlot(botState.inventory, emptySlot, "dirt", 5);
  });

  it("drops one item from a stack using item_stack_request", async function () {
    const dirtSlot = findSlotByName(botState, "dirt");

    await assertActionProducesPackets(botState, "dropOneInventoryItem", () => {
      return botState.dropOneInventoryItem(dirtSlot);
    });

    assertSlot(botState.inventory, dirtSlot, "dirt", 6);
  });

  it("drops an entire slot using item_stack_request", async function () {
    const stickSlot = findSlotByName(botState, "stick");

    await assertActionProducesPackets(botState, "dropInventorySlot", () => {
      return botState.dropInventorySlot(stickSlot);
    });

    assertSlot(botState.inventory, stickSlot, null, 0);
  });

  it.skip("destroys one item from a stack using item_stack_request", async function () {
    const dirtSlot = findSlotByName(botState, "dirt");

    await assertActionProducesPackets(botState, "destroyOneInventoryItem", () => {
      return botState.destroyOneInventoryItem(dirtSlot);
    });

    assertSlot(botState.inventory, dirtSlot, "dirt", 6);
  });

  it.skip("destroys an entire slot using item_stack_request", async function () {
    const diamondSlot = findSlotByName(botState, "diamond");

    await assertActionProducesPackets(botState, "destroyInventorySlot", () => {
      return botState.destroyInventorySlot(diamondSlot);
    });

    assertSlot(botState.inventory, diamondSlot, null, 0);
  });
});
