// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  AutonomyConfigSchema,
  AUTONOMY_PROFILES,
  resolveAutonomy,
} from "./schema-agent-autonomy.js";
// PROFILE-03 honest-degrade moved to its own leaf (213-03 file-size split).
import { degradeAutonomy, type AutonomyDownshift } from "./schema-agent-autonomy-degrade.js";

// ---------------------------------------------------------------------------
// PROFILE-01 (Phase 210): the v8 §3.8 named-profile resolver. An
// `AutonomyConfigSchema` Zod leaf whose `.default()` produces `standard` (the
// zero-config great-out-of-box default + the MIG-01 migration target), plus a
// PURE `resolveAutonomy()` that expands `profile:` into the full §3.3
// cap/guard block (an explicit field OVERRIDES the profile — progressive
// disclosure). Per v8 §3.8, `unattended`/`max` MUST CLAMP to `standard`'s cap
// set in M1 (no silent over-grant) + carry an "available in M2/M3" notice.
//
// These cases fail on the pre-patch tree (the schema file does not exist yet,
// so the import itself is unresolvable) — RED proof. The resolver is a pure
// function of its config input (no env/clock/fs — AGENTS §2.2).
// ---------------------------------------------------------------------------

// The nine FLOOR-CONTAINED orchestration caps `standard` turns on (v8 §3.8 /
// §22.3). `orch:message` IS a member (210-GAP MIG-01 / §3.8 line 253): the
// standard profile turns ON origin-channel messaging. The ORIGIN-vs-new scoping
// rides `message.channels` (`["origin"]` default); origin sends are
// auto-allowable under quota, a NEW channel is an `autoApprovable:false` floor
// item (§3.5/§22.3) — so the cap-literal is floor-contained + autoApprovable.
const STANDARD_FLOOR_CAPS = [
  "orch:read",
  "orch:web",
  "orch:write",
  "orch:analyze",
  "orch:spawn",
  "orch:graph",
  "orch:cron",
  "orch:skill",
  "orch:message",
] as const;

describe("AutonomyConfigSchema (PROFILE-01 — zero-config default → standard)", () => {
  it("PROFILE-01-S1: parse({}) resolves profile 'standard' (the zero-config default + MIG-01 target)", () => {
    const parsed = AutonomyConfigSchema.parse({});
    expect(parsed.profile).toBe("standard");
  });

  it("PROFILE-01-S2: strictObject rejects an unknown key (typo guard)", () => {
    expect(AutonomyConfigSchema.safeParse({ profil: "standard" }).success).toBe(false);
  });

  it("PROFILE-01-S3: accepts each of the four profile names", () => {
    for (const p of ["assistant", "standard", "unattended", "max"] as const) {
      expect(AutonomyConfigSchema.safeParse({ profile: p }).success).toBe(true);
    }
    expect(AutonomyConfigSchema.safeParse({ profile: "nope" }).success).toBe(false);
  });
});

describe("AUTONOMY_PROFILES (the §3.8 resolved cap/guard sets)", () => {
  it("exposes all four named profiles", () => {
    expect(Object.keys(AUTONOMY_PROFILES).sort()).toEqual(
      ["assistant", "max", "standard", "unattended"].sort(),
    );
  });
});

