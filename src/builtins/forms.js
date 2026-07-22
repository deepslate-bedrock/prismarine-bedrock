'use strict'

const MODERN_FORM_RESPONSE_VERSION = [1, 19, 20]
const FORM_TYPE_NAMES = {
  action: 'simple',
  action_form: 'simple',
  custom: 'custom',
  custom_form: 'custom',
  form: 'simple',
  message: 'modal',
  message_form: 'modal',
  modal: 'modal',
  simple: 'simple',
  simple_form: 'simple'
}
const PRESENTATION_COMPONENTS = new Set(['divider', 'header', 'label'])
const CUSTOM_COMPONENT_NAMES = {
  dropdown: 'dropdown',
  input: 'input',
  label: 'label',
  slider: 'slider',
  step_slider: 'step_slider',
  stepslider: 'step_slider',
  text_field: 'input',
  text_input: 'input',
  textfield: 'input',
  toggle: 'toggle',
  divider: 'divider',
  header: 'header'
}
const CANCEL_REASONS = new Set(['closed', 'busy'])
const FORM_BRAND = Symbol('prismarine-bedrock.form')

function stripColorCodes (value) {
  return String(value ?? '').replace(/\u00a7[0-9a-v]/gi, '')
}

function normalizeFormType (value) {
  return FORM_TYPE_NAMES[String(value ?? '').toLowerCase()] ?? 'unknown'
}

function normalizeComponentType (value) {
  const name = String(value ?? '').toLowerCase()
  return CUSTOM_COMPONENT_NAMES[name] ?? name ?? 'unknown'
}

function parseVersion (version) {
  const parts = String(version ?? '').match(/\d+/g) ?? []
  return [0, 1, 2].map(index => Number(parts[index] ?? 0))
}

function versionAtLeast (version, minimum) {
  const actual = parseVersion(version)
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] > minimum[index]) return true
    if (actual[index] < minimum[index]) return false
  }
  return true
}

function supportsOptionalFormResponse (version) {
  return versionAtLeast(version, MODERN_FORM_RESPONSE_VERSION)
}

function parseJsonData (data) {
  if (data && typeof data === 'object') return { value: data, text: JSON.stringify(data) }
  const text = String(data ?? '')
  return {
    value: JSON.parse(text.replace(/^\uFEFF/, '')),
    text
  }
}

function formText (value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(formText).join('')
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value.rawtext)) return value.rawtext.map(formText).join('')
  if (value.text != null) return formText(value.text)
  if (value.translate != null) {
    const parameters = formText(value.with)
    return parameters ? `${value.translate} ${parameters}` : String(value.translate)
  }
  return ''
}

function actionControlsFrom (data) {
  const raw = Array.isArray(data?.buttons)
    ? data.buttons
    : Array.isArray(data?.controls)
      ? data.controls
      : Array.isArray(data?.elements)
        ? data.elements
      : Array.isArray(data?.content)
        ? data.content
        : []

  let nextButtonId = 0
  return raw.map((control, index) => {
    const source = control && typeof control === 'object' ? control : { text: String(control ?? '') }
    const declaredType = source.type ?? source.kind
    const type = declaredType == null ? 'button' : normalizeComponentType(declaredType)
    const clickable = type === 'button' || type === 'action'
    const normalized = {
      ...source,
      type: clickable ? 'button' : type,
      text: formText(source.text ?? source.label),
      sourceIndex: index,
      raw: control
    }
    if (clickable) normalized.id = nextButtonId++
    return normalized
  })
}

function customComponentsFrom (data) {
  const raw = Array.isArray(data?.content)
    ? data.content
    : Array.isArray(data?.controls)
      ? data.controls
      : Array.isArray(data?.elements)
        ? data.elements
      : []

  return raw.map((component, index) => {
    const source = component && typeof component === 'object' ? component : { text: String(component ?? '') }
    const normalized = {
      ...source,
      id: index,
      type: normalizeComponentType(source.type ?? source.kind),
      raw: component
    }
    if (source.text != null) normalized.text = formText(source.text)
    if (source.label != null) normalized.label = formText(source.label)
    if (source.placeholder != null) normalized.placeholder = formText(source.placeholder)
    if (Array.isArray(source.options)) normalized.options = source.options.map(formText)
    if (Array.isArray(source.steps)) normalized.steps = source.steps.map(formText)
    return normalized
  })
}

