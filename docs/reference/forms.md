# Bedrock Forms

The `forms` built-in handles Bedrock's native `modal_form_request` family. It
tracks pending forms by `form_id`, parses all standard form layouts, and builds
the version-correct `modal_form_response` packet.

## Form Types

| Wire type | API type | Response |
| --- | --- | --- |
| `form` | `simple` | Clicked button id (`0`-based). |
| `modal` | `modal` | `true` for `button1`, `false` for `button2`. |
| `custom_form` | `custom` | Ordered array of component values. |

Simple/action buttons preserve path or URL image metadata. Custom forms parse
`dropdown`, `input`/`text_field`, `toggle`, `slider`, `step_slider`, `label`,
`header`, and `divider`. Unknown form and component types remain available in
their raw representation so newer servers do not make the built-in throw.
Both classic string/array payloads and current Endstone/BDS `rawtext` plus
`elements` payloads normalize to the same form API.

## Receiving And Waiting

Every received form is placed in `bot.forms.pending` and emitted as `form`.
Typed events are `simpleForm`, `modalForm`, and `customForm`.

```js
const form = await bot.waitForForm({ type: 'simple', timeoutMs: 10_000 })

console.log(form.id, form.title, form.content)
console.log(form.getButtons())
```

`waitForForm()` returns an already-pending match by default. Pass
`includePending: false` to wait only for the next matching packet. Options also
support `source: 'modal' | 'server_settings'` and `predicate(form)`.

Useful state:

- `bot.forms.pending`: `Map<formId, form>`.
- `bot.forms.current`: most recently received pending form.
- `bot.forms.last`: most recently received form, including completed forms.
- `bot.forms.getById(formId)`: pending form or `null`.

Malformed JSON still emits `form` with `type: 'unknown'`, `parseError`,
`rawData`, and `rawPacket`; `formParseError` is emitted as well.

## Responding

```js
// Simple/action form.
form.clickButtonById(0)
form.clickButtonByText('Spleef')

// Two-button message form. Button ids are also accepted by respond():
// id 0 => true/button1, id 1 => false/button2.
form.respond(true)

// Custom form. Presentation components use null in their response slot.
form.respond([null, 1, 'Alex', true, 4.5, 2])

// Submit each custom control's declared default value.
form.respondWithDefaults()
```

Button text matching is case-insensitive substring matching by default and
strips Bedrock `§` formatting codes. Pass `{ exact: true }`,
`{ caseSensitive: true }`, or `{ includeColorCodes: true }` to change it.

Each form is consumed once. A second response throws. Successful sends emit
`formResponded` with `(form, response, packet)`.

Form-object operations accept only a parsed form returned by an event,
`waitForForm()`, or `getById()`. They do not also accept numeric ids or raw
packets. Use the explicit id variants when only an id is available:

```js
bot.forms.respondById(formId, response)
bot.forms.cancelById(formId, 'closed')

const form = bot.forms.getById(formId)
form.getButtons()
form.clickButtonByText('Spleef')
```

Use `bot.forms.parsePacket(packet)` to inspect a raw packet explicitly. Parsing
does not add it to the pending-form map, so it cannot be submitted unless the
same form was received by the bot.

The same helpers are available on `bot.forms` and as compatibility shortcuts:
`bot.getFormButtons`, `bot.clickButtonById`, `bot.clickButtonByText`,
`bot.respondToForm`, and `bot.closeForm`.

## Closing And Busy Forms

```js
form.close()       // cancel reason: closed
form.busy()        // cancel reason: busy
bot.closeForm(form, 'closed')
```

Modern protocols send no response data plus an explicit cancel reason. Versions
before 1.19.20 use the older JSON `null` response. `respond(null)` is treated as
`close()` unless `{ nullIsResponse: true, validate: false }` is explicitly used.

`formClosed` fires for local cancellation, replacement, and server-forced
closure. A `clientbound_close_form` packet clears every pending form and emits
`formsClosed` with the cleared array.

## Server Settings

```js
bot.forms.requestServerSettings()
const settings = await bot.waitForForm({ source: 'server_settings' })
settings.respondWithDefaults()
```

The server-settings response is parsed like a custom form and additionally
emits `serverSettingsForm`.

## Raw And Forward-Compatible Responses

Validation catches wrong button ids and incorrect custom value types. For a
new or server-specific form shape, callers may deliberately bypass it while
the raw data remains visible:

```js
form.respond(serverSpecificValue, { validate: false })
```

This bypass changes only local validation; the value must still be JSON
serializable and acceptable to the server.