describe("resolveAutonomy (PROFILE-01 — pure profile → §3.3 block)", () => {
  it("PROFILE-01-S4: resolveAutonomy(undefined) → standard, caps include orch:spawn/orch:graph/orch:cron/orch:message", () => {
    const r = resolveAutonomy(undefined);
    expect(r.profile).toBe("standard");
    expect(r.enabled).toBe(true);
    expect(r.capabilities).toEqual(
      expect.arrayContaining(["orch:spawn", "orch:graph", "orch:cron", "orch:message"]),
    );
  });

  it("PROFILE-01-S5: standard resolves to exactly the nine floor-contained caps (incl. origin orch:message)", () => {
    const r = resolveAutonomy({ profile: "standard" });
    expect([...r.capabilities].sort()).toEqual([...STANDARD_FLOOR_CAPS].sort());
  });

  it("210-GAP MIG-01: standard's orch:message is autoApprovable:true (origin-channel auto-send), NOT an always-escalate floor cap", () => {
    // The cap-literal is auto-allowable to the OWN origin channel under quota
    // (§3.8 capable default); the non-origin TARGET escalates via the message
    // config, NOT by marking the cap autoApprovable:false. orch:browse stays the
    // only always-escalate cap-literal.
    const r = resolveAutonomy({ profile: "standard" });
    const msg = r.resolvedCapabilities.find((c) => c.capability === "orch:message");
    expect(msg, "standard must resolve an orch:message cap").toBeDefined();
    expect(msg!.autoApprovable).toBe(true);
  });

  it("210-GAP IN-01: a per-surface toggle OVERRIDES enabled — { profile: assistant, web: true } resolves enabled:false but STILL grants orch:web", () => {
    // The toggle IS the enable signal for that surface (design option (a)):
    // enabled:false does NOT zero an explicitly-toggled surface (progressive
    // disclosure). The §22.3 floor still bounds the granted cap.
    const r = resolveAutonomy({ profile: "assistant", web: true });
    expect(r.enabled).toBe(false);
    expect(r.capabilities).toContain("orch:web");
  });

  it("PROFILE-01-S6: assistant → enabled false, zero orchestration surfaces", () => {
    const r = resolveAutonomy({ profile: "assistant" });
    expect(r.enabled).toBe(false);
    expect(r.capabilities.length).toBe(0);
  });

  it("PROFILE-01-S7: standard ships guards ON (budget/rate/ceiling > 0)", () => {
    const r = resolveAutonomy({ profile: "standard" });
    expect(r.aggregateBudgetUsd).toBeGreaterThan(0);
    expect(r.maxConcurrentSelfAgents).toBeGreaterThan(0);
    expect(r.maxSelfSpawnRatePerMin).toBeGreaterThan(0);
  });

  it("PROFILE-01-S8: standard.message.channels is origin-only", () => {
    const r = resolveAutonomy({ profile: "standard" });
    expect(r.message.channels).toEqual(["origin"]);
  });

  it("PROFILE-01-S9: max is CLAMPED to a subset of standard's caps + carries an m1Notice naming M2/M3", () => {
    const max = resolveAutonomy({ profile: "max" });
    const std = resolveAutonomy({ profile: "standard" });
    const stdSet = new Set(std.capabilities);
    expect(max.capabilities.every((c) => stdSet.has(c))).toBe(true);
    expect(typeof max.m1Notice).toBe("string");
    expect(max.m1Notice).toMatch(/M2|M3/);
  });

  it("PROFILE-01-S10: unattended is likewise CLAMPED + carries an m1Notice", () => {
    const un = resolveAutonomy({ profile: "unattended" });
    const std = resolveAutonomy({ profile: "standard" });
    const stdSet = new Set(std.capabilities);
    expect(un.capabilities.every((c) => stdSet.has(c))).toBe(true);
    expect(un.m1Notice).toBeTruthy();
    expect(un.m1Notice).toMatch(/M2|M3/);
  });

  it("PROFILE-01-S11: an explicit field OVERRIDES the profile (progressive disclosure)", () => {
    const r = resolveAutonomy({ profile: "standard", aggregateBudgetUsd: 5 });
    expect(r.aggregateBudgetUsd).toBe(5);
  });

  it("PROFILE-01-S12: an enabled per-surface toggle adds its matching orch:* cap (browse → orch:browse)", () => {
    // `orch:browse` is OFF in every default profile; an explicit toggle opts in.
    const r = resolveAutonomy({ profile: "standard", browse: true });
    expect(r.capabilities).toContain("orch:browse");
  });

  it("PROFILE-01-S13: resolveAutonomy is pure — same input yields a deeply-equal result", () => {
    expect(resolveAutonomy({ profile: "standard" })).toEqual(resolveAutonomy({ profile: "standard" }));
  });
});

