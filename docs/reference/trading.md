# Trading

Trading is Bedrock/Geyser-specific. The builtin opens villager-like trade
windows, tracks the active trading entity, reads available recipes, and executes
trade stack requests.

## Opening And State

| API | Purpose |
| --- | --- |
| `bot.openTrade(entity, opts?)` / `bot.tradeWith` | Interacts with an entity and waits for a trade window. |
| `bot.waitForTradeWindow(predicate?, timeoutMs?)` | Waits for `update_trade`. |
| `bot.closeTradeWindow()` | Closes active trade/container state. |
| `bot.currentTradeWindow` | Last active trade window packet or `null`. |
| `bot.currentTradingEntity` | Entity associated with the active trade window. |

## Recipes And Execution

| API | Purpose |
| --- | --- |
| `bot.currentTradeRecipes()` | Reads recipes from the current trade window. |
| `bot.findTrade(predicateOrOptions?)` | Finds a matching trade recipe. |
| `bot.executeTrade(recipeOrOptions, options?)` | Sends ingredient, selection, and result requests. |
| `bot.setTradeTimeout(ms)` | Updates trade wait timeout. |

The API intentionally leaves helper access available for agents because native
BDS and Geyser can differ in response details.

## Events

| Event | Payload |
| --- | --- |
| `trade_window_open` | Packet, entity. |
| `trade_window_update` | Packet, entity. |
| `trade_window_close` | Packet. |
| `trade_executed` | Execution payload. |