function parseFormPacket (packet, source = 'modal') {
  const formId = Number(packet?.form_id ?? packet?.formId)
  const rawData = packet?.data ?? packet?.form_data ?? packet?.formData
  let data = null
  let parseError = null
  let rawDataText = typeof rawData === 'string' ? rawData : ''

  try {
    const parsed = parseJsonData(rawData)
    data = parsed.value
    rawDataText = parsed.text
  } catch (error) {
    parseError = error
  }

  const wireType = data && typeof data === 'object' ? data.type : null
  const type = normalizeFormType(wireType)
  const controls = type === 'simple' ? actionControlsFrom(data) : []
  const buttons = type === 'simple'
    ? controls.filter(control => control.type === 'button')
    : type === 'modal'
      ? [
          { id: 0, type: 'button', text: formText(data?.button1), sourceIndex: 0, raw: data?.button1 },
          { id: 1, type: 'button', text: formText(data?.button2), sourceIndex: 1, raw: data?.button2 }
        ]
      : []
  const components = type === 'custom' ? customComponentsFrom(data) : []

  const form = {
    id: formId,
    formId,
    type,
    wireType,
    source,
    title: formText(data?.title),
    content: type === 'custom' ? formText(data?.body) : formText(data?.content ?? data?.body),
    icon: data?.icon ?? null,
    submitButton: data?.submit_button != null || data?.submitButton != null || data?.submit != null
      ? formText(data?.submit_button ?? data?.submitButton ?? data?.submit)
      : null,
    controls,
    buttons,
    components,
    data,
    rawData: rawDataText,
    rawPacket: packet,
    parseError,
    receivedAt: Date.now(),
    responded: false,
    closed: false,
    status: 'pending'
  }
  Object.defineProperty(form, FORM_BRAND, { value: true })
  return form
}

function assertForm (form) {
  if (!form || typeof form !== 'object' || form[FORM_BRAND] !== true) {
    throw new TypeError('form must be a parsed form object; use bot.forms.getById(formId) for an id or bot.forms.parsePacket(packet) for a raw packet')
  }
  return form
}

function getFormButtons (form, options = {}) {
  assertForm(form)
  const includeColorCodes = options.includeColorCodes ?? options.includeFormatting ?? false

  return (form.buttons ?? []).map(button => ({
    ...button,
    text: includeColorCodes ? String(button.text ?? '') : stripColorCodes(button.text)
  }))
}

function defaultCustomResponse (components) {
  return components.map(component => {
    if (PRESENTATION_COMPONENTS.has(component.type)) return null
    switch (component.type) {
      case 'dropdown':
      case 'step_slider': return Number(component.default ?? component.default_index ?? 0)
      case 'input': return String(component.default ?? component.default_value ?? '')
      case 'slider': return Number(component.default ?? component.default_value ?? component.min ?? 0)
      case 'toggle': return Boolean(component.default ?? component.default_value ?? false)
      default: return null
    }
  })
}

function defaultResponseFor (form) {
  switch (form.type) {
    case 'simple': return form.buttons.length > 0 ? 0 : null
    case 'modal': return true
    case 'custom': return defaultCustomResponse(form.components)
    default: return null
  }
}

function normalizeResponseFor (form, response) {
  if (form.type === 'modal' && Number.isInteger(response)) {
    if (response === 0) return true
    if (response === 1) return false
  }
  return response
}

function validateCustomResponse (form, response) {
  if (!Array.isArray(response)) throw new TypeError('custom form response must be an array')
  if (response.length !== form.components.length) {
    throw new RangeError(`custom form response has ${response.length} values for ${form.components.length} components`)
  }

  form.components.forEach((component, index) => {
    const value = response[index]
    if (PRESENTATION_COMPONENTS.has(component.type)) {
      if (value !== null && value !== undefined) {
        throw new TypeError(`${component.type} response at index ${index} must be null`)
      }
      return
    }

    switch (component.type) {
      case 'dropdown':
      case 'step_slider':
        if (!Number.isInteger(value)) throw new TypeError(`${component.type} response at index ${index} must be an integer`)
        break
      case 'input':
        if (typeof value !== 'string') throw new TypeError(`input response at index ${index} must be a string`)
        break
      case 'slider':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`slider response at index ${index} must be a finite number`)
        break
      case 'toggle':
        if (typeof value !== 'boolean') throw new TypeError(`toggle response at index ${index} must be a boolean`)
        break
    }
  })
}

