'use strict'

const path = require('path')

const DEFAULT_BEDROCK_VERSION = '1.26.45'

function normalizeBedrockVersion (version = DEFAULT_BEDROCK_VERSION) {
  const value = String(version || DEFAULT_BEDROCK_VERSION).trim()
  if (!value) return DEFAULT_BEDROCK_VERSION
  if (/^\d{2,}\.\d+$/.test(value)) return `1.${value}`
  return value
}

function bedrockVersionFromEnv (env = process.env, fallback = DEFAULT_BEDROCK_VERSION) {
  return normalizeBedrockVersion(env.MC_VERSION || fallback)
}

function bedrockRegistryName (version = DEFAULT_BEDROCK_VERSION) {
  return `bedrock_${normalizeBedrockVersion(version)}`
}

function minecraftDataBedrockDir (version = DEFAULT_BEDROCK_VERSION, rootDir = path.join(__dirname, '..')) {
  return path.join(
    rootDir,
    'node_modules',
    'minecraft-data',
    'minecraft-data',
    'data',
    'bedrock',
    normalizeBedrockVersion(version)
  )
}

module.exports = {
  DEFAULT_BEDROCK_VERSION,
  bedrockRegistryName,
  bedrockVersionFromEnv,
  minecraftDataBedrockDir,
  normalizeBedrockVersion
}
