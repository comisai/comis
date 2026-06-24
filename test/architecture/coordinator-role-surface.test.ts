// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture test: COORD-01 / SUMREF-03 — `autonomy.role: coordinator`
 * narrows the TOOL surface to the orchestration set, and NEVER changes the
 * resolved capability set (no escalation). Phase 218, design §23.10.
 *
 * Asserts the invariants the coordinator role rests on:
 *   (1) `resolveAutonomy({ role: "coordinator" })` resolves `role:"coordinator"`
 *       and `coordinatorToolGroups: ["coordinator"]` (the allowlist setup-tools
 *       applies at the single filter seam).
 *   (2) `role: worker` (the default — `{}` or any profile without `role`) does
 *       NOT narrow: `role:"worker"`, `coordinatorToolGroups: undefined`.
 *   (3) THE SECURITY KEYSTONE (no escalation): the resolved `capabilities` set
 *       is DEEP-EQUAL with and without `role: coordinator` for the same profile.
 *       `role` narrows the tool SURFACE only — it can never widen (or change) a
 *       capability (§22.3 over-grant guard, T-218-19).
 *   (4) The `coordinator` TOOL_PROFILE EXCLUDES the heavy-work tools
 *       (`exec`/`edit`/`write`/`browser`) — a coordinator cannot do inline heavy
 *       work (COORD-02), it must delegate.
 *   (5) SUMREF-03 reachability: the surface INCLUDES the orch:read drill-in
 *       tools (`read`/`grep`) so the lead can drill into a child ResultRef
 *       WITHOUT ingesting it into its window.
 *   (6) The surface includes the orchestration tools (`sessions_spawn`,
 *       `pipeline`, `cron`, `message`) + the observability tool-name
 *       (`obs_query`).
 *
 * It imports the COMPILED `resolveAutonomy` from `@comis/core` (dist) and
 * `TOOL_PROFILES` from `@comis/skills` (dist) — the runtime resolved posture and
 * the runtime profile, not their AST — so a future resolver/profile change that
 * un-narrows the coordinator or grants it a heavy-work tool flips this RED (the
 * `autonomy-profile-floor.test.ts` template; the architecture project aliases
 * both packages to dist/ for exactly this reason). This is why the plan is Wave
 * 2: it needs `pnpm build` of Plan 01's changes.
 *
 * Discriminating power (the one-line edits that flip each assertion to RED):
 *   - (1)/(2): making `resolveCoordinatorToolGroups` return the groups for a
 *     worker (or undefined for a coordinator) fails the role-mapping checks.
 *   - (3): adding a cap under `role: coordinator` in the resolver fails the
 *     deep-equality no-escalation check (the keystone).
 *   - (4): adding `"exec"` (or edit/write/browser) to the `coordinator`
 *     TOOL_PROFILE fails the heavy-work-exclusion check.
 *   - (5): removing `"read"`/`"grep"` from the profile fails the SUMREF-03
 *     drill-in reachability check.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { resolveAutonomy } from "@comis/core";
import { TOOL_PROFILES } from "@comis/skills";
import { formatViolations, type ViolationCitation } from "../support/architecture-helpers.js";

const DESIGN_REF = "v8 §23.10 (long-running coordinator) / §22.3 (no over-grant) / Phase 218 COORD-01+SUMREF-03";

/** The coordinator surface (compiled). Read once off `@comis/skills` dist. */
const COORDINATOR_PROFILE: readonly string[] = TOOL_PROFILES.coordinator;

/** Tools a coordinator must NOT carry — heavy work is delegated, never inline
 *  (COORD-02, T-218-19). */
const HEAVY_WORK_TOOLS = ["exec", "edit", "write", "browser"] as const;
/** The orch:read drill-in tools the lead needs to inspect a child ResultRef
 *  WITHOUT ingesting it (SUMREF-03). */
