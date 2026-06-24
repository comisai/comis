// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — Autonomy (named-profile) schema + resolver.
 *
 * Owns the v8 §3.8 named-profile posture: the `AutonomyConfigSchema` Zod leaf
 * (whose `.default()` produces the `standard` posture — the zero-config
 * great-out-of-box default and the MIG-01 migration target), the
 * `AUTONOMY_PROFILES` resolved cap/guard table, and the PURE `resolveAutonomy()`
 * that expands a `profile:` into the full §3.3 cap/guard block (any explicit
 * field OVERRIDES the profile — progressive disclosure).
 *
 * Imports nothing from sibling leaves (model/context/prompt/runtime) —
 * one-directional dependency graph; the top-level `PerAgentConfigSchema` in
 * `schema-agent-runtime.ts` composes from this leaf.
 *
 * Design anchors: v8 §3.3 (the knob block), §3.8 (the named-profile table +
 * zero-config + the M1 clamp for `unattended`/`max`), §22.3 (the structural
 * floor — the `autoApprovable:false` caps that escalate, never auto, in EVERY
 * profile forever). Pure config→caps transform: NO `process.env` / `Date.now`
 * / `path.join` (AGENTS §2.2). The resolver's downshift (PROFILE-03) is driven
 * by a preflight-result INPUT, never a live bwrap probe (that probe is Phase
 * 211); this leaf only provides the profile→caps expansion.
 *
 * @module
 */
import { z } from "zod";

// ── Orchestration-capability vocabulary ─────────────────────────────────────
//
// SINGLE SOURCE OF TRUTH: the closed `orch:*` set and the `AgentCapability`
// union are owned by the security layer (`security/capability.ts`, Phase 210)
// and imported here — the autonomy profiles below draw their caps from that one
// canonical list. An earlier draft kept a config-leaf-local copy to avoid a
// config→security edge, but two arrays that must stay "identical by
// construction" is exactly the drift the closed union exists to prevent, and the
// import is benign (one-way, into a dependency-free leaf — no package cycle).
// NAMING: the type is `AgentCapability` (NOT bare `Capability`) — bare
// `Capability` collides with `CapabilityId`/`ChannelCapability`/
// `CapabilityDescriptor` already in the tree (v8 / RESEARCH A1).
import { AGENT_CAPABILITIES, type AgentCapability } from "../../security/capability.js";
// The four nested BOUNDS sub-blocks (BUDGET/RATE/SPAWN/OUTWARD, 213-03) live in a
// sibling leaf to keep this file under the schema-agent file-size cap; re-exported
// below so consumers continue to import them from `schema-agent-autonomy`.
import {
  AutonomyBudgetConfigSchema,
  AutonomyRateConfigSchema,
  AutonomySpawnConfigSchema,
  AutonomyOutwardConfigSchema,
  STANDARD_AUTONOMY_BOUNDS,
  resolveAutonomyBounds,
  type AutonomyBudgetConfig,
  type AutonomyRateConfig,
  type AutonomySpawnConfig,
  type AutonomyOutwardConfig,
} from "./schema-agent-autonomy-bounds.js";
// Phase 216 (DUR-01..04 / HB-01): the durable-run + resume-engine gate. Default-
// off; nested into AutonomyConfigSchema below. Sibling leaf to keep this file
// under the schema-agent file-size cap; re-exported via the schema-agent barrel.
import { DurabilityConfigSchema } from "./schema-agent-autonomy-durability.js";
// 217: the §22 mode vocabulary + the EVICT-02 fail-closed `resolveEffectiveMode`
// primitive + the two `unattended`/`max` posture notices live in a sibling leaf
// (file-size cap), exported to `@comis/core` via the schema-agent barrel.
import {
  AUTONOMY_MODES,
  UNATTENDED_NOTICE,
  MAX_M1_CLAMP_NOTICE,
  type AutonomyMode,
} from "./schema-agent-autonomy-mode.js";