function validateResponse (form, response) {
  if (response === undefined) throw new TypeError('form response cannot be undefined')
  if (form.type === 'simple') {
    if (!Number.isInteger(response)) throw new TypeError('simple form response must be a button id')
    if (!form.buttons.some(button => button.id === response)) throw new RangeError(`simple form has no button ${response}`)
  } else if (form.type === 'modal') {
    if (typeof response !== 'boolean') throw new TypeError('modal form response must be a boolean or button id 0/1')
  } else if (form.type === 'custom') {
    validateCustomResponse(form, response)
  }
  return response
}

function buildResponsePacket (version, formId, response) {
  const data = JSON.stringify(response)
  if (data === undefined) throw new TypeError('form response is not JSON serializable')
  if (!supportsOptionalFormResponse(version)) return { form_id: formId, data }
  return {
    form_id: formId,
    has_response_data: true,
    data,
    has_cancel_reason: false
  }
}

function buildCancelPacket (version, formId, reason = 'closed') {
  reason = String(reason).toLowerCase()
  if (!CANCEL_REASONS.has(reason)) throw new Error(`Unknown form cancel reason: ${reason}`)
  if (!supportsOptionalFormResponse(version)) return { form_id: formId, data: 'null' }
  return {
    form_id: formId,
    has_response_data: false,
    has_cancel_reason: true,
    cancel_reason: reason
  }
}

function matchesWaitOptions (form, options) {
  if (options.type && normalizeFormType(options.type) !== form.type) return false
  if (options.source && options.source !== form.source) return false
  return typeof options.predicate !== 'function' || options.predicate(form)
}

