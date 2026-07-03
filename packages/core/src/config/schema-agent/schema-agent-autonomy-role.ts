// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — Autonomy ROLE vocabulary + the coordinator tool-surface
 * expansion (lean-coordinator).
 *
 * Split from `schema-agent-autonomy.ts` (file-size cap
 * discipline): the `role` axis (the operator-set lean-coordinator posture the
 * agent CANNOT self-raise) and the pure `coordinator → coordinatorToolGroups`
 * expansion are a self-contained unit the main autonomy leaf imports. The role
 * NARROWS the resolved tool surface ONLY — it never adds a capability (the
 * resolved `capabilities[]` set is role-invariant), and the structural
 * floor + the `requireCapability` gate are unchanged. Default `worker` ⇒
 * byte-identical to a role-less config (no migration code, no posture flag).
 *
 * One-directional dependency (role → consumed by autonomy), no cycle;
 * re-exported by the `schema-agent/index.ts` barrel so consumers reach these via
 * `@comis/core` exactly as before. Imports nothing from sibling leaves — pure
 * data + a pure function (AGENTS §2.2).
 *
 * @module
 */

/**
 * Lean-coordinator roles. `worker` (default) leaves the resolved tool
 * surface untouched; `coordinator` narrows it to the orchestration set
 * (sessions_spawn/pipeline/cron/message + the orch:read drill-in tools +
 * obs_query) under a delegate-then-synthesize doctrine — heavy/long/high-volume
 * work always routes to a fresh-window child, never inline.
 */
export const AUTONOMY_ROLES = ["worker", "coordinator"] as const;
export type AutonomyRole = (typeof AUTONOMY_ROLES)[number];

/**
 * The tool-group allowlist the `coordinator` role resolves to — the single name
 * `setup-tools` expands into the `coordinator` TOOL_PROFILE. Surfaced on
 * `ResolvedAutonomy.coordinatorToolGroups` so the assembly seam and the
 * coordinator arch-test read one source of truth off the compiled resolver.
 */
export const COORDINATOR_TOOL_GROUPS = ["coordinator"] as const satisfies readonly string[];

/**
 * Expand a resolved role into its tool-group allowlist. `coordinator`
 * → the `["coordinator"]` allowlist `setup-tools` applies; `worker` → `undefined`
 * (no narrowing, so a default install resolves with the full surface). PURE
 * (no env/clock/fs). NARROWS the tool surface only — never the cap set.
 */
export function resolveCoordinatorToolGroups(role: AutonomyRole): readonly string[] | undefined {
  return role === "coordinator" ? COORDINATOR_TOOL_GROUPS : undefined;
}