/**
 * The nine FLOOR-CONTAINED orchestration caps the `standard` profile turns on
 * (v8 §3.8 / §22.3). A profile MAY auto-allow these because the non-removable
 * §22.3 floor (deny-by-origin, secrets/host unreachability, the always-on
 * budget/rate/spawn-ceiling, live revoke) bounds their blast radius.
 *
 * `orch:message` IS a member (210-GAP MIG-01 / v8 §3.8 line 253 profile table /
 * §3.3 line 190): the `standard` profile turns ON origin-channel messaging, and
 * Plan 04 gates `message.send/reply/react` on `requireCapability(_,
 * "orch:message")`. The held cap is what lets the most fundamental agent action
 * — sending a message to the channel it was spoken to — pass that gate. The
 * ORIGIN-vs-new-channel scoping rides the separate `message.channels` config
 * (`["origin"]` by default): origin sends are auto-allowable under quota, while
 * a send to a NEW channel is an `autoApprovable:false` floor item (§3.5/§22.3)
 * enforced by the message config + the §8.4 per-target grant — NOT by removing
 * the cap from the held set. The cap-literal `orch:message` is therefore
 * floor-contained + `autoApprovable:true` (origin); only its non-origin TARGET
 * escalates. (§3.5: the cap covers the genuinely-outward subset send/reply/react
 * ONLY — edit/delete/fetch/attach stay admin-only and are not part of it.)
 */
export const STANDARD_FLOOR_CAPABILITIES = [
  "orch:read",
  "orch:web",
  "orch:write",
  "orch:analyze",
  "orch:spawn",
  "orch:graph",
  "orch:cron",
  "orch:skill",
  "orch:message",
] as const satisfies readonly AgentCapability[];

/**
 * The structural-floor caps that are `autoApprovable:false` in EVERY profile
 * forever (v8 §22.3): outward + irreversible. They are escalate-not-auto —
 * no mode, trust-graduation, or LLM-judge may ever auto-decide them. A profile
 * that opts one IN (e.g. an explicit `browse: true`) still resolves it with
 * `autoApprovable:false`.
 *
 * `orch:browse` (the browser) is the always-escalate cap-LITERAL member.
 * `orch:message` is deliberately NOT here: per §22.3 the floor item is
 * "orch:message to a NON-ORIGIN channel", and that target scoping rides the
 * `message.channels` config (`["origin"]` default + the §8.4 per-target grant),
 * NOT the cap literal. The cap-literal `orch:message` is auto-approvable to the
 * agent's OWN origin channel under quota (the §3.8 capable default), so it
 * resolves `autoApprovable:true` here while the non-origin send is gated by the
 * message config — modeling it as an always-escalate cap-literal would
 * incorrectly forbid even origin sends. `report:issue` is a Phase-215 deputy cap
 * outside this milestone's `orch:*` vocabulary.
 */
const ALWAYS_ESCALATE_CAPABILITIES = ["orch:browse"] as const satisfies readonly AgentCapability[];

const ALWAYS_ESCALATE_SET: ReadonlySet<AgentCapability> = new Set(ALWAYS_ESCALATE_CAPABILITIES);

// ── The autonomy config schema (§3.3 knob surface, §6.4 defaulting) ──────────

/** Per-agent autonomy posture. `accept-reversible` is the `standard` mode. */
export const AUTONOMY_PROFILE_NAMES = ["assistant", "standard", "unattended", "max"] as const;
export type AutonomyProfileName = (typeof AUTONOMY_PROFILE_NAMES)[number];

/**
 * The origin-channel message posture (§3.5/§8.4). `standard` resolves
 * `channels: ["origin"]` (own channel only) under an hourly quota; any NEW
 * target is an explicit per-target grant (`autoApprovable:false`).
 */
export const AutonomyMessageConfigSchema = z.strictObject({
  /** Allowed outward channels. 'origin' = the agent's own channel. */
  channels: z.array(z.string()).default(["origin"]),
  /** Outward-send quota per rolling hour. */
  maxPerHour: z.number().int().positive().default(20),
});

