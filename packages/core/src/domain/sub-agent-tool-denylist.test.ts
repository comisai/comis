// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  RequiredToolsUnreachableError,
  computeReachableToolNames,
  SUB_AGENT_TOOL_GROUPS,
  SUB_AGENT_TOOL_PROFILES,
  type UnreachableToolEntry,
} from "./sub-agent-tool-denylist.js";

function outsideProfile(...names: string[]): UnreachableToolEntry[] {
  return names.map((toolName) => ({
    toolName,
    reason: "outside_profile" as const,
    hint: `Tool '${toolName}' is outside the active profile.`,
  }));
}

/**
 * The rejection message is the only instruction a sub-agent gets when a spawn is
 * refused for tool reachability. It must name a ceiling that (a) actually reaches
 * the required tools and (b) is the narrowest one that does — a suggestion of
 * 'full' where a narrow group suffices converts a reachability error into a
 * privilege escalation.
 *
 * Live incident: a delegated market scan required web_search + web_fetch. No
 * profile lists web_fetch, so the suggester fell back to 'full' and declared the
 * group that would have worked ('web') invalid. The caller retried the same spawn
 * three times, tripped the sessions_spawn breaker, and the run timed out.
 */
describe("RequiredToolsUnreachableError suggestion", () => {
  it("suggests the narrow group that reaches tools no profile lists", () => {
    const message = new RequiredToolsUnreachableError(outsideProfile("web_search", "web_fetch")).message;

    expect(message).toContain("tool_groups:['web']");
    expect(message).not.toContain("tool_groups:['full']");
  });

  it("suggests a group for a group-only tool instead of escalating to full", () => {
    const message = new RequiredToolsUnreachableError(outsideProfile("browser")).message;

    expect(message).toMatch(/tool_groups:\['(browser|web)'\]/);
    expect(message).not.toContain("tool_groups:['full']");
  });

  it("does not declare a valid group name invalid", () => {
    const message = new RequiredToolsUnreachableError(outsideProfile("web_search", "web_fetch")).message;

    // The message asserts "any other value is ignored" about the groups it lists,
    // so every accepted ceiling must appear in that list.
    expect(message).toContain("'web'");
  });

  it("suggests the narrowest sufficient ceiling when a profile also reaches the tool", () => {
    // web_search is reachable via the 'cron-minimal' profile (9 tools) and the
    // 'web' group (3 tools). Least privilege picks the smaller one.
    const message = new RequiredToolsUnreachableError(outsideProfile("web_search")).message;

    expect(message).toContain("tool_groups:['web']");
  });

  it("only ever suggests a ceiling the reachability gate actually accepts", () => {
    // Whatever the message tells a caller to pass must survive the same
    // computeReachableToolNames() gate that rejected the spawn.
    for (const tool of ["web_search", "web_fetch", "browser", "memory_get", "subagents"]) {
      const message = new RequiredToolsUnreachableError(outsideProfile(tool)).message;
      const suggested = /tool_groups:\['([^']+)'\]/.exec(message)?.[1];
      expect(suggested, `no suggestion for ${tool}`).toBeDefined();
      if (suggested === "full") continue;
      const reachable = computeReachableToolNames([suggested as string]);
      expect(reachable?.has(tool), `${suggested} does not reach ${tool}`).toBe(true);
    }
  });

  it("emits no re-spawn directive when a denylisted tool is required", () => {
    const message = new RequiredToolsUnreachableError([
      { toolName: "gateway", reason: "denylist", hint: "'gateway' is never delegatable." },
      ...outsideProfile("web_search"),
    ]).message;

    expect(message).not.toContain("Re-spawn with tool_groups");
  });
});

describe("suggester and reachability gate share one universe", () => {
  it("can name a ceiling for every tool the gate can reach", () => {
    const profileTools = new Set(Object.values(SUB_AGENT_TOOL_PROFILES).flat());
    const groupOnly = [...new Set(Object.values(SUB_AGENT_TOOL_GROUPS).flat())]
      .filter((t) => !profileTools.has(t));

    // These are exactly the tools the profile-only suggester was blind to.
    expect(groupOnly.length).toBeGreaterThan(0);

    for (const tool of groupOnly) {
      const message = new RequiredToolsUnreachableError(outsideProfile(tool)).message;
      expect(message, `escalated to full for ${tool}`).not.toContain("tool_groups:['full']");
    }
  });
});
