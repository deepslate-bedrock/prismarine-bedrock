function normalizeInputData (inputData, flagByBit) {
  if (inputData && typeof inputData === 'object') return inputData

  const flags = {}
  const value = BigInt(inputData || 0)
  for (const [bit, name] of Object.entries(flagByBit)) {
    flags[name] = (value & (1n << BigInt(bit))) !== 0n
  }
  return flags
}

module.exports = {
  normalizeInputData
}
