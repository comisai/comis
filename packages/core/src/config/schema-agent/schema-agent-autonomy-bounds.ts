// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — Autonomy BOUNDS sub-blocks.
 *
 * The four NESTED `z.strictObject` bounding blocks the daemon-side
 * `BoundedAutonomy` service reads, split out of
 * `schema-agent-autonomy.ts` to keep that leaf under the schema-agent
 * file-size cap. They follow the `message`/`lease` nested-block precedent:
 * a `z.strictObject` per limb group, every field
 * `.default()`-ed, `strictObject` as the typo guard (fails-closed).
 *
 * `schema-agent-autonomy.ts` wires each into `AutonomyConfigSchema`,
 * derives `STANDARD_GUARDS` defaults from these schemas (`.parse({})`), and
 * the resolver merges the nested + the flat alias fields per-field.
 *
 * Pure schema leaf — imports only `zod`. No `process.env` / `Date.now` /
 * `path.join` (AGENTS §2.2).
 *
 * @module
 */
import { z } from "zod";

/**
 * Per-root-run BUDGET ceiling. The nested
 * `autonomy.budget.{ aggregateUsd, tokens, wallClockMs }` sub-block bounds the
 * WHOLE spawn tree keyed on its `rootRunId` (the daemon-side BoundedAutonomy
 * meter reads it). Three independent limbs so a runaway loop trips
 * a bound regardless of pricing knowledge:
 *  - `aggregateUsd` — the priced $-ceiling (the flat `aggregateBudgetUsd` is its
 *    alias; the resolver folds both into this one field).
 *  - `tokens` — the token ceiling, which STILL bites on an unknown-priced ($0)
 *    subscription model that the $-limb counts as free.
 *  - `wallClockMs` — the wall-clock ceiling, a backstop on a stuck/looping tree
 *    that burns neither $ nor tokens fast.
 * Every limb is `.positive()` so a profile can never resolve an absent/zero
 * (fails-open) bound. The defaults are a runaway BACKSTOP, not a normal-use
 * limit: sized generously above a legit multi-step task (which can cost several
 * dollars / millions of tokens over its whole spawn tree) yet still below a
 * self-spawning storm — a floor that is ON in every profile. An operator who
 * wants a tighter guard lowers them per-agent; the defaults let ordinary work
 * run to completion without tripping.
 */
export const AutonomyBudgetConfigSchema = z.strictObject({
  /** Priced per-root $ ceiling (the flat `aggregateBudgetUsd` is its alias). */
  aggregateUsd: z.number().positive().default(100),
  /** Per-root token ceiling — bites even on an unknown-priced ($0) model. */
  tokens: z.number().int().positive().default(100_000_000),
  /** Per-root wall-clock ceiling in ms — backstop on a stuck/looping tree (24 h). */
  wallClockMs: z.number().int().positive().default(86_400_000),
});

/**
 * Per-root / per-socket call-RATE ceiling. The nested
 * `autonomy.rate.{ perRootCallsPerSec, perSocketCallsPerSec, connectionChurnPerMin }`
 * sub-block bounds a `for(;;) spawn()` / cron-storm call rate without tripping a
 * legitimate burst (the daemon-side call-rate-limiter reads it):
 *  - `perRootCallsPerSec` — calls/sec across the whole spawn tree (per `rootRunId`).
 *  - `perSocketCallsPerSec` — calls/sec on a single orchestration socket.
 *  - `connectionChurnPerMin` — new-connection churn/min (a reconnect-storm cap).
 * Distinct from `maxSelfSpawnRatePerMin` (the spawn-rate, which stays flat) —
 * concurrency ≠ rate ≠ call-rate. Every limb `.positive()` (never fails open).
 */
export const AutonomyRateConfigSchema = z.strictObject({
  /** Calls/sec across the whole spawn tree (per rootRunId). */
  perRootCallsPerSec: z.number().int().positive().default(20),
  /** Calls/sec on a single orchestration socket. */
  perSocketCallsPerSec: z.number().int().positive().default(10),
  /** New-connection churn per minute (reconnect-storm cap). */
  connectionChurnPerMin: z.number().int().positive().default(60),
});

/**
 * The tree-wide SPAWN ceiling shape. The nested
 * `autonomy.spawn.{ maxConcurrentSelfAgents, maxSpawnDepth, maxChildrenPerAgent }`
 * sub-block is the ONE resolved source the per-root semaphore reads:
 *  - `maxConcurrentSelfAgents` — concurrent self-agents tree-wide (the flat
 *    field is its alias; the resolver folds both here).
 *  - `maxSpawnDepth` (3) — delegation-tree depth cap.
 *  - `maxChildrenPerAgent` (5) — per-caller fan-out cap.
 * Surfacing `maxSpawnDepth`/`maxChildrenPerAgent` here + into
 * `ResolvedAutonomy` gives the semaphore a single resolved read instead of the
 * `subagentContext` fallbacks (sub-agent-runner `?? 3`/`?? 5`). Every
 * limb `.positive()`.
 */
export const AutonomySpawnConfigSchema = z.strictObject({
  /** Concurrent self-agents tree-wide (the flat `maxConcurrentSelfAgents` is its alias). */
  maxConcurrentSelfAgents: z.number().int().positive().default(4),
  /** Delegation-tree depth cap. */
  maxSpawnDepth: z.number().int().positive().default(3),
  /** Per-caller fan-out cap. */
  maxChildrenPerAgent: z.number().int().positive().default(5),
});

