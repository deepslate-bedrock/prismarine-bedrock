'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const injectForms = require('../../src/builtins/forms')

function createBotState (version = '1.26.10') {
  const client = new EventEmitter()
  client.sent = []
  client.queue = (name, params) => client.sent.push({ name, params })

  const botState = new EventEmitter()
  botState.client = client
  botState.version = version
  botState.options = { version }
  injectForms(botState)
  return botState
}

function emitForm (botState, id, data) {
  botState.client.emit('modal_form_request', {
    form_id: id,
    data: typeof data === 'string' ? data : JSON.stringify(data)
  })
  return botState.forms.getById(id)
}

describe('forms builtin', function () {
  it('parses action forms, images, presentation controls, and formatted button text', function () {
    const botState = createBotState()
    const form = emitForm(botState, 12, {
      type: 'form',
      title: 'Minigames',
      content: 'Choose the games',
      buttons: [
        { text: '§bSpleef', image: { type: 'path', data: 'textures/items/diamond_shovel' } },
        { type: 'header', text: 'PvP' },
        { type: 'divider' },
        { text: '§cMurder Mystery', image: { type: 'url', data: 'https://example.test/sword.png' } },
        { type: 'label', text: 'More soon' }
      ]
    })

    assert.strictEqual(form.type, 'simple')
    assert.strictEqual(form.title, 'Minigames')
    assert.strictEqual(form.content, 'Choose the games')
    assert.deepStrictEqual(form.controls.map(control => control.type), ['button', 'header', 'divider', 'button', 'label'])
    assert.deepStrictEqual(form.buttons.map(button => button.id), [0, 1])
    assert.deepStrictEqual(form.getButtons().map(button => button.text), ['Spleef', 'Murder Mystery'])
    assert.deepStrictEqual(form.getButtons({ includeColorCodes: true }).map(button => button.text), ['§bSpleef', '§cMurder Mystery'])
    assert.deepStrictEqual(form.buttons[0].image, { type: 'path', data: 'textures/items/diamond_shovel' })
    assert.strictEqual(botState.forms.current, form)
    assert.strictEqual(botState.forms.last, form)
    assert.deepStrictEqual(botState.getFormButtons(form).map(button => button.text), ['Spleef', 'Murder Mystery'])
    assert.strictEqual(botState.waitForForm, botState.forms.waitForForm)
  })

  it('parses current Endstone rich text and elements arrays', function () {
    const botState = createBotState()
    const form = emitForm(botState, 121, {
      type: 'form',
      title: { rawtext: [{ text: 'Minigames' }] },
      content: { rawtext: [{ text: 'Choose ' }, { text: 'the games' }] },
      elements: [
        { type: 'header', text: { rawtext: [{ text: 'Featured' }] } },
        { type: 'label', text: { rawtext: [{ text: 'Two choices' }] } },
        { type: 'divider', text: '' },
        {
          type: 'button',
          text: { rawtext: [{ text: '§bSpleef' }] },
          image: { type: 'path', data: 'textures/items/diamond_shovel' }
        }
      ]
    })

    assert.strictEqual(form.title, 'Minigames')
    assert.strictEqual(form.content, 'Choose the games')
    assert.deepStrictEqual(form.controls.map(control => control.text), ['Featured', 'Two choices', '', '§bSpleef'])
    assert.deepStrictEqual(form.getButtons().map(button => button.text), ['Spleef'])
  })

  it('clicks action-form buttons by text or id and consumes the form once', function () {
    const botState = createBotState()
    const form = emitForm(botState, 13, {
      type: 'form',
      title: 'Games',
      content: '',
      buttons: [{ text: '§aSpleef' }, { text: 'Bedwars' }]
    })

    const button = botState.forms.clickButtonByText(form, 'spleef')

    assert.strictEqual(button.id, 0)
    assert.deepStrictEqual(botState.client.sent[0], {
      name: 'modal_form_response',
      params: {
        form_id: 13,
        has_response_data: true,
        data: '0',
        has_cancel_reason: false
      }
    })
    assert.strictEqual(form.status, 'responded')
    assert.strictEqual(form.response, 0)
    assert.strictEqual(botState.forms.getById(13), null)
    assert.throws(() => form.clickButtonById(1), /already responded/)
  })

  it('returns false when a simple button does not exist', function () {
    const botState = createBotState()
    const form = emitForm(botState, 14, {
      type: 'form',
      title: '',
      content: '',
      buttons: [{ text: 'One' }]
    })

    assert.strictEqual(form.clickButtonByText('missing'), false)
    assert.strictEqual(form.clickButtonById(4), false)
    assert.strictEqual(botState.client.sent.length, 0)
  })

  it('separates parsed-form operations from explicit form-id operations', function () {
    const botState = createBotState()
    const form = emitForm(botState, 15, {
      type: 'form',
      title: 'Typed references',
      content: '',
      buttons: [{ text: 'One' }]
    })

    assert.throws(() => botState.forms.respond(15, 0), /parsed form object/)
    assert.throws(() => botState.forms.respond(form.rawPacket, 0), /parsed form object/)
    assert.throws(() => botState.forms.getButtons(form.rawPacket), /parsed form object/)
    assert.throws(() => botState.forms.getById('15'), /non-negative integer/)
    assert.throws(() => botState.forms.respondById('15', 0), /non-negative integer/)

    botState.forms.respondById(15, 0)
    assert.strictEqual(form.status, 'responded')
    assert.strictEqual(botState.client.sent[0].params.data, '0')
  })

  it('parses raw packets explicitly without treating them as pending forms', function () {
    const botState = createBotState()
    const form = botState.forms.parsePacket({
      form_id: 16,
      data: JSON.stringify({ type: 'modal', title: 'Raw', content: '', button1: 'A', button2: 'B' })
    })

    assert.strictEqual(form.type, 'modal')
    assert.deepStrictEqual(botState.forms.getButtons(form).map(button => button.text), ['A', 'B'])
    assert.throws(() => botState.forms.respond(form, true), /not the tracked pending form/)
  })

  it('maps modal button ids to the Bedrock boolean response', function () {
    const botState = createBotState()
    const first = emitForm(botState, 20, {
      type: 'modal',
      title: 'Confirm',
      content: 'Continue?',
      button1: 'Yes',
      button2: 'No'
    })

    assert.deepStrictEqual(first.getButtons().map(button => button.text), ['Yes', 'No'])
    first.clickButtonById(1)
    assert.strictEqual(botState.client.sent[0].params.data, 'false')

    const second = emitForm(botState, 21, {
      type: 'modal',
      title: 'Confirm',
      content: 'Continue?',
      button1: 'Yes',
      button2: 'No'
    })
    second.respond(0)
    assert.strictEqual(botState.client.sent[1].params.data, 'true')
  })

  it('parses and validates every custom-form control', function () {
    const botState = createBotState()
    const form = emitForm(botState, 30, {
      type: 'custom_form',
      title: 'All controls',
      icon: { type: 'path', data: 'textures/ui/icon_recipe_nature' },
      submit_button: 'Save',
      content: [
        { type: 'header', text: 'Profile' },
        { type: 'label', text: 'Choose values' },
        { type: 'divider' },
        { type: 'dropdown', text: 'Mode', options: ['A', 'B'], default: 1 },
        { type: 'input', text: 'Name', placeholder: 'Steve', default: 'Alex' },
        { type: 'toggle', text: 'Enabled', default: true },
        { type: 'slider', text: 'Volume', min: 0, max: 10, step: 0.5, default: 4.5 },
        { type: 'step_slider', text: 'Size', steps: ['S', 'M', 'L'], default: 2 }
      ]
    })

    assert.strictEqual(form.type, 'custom')
    assert.strictEqual(form.submitButton, 'Save')
    assert.deepStrictEqual(form.components.map(component => component.type), [
      'header', 'label', 'divider', 'dropdown', 'input', 'toggle', 'slider', 'step_slider'
    ])
    assert.deepStrictEqual(form.defaultResponse(), [null, null, null, 1, 'Alex', true, 4.5, 2])

    form.respond([null, null, null, 0, 'Player', false, 7.5, 1])
    assert.strictEqual(botState.client.sent[0].params.data, '[null,null,null,0,"Player",false,7.5,1]')
  })

  it('parses current Endstone custom-form rich text and submit fields', function () {
    const botState = createBotState()
    const form = emitForm(botState, 32, {
      type: 'custom_form',
      title: { rawtext: [{ text: 'Profile' }] },
      submit: { rawtext: [{ text: 'Save profile' }] },
      content: [
        { type: 'header', text: { rawtext: [{ text: 'Details' }] } },
        {
          type: 'input',
          text: { rawtext: [{ text: 'Name' }] },
          placeholder: { rawtext: [{ text: 'Steve' }] },
          default: 'Alex'
        }
      ]
    })

    assert.strictEqual(form.title, 'Profile')
    assert.strictEqual(form.submitButton, 'Save profile')
    assert.strictEqual(form.components[0].text, 'Details')
    assert.strictEqual(form.components[1].text, 'Name')
    assert.strictEqual(form.components[1].placeholder, 'Steve')
  })

  it('accepts text-field aliases and rejects invalid custom responses', function () {
    const botState = createBotState()
    const form = emitForm(botState, 31, {
      type: 'custom_form',
      title: 'Aliases',
      controls: [
        { type: 'text_field', text: 'Name' },
        { type: 'toggle', text: 'On' }
      ]
    })

    assert.deepStrictEqual(form.components.map(component => component.type), ['input', 'toggle'])
    assert.throws(() => form.respond(['only one']), /2 components/)
    assert.throws(() => form.respond([7, false]), /input response.*string/)
    assert.throws(() => form.respond(['ok', 1]), /toggle response.*boolean/)
    assert.strictEqual(form.status, 'pending')
  })

  it('sends closed and busy cancellation reasons on modern protocols', function () {
    const botState = createBotState()
    const closed = emitForm(botState, 40, { type: 'form', title: '', content: '', buttons: [] })
    const closedPacket = closed.close()
    const busy = emitForm(botState, 41, { type: 'form', title: '', content: '', buttons: [] })
    const busyPacket = busy.busy()

    assert.deepStrictEqual(closedPacket, {
      form_id: 40,
      has_response_data: false,
      has_cancel_reason: true,
      cancel_reason: 'closed'
    })
    assert.deepStrictEqual(busyPacket, {
      form_id: 41,
      has_response_data: false,
      has_cancel_reason: true,
      cancel_reason: 'busy'
    })
  })

  it('uses JSON null cancellation on pre-1.19.20 protocols', function () {
    const botState = createBotState('1.19.10')
    const form = emitForm(botState, 42, { type: 'modal', title: '', content: '', button1: 'A', button2: 'B' })

    assert.deepStrictEqual(form.close(), { form_id: 42, data: 'null' })
    assert.deepStrictEqual(botState.client.sent[0].params, { form_id: 42, data: 'null' })
  })

  it('treats respond(null) as a close unless explicitly sending JSON null', function () {
    const botState = createBotState()
    const closeForm = emitForm(botState, 43, 'not json')
    closeForm.respond(null)
    assert.strictEqual(botState.client.sent[0].params.has_response_data, false)

    const rawNullForm = emitForm(botState, 44, 'not json')
    rawNullForm.respond(null, { nullIsResponse: true, validate: false })
    assert.strictEqual(botState.client.sent[1].params.has_response_data, true)
    assert.strictEqual(botState.client.sent[1].params.data, 'null')
  })

  it('emits malformed forms without losing their raw packet', function () {
    const botState = createBotState()
    let seenError = null
    botState.on('formParseError', (form, error) => { seenError = { form, error } })

    const form = emitForm(botState, 50, '{not valid json')

    assert.strictEqual(form.type, 'unknown')
    assert.strictEqual(form.rawData, '{not valid json')
    assert.strictEqual(form.rawPacket.form_id, 50)
    assert.strictEqual(seenError.form, form)
    assert(seenError.error instanceof SyntaxError)
    form.respond({ future: true }, { validate: false })
    assert.strictEqual(botState.client.sent[0].params.data, '{"future":true}')
  })

  it('waits for matching future forms and can reuse a pending form', async function () {
    const botState = createBotState()
    const pendingWait = botState.forms.waitForForm({ type: 'custom', timeoutMs: 1000 })
    emitForm(botState, 60, { type: 'form', title: 'skip', content: '', buttons: [] })
    const expected = emitForm(botState, 61, { type: 'custom_form', title: 'match', content: [] })

    assert.strictEqual(await pendingWait, expected)
    assert.strictEqual(await botState.waitForForm({ type: 'custom' }), expected)
  })

  it('times out waiting for a form', async function () {
    const botState = createBotState()
    await assert.rejects(
      botState.forms.waitForForm({ type: 'modal', timeoutMs: 10, includePending: false }),
      /Timed out waiting for modal form/
    )
  })

  it('requests and handles server settings forms', function () {
    const botState = createBotState()
    let settingsForm = null
    botState.on('serverSettingsForm', form => { settingsForm = form })

    botState.forms.requestServerSettings()
    botState.client.emit('server_settings_response', {
      form_id: 70,
      data: JSON.stringify({ type: 'custom_form', title: 'Server Settings', content: [] })
    })

    assert.deepStrictEqual(botState.client.sent[0], { name: 'server_settings_request', params: {} })
    assert.strictEqual(settingsForm.source, 'server_settings')
    assert.strictEqual(settingsForm.type, 'custom')
  })

  it('clears the pending form stack when the server sends clientbound_close_form', function () {
    const botState = createBotState()
    const first = emitForm(botState, 80, { type: 'form', title: 'One', content: '', buttons: [] })
    const second = emitForm(botState, 81, { type: 'form', title: 'Two', content: '', buttons: [] })
    let closed = null
    botState.on('formsClosed', forms => { closed = forms })

    botState.client.emit('clientbound_close_form', {})

    assert.deepStrictEqual(closed, [first, second])
    assert.strictEqual(first.status, 'closed_by_server')
    assert.strictEqual(second.status, 'closed_by_server')
    assert.strictEqual(botState.forms.pending.size, 0)
  })

  it('marks a resent form id as replaced', function () {
    const botState = createBotState()
    const first = emitForm(botState, 90, { type: 'form', title: 'First', content: '', buttons: [] })
    const second = emitForm(botState, 90, { type: 'form', title: 'Second', content: '', buttons: [] })

    assert.strictEqual(first.status, 'closed_by_server')
    assert.strictEqual(first.cancelReason, 'replaced')
    assert.strictEqual(botState.forms.getById(90), second)
  })
})
