// Compile-only contract tests for the fishing API declarations.
// Run with `pnpm run test:types`. Every positive case must type-check and
// every `@ts-expect-error` case must fail to compile; this file also pulls
// src/builtins/fishing.js (which carries `// @ts-check`) into the program so
// the runtime JSDoc cannot drift from types/fishing.d.ts.

import type {
  FishingApi,
  FishingBiteEvent,
  FishingBiteSource,
  FishingCatchEvent,
  FishingError,
  FishingEventMap,
  FishingHookMetadata,
  FishingOptions,
  FishingOutcome,
  FishingPhase,
  FishingResult,
  FishingState,
  FishingStoppedEvent,
  MineflayerFishingApi
} from '../../types'

import {
  BotState,
  createBot,
  FishingCancelledError,
  FishingPreconditionError,
  FishingTimeoutError,
  MineflayerBot
} from '../..'

declare const bot: BotState

// ---- native API surface ----

async function nativeSurface (): Promise<void> {
  const result: FishingResult = await bot.fish()
  const outcome: FishingOutcome = result.outcome
  const startedAt: number = result.startedAt
  const completedAt: number = result.completedAt
  void outcome
  void startedAt
  void completedAt

  // Options infer exact field types, including the translated-bite options.
  const options: FishingOptions = {
    signal: new AbortController().signal,
    hookSpawnTimeoutMs: 5000,
    biteTimeoutMs: 60000,
    reelAckTimeoutMs: 5000,
    catchCorrelationTimeoutMs: 2000,
    translatedBiteEnabled: true,
    translatedBiteMinAgeMs: 1000,
    translatedBiteVelocityThreshold: -0.15
  }
  await bot.fish(options)

  await bot.stopFishing()
  await bot.stopFishing('leaving the area')
  await bot.stopFishing(new Error('shutting down'))

  const api: FishingApi = bot
  void api

  const state: Readonly<FishingState> = bot.fishingState
  const phase: FishingPhase = state.phase
  const hookRuntimeId: bigint | null = state.hookRuntimeId
  const hookUniqueId: bigint | null = state.hookUniqueId
  const ownerMatch: 'metadata' | 'spawn_window' | null = state.ownerMatch
  const fishX: number | null = state.fishX
  const targetEid: bigint | null = state.targetEid
  const isFishing: boolean = bot.isFishing
  void phase
  void hookRuntimeId
  void hookUniqueId
  void ownerMatch
  void fishX
  void targetEid
  void isFishing
}
void nativeSurface

// ---- proxy surface ----

async function proxySurface (): Promise<void> {
  const proxy: MineflayerBot = bot.asMineflayerBot()
  const compat: MineflayerFishingApi = proxy
  void compat

  const erased: Promise<void> = proxy.fish()
  await erased

  const sameProxy: MineflayerBot = bot.mineflayer
  await sameProxy.fish()

  // @ts-expect-error the proxy erases the result: it is not a FishingResult promise
  const leak: Promise<FishingResult> = proxy.fish()
  void leak

  // @ts-expect-error the Mineflayer contract takes no arguments
  await proxy.fish({ hookSpawnTimeoutMs: 1000 })
}
void proxySurface

// ---- typed error classes ----

function errorSurface (cancelled: FishingCancelledError, timeout: FishingTimeoutError, precondition: FishingPreconditionError): void {
  const cancelledCode: 'ERR_FISHING_CANCELLED' = cancelled.code
  const timeoutCode: 'ERR_FISHING_TIMEOUT' = timeout.code
  const preconditionCode: 'ERR_FISHING_PRECONDITION' = precondition.code
  void cancelledCode
  void timeoutCode
  void preconditionCode

  const union: FishingError = cancelled
  void union

  // @ts-expect-error the code literals are not interchangeable
  const wrongCode: 'ERR_FISHING_TIMEOUT' = cancelled.code
  void wrongCode
}
void errorSurface

// ---- event map inference ----

