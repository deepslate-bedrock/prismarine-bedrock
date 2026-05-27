# Crafting

The crafting builtin plans recipes from the local inventory and server recipe
data, then executes Bedrock crafting through `item_stack_request` actions.

## Planning State

| API | Purpose |
| --- | --- |
| `bot.bedrockCraftingRecipes` | Raw server-authoritative `crafting_data` recipes. |
| `bot.craftingRecipeRegistry` | Registry used by the recipe planner. |
| `bot.craftingRecipe` | Recipe class/constructor. |
| `bot.craftingItemIdsByName` | Item name to item id map. |
| `bot.craftingItemNamesById` | Item id to item name map. |

## Planning API

| API | Purpose |
| --- | --- |
| `bot.planCraftInventory(wantedItem)` | Uses `mineflayer-crafting-util`; returns a plan with `status` and `source`. |
| `bot.planCraftInventoryWithUtil` | Alias for `planCraftInventory`. |
| `bot.planCraft` | Alias for `planCraftInventory`. |

Failed plans throw before packet execution.

## Execution API

| API | Purpose |
| --- | --- |
| `bot.craftPlanRecipeBookAuto(plan, craftingTableBlock?)` | Sends recipe-book style auto craft actions. |
| `bot.craftPlanAuto(plan, craftingTableBlock?)` | Chooses auto or normal according to options. |
| `bot.craftPlanNormal(plan, craftingTableBlock?)` | Places ingredients and takes result through normal requests. |
| `bot.craftPlan` | Alias for `craftPlanNormal`. |
| `bot.craftItemAuto(itemId, count, craftingTableBlock?)` | Plans then executes auto craft. |
| `bot.craftItemRecipeBookAuto(itemId, count, craftingTableBlock?)` | Plans then executes recipe-book auto craft. |
| `bot.craftItemNormal(itemId, count, craftingTableBlock?)` | Plans then executes normal craft. |
| `bot.craftItem` | Alias for `craftItemNormal`. |
| `bot.craftAuto` | Alias for `craftItemAuto`. |
| `bot.craftRecipeBookAuto` | Alias for `craftItemRecipeBookAuto`. |
| `bot.craftNormal` | Alias for `craftItemNormal`. |

Crafting depends on current inventory state, server recipe data, stack ids,
container/window availability, and accepted server responses.

```js
const planks = bot.craftingItemIdsByName.oak_planks
await bot.craftItem(planks, 4)
```

## Events

| Event | Payload |
| --- | --- |
| `craft_item_stack_request` | Raw crafting request. |