// ---------------------------------------------------------------------------
// PROFILE-03 (Phase 210): honest, LEGIBLE degrade. When a host precondition for
// the jail fails — the namespace/`unshare` preflight — the resolved posture must
// downshift to `assistant` (enabled === false, zero caps) AND SAY SO: it returns
// a structured `AutonomyDownshift` signal (downshiftedFrom/To, reason, hint,
// errorKind:"precondition") so the daemon can emit a WARN + a doctor finding.
// There is NEVER a silent unjailed fallback (an enabled-but-unjailed posture).
//
// The downshift is driven by a preflight-RESULT INPUT (a boolean the resolver
// receives), NOT a live bwrap probe — that probe is Phase 211 (JAIL-03). This
// keeps `degradeAutonomy` PURE (AGENTS §2.2): a function of (resolved, preflight)
// only. These cases are RED until `degradeAutonomy` + `AutonomyDownshift` exist.
// ---------------------------------------------------------------------------
describe("degradeAutonomy (PROFILE-03 — honest legible degrade on a failed preflight)", () => {
  it("PROFILE-03-S1: namespacePreflightOk:false downshifts standard → assistant (enabled false, zero caps)", () => {
    const std = resolveAutonomy({ profile: "standard" });
    const { resolved } = degradeAutonomy(std, { namespacePreflightOk: false });
    expect(resolved.profile).toBe("assistant");
    expect(resolved.enabled).toBe(false);
    expect(resolved.capabilities.length).toBe(0);
  });

  it("PROFILE-03-S2: the downshift SURFACES a structured signal (never a silent swap)", () => {
    const std = resolveAutonomy({ profile: "standard" });
    const { downshift } = degradeAutonomy(std, { namespacePreflightOk: false });
    expect(downshift).toBeDefined();
    const signal = downshift as AutonomyDownshift;
    expect(signal.downshiftedFrom).toBe("standard");
    expect(signal.downshiftedTo).toBe("assistant");
    expect(signal.reason).toBe("namespace_preflight_failed");
    expect(signal.errorKind).toBe("precondition");
    // The hint must be actionable (name a remediation), not empty.
    expect(typeof signal.hint).toBe("string");
    expect(signal.hint.length).toBeGreaterThan(0);
  });

  it("PROFILE-03-S3: namespacePreflightOk:true (the 210 default) leaves the resolved profile UNCHANGED + no signal", () => {
    const std = resolveAutonomy({ profile: "standard" });
    const { resolved, downshift } = degradeAutonomy(std, { namespacePreflightOk: true });
    expect(resolved).toEqual(std);
    expect(downshift).toBeUndefined();
  });

  it("PROFILE-03-S4: the downshift NEVER yields an enabled-but-unjailed posture (no silent unjailed fallback)", () => {
    // Even from `max` (the most-privileged selectable profile), a failed
    // preflight must land on the assistant posture — enabled false.
    const max = resolveAutonomy({ profile: "max" });
    const { resolved, downshift } = degradeAutonomy(max, { namespacePreflightOk: false });
    expect(resolved.enabled).toBe(false);
    expect(resolved.capabilities.length).toBe(0);
    expect((downshift as AutonomyDownshift).downshiftedFrom).toBe("max");
  });

  it("PROFILE-03-S5: an already-assistant posture is a no-op downshift (idempotent, no spurious signal)", () => {
    const asst = resolveAutonomy({ profile: "assistant" });
    const { resolved, downshift } = degradeAutonomy(asst, { namespacePreflightOk: false });
    expect(resolved.profile).toBe("assistant");
    expect(resolved.enabled).toBe(false);
    // Already at the floor — nothing was taken away, so no downshift signal.
    expect(downshift).toBeUndefined();
  });

  it("PROFILE-03-S6: the m1Notice rides the resolved result so the boot log can print it (unattended/max)", () => {
    // Re-assert (PROFILE-03 reads this at boot): `max` carries the M2/M3 notice
    // on the resolved posture, which the legible boot log surfaces.
    const max = resolveAutonomy({ profile: "max" });
    expect(max.m1Notice).toBeTruthy();
    expect(max.m1Notice).toMatch(/M2|M3/);
  });
});

