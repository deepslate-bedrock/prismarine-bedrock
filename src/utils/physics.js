function normalizePhysicsGameMode (gamemode) {
  if (gamemode === 'creative' || gamemode === 1) return 'creative'
  if (gamemode === 'adventure' || gamemode === 2) return 'adventure'
  if (gamemode === 'spectator' || gamemode === 3 || gamemode === 6) return 'spectator'
  return 'survival'
}

function normalizePhysicsPose (pose, PlayerPoses) {
  if (!pose) return PlayerPoses.STANDING
  if (typeof pose === 'number') return PlayerPoses[pose] ? pose : PlayerPoses.STANDING
  if (typeof pose === 'string') {
    switch (pose.toLowerCase()) {
      case 'standing': return PlayerPoses.STANDING
      case 'sneaking':
      case 'crouching': return PlayerPoses.SNEAKING || PlayerPoses.CROUCHING || 1
      case 'swimming': return PlayerPoses.SWIMMING || 2
      case 'fall_flying':
      case 'fallflying': return PlayerPoses.FALL_FLYING || 3
      case 'sleeping': return PlayerPoses.SLEEPING || 0
      default: return PlayerPoses.STANDING
    }
  }
  return PlayerPoses.STANDING
}

module.exports = {
  normalizePhysicsGameMode,
  normalizePhysicsPose
}
