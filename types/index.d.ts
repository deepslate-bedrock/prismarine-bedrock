import { EventEmitter } from 'events'
import type {
  FishingApi,
  FishingEventMap,
  FishingOptions,
  FishingResult,
  FishingState,
  MineflayerFishingApi
} from './fishing'

export * from './fishing'

/**
 * Excludes the typed fishing event names from the generic string/symbol
 * `on`/`once`/`off` overloads: `E & never` for a fishing name makes the
 * generic overload inapplicable, so a mistyped fishing listener cannot fall
 * through to the untyped `(...args: any[])` fallback. Non-fishing events are
 * unaffected.
 */
type NonFishingEvent<E> = E & (E extends keyof FishingEventMap ? never : unknown)

/**
 * Options accepted by `createBot`/`new BotState`. Only the runtime options
 * this package interprets are typed; everything else passes through to
 * bedrock-protocol untouched.
 */
export interface BotOptions {
  readonly host?: string
  readonly port?: number
  readonly username?: string
  readonly version?: string
  readonly offline?: boolean
  readonly loggingEnabled?: boolean
  readonly worldDecodeEnabled?: boolean
  readonly physicsEnabled?: boolean
  readonly physicsEngine?: 'native' | 'nxg' | 'nxg-org'
  /** Base defaults for every fishing session; per-call FishingOptions win. */
  readonly fishing?: Omit<FishingOptions, 'signal'>
  readonly [option: string]: unknown
}

/**
 * The Mineflayer compatibility proxy returned by `bot.mineflayer` and
 * `bot.asMineflayerBot()`. Fishing is adapted explicitly: `fish()` resolves
 * `void` after the native operation classifies its outcome and rejections
 * keep their native identity and `Fishing cancelled…` messages.
 */
export interface MineflayerBot extends MineflayerFishingApi {
  readonly nativeBot: BotState
  asMineflayerBot(): MineflayerBot
  loadPlugin(plugin: (bot: MineflayerBot) => void): MineflayerBot
  hasPlugin(plugin: (bot: MineflayerBot) => void): boolean
  on<E extends keyof FishingEventMap>(event: E, listener: (...args: [...FishingEventMap[E]]) => void): this
  on<E extends string | symbol>(event: NonFishingEvent<E>, listener: (...args: any[]) => void): this
  once<E extends keyof FishingEventMap>(event: E, listener: (...args: [...FishingEventMap[E]]) => void): this
  once<E extends string | symbol>(event: NonFishingEvent<E>, listener: (...args: any[]) => void): this
  off<E extends keyof FishingEventMap>(event: E, listener: (...args: [...FishingEventMap[E]]) => void): this
  off<E extends string | symbol>(event: NonFishingEvent<E>, listener: (...args: any[]) => void): this
  [member: string]: unknown
}

/**
 * The bot runtime state. Builtins install additional members at runtime; the
 * fishing surface is declared explicitly and everything undeclared resolves
 * to `unknown` through the index signature.
 */
export class BotState extends EventEmitter implements FishingApi {
  constructor (options?: BotOptions)

  readonly fishingState: Readonly<FishingState>
  readonly isFishing: boolean
  fish (options?: FishingOptions): Promise<FishingResult>
  stopFishing (reason?: string | Error): Promise<void>

  readonly mineflayer: MineflayerBot
  asMineflayerBot (): MineflayerBot

  on<E extends keyof FishingEventMap>(event: E, listener: (...args: [...FishingEventMap[E]]) => void): this
  on<E extends string | symbol>(event: NonFishingEvent<E>, listener: (...args: any[]) => void): this
  once<E extends keyof FishingEventMap>(event: E, listener: (...args: [...FishingEventMap[E]]) => void): this
  once<E extends string | symbol>(event: NonFishingEvent<E>, listener: (...args: any[]) => void): this
  off<E extends keyof FishingEventMap>(event: E, listener: (...args: [...FishingEventMap[E]]) => void): this
  off<E extends string | symbol>(event: NonFishingEvent<E>, listener: (...args: any[]) => void): this

  start (): void
  disconnect (reason?: string): void

  [member: string]: unknown
}

/** Creates a BotState and starts its client connection. */
export function createBot (options?: BotOptions): BotState

export const pluginLoader: {
  readonly [helper: string]: unknown
}

export const utils: {
  readonly [helper: string]: unknown
}

export const DEFAULT_BEDROCK_VERSION: string
export function normalizeBedrockVersion (version?: string): string
export function bedrockVersionFromEnv (env?: Record<string, string | undefined>, fallback?: string): string
export function bedrockRegistryName (version?: string): string
export function minecraftDataBedrockDir (version?: string, rootDir?: string): string
