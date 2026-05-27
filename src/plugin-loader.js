const fs = require('fs')
const path = require('path')

const loaderStates = new WeakMap()
const installedPluginBots = new WeakMap()
const INSTALLED_PLUGIN_BOTS = Symbol.for('prismarine-bedrock.plugin-loader.installedBots')
const builtinLoadPriority = {
  'world.js': -100,
  'setup.js': -90,
  'respawn.js': -80
}

function ensureState (botState) {
  if (!loaderStates.has(botState)) {
    loaderStates.set(botState, {
      plugins: [],
      injected: false
    })
  }

  return loaderStates.get(botState)
}

function loadedBotsFor (plugin) {
  if (plugin[INSTALLED_PLUGIN_BOTS]) return plugin[INSTALLED_PLUGIN_BOTS]
  if (installedPluginBots.has(plugin)) return installedPluginBots.get(plugin)

  const loadedBots = new WeakSet()
  try {
    Object.defineProperty(plugin, INSTALLED_PLUGIN_BOTS, {
      configurable: false,
      enumerable: false,
      value: loadedBots
    })
  } catch {
    installedPluginBots.set(plugin, loadedBots)
  }

  return loadedBots
}

function validatePlugin (plugin) {
  if (typeof plugin !== 'function') {
    throw new TypeError('[plugin-loader] plugin must be an install function')
  }
}

function markPluginLoaded (botState, plugin) {
  loadedBotsFor(plugin).add(botState)
}

function isPluginLoaded (botState, plugin) {
  if (typeof plugin !== 'function') return false
  return loadedBotsFor(plugin).has(botState)
}

function installPlugin (botState, plugin) {
  validatePlugin(plugin)
  if (isPluginLoaded(botState, plugin)) return false

  plugin(botState, botState.options)
  markPluginLoaded(botState, plugin)
  return true
}

function loadPlugin (botState, plugin) {
  validatePlugin(plugin)

  const state = ensureState(botState)
  if (!state.plugins.includes(plugin)) state.plugins.push(plugin)

  if (state.injected) installPlugin(botState, plugin)
}

function loadPlugins (botState, plugins = []) {
  plugins.forEach(plugin => loadPlugin(botState, plugin))
}

function hasPlugin (botState, plugin) {
  return ensureState(botState).plugins.includes(plugin) || isPluginLoaded(botState, plugin)
}

function isInjected (botState) {
  return ensureState(botState).injected
}

function injectPlugins (botState) {
  const state = ensureState(botState)
  if (state.injected) return

  state.plugins.forEach(plugin => installPlugin(botState, plugin))
  state.injected = true
  botState.emit?.('pluginsLoaded', { plugins: [...state.plugins], bot: botState })
}

function shouldLoadBuiltin (botState, entry) {
  const options = botState.options ?? {}
  if ((entry === 'physics.js' || entry === 'physics') && options.physicsEnabled === false) return false
  return true
}

function loadBuiltins (botState) {
  const builtinsDir = path.join(__dirname, 'builtins')
  if (!fs.existsSync(builtinsDir)) return

  const entries = fs.readdirSync(builtinsDir).sort((a, b) => {
    const priority = (builtinLoadPriority[a] ?? 0) - (builtinLoadPriority[b] ?? 0)
    return priority || a.localeCompare(b)
  })
  for (const entry of entries) {
    if (!shouldLoadBuiltin(botState, entry)) continue

    const entryPath = path.join(builtinsDir, entry)
    const stat = fs.statSync(entryPath)
    let pluginPath = null

    if (stat.isFile() && entry.endsWith('.js')) {
      pluginPath = entryPath
    } else if (stat.isDirectory()) {
      const indexPath = path.join(entryPath, 'index.js')
      const siblingFilePath = path.join(builtinsDir, `${entry}.js`)
      if (!fs.existsSync(siblingFilePath) && fs.existsSync(indexPath)) pluginPath = indexPath
    }

    if (!pluginPath) continue

    const plugin = require(pluginPath)
    if (typeof plugin === 'function') plugin(botState, botState.options)
  }
}

function injectAll (botState) {
  loadBuiltins(botState)
  injectPlugins(botState)
}

module.exports = {
  ensureState,
  hasPlugin,
  injectAll,
  injectPlugins,
  installPlugin,
  isPluginLoaded,
  isInjected,
  loadBuiltins,
  loadPlugin,
  loadPlugins,
  shouldLoadBuiltin
}