/**
 * `AutonomyConfigSchema` — the §3.3 knob surface. Every field carries a
 * `.default()` (§6.4); a fully-omitted block parses to the `standard` posture
 * (PROFILE-01 + MIG-01). `strictObject` is the typo guard.
 *
 * Most operators set ONLY `profile:` (or nothing → `standard`). The fields
 * below are the full resolved surface a profile expands to; any explicit field
 * OVERRIDES the profile (progressive disclosure).
 */
export const AutonomyConfigSchema = z.strictObject({
  /** §3.8 posture: assistant | standard (default) | unattended | max. */
  profile: z.enum(AUTONOMY_PROFILE_NAMES).default("standard"),
  /**
   * Whether autonomy surfaces are on. Optional at the config layer — the
   * resolver fills it from the profile when omitted (`standard` → true,
   * `assistant` → false). An explicit value overrides the profile.
   *
   * IN-01 SEMANTICS (210-GAP, design option (a)): a per-surface toggle
   * (`web`/`analyze`/`write`/`browse`) is the ENABLE SIGNAL FOR THAT SURFACE and
   * OVERRIDES `enabled`. So `{ profile: "assistant", web: true }` resolves
   * `enabled:false` but STILL grants `orch:web` — progressive disclosure: an
   * operator who turned one surface ON gets that one cap, not silence. `enabled`
   * is the profile-level autonomy posture; it does NOT zero an explicitly-toggled
   * surface (that would surprise an operator who set `web:true`). The §22.3 floor
   * still bounds every granted cap regardless. Pinned by `schema-agent-autonomy`
   * resolver tests (the toggle-overrides-enabled case).
   */
  enabled: z.boolean().optional(),
  /**
   * Explicit base capability list. Optional — the resolver expands the profile
   * into the floor-contained set when omitted. An explicit list overrides the
   * profile's base set (still subject to the M1 clamp + the §22.3 floor).
   */
  capabilities: z.array(z.enum(AGENT_CAPABILITIES)).optional(),
  /** §22 autonomy mode (operator-set; the agent CANNOT self-raise). */
  mode: z.enum(AUTONOMY_MODES).optional(),
  /** Per-root-run hard $ ceiling across the whole spawn tree (§8.7). */
  aggregateBudgetUsd: z.number().positive().optional(),
  /** Tree-wide concurrent-self-agent ceiling (§8). */
  maxConcurrentSelfAgents: z.number().int().positive().optional(),
  /** Self-spawn rate limit per minute (concurrency ≠ rate). */
  maxSelfSpawnRatePerMin: z.number().int().positive().optional(),
  /** Max agent-authored cron jobs (§8). */
  cronSelfMax: z.number().int().positive().optional(),
  /**
   * §8.8/§22.4 denial-limit circuit breaker (BREAK-01). The number of
   * CONSECUTIVE structural-floor blocks within one root run after which the run
   * aborts + escalates rather than retry-looping the budget away. A positive int
   * (a 0 would disable the breaker — `z.number().int().positive()` rejects it so
   * a malformed config fails CLOSED, T-217-01). Default 5; inert until a deny
   * actually happens, so a default install is byte-identical.
   */
  denialBreakerN: z.number().int().positive().default(5),
  /**
   * §22.5 fail-closed evict posture (EVICT-02). When the per-run autonomy mode
   * cannot be resolved (an unreachable/forged policy source), resolve to the
   * `default` (SAFE) mode, never a broader profile. Default true — which IS the
   * already-safe behavior, so a default install is byte-identical.
   */
  evictOnPolicyUnreachable: z.boolean().default(true),
  /**
   * Capability-lease posture (§4.2 / LEASE-02). The nested `lease` sub-block —
   * `autonomy.lease.{ leaseMaxTtlMin }` — bounds how long a renewable lease can
   * live. `leaseMaxTtlMin` is the renewal CEILING in MINUTES (a positive int);
   * the LeaseManager (211-01) clamps each renew to a `maxExpiresAt` derived from
   * it, so revoke actually STOPS renewal (no unbounded re-lease). Omitted → the
   * profile default (60). Modeled as a nested object (the `message:` sub-block
   * precedent above) per REQUIREMENTS.md `autonomy.lease.{...}`.
   */
  lease: z.object({ leaseMaxTtlMin: z.number().int().positive().optional() }).optional(),
  /** Origin-channel outward-message posture (§3.5/§8.4). */
  message: AutonomyMessageConfigSchema.default(() => AutonomyMessageConfigSchema.parse({})),
  // 213 nested BOUNDS sub-blocks (per-limb docs in schema-agent-autonomy-bounds.ts;
  // flat aggregateBudgetUsd/maxConcurrentSelfAgents are aliases the resolver folds in).
  budget: AutonomyBudgetConfigSchema.default(() => AutonomyBudgetConfigSchema.parse({})), // $/token/wall-clock (BUDGET-01/02)
  rate: AutonomyRateConfigSchema.default(() => AutonomyRateConfigSchema.parse({})), // per-root/socket/churn (RATE-01)
  spawn: AutonomySpawnConfigSchema.default(() => AutonomySpawnConfigSchema.parse({})), // concurrent/depth/fanout (CEIL-01)
  outward: AutonomyOutwardConfigSchema.default(() => AutonomyOutwardConfigSchema.parse({})), // origin/grants/volume (QUOTA-01/02)
  // Phase 216 DURABILITY sub-block (DUR-01..04 / HB-01). Default-off
  // (`{ enabled:false, ... }` on a fully-omitted block) — a default install
  // constructs no durable stores / boot recovery / watchdog (byte-identical).
  // `.parse({})` materializes the per-field defaults (mirrors the sibling
  // budget/rate/spawn/outward blocks above; a bare `.default({})` does not
  // typecheck because every nested field is itself `.default()`-ed).
  durability: DurabilityConfigSchema.default(() => DurabilityConfigSchema.parse({})),
  // ── per-surface ergonomic toggles → matching orch:* cap (§3.3 "one cap model") ──
  /** orch:web — untrusted external content (Rule-of-Two leg A). */
  web: z.boolean().optional(),
  /** orch:analyze — cost-bearing media analysis (behind the §8.7 budget). */
  analyze: z.boolean().optional(),
  /** orch:write — workspace mutation (jailed + reversible-ish). */
  write: z.boolean().optional(),
  /** orch:browse — browser; OUTWARD/semi-irreversible. OFF in every default profile. */
  browse: z.boolean().optional(),
  /** Surface-3 CLI (comis-agent in jail). OFF in all default profiles. */
  cli: z.boolean().optional(),
  /** Surface-2 orchestrate script. */
  script: z.boolean().optional(),
});

