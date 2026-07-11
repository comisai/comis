// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  AutonomyConfigSchema,
  AUTONOMY_PROFILES,
  resolveAutonomy,
} from "./schema-agent-autonomy.js";
// resolveEffectiveMode lives in the mode leaf (file-size split); the barrel
// re-exports it, so @comis/core consumers reach it unchanged.
import { resolveEffectiveMode } from "./schema-agent-autonomy-mode.js";
// The honest-degrade path lives in its own leaf (file-size split).
import { degradeAutonomy, type AutonomyDownshift } from "./schema-agent-autonomy-degrade.js";
// Layer-2 per-server allowlist predicate — the operative default-deny gate.
import { permitsMcpTool } from "./schema-agent-autonomy-mcp.js";

// ---------------------------------------------------------------------------
// The named-profile resolver. An
// `AutonomyConfigSchema` Zod leaf whose `.default()` produces `standard` (the
// zero-config great-out-of-box default), plus a
// PURE `resolveAutonomy()` that expands `profile:` into the full
// cap/guard block (an explicit field OVERRIDES the profile — progressive
// disclosure). `unattended`/`max` keep `standard`'s cap set (no
// silent over-grant); `max` carries a clamp notice disclosing its
// not-yet-available surface, while `unattended`'s notice says its never-hang
// MODE behaviors are ACTIVE.
//
// The resolver is a pure function of its config input (no env/clock/fs —
// AGENTS §2.2).
// ---------------------------------------------------------------------------

// The ten FLOOR-CONTAINED orchestration caps `standard` turns on.
// `orch:message` IS a member: the
// standard profile turns ON origin-channel messaging. The ORIGIN-vs-new scoping
// rides `message.channels` (`["origin"]` default); origin sends are
// auto-allowable under quota, a NEW channel is an `autoApprovable:false` floor
// item — so the cap-literal is floor-contained + autoApprovable.
// `orch:mcp` IS a member (floor-granted like orch:write): the CAP is held by
// default, but the OPERATIVE default-deny is the per-server allowlist
// (`autonomy.mcp.allow`, default {} ⇒ permitsMcpTool denies by absence), exactly
// mirroring orch:write's floor-cap + writeSurfaceEnabled opt-in. So granting the
// cap opens NO MCP server until the operator allowlists one.
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
  "orch:mcp",
] as const;

describe("AutonomyConfigSchema (zero-config default → standard)", () => {
  it("parse({}) resolves profile 'standard' (the zero-config default)", () => {
    const parsed = AutonomyConfigSchema.parse({});
    expect(parsed.profile).toBe("standard");
  });

  it("strictObject rejects an unknown key (typo guard)", () => {
    expect(AutonomyConfigSchema.safeParse({ profil: "standard" }).success).toBe(false);
  });

  it("accepts each of the four profile names and rejects an unknown one", () => {
    for (const p of ["assistant", "standard", "unattended", "max"] as const) {
      expect(AutonomyConfigSchema.safeParse({ profile: p }).success).toBe(true);
    }
    expect(AutonomyConfigSchema.safeParse({ profile: "nope" }).success).toBe(false);
  });
});

describe("AUTONOMY_PROFILES (the resolved cap/guard sets)", () => {
  it("exposes all four named profiles", () => {
    expect(Object.keys(AUTONOMY_PROFILES).sort()).toEqual(
      ["assistant", "max", "standard", "unattended"].sort(),
    );
  });
});

