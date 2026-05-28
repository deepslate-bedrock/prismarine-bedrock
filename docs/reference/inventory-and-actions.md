# Inventory And Actions

The inventory builtin mirrors player and container windows. The inventory
actions builtin sends Bedrock `item_stack_request` operations and applies server
responses back into the local mirror. Player inventory actions also maintain a
predicted slot/cursor view while stack requests are pending.

## Inventory Mirror

| API | Purpose |
| --- | --- |
| `bot.inventory` | Player inventory window from `prismarine-windows`. |
| `bot.windows` | Map of windows by window id; window id `0` is player inventory. |
| `bot.uiSlots` | Bedrock UI slot projection map. |
| `bot.heldItemSlot` | Selected hotbar slot. |
| `bot.heldItem` | Getter for the currently held item or `null`. |
| `bot.inventory.predicted` | Read-only predicted inventory snapshot. It is array-compatible for player slots and also exposes `.slots`, `.cursor`, `.windows`, `.activeWindowId`, `.activeWindow`, `.uiSlots`, `.armor`, `.offhand`, `.craftingInput`, `.creativeOutput`, and `.slot(slotInfo)`. |
| `bot.inventory.cursor` | Compatibility alias for `bot.inventory.predicted.cursor`, or `null`. |
| `bot.getWindow(windowId = 0)` | Reads a window. |
| `bot.getUiSlot(slot)` | Reads a projected UI slot. |
| `bot.inventory.getItem(slot, windowId = 0)` | Reads a window slot. |
| `bot.inventory.findItem(itemType, metadata, notFull, nbt, windowId = 0)` | Searches inventory range. |
| `bot.inventory.count(itemType, metadata, windowId = 0)` | Counts matching items. |
| `bot.inventory.applyItemStackResponse(response)` | Applies accepted stack ids/counts into the mirror. |

```js
const stick = bot.inventory.findItem(bot.registry.itemsByName.stick.id)
console.log(stick?.count ?? 0)
```

## Item Stack Requests

| API | Purpose |
| --- | --- |
| `bot.inventory.actions.send(request)` | Queues a request in the auth-input path. |
| `bot.inventory.actions.sendStandalone(request)` | Sends standalone `item_stack_request`. |
| `bot.inventory.actions.wait(id, timeoutMs?)` | Waits for an accepted response. |
| `bot.inventory.actions.waitRaw(id, timeoutMs?)` | Waits for any response status. |
| `bot.inventory.actions.batch(fn)` | Records player inventory actions and sends them as one packet containing ordered stack request entries. |
| `bot.inventory.actions.setResponseTimeout(ms)` | Changes response timeout. |
| `bot.inventory.actions.setUpdateTimeout(ms)` | Changes slot update timeout. |
| `bot.inventory.actions.clearWaiters()` | Rejects pending waits. |

## Prediction

When no predicted transactions are pending, `bot.inventory.predicted` tracks the
actual inventory mirror. During pending player-inventory transactions, predicted
slots and `bot.inventory.cursor` reflect the locally simulated result while
`bot.inventory.slots` remains server-authoritative. Accepted responses reconcile
server counts and stack ids into both views. Rejected responses or accepted
responses that differ from prediction emit `inventory_prediction_failed`; the
server response is treated as ground truth.

```js
await bot.inventory.actions.batch((inventory) => {
  inventory.split(10, 11)
  inventory.merge(10, 11)
})
```

Batch prediction advances between recorded operations. The emitted packet uses
multiple ordered request ids when needed, matching vanilla's provisional
negative stack-id behavior for chained unconfirmed slot/cursor changes. Adjacent
player moves that split and then merge the same source into the same destination
may be coalesced into one server request, because BDS rejects the repeated
provisional-destination form for that closed-inventory action shape.

## Common Actions

| API | Purpose |
| --- | --- |
| `bot.inventory.select(slot)` | Selects a hotbar slot. |
| `bot.inventory.equip(slot, hotbarSlot = 0)` | Equips a slot directly or via hotbar swap. |
| `bot.inventory.swap(slotA, slotB)` | Swaps slots. |
| `bot.inventory.move(fromSlot, toSlot)` | Moves a full stack. |
| `bot.inventory.merge(fromSlot, toSlot)` | Merges as much as destination can accept. |
| `bot.inventory.move1(fromSlot, toSlot)` | Moves one item. |
| `bot.inventory.split(fromSlot, toSlot)` | Moves half of source, rounded up. |
| `bot.inventory.pickup(slot, count?)` | Takes a slot, or part of it, onto the predicted cursor. In the closed-inventory player path this is a local prediction until a later placement/drop flushes a server request. |
| `bot.inventory.placeCursor(slot, count?)` | Places the predicted cursor, or part of it, into a slot and flushes the pending cursor move when possible. |
| `bot.inventory.drop(slot, randomly = false)` | Drops a full stack. |
| `bot.inventory.drop1(slot, randomly = false)` | Drops one item. |
| `bot.inventory.destroy(slot)` | Destroys a full stack through the request path. |
| `bot.inventory.destroy1(slot)` | Destroys one item. |

```js
await bot.inventory.equip(12, 0)
await bot.inventory.drop1(bot.heldItemSlot)
```

## Events

| Event | Payload |
| --- | --- |
| `held_item_slot_changed` | Slot, item. |
| `inventory_action_request` | Request. |
| `inventory_prediction_updated` | Prediction snapshot payload. |
| `inventory_prediction_reconciled` | Request, response, changed slots, mismatch list. |
| `inventory_prediction_failed` | Error payload with request, response, and mismatches. |
| `item_stack_response` | Parsed response. |
| `inventory_response_applied` | Response, changed slot list. |
| `ui_slot_projected` | Projection payload. |
| `ui_slot_updated` | Slot, item, packet. |
| `ui_content_updated` | `uiSlots`, packet. |
| `inventory_content_updated` | Window id, window. |
| `inventory_trade_window_updated` | Window id, window, packet. |
| `container_data_updated` | Window id, data, packet. |