export type AutonomyConfig = z.infer<typeof AutonomyConfigSchema>;
export type AutonomyMessageConfig = z.infer<typeof AutonomyMessageConfigSchema>;

// The nested-bounds schemas/types/helper live in `schema-agent-autonomy-bounds.ts`
// (imported above for the schema fields + resolver) and are re-exported by the
// `schema-agent/index.ts` barrel, so consumers reach them via `@comis/core`.

/** A per-surface toggle field paired with the orch:* cap it maps to (§3.3). */
const SURFACE_TOGGLE_TO_CAP = {
  web: "orch:web",
  analyze: "orch:analyze",
  write: "orch:write",
  browse: "orch:browse",
} as const satisfies Record<string, AgentCapability>;

// ── The resolved profile table (§3.8) ───────────────────────────────────────

/** The guard/cap shape a profile resolves to (before per-surface toggles + overrides). */
interface ProfileEntry {
  readonly enabled: boolean;
  /** Base orch:* caps the profile turns on (the floor-contained set, or empty). */
  readonly capabilities: readonly AgentCapability[];
  readonly mode: AutonomyMode;
  readonly aggregateBudgetUsd: number;
  readonly maxConcurrentSelfAgents: number;
  readonly maxSelfSpawnRatePerMin: number;
  readonly cronSelfMax: number;
  /** Consecutive floor-blocks → abort+escalate (BREAK-01, §8.8/§22.4). */
  readonly denialBreakerN: number;
  /** Fail-closed to `default` on an unresolvable mode (EVICT-02, §22.5). */
  readonly evictOnPolicyUnreachable: boolean;
  /** Lease renewal ceiling in minutes (LEASE-02); the LeaseManager clamps renew to it. */
  readonly leaseMaxTtlMin: number;
  readonly message: AutonomyMessageConfig;
  // 213 nested bounds (BUDGET-01/02, RATE-01, CEIL-01, QUOTA-01/02).
  readonly budget: AutonomyBudgetConfig;
  readonly rate: AutonomyRateConfig;
  readonly spawn: AutonomySpawnConfig;
  readonly outward: AutonomyOutwardConfig;
  /** Present for `unattended` (mode-active notice) + `max` (M3 clamp notice). */
  readonly m1Notice?: string;
}

