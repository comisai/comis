// SPDX-License-Identifier: Apache-2.0
/**
 * COORD-01 (218-01): the lean-coordinator tool-surface selection.
 *
 * Split from `setup-tools.ts` (file-size cap discipline; mirrors the
 * `setup-tools-autonomy.ts` sibling precedent). A PURE selector that decides the
 * effective tool-group allowlist for `assembleToolsForAgent`: a `role:
 * coordinator` lead with NO explicit `tool_groups` is narrowed to the
 * coordinator orchestration surface (`resolveAutonomy().coordinatorToolGroups`);
 * an explicit `tool_groups` (or "full") still wins (operator intent —
 * progressive disclosure, T-218-04); `role:worker` (the default) leaves the
 * surface untouched (byte-identical to today). This narrows the TOOL SURFACE
 * only — the resolved capability set is unchanged.
 *
 * @module
 */
import type { ResolvedAutonomy } from "@comis/core";

/** The selected effective tool groups + whether the coordinator role narrowed them. */
export interface EffectiveToolGroupsResult {
  /** The groups the platform-tool filter applies (undefined ⇒ no group filter / full surface). */
  readonly effectiveGroups: readonly string[] | undefined;
  /** True when the coordinator role drove the narrowing (no explicit tool_groups). */
  readonly narrowed: boolean;
}

/**
 * Select the effective tool groups for a lead given its resolved autonomy posture
 * and any explicit `tool_groups`. PURE (no env/clock/fs).
 *
 * @param resolvedAutonomy the lead's resolved autonomy posture (carries `role` + `coordinatorToolGroups`).
 * @param optionsToolGroups the explicit `tool_groups` from the assemble options (wins when present).
 */
export function selectEffectiveToolGroups(
  resolvedAutonomy: Pick<ResolvedAutonomy, "role" | "coordinatorToolGroups">,
  optionsToolGroups: readonly string[] | undefined,
): EffectiveToolGroupsResult {
  const hasExplicitToolGroups = optionsToolGroups !== undefined && optionsToolGroups.length > 0;
  const narrowed = resolvedAutonomy.role === "coordinator" && !hasExplicitToolGroups;
  return {
    effectiveGroups: narrowed ? resolvedAutonomy.coordinatorToolGroups : optionsToolGroups,
    narrowed,
  };
}

/**
 * Expand a set of effective tool-group names into the flat allowed tool-name set
 * the platform-tool filter applies — expanding both profile names (TOOL_PROFILES)
 * and `group:xxx` / bare group names (TOOL_GROUPS), exactly as the spawn-gate's
 * `computeReachableToolNames` does. PURE — the profile/group maps are passed in.
 *
 * @param groups the effective tool groups (already selected; never "full" / empty here).
 * @param toolProfiles the canonical profile→tools map (@comis/skills TOOL_PROFILES).
 * @param toolGroups the canonical group→tools map (@comis/skills TOOL_GROUPS).
 */
export function expandToolGroupsToNames(
  groups: readonly string[],
  toolProfiles: Record<string, string[]>,
  toolGroups: Record<string, string[]>,
): Set<string> {
  const allowedNames = new Set<string>();
  for (const group of groups) {
    const profileTools = toolProfiles[group];
    if (profileTools) {
      for (const t of profileTools) allowedNames.add(t);
    }
    // Also expand TOOL_GROUPS (e.g. "web" -> ["web_fetch", "web_search", "browser"]).
    const groupKey = group.startsWith("group:") ? group : `group:${group}`;
    const groupTools = toolGroups[groupKey];
    if (groupTools) {
      for (const t of groupTools) allowedNames.add(t);
    }
  }
  return allowedNames;
}