module.exports = function formsPlugin (botState) {
  const client = botState.client
  const pending = new Map()
  const waiters = new Set()
  let lastForm = null

  function getById (formId) {
    if (!Number.isInteger(formId) || formId < 0) throw new TypeError('formId must be a non-negative integer')
    return pending.get(formId) ?? null
  }

  function requirePendingById (formId) {
    const form = getById(formId)
    if (!form) throw new Error(`No pending form with id ${formId}`)
    return form
  }

  function assertPendingForm (form) {
    assertForm(form)
    if (form.status !== 'pending') throw new Error(`Form ${form.id} is already ${form.status}`)
    if (pending.get(form.id) !== form) {
      throw new Error(`Form ${form.id} is not the tracked pending form; use bot.forms.getById(${form.id})`)
    }
    return form
  }

  function finishForm (form, status, detail) {
    pending.delete(form.id)
    form.status = status
    form.responded = status === 'responded'
    form.closed = status === 'cancelled' || status === 'closed_by_server'
    form.completedAt = Date.now()
    if (status === 'responded') form.response = detail
    if (form.closed) form.cancelReason = detail
  }

  function respond (form, rawResponse, options = {}) {
    assertPendingForm(form)
    if (rawResponse === null && options.nullIsResponse !== true) return cancel(form, options.cancelReason ?? 'closed')
    const response = normalizeResponseFor(form, rawResponse)
    if (options.validate !== false) validateResponse(form, response)
    const packet = buildResponsePacket(botState.version ?? botState.options?.version, form.id, response)
    client.queue('modal_form_response', packet)
    finishForm(form, 'responded', response)
    botState.emit?.('formResponded', form, response, packet)
    return packet
  }

  function respondById (formId, response, options = {}) {
    return respond(requirePendingById(formId), response, options)
  }

  function cancel (form, reason = 'closed') {
    assertPendingForm(form)
    const packet = buildCancelPacket(botState.version ?? botState.options?.version, form.id, reason)
    client.queue('modal_form_response', packet)
    finishForm(form, 'cancelled', reason)
    botState.emit?.('formClosed', form, reason, packet)
    return packet
  }

  function cancelById (formId, reason = 'closed') {
    return cancel(requirePendingById(formId), reason)
  }

  function clickButtonById (form, buttonId) {
    assertPendingForm(form)
    if (!Number.isInteger(buttonId) || buttonId < 0) throw new TypeError('buttonId must be a non-negative integer')
    const button = form.buttons.find(candidate => candidate.id === buttonId)
    if (!button) return false
    respond(form, form.type === 'modal' ? buttonId === 0 : buttonId)
    return button
  }

  function clickButtonByText (form, text, options = {}) {
    assertPendingForm(form)
    const buttons = getFormButtons(form, options)
    const caseSensitive = options.caseSensitive ?? false
    const exact = options.exact ?? false
    let expected = String(text)
    if (!caseSensitive) expected = expected.toLowerCase()

    const button = buttons.find(candidate => {
      let actual = candidate.text
      if (!caseSensitive) actual = actual.toLowerCase()
      return exact ? actual === expected : actual.includes(expected)
    })
    if (!button) return false
    return clickButtonById(form, button.id)
  }

  function attachMethods (form) {
    form.respond = (response, options) => respond(form, response, options)
    form.submit = form.respond
    form.cancel = reason => cancel(form, reason)
    form.close = form.cancel
    form.busy = () => cancel(form, 'busy')
    form.getButtons = options => getFormButtons(form, options)
    form.clickButtonById = id => clickButtonById(form, id)
    form.clickButtonByText = (text, options) => clickButtonByText(form, text, options)
    form.defaultResponse = () => defaultResponseFor(form)
    form.respondWithDefaults = () => respond(form, defaultResponseFor(form))
    return form
  }

  function resolveWaiters (form) {
    for (const waiter of waiters) {
      if (!matchesWaitOptions(form, waiter.options)) continue
      waiters.delete(waiter)
      clearTimeout(waiter.timeout)
      waiter.resolve(form)
    }
  }

  function receiveForm (packet, source) {
    const form = attachMethods(parseFormPacket(packet, source))
    const replaced = pending.get(form.id)
    if (replaced) {
      finishForm(replaced, 'closed_by_server', 'replaced')
      botState.emit?.('formClosed', replaced, 'replaced')
    }

    pending.set(form.id, form)
    lastForm = form
    resolveWaiters(form)
    botState.emit?.('form', form)
    if (form.type !== 'unknown') botState.emit?.(`${form.type}Form`, form)
    if (source === 'server_settings') botState.emit?.('serverSettingsForm', form)
    if (form.parseError) botState.emit?.('formParseError', form, form.parseError)
    return form
  }

  function waitForForm (waitOptions = {}) {
    if (typeof waitOptions === 'number') waitOptions = { timeoutMs: waitOptions }
    if (typeof waitOptions === 'string') waitOptions = { type: waitOptions }
    const options = { includePending: true, ...waitOptions }

    if (options.includePending) {
      const existing = Array.from(pending.values()).find(form => matchesWaitOptions(form, options))
      if (existing) return Promise.resolve(existing)
    }

    return new Promise((resolve, reject) => {
      const waiter = { options, resolve, reject, timeout: null }
      const timeoutMs = Number(options.timeoutMs ?? 10000)
      if (timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(`Timed out waiting for${options.type ? ` ${options.type}` : ''} form`))
        }, timeoutMs)
        waiter.timeout.unref?.()
      }
      waiters.add(waiter)
    })
  }

  function closeAllFromServer (packet) {
    const forms = Array.from(pending.values())
    for (const form of forms) {
      finishForm(form, 'closed_by_server', 'server')
      botState.emit?.('formClosed', form, 'server', packet)
    }
    botState.emit?.('formsClosed', forms, packet)
  }

  function requestServerSettings () {
    client.queue('server_settings_request', {})
  }

  client.on('modal_form_request', packet => receiveForm(packet, 'modal'))
  client.on('server_settings_response', packet => receiveForm(packet, 'server_settings'))
  client.on('clientbound_close_form', closeAllFromServer)

  const api = {
    pending,
    waitForForm,
    wait: waitForForm,
    getById,
    parsePacket: parseFormPacket,
    getButtons: getFormButtons,
    clickButtonById,
    clickButtonByText,
    respond,
    respondById,
    submit: respond,
    submitById: respondById,
    cancel,
    cancelById,
    close: cancel,
    closeById: cancelById,
    requestServerSettings,
    stripColorCodes
  }
  Object.defineProperties(api, {
    current: {
      enumerable: true,
      get: () => Array.from(pending.values()).at(-1) ?? null
    },
    last: {
      enumerable: true,
      get: () => lastForm
    }
  })
  botState.forms = api
  botState.waitForForm = waitForForm
  botState.getFormButtons = getFormButtons
  botState.clickButtonById = clickButtonById
  botState.clickButtonByText = clickButtonByText
  botState.respondToForm = respond
  botState.closeForm = cancel
}

module.exports._formsHelpers = {
  buildCancelPacket,
  buildResponsePacket,
  defaultResponseFor,
  getFormButtons,
  formText,
  normalizeFormType,
  parseFormPacket,
  stripColorCodes,
  supportsOptionalFormResponse,
  validateResponse
}