/**
 * OUTWARD-send governance beyond the per-hour quota. The nested
 * `autonomy.outward.{ originOnly, perTargetGrants, volumeCap }` sub-block bounds
 * the genuinely-outward `orch:message` subset (the outward-quota meter
 * reads it; `message.channels`/`maxPerHour` stay for the channel/hour quota):
 *  - `originOnly` (true) — by default only the agent's OWN origin channel is an
 *    auto-allowable target; a NEW target needs an explicit grant.
 *  - `perTargetGrants` — the explicit per-target grant list (empty default);
 *    a send to a non-origin target is denied unless its id is here.
 *  - `volumeCap` — a per-send volume bound (chars / recipient-weighted units; the
 *    outward-quota meter defines the unit) so a mass-recipient / high-volume send
 *    trips a gate even when reversible. `.positive()`.
 * NB: `orch:browse` stays OFF (an `ALWAYS_ESCALATE_CAPABILITIES` member) —
 * no tool maps to it, so no config knob is needed here.
 */
export const AutonomyOutwardConfigSchema = z.strictObject({
  /** Only the agent's own origin channel is auto-allowable by default. */
  originOnly: z.boolean().default(true),
  /** The explicit per-target grant list (a non-origin target needs an entry). */
  perTargetGrants: z.array(z.string()).default([]),
  /** Per-send volume bound (chars / recipient-weighted; the outward-quota meter defines the unit). */
  volumeCap: z.number().int().positive().default(4000),
});

export type AutonomyBudgetConfig = z.infer<typeof AutonomyBudgetConfigSchema>;
export type AutonomyRateConfig = z.infer<typeof AutonomyRateConfigSchema>;
export type AutonomySpawnConfig = z.infer<typeof AutonomySpawnConfigSchema>;
export type AutonomyOutwardConfig = z.infer<typeof AutonomyOutwardConfigSchema>;

/** The four fully-resolved bounds blocks the resolver assembles. */
export interface ResolvedAutonomyBounds {
  readonly budget: AutonomyBudgetConfig;
  readonly rate: AutonomyRateConfig;
  readonly spawn: AutonomySpawnConfig;
  readonly outward: AutonomyOutwardConfig;
}

/**
 * The `standard` BOUNDS defaults — ON under every autonomy-bearing profile.
 * Derived from the schemas (`.parse({})`) so the profile table (`STANDARD_GUARDS`
 * in `schema-agent-autonomy.ts`) and the Zod `.default()`s never drift.
 */
export const STANDARD_AUTONOMY_BOUNDS: ResolvedAutonomyBounds = {
  budget: AutonomyBudgetConfigSchema.parse({}),
  rate: AutonomyRateConfigSchema.parse({}),
  spawn: AutonomySpawnConfigSchema.parse({}),
  outward: AutonomyOutwardConfigSchema.parse({}),
};

/**
 * The partial-config view `resolveAutonomyBounds` reads (a structural subset of
 * `AutonomyConfig` — declared here to avoid a leaf→leaf import cycle). Each field
 * is optional; the merge falls back to the profile `base` per-field.
 */
export interface AutonomyBoundsConfigInput {
  readonly budget?: Partial<AutonomyBudgetConfig>;
  readonly rate?: Partial<AutonomyRateConfig>;
  readonly spawn?: Partial<AutonomySpawnConfig>;
  readonly outward?: Partial<AutonomyOutwardConfig>;
  /** Flat alias of `budget.aggregateUsd` (folded into it). */
  readonly aggregateBudgetUsd?: number;
  /** Flat alias of `spawn.maxConcurrentSelfAgents` (folded into it). */
  readonly maxConcurrentSelfAgents?: number;
}

/**
 * Merge the nested BOUNDS blocks per-field against the profile `base` (the
 * `cfg?.lease?.leaseMaxTtlMin ?? base.leaseMaxTtlMin` model). Each
 * limb reads the explicit nested field first, then — for the two aliased limbs —
 * the flat field (`aggregateBudgetUsd` → `budget.aggregateUsd`;
 * `maxConcurrentSelfAgents` → `spawn.maxConcurrentSelfAgents`), then the profile
 * default. The flat and nested representations resolve to ONE value (a live
 * alias, not a compatibility shim). PURE.
 */
export function resolveAutonomyBounds(
  cfg: AutonomyBoundsConfigInput | undefined,
  base: ResolvedAutonomyBounds,
): ResolvedAutonomyBounds {
  return {
    budget: {
      aggregateUsd: cfg?.budget?.aggregateUsd ?? cfg?.aggregateBudgetUsd ?? base.budget.aggregateUsd,
      tokens: cfg?.budget?.tokens ?? base.budget.tokens,
      wallClockMs: cfg?.budget?.wallClockMs ?? base.budget.wallClockMs,
    },
    rate: {
      perRootCallsPerSec: cfg?.rate?.perRootCallsPerSec ?? base.rate.perRootCallsPerSec,
      perSocketCallsPerSec: cfg?.rate?.perSocketCallsPerSec ?? base.rate.perSocketCallsPerSec,
      connectionChurnPerMin: cfg?.rate?.connectionChurnPerMin ?? base.rate.connectionChurnPerMin,
    },
    spawn: {
      maxConcurrentSelfAgents:
        cfg?.spawn?.maxConcurrentSelfAgents ??
        cfg?.maxConcurrentSelfAgents ??
        base.spawn.maxConcurrentSelfAgents,
      maxSpawnDepth: cfg?.spawn?.maxSpawnDepth ?? base.spawn.maxSpawnDepth,
      maxChildrenPerAgent: cfg?.spawn?.maxChildrenPerAgent ?? base.spawn.maxChildrenPerAgent,
    },
    outward: {
      originOnly: cfg?.outward?.originOnly ?? base.outward.originOnly,
      perTargetGrants: cfg?.outward?.perTargetGrants ?? base.outward.perTargetGrants,
      volumeCap: cfg?.outward?.volumeCap ?? base.outward.volumeCap,
    },
  };
}