describe("resolveAutonomy (pure profile → cap/guard block)", () => {
  it("resolveAutonomy(undefined) → standard, caps include orch:spawn/orch:graph/orch:cron/orch:message", () => {
    const r = resolveAutonomy(undefined);
    expect(r.profile).toBe("standard");
    expect(r.enabled).toBe(true);
    expect(r.capabilities).toEqual(
      expect.arrayContaining(["orch:spawn", "orch:graph", "orch:cron", "orch:message"]),
    );
  });

  it("standard resolves to exactly the ten floor-contained caps (incl. origin orch:message + orch:mcp)", () => {
    const r = resolveAutonomy({ profile: "standard" });
    expect([...r.capabilities].sort()).toEqual([...STANDARD_FLOOR_CAPS].sort());
  });

  it("standard's orch:message is autoApprovable:true (origin-channel auto-send), NOT an always-escalate floor cap", () => {
    // The cap-literal is auto-allowable to the OWN origin channel under quota;
    // the non-origin TARGET escalates via the message
    // config, NOT by marking the cap autoApprovable:false. orch:browse stays the
    // only always-escalate cap-literal.
    const r = resolveAutonomy({ profile: "standard" });
    const msg = r.resolvedCapabilities.find((c) => c.capability === "orch:message");
    expect(msg, "standard must resolve an orch:message cap").toBeDefined();
    expect(msg!.autoApprovable).toBe(true);
  });

  it("a per-surface toggle OVERRIDES enabled — { profile: assistant, web: true } resolves enabled:false but STILL grants orch:web", () => {
    // The toggle IS the enable signal for that surface:
    // enabled:false does NOT zero an explicitly-toggled surface (progressive
    // disclosure). The structural floor still bounds the granted cap.
    const r = resolveAutonomy({ profile: "assistant", web: true });
    expect(r.enabled).toBe(false);
    expect(r.capabilities).toContain("orch:web");
  });

  it("assistant → enabled false, zero orchestration surfaces", () => {
    const r = resolveAutonomy({ profile: "assistant" });
    expect(r.enabled).toBe(false);
    expect(r.capabilities.length).toBe(0);
  });

  it("standard ships guards ON (budget/rate/ceiling > 0)", () => {
    const r = resolveAutonomy({ profile: "standard" });
    expect(r.aggregateBudgetUsd).toBeGreaterThan(0);
    expect(r.maxConcurrentSelfAgents).toBeGreaterThan(0);
    expect(r.maxSelfSpawnRatePerMin).toBeGreaterThan(0);
  });

  it("standard.message.channels is origin-only", () => {
    const r = resolveAutonomy({ profile: "standard" });
    expect(r.message.channels).toEqual(["origin"]);
  });

  it("max is CLAMPED to a subset of standard's caps and its m1Notice discloses the not-yet-available surface", () => {
    const max = resolveAutonomy({ profile: "max" });
    const std = resolveAutonomy({ profile: "standard" });
    const stdSet = new Set(std.capabilities);
    expect(max.capabilities.every((c) => stdSet.has(c))).toBe(true);
    expect(typeof max.m1Notice).toBe("string");
    expect(max.m1Notice).toMatch(/not yet available/i);
  });

  it("unattended keeps a standard-equivalent cap set and its notice says the never-hang behaviors are ACTIVE, not deferred", () => {
    const un = resolveAutonomy({ profile: "unattended" });
    const std = resolveAutonomy({ profile: "standard" });
    const stdSet = new Set(std.capabilities);
    // The cap set stays standard-equivalent (no over-grant — that is unchanged).
    expect(un.capabilities.every((c) => stdSet.has(c))).toBe(true);
    expect(un.m1Notice).toBeTruthy();
    // The notice describes the ACTIVE never-hang behaviors, NOT a deferral —
    // it must not read as a not-yet-available surface.
    expect(un.m1Notice).not.toMatch(/not yet available/i);
    expect(un.m1Notice).toMatch(/active/i);
    expect(un.m1Notice).toMatch(/escalate/i);
  });

  it("an explicit field OVERRIDES the profile (progressive disclosure)", () => {
    const r = resolveAutonomy({ profile: "standard", aggregateBudgetUsd: 5 });
    expect(r.aggregateBudgetUsd).toBe(5);
  });

  it("an enabled per-surface toggle adds its matching orch:* cap (browse → orch:browse)", () => {
    // `orch:browse` is OFF in every default profile; an explicit toggle opts in.
    const r = resolveAutonomy({ profile: "standard", browse: true });
    expect(r.capabilities).toContain("orch:browse");
  });

  it("resolveAutonomy is pure — same input yields a deeply-equal result", () => {
    expect(resolveAutonomy({ profile: "standard" })).toEqual(resolveAutonomy({ profile: "standard" }));
  });
});

