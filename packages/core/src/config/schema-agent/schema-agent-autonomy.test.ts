// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  AutonomyConfigSchema,
  AUTONOMY_PROFILES,
  resolveAutonomy,
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

// The eight FLOOR-CONTAINED orchestration caps `standard` turns on (v8 §3.8 /
// §22.3). `orch:message` is NOT in this list — it rides the separate
// `message:` block (origin-channel-only is auto-allowable; a NEW channel is an
// `autoApprovable:false` floor item, §3.5/§22.3).
const STANDARD_FLOOR_CAPS = [
  "orch:read",
  "orch:web",
  "orch:write",
  "orch:analyze",
  "orch:spawn",
  "orch:graph",
  "orch:cron",
  "orch:skill",
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
  it("PROFILE-01-S4: resolveAutonomy(undefined) → standard, caps include orch:spawn/orch:graph/orch:cron", () => {
    const r = resolveAutonomy(undefined);
    expect(r.profile).toBe("standard");
    expect(r.enabled).toBe(true);
    expect(r.capabilities).toEqual(expect.arrayContaining(["orch:spawn", "orch:graph", "orch:cron"]));
  });

  it("PROFILE-01-S5: standard resolves to exactly the eight floor-contained caps", () => {
    const r = resolveAutonomy({ profile: "standard" });
    expect([...r.capabilities].sort()).toEqual([...STANDARD_FLOOR_CAPS].sort());
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