// ---------------------------------------------------------------------------
// LEASE-02 (Phase 211): the `autonomy.lease.leaseMaxTtlMin` renewal ceiling. A
// nested `autonomy.lease.{ leaseMaxTtlMin }` sub-block (REQUIREMENTS.md:111 /
// v8 §3.3) — the bounded positive-int (MINUTES) maximum a renewable lease can
// live. The LeaseManager (211-01) clamps each renew to a `maxExpiresAt` derived
// from it, so revoke actually STOPS renewal (no unbounded re-lease). Defaults to
// 60 under every autonomy-bearing profile so `ResolvedAutonomy` stays total.
//
// These cases are RED until the field is threaded through the schema +
// ProfileEntry + STANDARD_GUARDS + the resolver merge: `result.leaseMaxTtlMin`
// is `undefined` (≠ 60) and the field is absent from the resolved type.
// ---------------------------------------------------------------------------
describe("resolveAutonomy (LEASE-02 — autonomy.lease.leaseMaxTtlMin renewal ceiling)", () => {
  it("LEASE-02-S1: zero-config (→ standard) resolves leaseMaxTtlMin to the default 60 (a 1-hour ceiling)", () => {
    const r = resolveAutonomy(undefined);
    expect(r.leaseMaxTtlMin).toBe(60);
  });

  it("LEASE-02-S2: an explicit lease.leaseMaxTtlMin OVERRIDES the profile default (progressive disclosure)", () => {
    const r = resolveAutonomy({ profile: "standard", lease: { leaseMaxTtlMin: 30 } });
    expect(r.leaseMaxTtlMin).toBe(30);
  });

  it("LEASE-02-S3: every profile exposes a numeric leaseMaxTtlMin — the resolved type is TOTAL (assistant included)", () => {
    // assistant mints no lease, but the field is harmless and keeps the resolved
    // posture total (no `number | undefined` at the LeaseManager call site).
    for (const profile of ["assistant", "standard", "unattended", "max"] as const) {
      const r = resolveAutonomy({ profile });
      expect(typeof r.leaseMaxTtlMin, `${profile} must expose a numeric leaseMaxTtlMin`).toBe(
        "number",
      );
      expect(r.leaseMaxTtlMin).toBeGreaterThan(0);
    }
  });
});