/**
 * The §3.8 `standard` guard set — ON under every autonomy-bearing profile
 * (§8.7). The nested `budget`/`rate`/`spawn`/`outward` blocks derive their
 * concrete defaults from the SCHEMA (`.parse({})`) so the profile table and the
 * Zod `.default()`s stay in single-source-of-truth lockstep — adding/retuning a
 * limb is a one-edit change in the schema above.
 */
const STANDARD_GUARDS = {
  aggregateBudgetUsd: 2.0,
  maxConcurrentSelfAgents: 4,
  maxSelfSpawnRatePerMin: 30,
  cronSelfMax: 8,
  // 217 never-hang scalars (flow into all four profiles). Default-safe: the
  // breaker is inert until a deny happens; evict fail-closed defaults to the
  // already-safe `true`. Kept in SSOT lockstep with the schema `.default()`s.
  denialBreakerN: 5,
  evictOnPolicyUnreachable: true,
  // LEASE-02: a 1-hour renewal ceiling (Vault-style). Per-renew ttl is shorter
  // (e.g. 15 min) and renewable UP TO this max — so revoke stops renewal.
  leaseMaxTtlMin: 60,
  // 213 nested limbs (BUDGET-01/02, RATE-01, CEIL-01, QUOTA-01/02).
  ...STANDARD_AUTONOMY_BOUNDS,
} as const;

const STANDARD_MESSAGE: AutonomyMessageConfig = { channels: ["origin"], maxPerHour: 20 };

/**
 * The resolved cap/guard sets for the four named profiles (v8 §3.8).
 *
 * - `assistant`: enabled off, zero orchestration surfaces.
 * - `standard` (default): enabled on, the nine floor-contained caps (incl.
 *   origin-channel `orch:message`), guards ON, origin-only message.
 * - `unattended`: cap set standard-equivalent (no over-grant) + a notice that
 *   the never-hang MODE behaviors (deny+escalate, denial breaker, evict) are
 *   ACTIVE as of Phase 217 (UNATT/BREAK/EVICT). `max`: CLAMPED to `standard`'s
 *   cap set in M1 + a clamp notice (sandbox auto-allow is M3 — no larger cap set).
 */
export const AUTONOMY_PROFILES = {
  assistant: {
    enabled: false,
    capabilities: [],
    mode: "default",
    ...STANDARD_GUARDS,
    message: STANDARD_MESSAGE,
  },
  standard: {
    enabled: true,
    capabilities: STANDARD_FLOOR_CAPABILITIES,
    mode: "accept-reversible",
    ...STANDARD_GUARDS,
    message: STANDARD_MESSAGE,
  },
  unattended: {
    enabled: true,
    capabilities: STANDARD_FLOOR_CAPABILITIES, // cap set standard-equivalent (no over-grant); mode behaviors active (217)
    mode: "unattended",
    ...STANDARD_GUARDS,
    message: STANDARD_MESSAGE,
    m1Notice: UNATTENDED_NOTICE,
  },
  max: {
    enabled: true,
    capabilities: STANDARD_FLOOR_CAPABILITIES, // CLAMP — no over-grant in M1
    mode: "max",
    ...STANDARD_GUARDS,
    message: STANDARD_MESSAGE,
    m1Notice: MAX_M1_CLAMP_NOTICE,
  },
} as const satisfies Record<AutonomyProfileName, ProfileEntry>;

// ── The resolver (PROFILE-01) ────────────────────────────────────────────────

