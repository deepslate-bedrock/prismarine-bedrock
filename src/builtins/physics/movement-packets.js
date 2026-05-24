const { Vec3 } = require('vec3')
const { deltaDeg, logAction, normalizeInputData, numberOrZero } = require('../../utils')
const { toFeetPosition } = require('./position')

const INPUT_FLAG_NAME_BY_CONSTANT = {
  BIT_ASCEND: 'ascend',
  BIT_DESCEND: 'descend',
  BIT_SPRINT_DOWN: 'sprint_down',
  BIT_CHANGE_HEIGHT: 'change_height',
  BIT_JUMPING: 'jumping',
  BIT_AUTO_JUMPING_IN_WATER: 'auto_jumping_in_water',
  BIT_SNEAKING: 'sneaking',
  BIT_SNEAK_DOWN: 'sneak_down',
  BIT_UP: 'up',
  BIT_DOWN: 'down',
  BIT_LEFT: 'left',
  BIT_RIGHT: 'right',
  BIT_UP_LEFT: 'up_left',
  BIT_UP_RIGHT: 'up_right',
  BIT_WANT_UP: 'want_up',
  BIT_WANT_DOWN: 'want_down',
  BIT_SPRINTING: 'sprinting',
  BIT_START_SPRINTING: 'start_sprinting',
  BIT_STOP_SPRINTING: 'stop_sprinting',
  BIT_START_SNEAKING: 'start_sneaking',
  BIT_STOP_SNEAKING: 'stop_sneaking',
  BIT_START_SWIMMING: 'start_swimming',
  BIT_STOP_SWIMMING: 'stop_swimming',
  BIT_START_JUMPING: 'start_jumping',
  BIT_START_FLYING: 'start_flying',
  BIT_STOP_FLYING: 'stop_flying',
  BIT_HANDLED_TELEPORT: 'handled_teleport',
  BIT_RECEIVED_SERVER_DATA: 'received_server_data',
  BIT_BLOCK_ACTION: 'block_action',
  BIT_BLOCK_BREAKING_DELAY_ENABLED: 'block_breaking_delay_enabled',
  BIT_HORIZONTAL_COLLISION: 'horizontal_collision',
  BIT_VERTICAL_COLLISION: 'vertical_collision',
  BIT_START_USING_ITEM: 'start_using_item',
  BIT_CAMERA_RELATIVE_MOVEMENT: 'camera_relative_movement_enabled',
  BIT_SNEAK_RELEASED_RAW: 'sneak_released_raw',
  BIT_SNEAK_PRESSED_RAW: 'sneak_pressed_raw',
  BIT_SNEAK_CURRENT_RAW: 'sneak_current_raw'
}

function inputFlagByBit (C) {
  return Object.fromEntries(
    Object.entries(INPUT_FLAG_NAME_BY_CONSTANT)
      .filter(([constant]) => C[constant] != null)
      .map(([constant, name]) => [String(C[constant]), name])
  )
}

function degreesToRadians (degrees) {
  return (degrees * Math.PI) / 180
}

function wrapDegrees (degrees) {
  const value = numberOrZero(degrees)
  let wrapped = value % 360
  if (wrapped >= 180) wrapped -= 360
  if (wrapped < -180) wrapped += 360
  return numberOrZero(wrapped)
}

function clampPitch (pitch) {
  return Math.max(-90, Math.min(90, numberOrZero(pitch)))
}

function cameraOrientationFromRotation (yaw, pitch) {
  const yawRad = degreesToRadians(numberOrZero(yaw))
  const pitchRad = degreesToRadians(numberOrZero(pitch))
  const cosPitch = Math.cos(pitchRad)

  return {
    x: numberOrZero(-Math.sin(yawRad) * cosPitch),
    y: numberOrZero(-Math.sin(pitchRad)),
    z: numberOrZero(Math.cos(yawRad) * cosPitch),
  }
}

function hasSupportingBlock (botState, C) {
  const self = botState.self
  if (!self?.position || !botState.world?.sync?.getBlock) return false

  try {
    const feet = toFeetPosition(self.position, self, C)
    const below = botState.world.sync.getBlock(feet.offset(0, -0.1, 0).floored())
    return below?.boundingBox === 'block' || (Array.isArray(below?.shapes) && below.shapes.length > 0)
  } catch {
    return false
  }
}

