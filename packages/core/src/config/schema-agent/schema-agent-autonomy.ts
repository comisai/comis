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
// The closed `orch:*` set the autonomy profiles draw from. This is the
// config-leaf-local copy of the v8 §3.2/§3.6 vocabulary so this leaf stays
// self-contained (it imports nothing from sibling leaves and introduces no
// config→security package edge). The canonical security predicate
// (`requireCapability`) and its union live in the security layer; the strings
// are identical by construction (the §3.8 profile table is the source of both).
//
// NAMING: the type is `AgentCapability` (NOT bare `Capability`) — bare
// `Capability` collides with `CapabilityId`/`ChannelCapability`/
// `CapabilityDescriptor` already in the tree (v8 / RESEARCH A1).
export const AGENT_CAPABILITIES = [
  // orchestration core
  "orch:spawn",
  "orch:graph",
  "orch:cron",
  "orch:skill",
  "orch:message",
  // tool-surface caps (§3.6)
  "orch:read",
  "orch:web",
  "orch:analyze",
  "orch:write",
  "orch:browse",
] as const;

/** Closed orchestration-capability union (inferred from {@link AGENT_CAPABILITIES}). */
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/**
 * The eight FLOOR-CONTAINED orchestration caps the `standard` profile turns on
 * (v8 §3.8 / §22.3). A profile MAY auto-allow these because the non-removable
 * §22.3 floor (deny-by-origin, secrets/host unreachability, the always-on
 * budget/rate/spawn-ceiling, live revoke) bounds their blast radius.
 *
 * `orch:message` is intentionally NOT in this list — it rides the separate
 * `message:` block. Origin-channel sends are auto-allowable under quota; a send
 * to a NEW channel is an `autoApprovable:false` floor item (§3.5/§22.3), so the
 * message cap is modeled by the message config, not by membership here.
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
] as const satisfies readonly AgentCapability[];

/**
 * The structural-floor caps that are `autoApprovable:false` in EVERY profile
 * forever (v8 §22.3): outward + irreversible. They are escalate-not-auto —
 * no mode, trust-graduation, or LLM-judge may ever auto-decide them. A profile
 * that opts one IN (e.g. an explicit `browse: true`) still resolves it with
 * `autoApprovable:false`.
 *
 * `orch:message` to a NON-origin channel is the third floor item; it is not an
 * `AgentCapability` literal of its own (the cap is `orch:message`, the target
 * scoping rides the `message.channels` config), so the always-false set here
 * carries the two cap-literal members. `report:issue` is a Phase-215 deputy cap
 * outside this milestone's `orch:*` vocabulary.
 */
const ALWAYS_ESCALATE_CAPABILITIES = ["orch:browse"] as const satisfies readonly AgentCapability[];

const ALWAYS_ESCALATE_SET: ReadonlySet<AgentCapability> = new Set(ALWAYS_ESCALATE_CAPABILITIES);

// ── The autonomy config schema (§3.3 knob surface, §6.4 defaulting) ──────────

/** Per-agent autonomy posture. `accept-reversible` is the `standard` mode. */
export const AUTONOMY_PROFILE_NAMES = ["assistant", "standard", "unattended", "max"] as const;
export type AutonomyProfileName = (typeof AUTONOMY_PROFILE_NAMES)[number];

export const AUTONOMY_MODES = ["default", "accept-reversible", "unattended", "max"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

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
  /** Origin-channel outward-message posture (§3.5/§8.4). */
  message: AutonomyMessageConfigSchema.default(() => AutonomyMessageConfigSchema.parse({})),
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
  readonly message: AutonomyMessageConfig;
  /** Present for `unattended`/`max` in M1: the "available in M2/M3" clamp notice. */
  readonly m1Notice?: string;
}

/** The §3.8 `standard` guard set — ON under every autonomy-bearing profile (§8.7). */
const STANDARD_GUARDS = {
  aggregateBudgetUsd: 2.0,
  maxConcurrentSelfAgents: 4,
  maxSelfSpawnRatePerMin: 30,
  cronSelfMax: 8,
} as const;

const STANDARD_MESSAGE: AutonomyMessageConfig = { channels: ["origin"], maxPerHour: 20 };

/**
 * The M1 clamp notice for `unattended`/`max`. Selecting either resolves to the
 * `standard`-equivalent cap set today; the extra surfaces (coordinator role,
 * durable runs, sandbox-auto-allow) land in M2/M3 (v8 §3.8 / ROADMAP criterion
 * 5). No silent over-grant.
 */
const M1_CLAMP_NOTICE =
  "Resolved to standard-equivalent in M1: the unattended/max surfaces (coordinator role, durable runs, max-mode sandbox auto-allow) are available in M2/M3.";

/**
 * The resolved cap/guard sets for the four named profiles (v8 §3.8).
 *
 * - `assistant`: enabled off, zero orchestration surfaces.
 * - `standard` (default): enabled on, the eight floor-contained caps, guards
 *   ON, origin-only message.
 * - `unattended` / `max`: CLAMPED to `standard`'s cap set in M1 + the notice
 *   (Pitfall 4 / §3.8 + ROADMAP criterion 5 — no larger cap set).
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
    capabilities: STANDARD_FLOOR_CAPABILITIES, // CLAMP — no over-grant in M1
    mode: "unattended",
    ...STANDARD_GUARDS,
    message: STANDARD_MESSAGE,
    m1Notice: M1_CLAMP_NOTICE,
  },
  max: {
    enabled: true,
    capabilities: STANDARD_FLOOR_CAPABILITIES, // CLAMP — no over-grant in M1
    mode: "max",
    ...STANDARD_GUARDS,
    message: STANDARD_MESSAGE,
    m1Notice: M1_CLAMP_NOTICE,
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
  readonly message: AutonomyMessageConfig;
  /** Present for `unattended`/`max` in M1 — the clamp notice. */
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

  const resolved: ResolvedAutonomy = {
    profile: profileName,
    enabled: cfg?.enabled ?? base.enabled,
    capabilities: orderedCaps,
    resolvedCapabilities,
    mode: cfg?.mode ?? base.mode,
    aggregateBudgetUsd: cfg?.aggregateBudgetUsd ?? base.aggregateBudgetUsd,
    maxConcurrentSelfAgents: cfg?.maxConcurrentSelfAgents ?? base.maxConcurrentSelfAgents,
    maxSelfSpawnRatePerMin: cfg?.maxSelfSpawnRatePerMin ?? base.maxSelfSpawnRatePerMin,
    cronSelfMax: cfg?.cronSelfMax ?? base.cronSelfMax,
    message: cfg?.message ?? base.message,
    ...(base.m1Notice !== undefined ? { m1Notice: base.m1Notice } : {}),
  };
  return resolved;
}
