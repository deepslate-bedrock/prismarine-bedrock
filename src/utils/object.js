function mergePatch (target, patch) {
  if (!patch) return
  for (const [key, value] of Object.entries(patch)) {
    target[key] = value
  }
}

module.exports = {
  mergePatch
}