/** A resolved capability carrying its §3.7/§22.3 `autoApprovable` bit. */
export interface ResolvedCapability {
  readonly capability: AgentCapability;
  /**
   * Whether the held cap may be auto-decided vs must escalate. `false` for the
   * §22.3 floor caps (orch:browse, and orch:message to a non-origin channel) in
   * EVERY profile forever; `true` for the floor-contained caps.
   */
  readonly autoApprovable: boolean;
}

/** The fully-resolved autonomy posture a consumer (Plan 04/06) reads. */
export interface ResolvedAutonomy {
  readonly profile: AutonomyProfileName;
  readonly enabled: boolean;
  /** The resolved orch:* caps (deduped). */
  readonly capabilities: readonly AgentCapability[];
  /** The same caps with their `autoApprovable` bits (Plan-04 auto-allow + the PROFILE-02 arch-test read this). */
  readonly resolvedCapabilities: readonly ResolvedCapability[];
  readonly mode: AutonomyMode;
  readonly aggregateBudgetUsd: number;
  readonly maxConcurrentSelfAgents: number;
  readonly maxSelfSpawnRatePerMin: number;
  readonly cronSelfMax: number;
  /** Consecutive floor-blocks → abort+escalate; the denial breaker (BREAK-01) reads this. */
  readonly denialBreakerN: number;
  /** Fail-closed to `default` on an unresolvable mode (EVICT-02); the chokepoint reads this. */
  readonly evictOnPolicyUnreachable: boolean;
  /** Lease renewal ceiling in minutes (LEASE-02) — the LeaseManager (211-01) clamps renew to it. */
  readonly leaseMaxTtlMin: number;
  readonly message: AutonomyMessageConfig;
  // 213 nested bounds — total on every profile. budget.aggregateUsd /
  // spawn.maxConcurrentSelfAgents mirror the flat fields (one resolved source);
  // spawn.maxSpawnDepth/maxChildrenPerAgent are surfaced here (prior: subagentContext).
  readonly budget: AutonomyBudgetConfig; // $/token/wall-clock (BUDGET-01/02)
  readonly rate: AutonomyRateConfig; // per-root/socket/churn (RATE-01)
  readonly spawn: AutonomySpawnConfig; // concurrent/depth/fanout (CEIL-01)
  readonly outward: AutonomyOutwardConfig; // origin/grants/volume (QUOTA-01/02)
  /** Present for `unattended` (mode-active notice) + `max` (M3 clamp notice). */
  readonly m1Notice?: string;
}

/** Is this resolved cap auto-allowable? `false` for the §22.3 always-escalate floor. */
function capIsAutoApprovable(cap: AgentCapability): boolean {
  return !ALWAYS_ESCALATE_SET.has(cap);
}

/**
 * Expand a (possibly partial) autonomy config into the full resolved posture.
 *
 * PURE — a function of `cfg` only (no env/clock/fs, AGENTS §2.2). Algorithm:
 *  1. base = the §3.8 profile entry for `cfg.profile ?? "standard"` (the
 *     `unattended`/`max` entries are already CLAMPED to `standard`'s caps).
 *  2. start from the profile's base caps; if `cfg.capabilities` is given,
 *     use it as the base instead (explicit override).
 *  3. union in the matching `orch:*` for each enabled per-surface toggle
 *     (`web`→`orch:web`, …), deduped.
 *  4. apply explicit scalar overrides (any defined field wins — progressive
 *     disclosure).
 *  5. attach the `autoApprovable` bit per cap (the §22.3 floor caps are
 *     always-escalate, even when opted in).
 *
 * @param cfg the per-agent autonomy block (omitted → `standard`, zero-config).
 */
