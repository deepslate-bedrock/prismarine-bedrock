# Inventory And Actions

The inventory builtin mirrors player and container windows. The inventory
actions builtin sends Bedrock `item_stack_request` operations and applies server
responses back into the local mirror.

## Inventory Mirror

| API | Purpose |
| --- | --- |
| `bot.inventory` | Player inventory window from `prismarine-windows`. |
| `bot.windows` | Map of windows by window id; window id `0` is player inventory. |
| `bot.uiSlots` | Bedrock UI slot projection map. |
| `bot.heldItemSlot` | Selected hotbar slot. |
| `bot.heldItem` | Getter for the currently held item or `null`. |
| `bot.getWindow(windowId = 0)` | Reads a window. |
| `bot.getUiSlot(slot)` | Reads a projected UI slot. |
| `bot.getItem(slot, windowId = 0)` | Reads a window slot. |
| `bot.findItem(itemType, metadata, notFull, nbt, windowId = 0)` | Searches inventory range. |
| `bot.count(itemType, metadata, windowId = 0)` | Counts matching items. |
| `bot.applyItemStackResponseToInventory(response)` | Applies accepted stack ids/counts into the mirror. |

```js
const stick = bot.findItem(bot.registry.itemsByName.stick.id)
console.log(stick?.count ?? 0)
```

## Item Stack Requests

| API | Purpose |
| --- | --- |
| `bot.sendItemStackRequest(request)` | Queues a request in the auth-input path. |
| `bot.sendStandaloneItemStackRequest(request)` | Sends standalone `item_stack_request`. |
| `bot.waitForItemStackResponse(id, timeoutMs?)` | Waits for an accepted response. |
| `bot.waitForRawItemStackResponse(id, timeoutMs?)` | Waits for any response status. |
| `bot.setInventoryActionResponseTimeout(ms)` | Changes response timeout. |
| `bot.setInventoryActionUpdateTimeout(ms)` | Changes slot update timeout. |
| `bot.clearInventoryActionWaiters()` | Rejects pending waits. |

## Common Actions

| API | Purpose |
| --- | --- |
| `bot.setHeldItemSlot(slot)` / `bot.selectHotbarSlot(slot)` | Selects a hotbar slot. |
| `bot.equipItem(slot, hotbarSlot = 0)` / `bot.equipInventorySlot` | Equips a slot directly or via hotbar swap. |
| `bot.swapInventorySlots(slotA, slotB)` | Swaps slots. |
| `bot.moveInventorySlot(fromSlot, toSlot)` | Moves a full stack. |
| `bot.mergeInventorySlots(fromSlot, toSlot)` | Merges as much as destination can accept. |
| `bot.moveOneInventoryItem(fromSlot, toSlot)` | Moves one item. |
| `bot.splitInventorySlot(fromSlot, toSlot)` | Moves half of source, rounded up. |
| `bot.dropInventorySlot(slot, randomly = false)` | Drops a full stack. |
| `bot.dropOneInventoryItem(slot, randomly = false)` | Drops one item. |
| `bot.destroyInventorySlot(slot)` | Destroys a full stack through the request path. |
| `bot.destroyOneInventoryItem(slot)` | Destroys one item. |

```js
await bot.equipItem(12, 0)
await bot.dropOneInventoryItem(bot.heldItemSlot)
```

## Events

| Event | Payload |
| --- | --- |
| `held_item_slot_changed` | Slot, item. |
| `inventory_action_request` | Request. |
| `item_stack_response` | Parsed response. |
| `inventory_response_applied` | Response, changed slot list. |
| `ui_slot_projected` | Projection payload. |
| `ui_slot_updated` | Slot, item, packet. |
| `ui_content_updated` | `uiSlots`, packet. |
| `inventory_content_updated` | Window id, window. |
| `inventory_trade_window_updated` | Window id, window, packet. |
| `container_data_updated` | Window id, data, packet. |

