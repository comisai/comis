// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  AutonomyConfigSchema,
  AUTONOMY_PROFILES,
  resolveAutonomy,
  degradeAutonomy,
  type AutonomyDownshift,
} from "./schema-agent-autonomy.js";

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