export function resolveAutonomy(cfg?: AutonomyConfig): ResolvedAutonomy {
  const profileName: AutonomyProfileName = cfg?.profile ?? "standard";
  // Widen to ProfileEntry so the optional `m1Notice` is visible across the
  // 4-member literal union (`as const satisfies` keeps each member's exact
  // shape, on which `.m1Notice` is otherwise absent for assistant/standard).
  const base: ProfileEntry = AUTONOMY_PROFILES[profileName];

  // Base caps: explicit list overrides the profile's set (still floor-bounded
  // by the arch-test + the always-escalate autoApprovable bit).
  const baseCaps: readonly AgentCapability[] = cfg?.capabilities ?? base.capabilities;

  // Union in per-surface toggles. `assistant` has zero surfaces by default, but
  // an explicit toggle is honored as an opt-in (progressive disclosure). The
  // pairs are read from explicit, statically-named fields (no dynamic indexing
  // into `cfg`) so each access is type-checked and injection-sink-free.
  const capSet = new Set<AgentCapability>(baseCaps);
  const surfaceToggles: readonly (readonly [boolean | undefined, AgentCapability])[] = [
    [cfg?.web, SURFACE_TOGGLE_TO_CAP.web],
    [cfg?.analyze, SURFACE_TOGGLE_TO_CAP.analyze],
    [cfg?.write, SURFACE_TOGGLE_TO_CAP.write],
    [cfg?.browse, SURFACE_TOGGLE_TO_CAP.browse],
  ];
  for (const [enabled, cap] of surfaceToggles) {
    if (enabled === true) capSet.add(cap);
  }
  // Stable order: profile/base order first, then any toggle-added caps.
  const orderedCaps: AgentCapability[] = [];
  for (const cap of AGENT_CAPABILITIES) {
    if (capSet.has(cap)) orderedCaps.push(cap);
  }

  const resolvedCapabilities: ResolvedCapability[] = orderedCaps.map((capability) => ({
    capability,
    autoApprovable: capIsAutoApprovable(capability),
  }));

  // Per-field merge of the nested BOUNDS blocks (resolveAutonomyBounds: explicit
  // nested → prior-flat alias → profile default). The flat aggregateBudgetUsd /
  // maxConcurrentSelfAgents resolved fields below mirror their nested twins (one
  // resolved source at the meter/semaphore).
  const bounds = resolveAutonomyBounds(cfg, base);

  const resolved: ResolvedAutonomy = {
    profile: profileName,
    enabled: cfg?.enabled ?? base.enabled,
    capabilities: orderedCaps,
    resolvedCapabilities,
    mode: cfg?.mode ?? base.mode,
    aggregateBudgetUsd: bounds.budget.aggregateUsd,
    maxConcurrentSelfAgents: bounds.spawn.maxConcurrentSelfAgents,
    maxSelfSpawnRatePerMin: cfg?.maxSelfSpawnRatePerMin ?? base.maxSelfSpawnRatePerMin,
    cronSelfMax: cfg?.cronSelfMax ?? base.cronSelfMax,
    denialBreakerN: cfg?.denialBreakerN ?? base.denialBreakerN,
    // `??` (NOT `||`) so an explicit `false` is honored, not coerced to the default true.
    evictOnPolicyUnreachable: cfg?.evictOnPolicyUnreachable ?? base.evictOnPolicyUnreachable,
    leaseMaxTtlMin: cfg?.lease?.leaseMaxTtlMin ?? base.leaseMaxTtlMin,
    message: cfg?.message ?? base.message,
    budget: bounds.budget,
    rate: bounds.rate,
    spawn: bounds.spawn,
    outward: bounds.outward,
    ...(base.m1Notice !== undefined ? { m1Notice: base.m1Notice } : {}),
  };
  return resolved;
}

// ── The honest, legible degrade path (PROFILE-03) ────────────────────────────
//
// Split into the sibling `schema-agent-autonomy-degrade.ts` leaf (PROFILE-03 is
// a separate concern from PROFILE-01 resolution; keeps both files under the
// schema-agent file-size cap). It imports `resolveAutonomy`/`AutonomyConfigSchema`
// from THIS leaf (one-directional: degrade → autonomy), and is re-exported
// alongside this leaf by the `schema-agent/index.ts` barrel — so consumers keep
// importing `degradeAutonomy`/`AutonomyDownshift`/`AutonomyPreflightResult` from
// `@comis/core`. (Re-exporting it HERE would form an autonomy↔degrade cycle.)