describe("AutonomyConfigSchema (LEASE-02 — the nested lease sub-block is positive-int guarded)", () => {
  it("LEASE-02-S4: accepts a positive-int lease.leaseMaxTtlMin", () => {
    expect(AutonomyConfigSchema.safeParse({ lease: { leaseMaxTtlMin: 120 } }).success).toBe(true);
  });

  it("LEASE-02-S5: rejects leaseMaxTtlMin = 0 (must be a positive renewal ceiling)", () => {
    expect(AutonomyConfigSchema.safeParse({ lease: { leaseMaxTtlMin: 0 } }).success).toBe(false);
  });

  it("LEASE-02-S6: rejects a negative leaseMaxTtlMin", () => {
    expect(AutonomyConfigSchema.safeParse({ lease: { leaseMaxTtlMin: -5 } }).success).toBe(false);
  });

  it("LEASE-02-S7: rejects a non-integer leaseMaxTtlMin (minutes are whole)", () => {
    expect(AutonomyConfigSchema.safeParse({ lease: { leaseMaxTtlMin: 1.5 } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUDGET-01/02 + RATE-01 + CEIL-01 + QUOTA-01/02 (Phase 213): the NET-NEW
// nested autonomy sub-blocks the daemon-side BoundedAutonomy service (Plans
// 04/05/06/07) reads. The shipped 210 schema has FLAT $-budget /
// concurrent-spawn / spawn-rate / cron fields + nested message/lease blocks,
// but the TOKEN + WALL-CLOCK budget limbs (BUDGET-01/02), the per-root /
// per-socket / connection-churn RATE limbs (RATE-01), the spawn DEPTH/FANOUT
// shape surfaced into ResolvedAutonomy (CEIL-01), and the outward
// per-target-grant / volume-cap (QUOTA-01/02) do NOT exist yet. Per
// REQUIREMENTS.md §Config surface + the message/lease nested precedent
// (RESEARCH §D — A2), these are NESTED `z.strictObject` sub-blocks with
// safe-floor defaults, the resolver merging the nested + legacy-flat per-field
// (the `cfg?.lease?.leaseMaxTtlMin ?? base.leaseMaxTtlMin` model).
//
// These cases are RED until the four sub-blocks + STANDARD_GUARDS defaults +
// ProfileEntry/ResolvedAutonomy fields + the resolver expansion land: the
// `resolved.budget`/`rate`/`spawn`/`outward` fields are absent from the
// resolved type and `undefined` at runtime.
// ---------------------------------------------------------------------------
describe("resolveAutonomy (BUDGET-01/02 — the nested budget sub-block: $/token/wall-clock limbs)", () => {
  it("BUDGET-01-S1: zero-config (→ standard) resolves all three budget limbs to safe non-zero defaults", () => {
    // BUDGET-01/02 need the token + wall-clock limbs ON TOP of the existing $
    // limb so an unknown-priced ($0) self-spawn loop still trips a bound.
    const r = resolveAutonomy(undefined);
    expect(r.budget.aggregateUsd).toBe(2.0); // mirrors the existing flat standard $ default
    expect(r.budget.tokens).toBeGreaterThan(0);
    expect(r.budget.wallClockMs).toBeGreaterThan(0);
  });

  it("BUDGET-01-S2: an explicit budget.tokens overrides ONLY tokens — the other limbs keep their defaults (per-field merge)", () => {
    const r = resolveAutonomy({ profile: "standard", budget: { tokens: 999 } });
    expect(r.budget.tokens).toBe(999);
    expect(r.budget.aggregateUsd).toBe(2.0);
    expect(r.budget.wallClockMs).toBeGreaterThan(0);
  });

  it("BUDGET-01-S3: the legacy flat aggregateBudgetUsd still feeds budget.aggregateUsd (resolved-output surfacing, not a compat shim)", () => {
    const r = resolveAutonomy({ profile: "standard", aggregateBudgetUsd: 7 });
    expect(r.budget.aggregateUsd).toBe(7);
    // the flat field is also still surfaced for the existing consumers.
    expect(r.aggregateBudgetUsd).toBe(7);
  });
});

describe("resolveAutonomy (RATE-01 — the nested rate sub-block: per-root/per-socket/churn)", () => {
  it("RATE-01-S1: zero-config (→ standard) resolves all three rate limbs to safe non-zero defaults", () => {
    const r = resolveAutonomy(undefined);
    expect(r.rate.perRootCallsPerSec).toBeGreaterThan(0);
    expect(r.rate.perSocketCallsPerSec).toBeGreaterThan(0);
    expect(r.rate.connectionChurnPerMin).toBeGreaterThan(0);
  });

  it("RATE-01-S2: an explicit rate.perRootCallsPerSec overrides ONLY that limb (per-field merge)", () => {
    const r = resolveAutonomy({ profile: "standard", rate: { perRootCallsPerSec: 3 } });
    expect(r.rate.perRootCallsPerSec).toBe(3);
    expect(r.rate.perSocketCallsPerSec).toBeGreaterThan(0);
    expect(r.rate.connectionChurnPerMin).toBeGreaterThan(0);
  });
});

describe("resolveAutonomy (CEIL-01 — the spawn sub-block surfaces depth/fanout into ResolvedAutonomy)", () => {
  it("CEIL-01-S1: zero-config (→ standard) resolves the v8 CEIL-01 spawn shape (concurrent 4 / depth 3 / children 5)", () => {
    const r = resolveAutonomy(undefined);
    expect(r.spawn.maxConcurrentSelfAgents).toBe(4);
    expect(r.spawn.maxSpawnDepth).toBe(3);
    expect(r.spawn.maxChildrenPerAgent).toBe(5);
  });

  it("CEIL-01-S2: the legacy flat maxConcurrentSelfAgents still feeds spawn.maxConcurrentSelfAgents (one resolved source)", () => {
    const r = resolveAutonomy({ profile: "standard", maxConcurrentSelfAgents: 9 });
    expect(r.spawn.maxConcurrentSelfAgents).toBe(9);
    expect(r.maxConcurrentSelfAgents).toBe(9);
  });
});

describe("resolveAutonomy (QUOTA-01/02 — the outward sub-block: origin-only/grants/volume)", () => {
  it("QUOTA-01-S1: zero-config (→ standard) resolves origin-only true, an EMPTY grant list, and a positive volume cap", () => {
    const r = resolveAutonomy(undefined);
    expect(r.outward.originOnly).toBe(true);
    expect(r.outward.perTargetGrants).toEqual([]);
    expect(r.outward.volumeCap).toBeGreaterThan(0);
  });

  it("QUOTA-01-S2: an explicit outward.perTargetGrants overrides the empty default (the §8.4 per-target grant seam)", () => {
    const r = resolveAutonomy({ profile: "standard", outward: { perTargetGrants: ["telegram:c1"] } });
    expect(r.outward.perTargetGrants).toEqual(["telegram:c1"]);
    expect(r.outward.originOnly).toBe(true);
  });
});

describe("AutonomyConfigSchema (BUDGET/RATE/SPAWN/OUTWARD — every new sub-block is strictObject typo-guarded)", () => {
  it("213-S1: strictObject rejects a typo'd budget key (budget.tokenz — fails-closed, not a silent disabled limb)", () => {
    expect(AutonomyConfigSchema.safeParse({ budget: { tokenz: 1 } }).success).toBe(false);
  });

  it("213-S2: strictObject rejects a typo'd rate key (rate.perRootCallsPerSecond)", () => {
    expect(
      AutonomyConfigSchema.safeParse({ rate: { perRootCallsPerSecond: 1 } }).success,
    ).toBe(false);
  });

  it("213-S3: strictObject rejects a typo'd spawn key (spawn.maxSpawnDepthh)", () => {
    expect(AutonomyConfigSchema.safeParse({ spawn: { maxSpawnDepthh: 1 } }).success).toBe(false);
  });

  it("213-S4: strictObject rejects a typo'd outward key (outward.volumeCapp)", () => {
    expect(AutonomyConfigSchema.safeParse({ outward: { volumeCapp: 1 } }).success).toBe(false);
  });

  it("213-S5: rejects a non-positive budget.tokens (must bound, never zero)", () => {
    expect(AutonomyConfigSchema.safeParse({ budget: { tokens: 0 } }).success).toBe(false);
  });

  it("213-S6: rejects a non-positive rate.perSocketCallsPerSec", () => {
    expect(AutonomyConfigSchema.safeParse({ rate: { perSocketCallsPerSec: 0 } }).success).toBe(
      false,
    );
  });

  it("213-S7: accepts a fully-specified budget/rate/spawn/outward config (the explicit-override surface)", () => {
    expect(
      AutonomyConfigSchema.safeParse({
        budget: { aggregateUsd: 1, tokens: 100, wallClockMs: 1000 },
        rate: { perRootCallsPerSec: 5, perSocketCallsPerSec: 5, connectionChurnPerMin: 10 },
        spawn: { maxConcurrentSelfAgents: 2, maxSpawnDepth: 2, maxChildrenPerAgent: 2 },
        outward: { originOnly: false, perTargetGrants: ["x"], volumeCap: 10 },
      }).success,
    ).toBe(true);
  });
});

describe("resolveAutonomy (213 — every profile surfaces a TOTAL resolved budget/rate/spawn/outward)", () => {
  it("213-S8: each of the four profiles resolves total (non-undefined) budget/rate/spawn/outward limbs", () => {
    for (const profile of ["assistant", "standard", "unattended", "max"] as const) {
      const r = resolveAutonomy({ profile });
      expect(typeof r.budget.tokens, `${profile} budget.tokens`).toBe("number");
      expect(typeof r.budget.wallClockMs, `${profile} budget.wallClockMs`).toBe("number");
      expect(typeof r.rate.perRootCallsPerSec, `${profile} rate.perRootCallsPerSec`).toBe("number");
      expect(typeof r.spawn.maxSpawnDepth, `${profile} spawn.maxSpawnDepth`).toBe("number");
      expect(typeof r.outward.volumeCap, `${profile} outward.volumeCap`).toBe("number");
      expect(r.outward.originOnly, `${profile} outward.originOnly`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 216 (DUR-01..04 / HB-01): the durability sub-block. Default-off — a
// fully-omitted autonomy block (and a fully-omitted durability block) resolves
// durability.enabled === false, so the daemon constructs no durable stores /
// boot recovery / watchdog (byte-identical default install). strictObject is the
// typo guard; each ms limb is a positive int (never fails-open at zero).
// ---------------------------------------------------------------------------
describe("AutonomyConfigSchema (216 — durability sub-block defaults off)", () => {
  it("216-S1: a fully-omitted autonomy block resolves durability.enabled = false", () => {
    const parsed = AutonomyConfigSchema.parse({});
    expect(parsed.durability.enabled).toBe(false);
  });

  it("216-S2: an omitted durability block fills the conservative-ratio defaults (stale = 4x keepAlive)", () => {
    const parsed = AutonomyConfigSchema.parse({});
    expect(parsed.durability.keepAliveMs).toBe(30_000);
    expect(parsed.durability.staleHeartbeatMs).toBe(120_000);
    expect(parsed.durability.recoveryBudgetMs).toBe(30_000);
    // The Pitfall-4 conservative ratio: the stale threshold is 4x the keep-alive.
    expect(parsed.durability.staleHeartbeatMs).toBe(parsed.durability.keepAliveMs * 4);
  });

  it("216-S3: an explicit enabled:true is honored", () => {
    const parsed = AutonomyConfigSchema.parse({ durability: { enabled: true } });
    expect(parsed.durability.enabled).toBe(true);
  });

  it("216-S4: strictObject rejects an unknown durability key (typo guard)", () => {
    expect(AutonomyConfigSchema.safeParse({ durability: { enabld: true } }).success).toBe(false);
  });

  it("216-S5: each ms limb is a positive int (a zero/negative/float fails closed)", () => {
    expect(AutonomyConfigSchema.safeParse({ durability: { keepAliveMs: 0 } }).success).toBe(false);
    expect(AutonomyConfigSchema.safeParse({ durability: { staleHeartbeatMs: -1 } }).success).toBe(false);
    expect(AutonomyConfigSchema.safeParse({ durability: { recoveryBudgetMs: 1.5 } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 217 (BREAK-01 / EVICT-02 / UNATT-01): the two FLAT never-hang config
// scalars the denial breaker + the evict fail-closed path read. Per v8 §22.6
// (line 720-721) these are flat siblings of `mode`/`cronSelfMax` (RESEARCH A1 —
// KISS, no sub-block for two scalars), threaded through the same five-touch
// pattern every scalar follows (schema field + ProfileEntry + STANDARD_GUARDS +
// ResolvedAutonomy + the resolveAutonomy fold). They MUST default-safe so a
// default install is byte-identical: the breaker is inert until a deny happens
// (`denialBreakerN: 5`), and `evictOnPolicyUnreachable: true` IS the already-safe
// fail-closed behavior.
//
// These cases are RED until the five touches land: the fields are absent from
// the resolved type and `undefined` at runtime, and the schema rejects/accepts
// nothing for them yet.
// ---------------------------------------------------------------------------
describe("AutonomyConfigSchema (217 — denialBreakerN + evictOnPolicyUnreachable defaults + validation)", () => {
  it("BREAK-01-S1: parse({}) resolves denialBreakerN to the default 5 and evictOnPolicyUnreachable to default true", () => {
    const parsed = AutonomyConfigSchema.parse({});
    expect(parsed.denialBreakerN).toBe(5);
    expect(parsed.evictOnPolicyUnreachable).toBe(true);
  });

  it("BREAK-01-S2: round-trips an explicit denialBreakerN + evictOnPolicyUnreachable override", () => {
    const parsed = AutonomyConfigSchema.parse({ denialBreakerN: 3, evictOnPolicyUnreachable: false });
    expect(parsed.denialBreakerN).toBe(3);
    expect(parsed.evictOnPolicyUnreachable).toBe(false);
  });

  it("BREAK-01-S3: rejects denialBreakerN = 0 (T-217-01 — a 0 would disable the breaker; must fail closed)", () => {
    expect(AutonomyConfigSchema.safeParse({ denialBreakerN: 0 }).success).toBe(false);
  });

  it("BREAK-01-S4: rejects a negative denialBreakerN (must be a positive consecutive-block count)", () => {
    expect(AutonomyConfigSchema.safeParse({ denialBreakerN: -2 }).success).toBe(false);
  });

  it("BREAK-01-S5: rejects a non-integer denialBreakerN (consecutive blocks are whole)", () => {
    expect(AutonomyConfigSchema.safeParse({ denialBreakerN: 2.5 }).success).toBe(false);
  });
});

describe("resolveAutonomy (217 — both scalars surface on every resolved profile, default-safe)", () => {
  it("BREAK-01-S6: zero-config (→ standard) exposes denialBreakerN 5 + evictOnPolicyUnreachable true on the resolved posture", () => {
    const r = resolveAutonomy(undefined);
    expect(r.denialBreakerN).toBe(5);
    expect(r.evictOnPolicyUnreachable).toBe(true);
  });

  it("UNATT-01-S1: the unattended profile exposes both scalars AND still resolves mode 'unattended' (the activation signal is intact, not clamped away)", () => {
    const un = resolveAutonomy({ profile: "unattended" });
    expect(un.denialBreakerN).toBe(5);
    expect(un.evictOnPolicyUnreachable).toBe(true);
    expect(un.mode).toBe("unattended");
  });

  it("BREAK-01-S7: every profile surfaces a numeric denialBreakerN + boolean evictOnPolicyUnreachable — the resolved type is TOTAL", () => {
    for (const profile of ["assistant", "standard", "unattended", "max"] as const) {
      const r = resolveAutonomy({ profile });
      expect(typeof r.denialBreakerN, `${profile} denialBreakerN`).toBe("number");
      expect(r.denialBreakerN).toBeGreaterThan(0);
      expect(typeof r.evictOnPolicyUnreachable, `${profile} evictOnPolicyUnreachable`).toBe(
        "boolean",
      );
    }
  });

  it("BREAK-01-S8: an explicit denialBreakerN OVERRIDES the profile default (progressive disclosure)", () => {
    const r = resolveAutonomy({ profile: "standard", denialBreakerN: 9 });
    expect(r.denialBreakerN).toBe(9);
  });

  it("EVICT-02-S1: an explicit evictOnPolicyUnreachable:false is HONORED (the fold uses ?? not ||, so false is not coerced to the default true)", () => {
    const r = resolveAutonomy({ profile: "standard", evictOnPolicyUnreachable: false });
    expect(r.evictOnPolicyUnreachable).toBe(false);
  });
});
