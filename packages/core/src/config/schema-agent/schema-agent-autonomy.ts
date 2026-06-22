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
 * - `standard` (default): enabled on, the nine floor-contained caps (incl.
 *   origin-channel `orch:message`), guards ON, origin-only message.
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

// ── The honest, legible degrade path (PROFILE-03) ────────────────────────────
//
// 210/211 SEAM (RESEARCH Pitfall 5 / A4): the downshift is driven by a
// preflight-RESULT INPUT (a boolean the caller passes in), NEVER a live
// bubblewrap / `unshare` probe. The probe that PRODUCES that boolean is Phase
// 211 (JAIL-03). Keeping the trigger an input keeps `degradeAutonomy` PURE
// (AGENTS §2.2) and independently testable — this leaf imports nothing from the
// daemon's sandbox-provider layer.

/** The host preconditions a jail-bearing posture depends on (210: the namespace preflight; 211 adds the probe that fills it). */
export interface AutonomyPreflightResult {
  /**
   * Whether the unprivileged-user-namespace (`unshare --user`/`--net`)
   * preflight passed. `false` means the jail cannot be built, so an
   * autonomy-bearing posture would run UNJAILED — which we refuse, downshifting
   * to `assistant` instead. In Phase 210 this is supplied by the caller (the
   * default at boot is `true`); the actual probe lands in Phase 211.
   */
  readonly namespacePreflightOk: boolean;
}

/**
 * The structured signal a downshift surfaces (PROFILE-03). Carried out of
 * {@link degradeAutonomy} so the daemon can emit a WARN + a `doctor` finding —
 * the operator is TOLD, never silently dropped to a safer posture. The
 * `errorKind` is the closed-union `"precondition"` (an unmet host guard), and
 * `hint` names the remediation.
 */
export interface AutonomyDownshift {
  /** The profile that was selected before the precondition failed. */
  readonly downshiftedFrom: AutonomyProfileName;
  /** Always `assistant` in M1 — the zero-surface safe floor. */
  readonly downshiftedTo: "assistant";
  /** Machine-readable reason (the failed precondition). */
  readonly reason: "namespace_preflight_failed";
  /** Operator-facing remediation (canonical logging field `hint`). */
  readonly hint: string;
  /** Closed-union errorKind — `"precondition"` = an unmet guard (AGENTS §2.7). */
  readonly errorKind: "precondition";
}

/** The actionable remediation surfaced on a namespace-preflight downshift. */
const NAMESPACE_PREFLIGHT_DOWNSHIFT_HINT =
  "Autonomy needs an unprivileged user namespace to build the jail, and the namespace preflight failed — downshifted to the 'assistant' profile (no orchestration surfaces). Enable unprivileged user namespaces (e.g. sysctl kernel.unprivileged_userns_clone=1 / kernel.apparmor_restrict_unprivileged_userns=0) and restart, or set autonomy.profile: assistant to silence this. See docs/agents/autonomy.";

/**
 * Honest legible degrade (PROFILE-03). Given a fully-resolved posture and the
 * host preflight RESULT, downshift to `assistant` (enabled false, zero caps) and
 * SURFACE a structured {@link AutonomyDownshift} when the namespace preflight
 * failed — never a silent enabled-but-unjailed fallback.
 *
 * PURE — a function of `(resolved, preflight)` only (no env/clock/fs, AGENTS
 * §2.2). The preflight boolean is an INPUT; the probe that produces it is Phase
 * 211 (JAIL-03 / RESEARCH Pitfall 5). The downshift is a no-op (no signal) when
 * the preflight passed OR the posture is already `assistant` (nothing to take
 * away — idempotent).
 *
 * @param resolved the posture from {@link resolveAutonomy}.
 * @param preflight the host preconditions (210: caller-supplied; 211: probed).
 * @returns the (possibly-downshifted) posture + an optional surfaced signal.
 */
export function degradeAutonomy(
  resolved: ResolvedAutonomy,
  preflight: AutonomyPreflightResult,
): { resolved: ResolvedAutonomy; downshift?: AutonomyDownshift } {
  // Preflight passed, or there is nothing to downshift FROM (already the
  // zero-surface floor): return the posture untouched, no signal.
  if (preflight.namespacePreflightOk || resolved.profile === "assistant") {
    return { resolved };
  }
  // Failed precondition on an autonomy-bearing posture → fall to the assistant
  // floor and SAY SO. Resolve the canonical `assistant` shape so the downshifted
  // posture is byte-identical to a selected `assistant` (enabled false, 0 caps).
  // Parse through the schema first so the `AutonomyConfig` is fully-defaulted
  // (the resolver's param is the OUTPUT type — `message` is required), matching
  // the Plan-02 m1Notice/`tsc`-vs-vitest typing precedent.
  const downshifted = resolveAutonomy(AutonomyConfigSchema.parse({ profile: "assistant" }));
  const downshift: AutonomyDownshift = {
    downshiftedFrom: resolved.profile,
    downshiftedTo: "assistant",
    reason: "namespace_preflight_failed",
    hint: NAMESPACE_PREFLIGHT_DOWNSHIFT_HINT,
    errorKind: "precondition",
  };
  return { resolved: downshifted, downshift };
}