bot.on('fishingBite', (hook, event) => {
  const source: FishingBiteSource = event.source
  const runtimeEntityId: bigint = event.runtimeEntityId
  const velocityY: number | null = event.velocityY
  const bite: Readonly<FishingBiteEvent> = event
  void hook
  void source
  void runtimeEntityId
  void velocityY
  void bite
})

bot.once('fishingHookUpdated', (hook, metadata) => {
  const snapshot: Readonly<FishingHookMetadata> = metadata
  const fishAngle: number | null = metadata.fishAngle
  void hook
  void snapshot
  void fishAngle
})

bot.on('fishingCatch', event => {
  const catchEvent: Readonly<FishingCatchEvent> = event
  void catchEvent
})

bot.on('fishingStateChanged', (previous, current) => {
  const before: Readonly<FishingState> = previous
  const after: Readonly<FishingState> = current
  void before
  void after
})

// Terminal-event narrowing makes result and error mutually exclusive.
bot.on('fishingStopped', event => {
  const stopped: Readonly<FishingStoppedEvent> = event
  void stopped
  if (event.status === 'completed') {
    const result: FishingResult = event.result
    const error: null = event.error
    void result
    void error
  } else {
    const status: 'cancelled' | 'failed' = event.status
    const error: FishingError = event.error
    const result: null = event.result
    void status
    void error
    void result
  }
})

bot.off('fishingBite', (_hook, _event) => {})

type FishingEventNames = keyof FishingEventMap
const eventName: FishingEventNames = 'fishingBite'
void eventName

// ---- the generic overloads stay open for non-fishing events... ----

bot.on('spawn', () => {})
bot.once(Symbol('marker'), () => {})
declare const dynamicEventName: string
bot.on(dynamicEventName, () => {})

// ---- ...but cannot be used to bypass the fishing event tuples ----

// @ts-expect-error a mistyped fishingCatch listener must not compile via bot.on
bot.on('fishingCatch', (event: number) => { void event })

// @ts-expect-error wrong payload types for fishingBite are rejected
bot.on('fishingBite', (hook: number, event: number) => { void hook; void event })

// @ts-expect-error once() enforces the same tuples as on()
bot.once('fishingStopped', (event: string) => { void event })

// @ts-expect-error off() enforces the same tuples as on()
bot.off('fishingHookUpdated', (hook: number, metadata: number) => { void hook; void metadata })

declare const proxyForEvents: MineflayerBot
// @ts-expect-error the proxy event surface rejects mistyped fishing listeners too
proxyForEvents.on('fishingCatch', (event: number) => { void event })
proxyForEvents.on('chat', () => {})

// The event map publishes readonly tuples.
declare const catchTuple: FishingEventMap['fishingCatch']
// @ts-expect-error fishing event tuples are readonly
catchTuple[0] = undefined as never
void catchTuple

// ---- negative cases ----

async function negativeCases (): Promise<void> {
  // @ts-expect-error invalid option keys are rejected
  await bot.fish({ timeoutMs: 1000 })

  // @ts-expect-error option values keep their exact primitive types
  await bot.fish({ translatedBiteVelocityThreshold: '-0.15' })

  // @ts-expect-error stopFishing accepts only string | Error reasons
  await bot.stopFishing(42)
}
void negativeCases

// @ts-expect-error invalid phase literals fail compilation
const badPhase: FishingPhase = 'swimming'
void badPhase

// @ts-expect-error invalid outcome literals fail compilation
const badOutcome: FishingOutcome = 'escaped'
void badOutcome

// @ts-expect-error unknown fishing events are not part of the typed map
const badEventName: FishingEventNames = 'fishBite'
void badEventName

declare const fishingResult: FishingResult

// @ts-expect-error result collections are readonly
fishingResult.experienceEntities.push(undefined as never)

// @ts-expect-error the state snapshot is readonly
bot.fishingState.phase = 'idle'

// @ts-expect-error listeners must match the tuple payload types
const badListener: (...args: [...FishingEventMap['fishingCatch']]) => void = (event: number) => { void event }
void badListener

// createBot produces the same typed bot surface.
const created: BotState = createBot({ version: '1.26.10', fishing: { biteTimeoutMs: 30000 } })
void created

export {}
