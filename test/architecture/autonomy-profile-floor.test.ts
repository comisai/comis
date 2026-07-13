// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture test: the named profiles never over-grant.
 *
 * Asserts the four invariants that keep the named profiles within the
 * structural floor:
 *   (1) every profile's resolved cap set ⊆ {floor-contained caps} — no profile
 *       grants a cap outside the floor;
 *   (2) no `autoApprovable:false` cap (the always-escalate floor —
 *       `orch:browse`, `orch:message`-to-non-origin, `report:issue`) is marked
 *       auto-allowable in ANY profile;
 *   (3) `standard`/`unattended`/`max` resolve with the budget/rate/spawn
 *       ceiling ENABLED (a profile cannot ship the floor's guards off);
 *   (4) `assistant` resolves with ZERO orchestration surfaces, and
 *       `unattended`/`max` keep a subset of `standard`'s caps (no silent
 *       over-grant). `max` carries a notice disclosing that its extra surface
 *       is not yet available; `unattended`'s notice states its never-hang MODE
 *       behaviors are now ACTIVE.
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

const DESIGN_REF = "named autonomy profiles never over-grant (resolveAutonomy in @comis/core)";

// The ten FLOOR-CONTAINED orchestration caps `standard` turns on. Hardcoded
// here as the independent source of truth: the resolver must stay a subset of
// these. `orch:message` IS a member: the standard profile turns ON
// origin-channel messaging. The ORIGIN-vs-new-channel scoping rides
// `message.channels` (`["origin"]` default) — origin sends are auto-allowable
// under quota; a NEW channel is an `autoApprovable:false` floor item enforced by
// the message config + the per-target grant, NOT by removing the cap. So the
// cap-literal is floor-contained + `autoApprovable:true`; only the non-origin
// target escalates (asserted via ALWAYS_ESCALATE below, which `orch:message` is
// NOT a member of). `orch:mcp` IS a member (floor-granted like orch:write) — the
// reachability gate is the per-server `autonomy.mcp.allow` allowlist (default {} ⇒
// deny by absence), NOT the cap grant, so floor-holding it opens no MCP server.
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
  "orch:mcp",
]);

// The caps that are `autoApprovable:false` in EVERY profile forever
// (outward + irreversible). Modeled in the orch:* vocabulary as `orch:browse`;
// `orch:message`-to-non-origin and `report:issue` are enforced via the message
// config / are outside the orch:* cap vocabulary.
const ALWAYS_ESCALATE: ReadonlySet<AgentCapability> = new Set<AgentCapability>(["orch:browse"]);

const PROFILES = ["assistant", "standard", "unattended", "max"] as const;

describe("named profiles never over-grant", () => {
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
        description: "A profile resolved a capability outside the floor-contained set (over-grant).",
        violations,
        suggestedFix:
          "Clamp the profile's resolved caps to the floor-contained caps. Caps whose enforcement floor (lease/durability) is not built yet must not be granted.",
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
          "A profile marked an always-escalate floor cap (orch:browse / outward-irreversible) as auto-allowable — Elevation of Privilege.",
        violations,
        suggestedFix:
          "The floor caps (orch:browse, orch:message-to-non-origin, report:issue) are autoApprovable:false in EVERY profile forever. Never set their autoApprovable bit true.",
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
          "A profile shipped the always-on budget/rate/spawn ceiling OFF, defeating the floor that earns the capable default (Tampering).",
        violations,
        suggestedFix:
          "standard/unattended/max must resolve with aggregateBudgetUsd > 0 and the spawn/rate ceilings > 0. A profile cannot ship the always-on guards off.",
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

  it("(4) unattended/max keep ⊆ standard's caps (no over-grant) + carry the correct per-profile notice", () => {
    // The CAP-CLAMP half is the load-bearing Elevation-of-Privilege invariant
    // and holds for BOTH profiles forever: neither may resolve a cap
    // outside standard's set. The NOTICE half differs by profile:
    // `max` still defers its sandbox-auto-allow surface (its notice discloses
    // that surface is not yet available), while `unattended`'s never-hang MODE
    // behaviors are now ACTIVE — its notice must NOT claim deferral. (Caps are
    // unchanged; only the mode is activated.)
    const standardCaps = new Set(resolveAutonomy({ profile: "standard" }).capabilities);
    const clamped = ["unattended", "max"] as const;
    const violations = clamped.flatMap((profile) => {
      const r = resolveAutonomy({ profile });
      const out: { file: string; line: number; snippet: string }[] = [];
      const where = `resolveAutonomy({ profile: "${profile}" })`;
      for (const cap of r.capabilities) {
        if (!standardCaps.has(cap)) {
          out.push({ file: where, line: 0, snippet: `cap "${cap}" is not in standard's cap set (over-grant beyond standard)` });
        }
      }
      if (!r.m1Notice) {
        out.push({ file: where, line: 0, snippet: `m1Notice missing (every clamped/mode-activated profile must surface one)` });
      } else if (profile === "max") {
        // max still has a deferred surface → its notice must disclose that.
        if (!/not yet available/i.test(r.m1Notice)) {
          out.push({ file: where, line: 0, snippet: `max m1Notice must disclose its still-deferred surface is not yet available (got: ${r.m1Notice})` });
        }
      } else {
        // unattended: the never-hang behaviors are ACTIVE — the notice
        // must NOT claim deferral, and must say the behaviors are active.
        if (/not yet available/i.test(r.m1Notice)) {
          out.push({ file: where, line: 0, snippet: `unattended m1Notice must NOT claim a deferred surface (got: ${r.m1Notice})` });
        }
        if (!/active/i.test(r.m1Notice)) {
          out.push({ file: where, line: 0, snippet: `unattended m1Notice must state its never-hang behaviors are active (got: ${r.m1Notice})` });
        }
      }
      return out;
    });
    expect(
      violations,
      formatViolations({
        description:
          "unattended/max over-granted past standard's cap set, or carried the wrong per-profile notice (Elevation of Privilege).",
        violations,
        suggestedFix:
          "unattended/max clamp to standard's cap set. `max`'s notice discloses that its extra surface is not yet available; `unattended`'s notice states its never-hang behaviors are ACTIVE — caps whose floor is not built yet must not be granted.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });
});
