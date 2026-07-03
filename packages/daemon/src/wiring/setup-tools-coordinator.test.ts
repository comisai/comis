// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { selectEffectiveToolGroups, expandToolGroupsToNames } from "./setup-tools-coordinator.js";

// ---------------------------------------------------------------------------
// The lean-coordinator tool-surface selection (extracted from
// setup-tools.ts for the file-size cap). selectEffectiveToolGroups decides the
// effective tool groups for a lead from its resolved autonomy posture +
// explicit tool_groups; expandToolGroupsToNames expands those groups into the
// flat allowed tool-name set the platform-tool filter applies. Both PURE.
// ---------------------------------------------------------------------------

describe("selectEffectiveToolGroups — role-driven tool-surface selection", () => {
  it("narrows a role:coordinator lead with NO explicit tool_groups to coordinatorToolGroups", () => {
    const result = selectEffectiveToolGroups(
      { role: "coordinator", coordinatorToolGroups: ["coordinator"] },
      undefined,
    );
    expect(result.narrowed).toBe(true);
    expect(result.effectiveGroups).toEqual(["coordinator"]);
  });

  it("does NOT narrow a default role:worker lead (effective groups = the passed tool_groups, here undefined)", () => {
    const result = selectEffectiveToolGroups({ role: "worker", coordinatorToolGroups: undefined }, undefined);
    expect(result.narrowed).toBe(false);
    expect(result.effectiveGroups).toBeUndefined();
  });

  it("lets an explicit tool_groups WIN over the coordinator role default (operator intent)", () => {
    const result = selectEffectiveToolGroups(
      { role: "coordinator", coordinatorToolGroups: ["coordinator"] },
      ["coding"],
    );
    expect(result.narrowed).toBe(false);
    expect(result.effectiveGroups).toEqual(["coding"]);
  });

  it("treats an empty explicit tool_groups as 'no explicit groups' so the coordinator narrowing still applies", () => {
    const result = selectEffectiveToolGroups(
      { role: "coordinator", coordinatorToolGroups: ["coordinator"] },
      [],
    );
    expect(result.narrowed).toBe(true);
    expect(result.effectiveGroups).toEqual(["coordinator"]);
  });

  it("passes a worker lead's explicit tool_groups through unchanged (no role involvement)", () => {
    const result = selectEffectiveToolGroups({ role: "worker", coordinatorToolGroups: undefined }, ["full"]);
    expect(result.narrowed).toBe(false);
    expect(result.effectiveGroups).toEqual(["full"]);
  });
});

describe("expandToolGroupsToNames — group/profile expansion to a flat tool-name set", () => {
  const TOOL_PROFILES = {
    coordinator: ["sessions_spawn", "pipeline", "message", "read", "obs_query"],
    coding: ["read", "edit", "exec"],
  };
  const TOOL_GROUPS = {
    "group:web": ["web_fetch", "web_search", "browser"],
  };

  it("expands a profile name to exactly its member tool names", () => {
    const allowed = expandToolGroupsToNames(["coordinator"], TOOL_PROFILES, TOOL_GROUPS);
    expect(allowed.has("sessions_spawn")).toBe(true);
    expect(allowed.has("obs_query")).toBe(true);
    expect(allowed.has("exec")).toBe(false);
  });

  it("expands a group:xxx reference to its member tool names", () => {
    const allowed = expandToolGroupsToNames(["group:web"], TOOL_PROFILES, TOOL_GROUPS);
    expect(allowed.has("web_fetch")).toBe(true);
    expect(allowed.has("browser")).toBe(true);
  });

  it("expands a bare group name (no group: prefix) via the group:<name> key", () => {
    const allowed = expandToolGroupsToNames(["web"], TOOL_PROFILES, TOOL_GROUPS);
    expect(allowed.has("web_search")).toBe(true);
  });

  it("unions members across multiple groups and dedupes overlapping tool names", () => {
    const allowed = expandToolGroupsToNames(["coordinator", "coding"], TOOL_PROFILES, TOOL_GROUPS);
    // `read` is in both profiles — present exactly once (Set dedupe).
    expect(allowed.has("read")).toBe(true);
    expect(allowed.has("sessions_spawn")).toBe(true);
    expect(allowed.has("exec")).toBe(true);
  });

  it("returns an empty set when no group matches a known profile or group", () => {
    const allowed = expandToolGroupsToNames(["unknown_profile"], TOOL_PROFILES, TOOL_GROUPS);
    expect(allowed.size).toBe(0);
  });
});