// ---------------------------------------------------------------------------
// Honest, LEGIBLE degrade. When a host precondition for
// the jail fails — the namespace/`unshare` preflight — the resolved posture must
// downshift to `assistant` (enabled === false, zero caps) AND SAY SO: it returns
// a structured `AutonomyDownshift` signal (downshiftedFrom/To, reason, hint,
// errorKind:"precondition") so the daemon can emit a WARN + a doctor finding.
// There is NEVER a silent unjailed fallback (an enabled-but-unjailed posture).
//
// The downshift is driven by a preflight-RESULT INPUT (a boolean the resolver
// receives), NOT a live bwrap probe — probing is the caller's job. This
// keeps `degradeAutonomy` PURE (AGENTS §2.2): a function of (resolved, preflight)
// only.
// ---------------------------------------------------------------------------
describe("degradeAutonomy (honest legible degrade on a failed preflight)", () => {
  it("namespacePreflightOk:false downshifts standard → assistant (enabled false, zero caps)", () => {
    const std = resolveAutonomy({ profile: "standard" });
    const { resolved } = degradeAutonomy(std, { namespacePreflightOk: false });
    expect(resolved.profile).toBe("assistant");
    expect(resolved.enabled).toBe(false);
    expect(resolved.capabilities.length).toBe(0);
  });

  it("the downshift SURFACES a structured signal (never a silent swap)", () => {
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

  it("namespacePreflightOk:true (the default) leaves the resolved profile UNCHANGED + no signal", () => {
    const std = resolveAutonomy({ profile: "standard" });
    const { resolved, downshift } = degradeAutonomy(std, { namespacePreflightOk: true });
    expect(resolved).toEqual(std);
    expect(downshift).toBeUndefined();
  });

  it("the downshift NEVER yields an enabled-but-unjailed posture (no silent unjailed fallback)", () => {
    // Even from `max` (the most-privileged selectable profile), a failed
    // preflight must land on the assistant posture — enabled false.
    const max = resolveAutonomy({ profile: "max" });
    const { resolved, downshift } = degradeAutonomy(max, { namespacePreflightOk: false });
    expect(resolved.enabled).toBe(false);
    expect(resolved.capabilities.length).toBe(0);
    expect((downshift as AutonomyDownshift).downshiftedFrom).toBe("max");
  });

  it("an already-assistant posture is a no-op downshift (idempotent, no spurious signal)", () => {
    const asst = resolveAutonomy({ profile: "assistant" });
    const { resolved, downshift } = degradeAutonomy(asst, { namespacePreflightOk: false });
    expect(resolved.profile).toBe("assistant");
    expect(resolved.enabled).toBe(false);
    // Already at the floor — nothing was taken away, so no downshift signal.
    expect(downshift).toBeUndefined();
  });

  it("the m1Notice rides the resolved result so the boot log can print it (unattended/max)", () => {
    // Re-assert (the boot-log builder reads this): `max` carries the clamp
    // notice on the resolved posture, which the legible boot log surfaces.
    const max = resolveAutonomy({ profile: "max" });
    expect(max.m1Notice).toBeTruthy();
    expect(max.m1Notice).toMatch(/not yet available/i);
  });
});

// ---------------------------------------------------------------------------
// The `autonomy.lease.leaseMaxTtlMin` renewal ceiling. A
// nested `autonomy.lease.{ leaseMaxTtlMin }` sub-block
// — the bounded positive-int (MINUTES) maximum a renewable lease can
// live. The LeaseManager clamps each renew to a `maxExpiresAt` derived
// from it, so revoke actually STOPS renewal (no unbounded re-lease). Defaults to
// 60 under every autonomy-bearing profile so `ResolvedAutonomy` stays total.
// ---------------------------------------------------------------------------
describe("resolveAutonomy (autonomy.lease.leaseMaxTtlMin renewal ceiling)", () => {
  it("zero-config (→ standard) resolves leaseMaxTtlMin to the default 60 (a 1-hour ceiling)", () => {
    const r = resolveAutonomy(undefined);
    expect(r.leaseMaxTtlMin).toBe(60);
  });

  it("an explicit lease.leaseMaxTtlMin OVERRIDES the profile default (progressive disclosure)", () => {
    const r = resolveAutonomy({ profile: "standard", lease: { leaseMaxTtlMin: 30 } });
    expect(r.leaseMaxTtlMin).toBe(30);
  });

  it("every profile exposes a numeric leaseMaxTtlMin — the resolved type is TOTAL (assistant included)", () => {
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

describe("AutonomyConfigSchema (the nested lease sub-block is positive-int guarded)", () => {
  it("accepts a positive-int lease.leaseMaxTtlMin", () => {
    expect(AutonomyConfigSchema.safeParse({ lease: { leaseMaxTtlMin: 120 } }).success).toBe(true);
  });

  it("rejects leaseMaxTtlMin = 0 (must be a positive renewal ceiling)", () => {
    expect(AutonomyConfigSchema.safeParse({ lease: { leaseMaxTtlMin: 0 } }).success).toBe(false);
  });

  it("rejects a negative leaseMaxTtlMin value", () => {
    expect(AutonomyConfigSchema.safeParse({ lease: { leaseMaxTtlMin: -5 } }).success).toBe(false);
  });

  it("rejects a non-integer leaseMaxTtlMin (minutes are whole)", () => {
    expect(AutonomyConfigSchema.safeParse({ lease: { leaseMaxTtlMin: 1.5 } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The nested autonomy BOUNDS sub-blocks the daemon-side BoundedAutonomy
// service reads: the schema has FLAT $-budget /
// concurrent-spawn / spawn-rate / cron fields + nested message/lease blocks,
// plus the TOKEN + WALL-CLOCK budget limbs, the per-root /
// per-socket / connection-churn RATE limbs, the spawn DEPTH/FANOUT
// shape surfaced into ResolvedAutonomy, and the outward
// per-target-grant / volume-cap. Following the
// message/lease nested precedent,
// these are NESTED `z.strictObject` sub-blocks with
// safe-floor defaults, the resolver merging the nested + flat aliases per-field
// (the `cfg?.lease?.leaseMaxTtlMin ?? base.leaseMaxTtlMin` model).
// ---------------------------------------------------------------------------
describe("resolveAutonomy (the nested budget sub-block: $/token/wall-clock limbs)", () => {
  it("zero-config (→ standard) resolves all three budget limbs to safe non-zero defaults", () => {
    // The token + wall-clock limbs sit ON TOP of the $
    // limb so an unknown-priced ($0) self-spawn loop still trips a bound.
    const r = resolveAutonomy(undefined);
    // Operator-friendly defaults: a runaway BACKSTOP (a self-spawning storm
    // still trips), NOT a normal-use limit — a single legit multi-step task
    // must run to completion well within them.
    expect(r.budget.aggregateUsd).toBe(200); // priced $ ceiling per spawn tree
    expect(r.budget.tokens).toBe(200_000_000); // token ceiling (bites on $0 subscription models)
    expect(r.budget.wallClockMs).toBe(172_800_000); // 48 h wall-clock backstop
  });

  it("an explicit budget.tokens overrides ONLY tokens — the other limbs keep their defaults (per-field merge)", () => {
    const r = resolveAutonomy({ profile: "standard", budget: { tokens: 999 } });
    expect(r.budget.tokens).toBe(999);
    expect(r.budget.aggregateUsd).toBe(200); // the other limbs keep the standard default
    expect(r.budget.wallClockMs).toBe(172_800_000);
  });

  it("the flat aggregateBudgetUsd alias still feeds budget.aggregateUsd (one resolved source, not a compat shim)", () => {
    const r = resolveAutonomy({ profile: "standard", aggregateBudgetUsd: 7 });
    expect(r.budget.aggregateUsd).toBe(7);
    // the flat field is also still surfaced for the existing consumers.
    expect(r.aggregateBudgetUsd).toBe(7);
  });
});

describe("resolveAutonomy (the nested rate sub-block: per-root/per-socket/churn)", () => {
  it("zero-config (→ standard) resolves all three rate limbs to safe non-zero defaults", () => {
    const r = resolveAutonomy(undefined);
    expect(r.rate.perRootCallsPerSec).toBeGreaterThan(0);
    expect(r.rate.perSocketCallsPerSec).toBeGreaterThan(0);
    expect(r.rate.connectionChurnPerMin).toBeGreaterThan(0);
  });

  it("an explicit rate.perRootCallsPerSec overrides ONLY that limb (per-field merge)", () => {
    const r = resolveAutonomy({ profile: "standard", rate: { perRootCallsPerSec: 3 } });
    expect(r.rate.perRootCallsPerSec).toBe(3);
    expect(r.rate.perSocketCallsPerSec).toBeGreaterThan(0);
    expect(r.rate.connectionChurnPerMin).toBeGreaterThan(0);
  });
});

describe("resolveAutonomy (the spawn sub-block surfaces depth/fanout into ResolvedAutonomy)", () => {
  it("zero-config (→ standard) resolves the default spawn shape (concurrent 4 / depth 3 / children 5)", () => {
    const r = resolveAutonomy(undefined);
    expect(r.spawn.maxConcurrentSelfAgents).toBe(4);
    expect(r.spawn.maxSpawnDepth).toBe(3);
    expect(r.spawn.maxChildrenPerAgent).toBe(5);
  });

  it("the flat maxConcurrentSelfAgents alias still feeds spawn.maxConcurrentSelfAgents (one resolved source)", () => {
    const r = resolveAutonomy({ profile: "standard", maxConcurrentSelfAgents: 9 });
    expect(r.spawn.maxConcurrentSelfAgents).toBe(9);
    expect(r.maxConcurrentSelfAgents).toBe(9);
  });
});

describe("resolveAutonomy (the outward sub-block: origin-only/grants/volume)", () => {
  it("zero-config (→ standard) resolves origin-only true, an EMPTY grant list, and a positive volume cap", () => {
    const r = resolveAutonomy(undefined);
    expect(r.outward.originOnly).toBe(true);
    expect(r.outward.perTargetGrants).toEqual([]);
    expect(r.outward.volumeCap).toBeGreaterThan(0);
  });

  it("an explicit outward.perTargetGrants overrides the empty default (the per-target grant seam)", () => {
    const r = resolveAutonomy({ profile: "standard", outward: { perTargetGrants: ["telegram:c1"] } });
    expect(r.outward.perTargetGrants).toEqual(["telegram:c1"]);
    expect(r.outward.originOnly).toBe(true);
  });
});

describe("AutonomyConfigSchema (BUDGET/RATE/SPAWN/OUTWARD — every new sub-block is strictObject typo-guarded)", () => {
  it("strictObject rejects a typo'd budget key (budget.tokenz — fails-closed, not a silent disabled limb)", () => {
    expect(AutonomyConfigSchema.safeParse({ budget: { tokenz: 1 } }).success).toBe(false);
  });

  it("strictObject rejects a typo'd rate key (rate.perRootCallsPerSecond)", () => {
    expect(
      AutonomyConfigSchema.safeParse({ rate: { perRootCallsPerSecond: 1 } }).success,
    ).toBe(false);
  });

  it("strictObject rejects a typo'd spawn key (spawn.maxSpawnDepthh)", () => {
    expect(AutonomyConfigSchema.safeParse({ spawn: { maxSpawnDepthh: 1 } }).success).toBe(false);
  });

  it("strictObject rejects a typo'd outward key (outward.volumeCapp)", () => {
    expect(AutonomyConfigSchema.safeParse({ outward: { volumeCapp: 1 } }).success).toBe(false);
  });

  it("rejects a non-positive budget.tokens (must bound, never zero)", () => {
    expect(AutonomyConfigSchema.safeParse({ budget: { tokens: 0 } }).success).toBe(false);
  });

  it("rejects a non-positive rate.perSocketCallsPerSec value", () => {
    expect(AutonomyConfigSchema.safeParse({ rate: { perSocketCallsPerSec: 0 } }).success).toBe(
      false,
    );
  });

  it("accepts a fully-specified budget/rate/spawn/outward config (the explicit-override surface)", () => {
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

describe("resolveAutonomy (every profile surfaces a TOTAL resolved budget/rate/spawn/outward)", () => {
  it("each of the four profiles resolves total (non-undefined) budget/rate/spawn/outward limbs", () => {
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
// The durability sub-block. Default-ON (full capability out of the box) — a
// fully-omitted autonomy block (and a fully-omitted durability block) resolves
// durability.enabled === true, so the daemon constructs durable stores + boot
// recovery + watchdog by default (an operator sets false to opt out). strictObject
// is the typo guard; each ms limb is a positive int (never fails-open at zero).
// ---------------------------------------------------------------------------
describe("AutonomyConfigSchema (durability sub-block defaults on)", () => {
  it("a fully-omitted autonomy block resolves durability.enabled = true", () => {
    const parsed = AutonomyConfigSchema.parse({});
    expect(parsed.durability.enabled).toBe(true);
  });

  it("an omitted durability block fills the conservative-ratio defaults (stale = 4x keepAlive)", () => {
    const parsed = AutonomyConfigSchema.parse({});
    expect(parsed.durability.keepAliveMs).toBe(30_000);
    expect(parsed.durability.staleHeartbeatMs).toBe(120_000);
    expect(parsed.durability.recoveryBudgetMs).toBe(30_000);
    // The conservative ratio: the stale threshold is 4x the keep-alive.
    expect(parsed.durability.staleHeartbeatMs).toBe(parsed.durability.keepAliveMs * 4);
  });

  it("an explicit durability.enabled:true is honored", () => {
    const parsed = AutonomyConfigSchema.parse({ durability: { enabled: true } });
    expect(parsed.durability.enabled).toBe(true);
  });

  it("strictObject rejects an unknown durability key (typo guard)", () => {
    expect(AutonomyConfigSchema.safeParse({ durability: { enabld: true } }).success).toBe(false);
  });

  it("each ms limb is a positive int (a zero/negative/float fails closed)", () => {
    expect(AutonomyConfigSchema.safeParse({ durability: { keepAliveMs: 0 } }).success).toBe(false);
    expect(AutonomyConfigSchema.safeParse({ durability: { staleHeartbeatMs: -1 } }).success).toBe(false);
    expect(AutonomyConfigSchema.safeParse({ durability: { recoveryBudgetMs: 1.5 } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The two FLAT never-hang config scalars the denial breaker + the evict
// fail-closed path read. These are flat siblings of `mode`/`cronSelfMax`
// (KISS — no sub-block for two scalars), threaded through the same five-touch
// pattern every scalar follows (schema field + ProfileEntry + STANDARD_GUARDS +
// ResolvedAutonomy + the resolveAutonomy fold). They MUST default-safe so a
// default install is byte-identical: the breaker is inert until a deny happens
// (`denialBreakerN: 5`), and `evictOnPolicyUnreachable: true` IS the already-safe
// fail-closed behavior.
// ---------------------------------------------------------------------------
describe("AutonomyConfigSchema (denialBreakerN + evictOnPolicyUnreachable defaults + validation)", () => {
  it("parse({}) resolves denialBreakerN to the default 5 and evictOnPolicyUnreachable to default true", () => {
    const parsed = AutonomyConfigSchema.parse({});
    expect(parsed.denialBreakerN).toBe(5);
    expect(parsed.evictOnPolicyUnreachable).toBe(true);
  });

  it("round-trips an explicit denialBreakerN + evictOnPolicyUnreachable override", () => {
    const parsed = AutonomyConfigSchema.parse({ denialBreakerN: 3, evictOnPolicyUnreachable: false });
    expect(parsed.denialBreakerN).toBe(3);
    expect(parsed.evictOnPolicyUnreachable).toBe(false);
  });

  it("rejects denialBreakerN = 0 (a 0 would disable the breaker; must fail closed)", () => {
    expect(AutonomyConfigSchema.safeParse({ denialBreakerN: 0 }).success).toBe(false);
  });

  it("rejects a negative denialBreakerN (must be a positive consecutive-block count)", () => {
    expect(AutonomyConfigSchema.safeParse({ denialBreakerN: -2 }).success).toBe(false);
  });

  it("rejects a non-integer denialBreakerN (consecutive blocks are whole)", () => {
    expect(AutonomyConfigSchema.safeParse({ denialBreakerN: 2.5 }).success).toBe(false);
  });
});

describe("resolveAutonomy (both scalars surface on every resolved profile, default-safe)", () => {
  it("zero-config (→ standard) exposes denialBreakerN 5 + evictOnPolicyUnreachable true on the resolved posture", () => {
    const r = resolveAutonomy(undefined);
    expect(r.denialBreakerN).toBe(5);
    expect(r.evictOnPolicyUnreachable).toBe(true);
  });

  it("the unattended profile exposes both scalars AND still resolves mode 'unattended' (the activation signal is intact, not clamped away)", () => {
    const un = resolveAutonomy({ profile: "unattended" });
    expect(un.denialBreakerN).toBe(5);
    expect(un.evictOnPolicyUnreachable).toBe(true);
    expect(un.mode).toBe("unattended");
  });

  it("every profile surfaces a numeric denialBreakerN + boolean evictOnPolicyUnreachable — the resolved type is TOTAL", () => {
    for (const profile of ["assistant", "standard", "unattended", "max"] as const) {
      const r = resolveAutonomy({ profile });
      expect(typeof r.denialBreakerN, `${profile} denialBreakerN`).toBe("number");
      expect(r.denialBreakerN).toBeGreaterThan(0);
      expect(typeof r.evictOnPolicyUnreachable, `${profile} evictOnPolicyUnreachable`).toBe(
        "boolean",
      );
    }
  });

  it("an explicit denialBreakerN OVERRIDES the profile default (progressive disclosure)", () => {
    const r = resolveAutonomy({ profile: "standard", denialBreakerN: 9 });
    expect(r.denialBreakerN).toBe(9);
  });

  it("an explicit evictOnPolicyUnreachable:false is HONORED (the fold uses ?? not ||, so false is not coerced to the default true)", () => {
    const r = resolveAutonomy({ profile: "standard", evictOnPolicyUnreachable: false });
    expect(r.evictOnPolicyUnreachable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The PURE `resolveEffectiveMode` fail-closed primitive.
// Given a (possibly absent/forged/unparseable) mode value — the chokepoint's
// injected `_autonomyMode`, or a future external policy read — return the SAFE
// mode. A recognized AutonomyMode passes through; ANYTHING else (undefined, a
// non-string, an unknown string) collapses to "default", NEVER to a broader
// profile (an elevation-of-privilege guard). This is the single fail-closed
// point where the "unreachable policy source -> default" contract is tested.
// PURE (no env/clock/fs).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// The lean-coordinator `autonomy.role` posture. A
// `role: z.enum(["worker","coordinator"]).default("worker")` field on
// AutonomyConfigSchema that `resolveAutonomy` expands into a
// `coordinatorToolGroups` allowlist (`["coordinator"]` when role:coordinator,
// undefined for worker). `role` NARROWS the resolved TOOL SURFACE only — it
// NEVER changes the resolved capability set (the over-grant guard: the
// resolved `capabilities[]` must be IDENTICAL with and without `role` for the
// same profile). Default `worker` ⇒ byte-identical to a config with no role.
// ---------------------------------------------------------------------------
describe("AutonomyConfigSchema (the role field is a closed worker|coordinator enum)", () => {
  it("parse({}) resolves role to the default 'worker' (zero-config byte-identical default)", () => {
    const parsed = AutonomyConfigSchema.parse({});
    expect(parsed.role).toBe("worker");
  });

  it("round-trips an explicit role:coordinator override", () => {
    expect(AutonomyConfigSchema.parse({ role: "coordinator" }).role).toBe("coordinator");
  });

  it("rejects a bogus role (closed enum, strictObject typo guard)", () => {
    expect(AutonomyConfigSchema.safeParse({ role: "bogus" }).success).toBe(false);
  });
});

describe("resolveAutonomy (role expands into coordinatorToolGroups; narrows-only)", () => {
  it("role:coordinator resolves role 'coordinator' + a non-empty coordinatorToolGroups containing 'coordinator'", () => {
    const r = resolveAutonomy({ profile: "unattended", role: "coordinator" });
    expect(r.role).toBe("coordinator");
    expect(Array.isArray(r.coordinatorToolGroups)).toBe(true);
    expect(r.coordinatorToolGroups!.length).toBeGreaterThan(0);
    expect(r.coordinatorToolGroups).toContain("coordinator");
  });

  it("role:worker (default) resolves role 'worker' + NO coordinatorToolGroups (no narrowing)", () => {
    const r = resolveAutonomy({ profile: "standard" });
    expect(r.role).toBe("worker");
    expect(r.coordinatorToolGroups).toBeUndefined();
  });

  it("zero-config (resolveAutonomy(undefined)) defaults role to 'worker'", () => {
    expect(resolveAutonomy(undefined).role).toBe("worker");
    expect(resolveAutonomy({}).role).toBe("worker");
  });

  it("role NARROWS the surface, NEVER the caps — the resolved capabilities are IDENTICAL with and without role (the over-grant guard)", () => {
    const withoutRole = resolveAutonomy({ profile: "unattended" });
    const withRole = resolveAutonomy({ profile: "unattended", role: "coordinator" });
    expect([...withRole.capabilities].sort()).toEqual([...withoutRole.capabilities].sort());
    // The autoApprovable bits must be unchanged too — role touches no cap.
    expect(withRole.resolvedCapabilities).toEqual(withoutRole.resolvedCapabilities);
  });

  it("every profile resolves a role field — the resolved type is TOTAL (worker by default)", () => {
    for (const profile of ["assistant", "standard", "unattended", "max"] as const) {
      const r = resolveAutonomy({ profile });
      expect(r.role, `${profile} must resolve a role`).toBe("worker");
      expect(r.coordinatorToolGroups, `${profile} worker has no narrowing`).toBeUndefined();
    }
  });
});

describe("resolveEffectiveMode (fail-closed mode resolution)", () => {
  it("a recognized mode 'unattended' passes through unchanged", () => {
    expect(resolveEffectiveMode("unattended")).toBe("unattended");
  });

  it("every valid AutonomyMode (default/accept-reversible/unattended/max) passes through", () => {
    for (const mode of ["default", "accept-reversible", "unattended", "max"] as const) {
      expect(resolveEffectiveMode(mode)).toBe(mode);
    }
  });

  it("an absent mode (undefined) fail-closes to 'default' (unreachable policy source)", () => {
    expect(resolveEffectiveMode(undefined)).toBe("default");
  });

  it("an unknown string 'bogus' fail-closes to 'default', NEVER a broader mode", () => {
    expect(resolveEffectiveMode("bogus")).toBe("default");
  });

  it("a non-string (a forged numeric mode) fail-closes to 'default'", () => {
    expect(resolveEffectiveMode(123 as never)).toBe("default");
  });

  it("null / an object likewise fail-close to 'default' (never throws on a hostile value)", () => {
    expect(resolveEffectiveMode(null)).toBe("default");
    expect(resolveEffectiveMode({ mode: "max" } as never)).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// The `orch:mcp` grant surface + the nested `autonomy.mcp` inbound leaf.
// Two layers, but the OPERATIVE default-deny is LAYER 2 (not the cap). LAYER 1
// (here) is the cap grant: `orch:mcp` is now a FLOOR cap for the autonomy-bearing
// profiles (standard/unattended/max) — held by default, exactly like orch:write —
// AND still grantable to `assistant` via the `autonomy.mcp.enabled` surface toggle
// (SURFACE_TOGGLE_TO_CAP, the web/analyze/write/browse "one cap model"). LAYER 2
// (the per-server allowlist, schema-agent-autonomy-mcp.ts `permitsMcpTool`) is the
// operative gate: `autonomy.mcp.allow` defaults `{}` ⇒ EVERY server denied by
// absence. So a fresh standard agent HOLDS orch:mcp yet reaches NO MCP server
// until the operator allowlists one — the same floor-cap + surface-opt-in shape
// as orch:write (floor cap + `writeSurfaceEnabled`). Granting the cap opens
// nothing.
// ---------------------------------------------------------------------------
describe("resolveAutonomy (the orch:mcp grant surface — floor cap, allowlist is the gate)", () => {
  it("autonomy.mcp.enabled:true unions orch:mcp into the resolved caps", () => {
    const r = resolveAutonomy(AutonomyConfigSchema.parse({ mcp: { enabled: true } }));
    expect(r.capabilities).toContain("orch:mcp");
  });

  it("the mcp surface gate grants orch:mcp on assistant too — { profile:assistant, mcp:{enabled:true} } grants orch:mcp yet resolves enabled:false", () => {
    const r = resolveAutonomy(
      AutonomyConfigSchema.parse({ profile: "assistant", mcp: { enabled: true } }),
    );
    expect(r.enabled).toBe(false);
    expect(r.capabilities).toContain("orch:mcp");
  });

  it("orch:mcp is FLOOR-granted by default on standard (zero-config / undefined / explicit standard)", () => {
    expect(resolveAutonomy(AutonomyConfigSchema.parse({})).capabilities).toContain("orch:mcp");
    expect(resolveAutonomy({ profile: "standard" }).capabilities).toContain("orch:mcp");
    expect(resolveAutonomy(undefined).capabilities).toContain("orch:mcp");
  });

  it("orch:mcp is floor-granted by standard/unattended/max but NOT the (autonomy-off) assistant profile", () => {
    for (const profile of ["standard", "unattended", "max"] as const) {
      expect(
        resolveAutonomy({ profile }).capabilities,
        `${profile} must floor-grant orch:mcp`,
      ).toContain("orch:mcp");
    }
    // assistant's floor is [] (autonomy off); orch:mcp only via an explicit toggle.
    expect(resolveAutonomy({ profile: "assistant" }).capabilities).not.toContain("orch:mcp");
  });

  it("SAFE-BY-DEFAULT invariant: a fresh agent HOLDS orch:mcp yet reaches NO MCP server (layer-2 allow {} denies by absence)", () => {
    const parsed = AutonomyConfigSchema.parse({});
    // Layer 1: the cap is held (floor).
    expect(resolveAutonomy(parsed).capabilities).toContain("orch:mcp");
    // Layer 2: the allowlist is empty ⇒ permitsMcpTool denies every {server,tool}.
    expect(parsed.mcp).toEqual({ enabled: false, allow: {} });
    expect(permitsMcpTool(parsed.mcp, "weather", "weather_forecast")).toBe(false);
    expect(permitsMcpTool(parsed.mcp, "anyserver", "anytool")).toBe(false);
  });
});

describe("AutonomyConfigSchema (the nested autonomy.mcp inbound leaf defaults off)", () => {
  it("a fully-omitted autonomy block resolves a default mcp block { enabled:false, allow:{} }", () => {
    const parsed = AutonomyConfigSchema.parse({});
    expect(parsed.mcp).toEqual({ enabled: false, allow: {} });
  });

  it("strictObject rejects an unknown key under autonomy.mcp (typo guard, fails-closed)", () => {
    expect(AutonomyConfigSchema.safeParse({ mcp: { enabld: true } }).success).toBe(false);
  });
});
