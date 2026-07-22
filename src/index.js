const BotState = require('./state')
const pluginLoader = require('./plugin-loader')
const utils = require('./utils')
const version = require('./version')
const fishing = require('./builtins/fishing')

function createBot (options) {
  const bot = new BotState(options)
  bot.start()
  return bot
}

module.exports = {
  BotState,
  createBot,
  pluginLoader,
  utils,
  FishingCancelledError: fishing.FishingCancelledError,
  FishingTimeoutError: fishing.FishingTimeoutError,
  FishingPreconditionError: fishing.FishingPreconditionError,
  ...version
}
