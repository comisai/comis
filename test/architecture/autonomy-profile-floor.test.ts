// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture test: PROFILE-02 — the §3.8 named profiles never over-grant.
 *
 * Asserts the four invariants the v8 design doc lists under §3.8 ("Arch-tests
 * (net-new)") + the §22.3 structural floor:
 *   (1) every profile's resolved cap set ⊆ {floor-contained caps} — no profile
 *       grants a cap outside the floor in M1;
 *   (2) no `autoApprovable:false` cap (the §22.3 always-escalate floor —
 *       `orch:browse`, `orch:message`-to-non-origin, `report:issue`) is marked
 *       auto-allowable in ANY profile;
 *   (3) `standard`/`unattended`/`max` resolve with the budget/rate/spawn
 *       ceiling ENABLED (a profile cannot ship the floor's guards off);
 *   (4) `assistant` resolves with ZERO orchestration surfaces, and
 *       `unattended`/`max` are CLAMPED to a subset of `standard`'s caps + carry
 *       the M1 "available in M2/M3" notice (no silent over-grant).
 *
 * It imports the COMPILED `resolveAutonomy` from `@comis/core` (dist) — the
 * runtime resolver, not its AST — so a future change that over-grants in the
 * resolver (the RED state) flips this red. Set-relation idiom mirrors
 * `contract-internal-fields.test.ts`.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { resolveAutonomy, type AgentCapability } from "@comis/core";
import { formatViolations } from "../support/architecture-helpers.js";

const DESIGN_REF = "v8 §3.8 (named profiles) / §22.3 (structural floor)";

// The nine FLOOR-CONTAINED orchestration caps `standard` turns on (v8 §3.8 /
// §22.3). Hardcoded here as the independent source of truth: the resolver must
// stay a subset of these in M1. `orch:message` IS a member (210-GAP MIG-01 / v8
// §3.8 line 253 profile table): the standard profile turns ON origin-channel
// messaging. The ORIGIN-vs-new-channel scoping rides `message.channels`
// (`["origin"]` default) — origin sends are auto-allowable under quota; a NEW
// channel is an `autoApprovable:false` floor item (§3.5/§22.3) enforced by the
// message config + the §8.4 per-target grant, NOT by removing the cap. So the
// cap-literal is floor-contained + `autoApprovable:true`; only the non-origin
// target escalates (asserted via ALWAYS_ESCALATE below, which `orch:message` is
// NOT a member of).
const FLOOR_CONTAINED: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  "orch:read",
  "orch:web",
  "orch:write",
  "orch:analyze",
  "orch:spawn",
  "orch:graph",
  "orch:cron",
  "orch:skill",
  "orch:message",
]);

// The §22.3 caps that are `autoApprovable:false` in EVERY profile forever
// (outward + irreversible). Modeled in the orch:* vocabulary as `orch:browse`;
// `orch:message`-to-non-origin and `report:issue` are enforced via the message
// config / are outside this milestone's vocabulary (§3.5/Phase 215).
const ALWAYS_ESCALATE: ReadonlySet<AgentCapability> = new Set<AgentCapability>(["orch:browse"]);

const PROFILES = ["assistant", "standard", "unattended", "max"] as const;