function createMovementPacketSender (botState, C, options = {}) {
  const client = botState.client
  const yawStepSpeed = Number(options.yawStepSpeed ?? 180)
  const pitchStepSpeed = Number(options.pitchStepSpeed ?? 180)

  let lastSentYaw = null
  let lastSentPitch = null
  let lookResolve = null
  let lookPromise = null

  function resetRotation () {
    lastSentYaw = null
    lastSentPitch = null
  }

  function interpolateRotation (dt) {
    if (!botState.self) return

    if (lastSentYaw === null) {
      lastSentYaw = botState.self.yaw
      lastSentPitch = botState.self.pitch
      return
    }

    const dYaw = deltaDeg(botState.self.yaw, lastSentYaw)
    const dPitch = botState.self.pitch - lastSentPitch
    const maxYaw = yawStepSpeed * dt
    const maxPitch = pitchStepSpeed * dt

    lastSentYaw += Math.max(-maxYaw, Math.min(maxYaw, dYaw))
    lastSentPitch += Math.max(-maxPitch, Math.min(maxPitch, dPitch))

    if (
      Math.abs(deltaDeg(botState.self.yaw, lastSentYaw)) < 0.001 &&
      Math.abs(botState.self.pitch - lastSentPitch) < 0.001 &&
      lookResolve
    ) {
      lookResolve()
      lookResolve = null
      lookPromise = null
    }
  }

  function sendPlayerAuthInput (dt) {
    const self = botState.self
    if (!self) return
    if (!botState.canSendPlayerAuthInput) return

    interpolateRotation(dt)

    const moveVector = self.moveVector || { x: 0, z: 0 }
    const analogueMoveVector = self.analogueMoveVector || moveVector
    const rawMoveVector = self.rawMoveVector || moveVector

    const sentPitch = clampPitch(lastSentPitch)
    const sentYaw = wrapDegrees(lastSentYaw)
    const cameraOrientation = cameraOrientationFromRotation(sentYaw, sentPitch)
    const inputData = normalizeInputData(self.inputData || 0n, inputFlagByBit(C))
    inputData.block_breaking_delay_enabled = true
    if (self.verticalCollision || self.onGround || hasSupportingBlock(botState, C)) {
      inputData.vertical_collision = true
    }
    if (self._handledTeleportPending) {
      inputData.handled_teleport = true
      self._handledTeleportPending = false
    }

    const packet = {
      pitch: sentPitch,
      yaw: sentYaw,
      position: {
        x: numberOrZero(self.position.x),
        y: numberOrZero(self.position.y),
        z: numberOrZero(self.position.z),
      },
      move_vector: {
        x: numberOrZero(moveVector.x),
        z: numberOrZero(moveVector.z),
      },
      head_yaw: sentYaw,
      input_data: inputData,
      input_mode: 1,
      play_mode: 2,
      interaction_model: 1,
      interact_rotation: { x: sentPitch, z: sentYaw },
      tick: self.tick || 0n,
      delta: self.delta || { x: 0, y: 0, z: 0 },
      analogue_move_vector: {
        x: numberOrZero(analogueMoveVector.x),
        z: numberOrZero(analogueMoveVector.z),
      },
      camera_orientation: cameraOrientation,
      raw_move_vector: {
        x: numberOrZero(rawMoveVector.x),
        z: numberOrZero(rawMoveVector.z),
      },
    }

    botState._applyPlayerAuthInputHooks?.(packet, { botState, dt, self })
    if (packet.item_stack_request) {
      logAction('[auth_input]', 'send item_stack_request', {
        inputData: packet.input_data?._value ?? packet.input_data,
        tick: packet.tick,
        requestId: packet.item_stack_request.request_id,
        actions: packet.item_stack_request.actions?.map(action => action.type_id),
      })
    }
    client.queue('player_auth_input', packet)
  }

  function sendMovePlayer (mode, dt) {
    const self = botState.self
    if (!self) return

    interpolateRotation(dt)

    client.queue('move_player', {
      runtime_id: client.entityId || 0n,
      position: {
        x: numberOrZero(self.position.x),
        y: numberOrZero(self.position.y),
        z: numberOrZero(self.position.z),
      },
      pitch: clampPitch(lastSentPitch),
      yaw: wrapDegrees(lastSentYaw),
      head_yaw: wrapDegrees(lastSentYaw),
      mode,
      on_ground: !!self.onGround,
      ridden_runtime_id: 0,
      teleport: undefined,
      tick: self.tick || 0n,
    })
  }

  function look (yaw, pitch, force = false) {
    if (!botState.self) return

    botState.self.yaw = yaw
    botState.self.pitch = pitch
    botState.self.headYaw = yaw

    if (force) {
      lastSentYaw = yaw
      lastSentPitch = pitch
    }
  }

  function lookAt (point, force = false) {
    if (!botState.self) return

    const eye = botState.self.position
    const d = point.minus ? point.minus(eye) : new Vec3(point.x - eye.x, point.y - eye.y, point.z - eye.z)
    const yaw = (Math.atan2(-d.x, d.z) * 180) / Math.PI
    const pitch = (-Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z)) * 180) / Math.PI

    look(yaw, pitch, force)
  }

  function waitForLookComplete () {
    if (!botState.self) return Promise.resolve()

    if (
      lastSentYaw !== null &&
      Math.abs(deltaDeg(botState.self.yaw, lastSentYaw)) < 0.001 &&
      Math.abs(botState.self.pitch - lastSentPitch) < 0.001
    ) {
      return Promise.resolve()
    }

    if (!lookPromise) {
      lookPromise = new Promise((resolve) => {
        lookResolve = resolve
      })
    }

    return lookPromise
  }

  return {
    sendPlayerAuthInput,
    sendMovePlayer,
    syncLook: () => sendMovePlayer(0, 0),
    resetRotation,
    look,
    lookAt,
    waitForLookComplete,
  }
}

module.exports = { createMovementPacketSender }
