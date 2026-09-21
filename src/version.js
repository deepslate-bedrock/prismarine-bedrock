'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_BEDROCK_VERSION = '1.26.45'

function normalizeBedrockVersion (version = DEFAULT_BEDROCK_VERSION) {
  const value = String(version || DEFAULT_BEDROCK_VERSION).trim()
  if (!value) return DEFAULT_BEDROCK_VERSION
  if (/^\d{2,}\.\d+$/.test(value)) return `1.${value}`
  return value
}

function versionTuple (value) {
  const [major = '0', minor = '0', patch = '0'] = String(value || '0').split('.')
  return [Number(major), Number(minor), Number(patch)]
}

function bedrockVersionFromEnv (env = process.env, fallback = DEFAULT_BEDROCK_VERSION) {
  return normalizeBedrockVersion(env.MC_VERSION || fallback)
}

function bedrockRegistryName (version = DEFAULT_BEDROCK_VERSION) {
  return `bedrock_${normalizeBedrockVersion(version)}`
}

function minecraftDataBedrockDir (version = DEFAULT_BEDROCK_VERSION, rootDir = path.join(__dirname, '..')) {
  const normalizedVersion = normalizeBedrockVersion(version)
  const bedrockRoot = path.join(
    rootDir,
    'node_modules',
    'minecraft-data',
    'minecraft-data',
    'data',
    'bedrock'
  )
  const exactDir = path.join(bedrockRoot, normalizedVersion)
  const typesFile = path.join(exactDir, 'types.yml')

  if (!fs.existsSync(bedrockRoot)) return exactDir
  if (fs.existsSync(typesFile)) return exactDir

  const candidates = fs.readdirSync(bedrockRoot)
    .filter(name => /^\d+\.\d+(?:\.\d+)?$/.test(name))
    .filter(name => fs.existsSync(path.join(bedrockRoot, name, 'types.yml')))
    .filter(name => {
      const tuple = versionTuple(name)
      const target = versionTuple(normalizedVersion)
      return tuple[0] < target[0] ||
        (tuple[0] === target[0] && tuple[1] < target[1]) ||
        (tuple[0] === target[0] && tuple[1] === target[1] && tuple[2] < target[2])
    })
    .sort((a, b) => {
      const left = versionTuple(a)
      const right = versionTuple(b)
      const leftScore = left[0] * 1000000 + left[1] * 1000 + left[2]
      const rightScore = right[0] * 1000000 + right[1] * 1000 + right[2]
      return leftScore - rightScore
    })

  const fallback = candidates[candidates.length - 1]
  return fallback ? path.join(bedrockRoot, fallback) : exactDir
}

module.exports = {
  DEFAULT_BEDROCK_VERSION,
  bedrockRegistryName,
  bedrockVersionFromEnv,
  minecraftDataBedrockDir,
  normalizeBedrockVersion
}