describe("PROFILE-02 — named profiles never over-grant (v8 §3.8 / §22.3)", () => {
  it("(1) every profile's resolved caps ⊆ the floor-contained set", () => {
    const violations = PROFILES.flatMap((profile) => {
      const resolved = resolveAutonomy({ profile });
      return resolved.capabilities
        .filter((cap) => !FLOOR_CONTAINED.has(cap))
        .map((cap) => ({
          file: `resolveAutonomy({ profile: "${profile}" })`,
          line: 0,
          snippet: `cap "${cap}" is not in the floor-contained set`,
        }));
    });
    expect(
      violations,
      formatViolations({
        description: "A profile resolved a capability outside the §22.3 floor-contained set (over-grant).",
        violations,
        suggestedFix:
          "Clamp the profile's resolved caps to the eight floor-contained caps in M1. Caps whose enforcement floor (lease/durability) is not built yet must not be granted.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("(2) no autoApprovable:false cap is auto-allowable in any profile", () => {
    const violations = PROFILES.flatMap((profile) => {
      const resolved = resolveAutonomy({ profile });
      return resolved.resolvedCapabilities
        .filter((rc) => ALWAYS_ESCALATE.has(rc.capability) && rc.autoApprovable)
        .map((rc) => ({
          file: `resolveAutonomy({ profile: "${profile}" })`,
          line: 0,
          snippet: `cap "${rc.capability}" is marked autoApprovable:true but is an always-escalate floor cap`,
        }));
    });
    expect(
      violations,
      formatViolations({
        description:
          "A profile marked an always-escalate floor cap (orch:browse / outward-irreversible) as auto-allowable — Elevation of Privilege (T-210-05).",
        violations,
        suggestedFix:
          "The §22.3 floor caps (orch:browse, orch:message-to-non-origin, report:issue) are autoApprovable:false in EVERY profile forever. Never set their autoApprovable bit true.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("(3) standard/unattended/max ship the budget/rate/spawn ceiling ENABLED", () => {
    const guarded = ["standard", "unattended", "max"] as const;
    const violations = guarded.flatMap((profile) => {
      const r = resolveAutonomy({ profile });
      const out: { file: string; line: number; snippet: string }[] = [];
      const where = `resolveAutonomy({ profile: "${profile}" })`;
      if (!(r.aggregateBudgetUsd > 0)) out.push({ file: where, line: 0, snippet: `aggregateBudgetUsd is ${r.aggregateBudgetUsd} (must be > 0)` });
      if (!(r.maxConcurrentSelfAgents > 0)) out.push({ file: where, line: 0, snippet: `maxConcurrentSelfAgents is ${r.maxConcurrentSelfAgents} (must be > 0)` });
      if (!(r.maxSelfSpawnRatePerMin > 0)) out.push({ file: where, line: 0, snippet: `maxSelfSpawnRatePerMin is ${r.maxSelfSpawnRatePerMin} (must be > 0)` });
      return out;
    });
    expect(
      violations,
      formatViolations({
        description:
          "A profile shipped the always-on budget/rate/spawn ceiling OFF, defeating the floor that earns the capable default (Tampering, T-210-07).",
        violations,
        suggestedFix:
          "standard/unattended/max must resolve with aggregateBudgetUsd > 0 and the spawn/rate ceilings > 0. A profile cannot ship the §8.7 guards off.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("(4) assistant has zero orchestration surfaces", () => {
    const r = resolveAutonomy({ profile: "assistant" });
    const violations =
      r.capabilities.length === 0 && r.enabled === false
        ? []
        : [
            {
              file: `resolveAutonomy({ profile: "assistant" })`,
              line: 0,
              snippet: `enabled=${r.enabled}, capabilities=[${r.capabilities.join(", ")}] (expected enabled:false, zero caps)`,
            },
          ];
    expect(
      violations,
      formatViolations({
        description: "The `assistant` profile resolved with orchestration surfaces — it must have none.",
        violations,
        suggestedFix: "assistant resolves enabled:false with an empty capability set (zero orchestration surfaces).",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("(4) unattended/max are CLAMPED to ⊆ standard's caps + carry the M1 notice", () => {
    const standardCaps = new Set(resolveAutonomy({ profile: "standard" }).capabilities);
    const clamped = ["unattended", "max"] as const;
    const violations = clamped.flatMap((profile) => {
      const r = resolveAutonomy({ profile });
      const out: { file: string; line: number; snippet: string }[] = [];
      const where = `resolveAutonomy({ profile: "${profile}" })`;
      for (const cap of r.capabilities) {
        if (!standardCaps.has(cap)) {
          out.push({ file: where, line: 0, snippet: `cap "${cap}" is not in standard's cap set (M1 over-grant)` });
        }
      }
      if (!r.m1Notice || !/M2|M3/.test(r.m1Notice)) {
        out.push({ file: where, line: 0, snippet: `m1Notice missing or does not mention M2/M3 (got: ${String(r.m1Notice)})` });
      }
      return out;
    });
    expect(
      violations,
      formatViolations({
        description:
          "unattended/max over-granted past standard's cap set in M1, or omitted the clamp notice (Elevation of Privilege, T-210-06).",
        violations,
        suggestedFix:
          "In M1, unattended/max clamp to standard's cap set + an 'available in M2/M3' notice — caps whose floor (lease, durability) is not built yet must not be granted.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });
});
