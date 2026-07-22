import type { Entity } from 'prismarine-entity'
import type { Item } from 'prismarine-item'

/**
 * Canonical fishing session phases. A session moves
 * `idle -> casting -> waiting_for_hook -> waiting_for_bite -> reeling ->
 * completed | cancelled | failed -> idle` with one active session per bot.
 */
export type FishingPhase =
  | 'idle'
  | 'casting'
  | 'waiting_for_hook'
  | 'waiting_for_bite'
  | 'reeling'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** Authoritative result classification of a completed fishing operation. */
export type FishingOutcome = 'caught' | 'missed'

/** The fishing operation was cancelled before reaching an authoritative outcome. */
export class FishingCancelledError extends Error {
  readonly code: 'ERR_FISHING_CANCELLED'
}

/** A bounded fishing wait (hook spawn, bite, reel acknowledgement) expired. */
export class FishingTimeoutError extends Error {
  readonly code: 'ERR_FISHING_TIMEOUT'
}

/** Fishing could not start: missing self/inventory state or no held fishing rod. */
export class FishingPreconditionError extends Error {
  readonly code: 'ERR_FISHING_PRECONDITION'
}

export type FishingError =
  | FishingCancelledError
  | FishingTimeoutError
  | FishingPreconditionError

export interface FishingOptions {
  readonly signal?: AbortSignal
  /** Default 5000. Hook add_entity is observed 2-4 ticks after cast. */
  readonly hookSpawnTimeoutMs?: number
  /** Default 60000. Observed bite waits: ~18-32 s per cast (vanilla window 5-30 s, lure reduces). */
  readonly biteTimeoutMs?: number
  /** Default 5000. The reel acknowledgement is observed <= 3 ticks after the reel transactions. */
  readonly reelAckTimeoutMs?: number
  /** Default 2000. The caught item is observed on the SAME tick as hook removal; 2 s is generous. */
  readonly catchCorrelationTimeoutMs?: number
  /** Default true. Geyser motion-based bite fallback; fish_hook_hook always wins when present. */
  readonly translatedBiteEnabled?: boolean
  /** Default 1000. Ignore hook motion younger than this (launch/collision noise). */
  readonly translatedBiteMinAgeMs?: number
  /** Default -0.15. Bite when velocity.y <= threshold (vanilla Java impulse -0.24..-0.4). */
  readonly translatedBiteVelocityThreshold?: number
}

export interface FishingHookMetadata {
  /** Raw fish_x metadata. Splash offset during tease; approach distance decaying to 0 pre-bite. */
  readonly fishX: number | null
  readonly fishZ: number | null
  /** Raw accumulating angle (observed values like 13572.97) - NOT normalized to 0-360. */
  readonly fishAngle: number | null
  /** Unique ID of an entity the hook attached to; 0/null means free-floating. No bite can occur while set. */
  readonly targetEid: bigint | null
}

export type FishingBiteSource = 'entity_event' | 'translated_motion'

export interface FishingBiteEvent {
  readonly source: FishingBiteSource
  readonly runtimeEntityId: bigint
  /** Hook velocity.y that triggered the translated-motion fallback; null for entity_event bites. */
  readonly velocityY: number | null
}

export type FishingOwnerMatch = 'metadata' | 'spawn_window'

export interface FishingState extends FishingHookMetadata {
  readonly phase: FishingPhase
  readonly hookRuntimeId: bigint | null
  readonly hookUniqueId: bigint | null
  readonly ownerMatch: FishingOwnerMatch | null
  readonly startedAt: number | null
  readonly updatedAt: number
}

export interface FishingResult {
  readonly outcome: FishingOutcome
  readonly hook: Entity
  readonly itemEntity: Entity | null
  readonly item: Item | null
  readonly experienceEntities: readonly Entity[]
  readonly startedAt: number
  readonly completedAt: number
}

export interface FishingCatchEvent {
  readonly hook: Entity
  readonly itemEntity: Entity
  readonly item: Item | null
  readonly experienceEntities: readonly Entity[]
}

export type FishingStoppedEvent =
  | { readonly status: 'completed'; readonly result: FishingResult; readonly error: null }
  | { readonly status: 'cancelled' | 'failed'; readonly result: null; readonly error: FishingError }

export interface FishingEventMap {
  fishingStateChanged: readonly [previous: Readonly<FishingState>, current: Readonly<FishingState>]
  fishingHookSpawned: readonly [hook: Entity]
  fishingHookUpdated: readonly [hook: Entity, metadata: Readonly<FishingHookMetadata>]
  fishingBite: readonly [hook: Entity, event: Readonly<FishingBiteEvent>]
  fishingCatch: readonly [event: Readonly<FishingCatchEvent>]
  fishingStopped: readonly [event: Readonly<FishingStoppedEvent>]
}

export interface FishingApi {
  /** Read-only snapshot of the active (or last terminal) fishing session state. */
  readonly fishingState: Readonly<FishingState>
  /** True while a fishing session is active (outside idle/terminal cleanup). */
  readonly isFishing: boolean
  /**
   * Casts the held fishing rod, associates the player-owned hook, waits for a
   * bite, reels, and resolves only after the server outcome is known
   * (`caught` or `missed`).
   */
  fish(options?: FishingOptions): Promise<FishingResult>
  /** Idempotent stop: reels/cancels an active cast and resolves after cleanup. */
  stopFishing(reason?: string | Error): Promise<void>
}

/**
 * Mineflayer-compatible proxy surface. Resolution timing deviates from
 * upstream Mineflayer deliberately: upstream resolves at reel time, this
 * proxy resolves after outcome classification (a `missed` outcome still
 * resolves successfully). Rejections preserve the native error object and
 * every cancellation message begins with `Fishing cancelled`.
 */
export interface MineflayerFishingApi {
  fish(): Promise<void>
}
