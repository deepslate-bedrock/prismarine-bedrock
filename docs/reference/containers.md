# Containers

The container builtin opens Bedrock block containers, wraps windows with a common
transfer API, and specializes known container types with slot-aware helpers.

## Opening Containers

| API | Purpose |
| --- | --- |
| `bot.openContainer(pos, opts = {})` / `bot.openBlockContainer` | Looks at a block, sends open action, and waits for content. |
| `bot.getCurrentContainer()` | Reads the active container pointer. |
| `bot.containers.waitForOpen(predicate?, timeoutMs?)` | Waits for a matching `container_open`. |
| `bot.containers.wrapWindow(packet)` | Wraps an existing Bedrock container window. |
| `bot.containers.get(windowId)` | Reads an open container by window id. |
| `bot.containers.open` | Map of open wrappers keyed by window id. |

```js
const chest = await bot.openContainer(new Vec3(10, 64, 10))
await chest.takeContainerSlot(0)
chest.close()
```

## Base Container API

Every wrapped container exposes:

| API | Purpose |
| --- | --- |
| `container.id` / `container.windowId` | Normalized Bedrock window id. |
| `container.type` | Bedrock/prismarine window type. |
| `container.containerSlotType` | Bedrock stack request container id/type. |
| `container.position` | Block coordinates from the open packet. |
| `container.window` | Underlying Prismarine window. |
| `container.slots` | Window slots. |
| `container.containerSlotCount` | Slot count before player inventory starts. |
| `container.getItem(slot)` | Reads a container slot. |
| `container.getInventoryItem(slot)` | Reads a bot inventory slot. |
| `container.firstEmptyContainerSlot()` | Finds first empty container slot. |
| `container.firstEmptyInventorySlot()` | Finds first empty inventory slot. |
| `container.findContainerItem(name)` | Searches by item name. |
| `container.putInventorySlot(inventorySlot, containerSlot?, count?)` | Transfers inventory to container. |
| `container.takeContainerSlot(containerSlot, inventorySlot?, count?)` | Transfers container to inventory. |
| `container.moveContainerSlot(fromSlot, toSlot, count?)` | Moves within the container. |
| `container.swapContainerSlots(slotA, slotB)` | Swaps two container slots. |
| `container.waitForContent(timeoutMs?)` | Waits for content update. |
| `container.close()` | Queues `container_close`. |

Transfer helpers throw on invalid slots, missing source items, incompatible
destination stacks, and insufficient destination space.

## Specialized Helpers

| Container type | Added API |
| --- | --- |
| `armor` / `hand` | Armor/offhand placement helpers. |
| `anvil`, `cartography`, `grindstone`, `smithing_table`, `stonecutter` | Input/material/result helpers. |
| `beacon` | Payment helper. |
| `brewing_stand` | Bottle, ingredient, fuel, result, and progress helpers. |
| `crafter`, `workbench` | Crafting input/result helpers. |
| `enchantment` | Lapis/input, enchant option lookup, wait, and selection helpers. |
| `furnace` and furnace-like | Input/fuel/output and cook progress helpers. |
| `loom` | Banner, dye, material/pattern, and result helpers. |
| `trading` | Trade ingredient/result slot helpers. |

## Events

| Event | Payload |
| --- | --- |
| `container_data` | `{ windowId, container, property, value, packet, handled }` |
| `player_enchant_options` | `{ container, packet, handled }` |