const DRILL_IN_TOOLS = ["read", "grep"] as const;
/** The orchestration + observability tools the coordinator must reach. */
const ORCHESTRATION_TOOLS = ["sessions_spawn", "pipeline", "cron", "message", "obs_query"] as const;

/** Helper: render a membership violation list off a tool-name predicate. */
function membershipViolations(
  toolNames: readonly string[],
  shouldInclude: boolean,
): ViolationCitation[] {
  return toolNames
    .filter((tool) => COORDINATOR_PROFILE.includes(tool) !== shouldInclude)
    .map((tool) => ({
      file: "packages/skills/src/skills/policy/tool-policy.ts (TOOL_PROFILES.coordinator)",
      line: 0,
      snippet: shouldInclude
        ? `tool "${tool}" is MISSING from the coordinator surface (it must be reachable)`
        : `tool "${tool}" is PRESENT in the coordinator surface (it must be excluded)`,
    }));
}

describe("COORD-01 — role:coordinator narrows to the orchestration surface (no escalation)", () => {
  it("maps role:coordinator to the coordinator tool-group allowlist", () => {
    const r = resolveAutonomy({ profile: "unattended", role: "coordinator" });
    expect(r.role).toBe("coordinator");
    expect(r.coordinatorToolGroups).toContain("coordinator");
  });

  it("does NOT narrow the surface for role:worker (the default)", () => {
    const standard = resolveAutonomy({ profile: "standard" });
    expect(standard.role).toBe("worker");
    expect(standard.coordinatorToolGroups).toBeUndefined();
    // The bare default resolves to worker too (net-new field, default no-op).
    expect(resolveAutonomy({}).role).toBe("worker");
  });

  it("narrows the tool surface only — role never changes the resolved capability set (no escalation)", () => {
    // THE SECURITY KEYSTONE (T-218-19): the resolved caps are role-invariant.
    // `role` is a tool-surface narrowing, never a capability grant — so adding
    // `role: coordinator` must leave the cap set byte-identical.
    const base = resolveAutonomy({ profile: "unattended" }).capabilities;
    const withRole = resolveAutonomy({ profile: "unattended", role: "coordinator" }).capabilities;
    expect(withRole).toEqual(base);
  });

  it("excludes the heavy-work tools from the coordinator surface (COORD-02: delegate, never inline)", () => {
    const violations = membershipViolations(HEAVY_WORK_TOOLS, false);
    expect(
      violations,
      formatViolations({
        description:
          "The coordinator surface gained a heavy-work tool (exec/edit/write/browser) — a coordinator must delegate heavy work, never run it inline (Elevation of Privilege, T-218-19).",
        violations,
        suggestedFix:
          "Remove exec/edit/write/browser from TOOL_PROFILES.coordinator. The coordinator orchestrates (spawn/pipeline/cron/message) and drills into results (read/grep) — heavy work goes to spawned workers.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("includes the orch:read drill-in tools (SUMREF-03: drill into a child ResultRef without ingesting it)", () => {
    const violations = membershipViolations(DRILL_IN_TOOLS, true);
    expect(
      violations,
      formatViolations({
        description:
          "The coordinator surface is missing an orch:read drill-in tool — the lead cannot inspect a child ResultRef without ingesting the full output (SUMREF-03 reachability broken).",
        violations,
        suggestedFix:
          "Keep read + grep in TOOL_PROFILES.coordinator so the lead drills into a materialized child ResultRef (a jailed-workspace handle) on demand, instead of pulling the megabyte body into its window.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("includes the orchestration + observability tools", () => {
    const violations = membershipViolations(ORCHESTRATION_TOOLS, true);
    expect(
      violations,
      formatViolations({
        description:
          "The coordinator surface is missing an orchestration/observability tool — the lead cannot spawn, schedule, route, or observe its fleet.",
        violations,
        suggestedFix:
          "Keep sessions_spawn, pipeline, cron, message, and obs_query in TOOL_PROFILES.coordinator. obs_query is a tool-NAME on the profile, not a new obs:read capability.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });
});
