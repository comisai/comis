// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { applyToolPolicy, TOOL_PROFILES, TOOL_GROUPS, expandGroups } from "./tool-policy.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolFilterReason, ToolPolicyResult } from "./tool-policy.js";
import { SUB_AGENT_TOOL_DENYLIST, SUB_AGENT_TOOL_PROFILES, SUB_AGENT_TOOL_GROUPS } from "@comis/core";

/** Create a minimal mock tool with the given name. */
function mockTool(name: string): AgentTool<any> {
  return {
    name,
    label: name,
    description: `Mock ${name} tool`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
  };
}

/** Create a standard set of mock tools for testing. */
function createMockTools(): AgentTool<any>[] {
  return [
    mockTool("read"),
    mockTool("edit"),
    mockTool("write"),
    mockTool("grep"),
    mockTool("find"),
    mockTool("ls"),
    mockTool("apply_patch"),
    mockTool("exec"),
    mockTool("process"),
    mockTool("web_fetch"),
    mockTool("web_search"),
    mockTool("browser"),
    mockTool("cron"),
    mockTool("message"),
    mockTool("session_status"),
    mockTool("sessions_list"),
    mockTool("sessions_history"),
    mockTool("sessions_send"),
    mockTool("sessions_spawn"),
    mockTool("subagents"),
  ];
}

describe("applyToolPolicy", () => {
  it("minimal profile allows read, write", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, { profile: "minimal", allow: [], deny: [] });

    const names = result.tools.map((t) => t.name);
    expect(result.tools).toHaveLength(2);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).not.toContain("exec");
  });

  it("full profile allows all tools", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, { profile: "full", allow: [], deny: [] });

    expect(result.tools).toHaveLength(tools.length);
  });

  it("allow list adds tools beyond profile", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, {
      profile: "minimal",
      allow: ["web_fetch"],
      deny: [],
    });

    const names = result.tools.map((t) => t.name);
    expect(names).toContain("web_fetch");
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).not.toContain("exec");
    expect(names).toHaveLength(3);
  });

  it("deny list removes tools from profile", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, {
      profile: "full",
      allow: [],
      deny: ["cron"],
    });

    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain("cron");
    expect(names).toHaveLength(tools.length - 1);
  });

  it("group expansion works in allow", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, {
      profile: "minimal",
      allow: ["group:web"],
      deny: [],
    });

    const names = result.tools.map((t) => t.name);
    // minimal (read, write) + group:web (web_fetch, web_search, browser)
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
    expect(names).toContain("browser");
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).not.toContain("exec");
    expect(names).toHaveLength(5);
  });

  it("group expansion works in deny", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, {
      profile: "full",
      allow: [],
      deny: ["group:scheduling"],
    });

    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain("cron");
    expect(names).toContain("read");
    expect(names).toContain("web_fetch");
  });

  it("deny overrides allow", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, {
      profile: "minimal",
      allow: ["web_fetch"],
      deny: ["web_fetch"],
    });

    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain("web_fetch");
    // minimal has 2 tools (read, write); web_fetch not in minimal so deny is no-op = 2 remaining
    expect(names).toHaveLength(2);
  });

  it("unknown profile defaults to empty tool set", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, {
      profile: "unknown",
      allow: [],
      deny: [],
    });

    expect(result.tools).toHaveLength(0);
  });

  it("unknown profile with allow list returns only allowed tools", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, {
      profile: "unknown",
      allow: ["read"],
      deny: [],
    });

    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(["read"]);
  });
});

describe("applyToolPolicy - denial reasons", () => {
  it("minimal profile reports not_in_profile for excluded tools", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, { profile: "minimal", allow: [], deny: [] });

    // Tools not in minimal (read, write) should be filtered with not_in_profile reason
    const execFiltered = result.filtered.find((f) => f.toolName === "exec");
    expect(execFiltered).toBeDefined();
    expect(execFiltered!.reason).toEqual({
      kind: "not_in_profile",
      profile: "minimal",
      toolName: "exec",
    });

    const cronFiltered = result.filtered.find((f) => f.toolName === "cron");
    expect(cronFiltered).toBeDefined();
    expect(cronFiltered!.reason.kind).toBe("not_in_profile");
  });

  it("explicit deny reports explicit_deny with direct denyEntry", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, {
      profile: "full",
      allow: [],
      deny: ["cron"],
    });

    const cronFiltered = result.filtered.find((f) => f.toolName === "cron");
    expect(cronFiltered).toBeDefined();
    expect(cronFiltered!.reason).toEqual({
      kind: "explicit_deny",
      toolName: "cron",
      denyEntry: "cron",
    });
  });

  it("group deny reports explicit_deny with group denyEntry", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, {
      profile: "full",
      allow: [],
      deny: ["group:web"],
    });

    const webFetchFiltered = result.filtered.find((f) => f.toolName === "web_fetch");
    expect(webFetchFiltered).toBeDefined();
    expect(webFetchFiltered!.reason).toEqual({
      kind: "explicit_deny",
      toolName: "web_fetch",
      denyEntry: "group:web",
    });

    const browserFiltered = result.filtered.find((f) => f.toolName === "browser");
    expect(browserFiltered).toBeDefined();
    expect(browserFiltered!.reason).toEqual({
      kind: "explicit_deny",
      toolName: "browser",
      denyEntry: "group:web",
    });
  });

  it("unknown profile with empty allow reports not_in_profile for all tools", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, {
      profile: "unknown",
      allow: [],
      deny: [],
    });

    expect(result.filtered).toHaveLength(tools.length);
    for (const entry of result.filtered) {
      expect(entry.reason).toEqual({
        kind: "not_in_profile",
        profile: "unknown",
        toolName: entry.toolName,
      });
    }
  });

  it("deny overrides allow: reports explicit_deny for denied tool", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, {
      profile: "minimal",
      allow: ["web_fetch"],
      deny: ["web_fetch"],
    });

    const webFetchFiltered = result.filtered.find((f) => f.toolName === "web_fetch");
    expect(webFetchFiltered).toBeDefined();
    expect(webFetchFiltered!.reason).toEqual({
      kind: "explicit_deny",
      toolName: "web_fetch",
      denyEntry: "web_fetch",
    });
  });

  it("full profile with no deny returns empty filtered array (fast path)", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, { profile: "full", allow: [], deny: [] });

    expect(result.filtered).toEqual([]);
    expect(result.tools).toHaveLength(tools.length);
  });
});

describe("expandGroups", () => {
  it("expands known groups", () => {
    const result = expandGroups(["group:web"]);
    expect(result).toContain("web_fetch");
    expect(result).toContain("web_search");
  });

  it("passes through non-group names", () => {
    const result = expandGroups(["read", "write"]);
    expect(result).toEqual(["read", "write"]);
  });

  it("deduplicates results", () => {
    const result = expandGroups(["read", "group:coding"]);
    const readCount = result.filter((n) => n === "read").length;
    expect(readCount).toBe(1);
  });

  it("passes through unknown group references as-is", () => {
    const result = expandGroups(["group:nonexistent"]);
    expect(result).toEqual(["group:nonexistent"]);
  });
});

describe("TOOL_PROFILES", () => {
  it("has minimal, coding, messaging, supervisor, and full profiles", () => {
    expect(TOOL_PROFILES).toHaveProperty("minimal");
    expect(TOOL_PROFILES).toHaveProperty("coding");
    expect(TOOL_PROFILES).toHaveProperty("messaging");
    expect(TOOL_PROFILES).toHaveProperty("supervisor");
    expect(TOOL_PROFILES).toHaveProperty("full");
  });

  it("full profile has empty array (all tools)", () => {
    expect(TOOL_PROFILES["full"]).toEqual([]);
  });

  it("minimal profile has 2 baseline tools", () => {
    expect(TOOL_PROFILES["minimal"]).toHaveLength(2);
    expect(TOOL_PROFILES["minimal"]).toContain("read");
    expect(TOOL_PROFILES["minimal"]).toContain("write");
    expect(TOOL_PROFILES["minimal"]).not.toContain("exec");
  });

  it("coding profile has 9 tools including apply_patch", () => {
    expect(TOOL_PROFILES["coding"]).toHaveLength(9);
    expect(TOOL_PROFILES["coding"]).toContain("apply_patch");
    expect(TOOL_PROFILES["coding"]).toContain("read");
    expect(TOOL_PROFILES["coding"]).toContain("exec");
  });

  it("supervisor profile has 10 privileged tools", () => {
    expect(TOOL_PROFILES["supervisor"]).toHaveLength(10);
    expect(TOOL_PROFILES["supervisor"]).toContain("agents_manage");
    expect(TOOL_PROFILES["supervisor"]).toContain("obs_query");
    expect(TOOL_PROFILES["supervisor"]).toContain("sessions_manage");
    expect(TOOL_PROFILES["supervisor"]).toContain("memory_manage");
    expect(TOOL_PROFILES["supervisor"]).toContain("channels_manage");
    expect(TOOL_PROFILES["supervisor"]).toContain("tokens_manage");
    expect(TOOL_PROFILES["supervisor"]).toContain("models_manage");
    expect(TOOL_PROFILES["supervisor"]).toContain("skills_manage");
    expect(TOOL_PROFILES["supervisor"]).toContain("mcp_manage");
    expect(TOOL_PROFILES["supervisor"]).toContain("heartbeat_manage");
  });
});

// ---------------------------------------------------------------------------
// COORD-01 (Phase 218): the `coordinator` TOOL_PROFILE — the lean-coordinator
// orchestration surface. A long-running lead with `autonomy.role: coordinator`
// resolves `coordinatorToolGroups: ["coordinator"]` (schema-agent-autonomy.ts),
// which setup-tools applies as the effective tool-group allowlist. The surface
// is: the orchestration tools (sessions_spawn/pipeline/cron/message + the rest
// of group:sessions) + the orch:read drill-in tools (read/grep/find/ls — so the
// lead can read a child ResultRef, SUMREF-03) + obs_query (the obs surface as a
// TOOL NAME, NOT a new capability — AGENT_CAPABILITIES is unchanged). It
// EXCLUDES the heavy-work tools (no exec/edit/write/browser inline — COORD-02:
// heavy work has nowhere to run except a fresh-window child).
//
// These cases are RED until the `coordinator` entry exists in TOOL_PROFILES.
// ---------------------------------------------------------------------------
describe("TOOL_PROFILES.coordinator (COORD-01 — the lean-coordinator orchestration surface)", () => {
  it("COORD-01-T1: the coordinator profile exists and includes the orchestration tools sessions_spawn/pipeline/cron/message", () => {
    const coordinator = TOOL_PROFILES["coordinator"];
    expect(coordinator, "TOOL_PROFILES.coordinator must exist").toBeDefined();
    expect(coordinator).toContain("sessions_spawn");
    expect(coordinator).toContain("pipeline");
    expect(coordinator).toContain("cron");
    expect(coordinator).toContain("message");
  });

  it("COORD-01-T2: includes the orch:read drill-in tools (read/grep/find/ls) so the lead can read a child ResultRef (SUMREF-03)", () => {
    const coordinator = TOOL_PROFILES["coordinator"]!;
    expect(coordinator).toContain("read");
    expect(coordinator).toContain("grep");
    expect(coordinator).toContain("find");
    expect(coordinator).toContain("ls");
  });

  it("COORD-01-T3: includes obs_query (the obs surface as a tool NAME, not a new capability)", () => {
    expect(TOOL_PROFILES["coordinator"]).toContain("obs_query");
  });

  it("COORD-01-T4: EXCLUDES the heavy-work tools — no exec/edit/write/browser inline (COORD-02)", () => {
    const coordinator = TOOL_PROFILES["coordinator"]!;
    expect(coordinator).not.toContain("exec");
    expect(coordinator).not.toContain("edit");
    expect(coordinator).not.toContain("write");
    expect(coordinator).not.toContain("browser");
  });

  it("COORD-01-T5: applyToolPolicy with the coordinator profile keeps the orchestration tools and filters the heavy-work tools", () => {
    const tools = [
      ...createMockTools(),
      mockTool("obs_query"),
    ];
    const result = applyToolPolicy(tools, { profile: "coordinator", allow: [], deny: [] });
    const names = result.tools.map((t) => t.name);
    // Orchestration + drill-in survive.
    expect(names).toContain("sessions_spawn");
    expect(names).toContain("message");
    expect(names).toContain("read");
    expect(names).toContain("obs_query");
    // Heavy-work tools are filtered out (not in the coordinator profile).
    expect(names).not.toContain("exec");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("browser");
  });
});

describe("TOOL_GROUPS", () => {
  it("has all expected groups", () => {
    expect(TOOL_GROUPS).toHaveProperty("group:coding");
    expect(TOOL_GROUPS).toHaveProperty("group:web");
    expect(TOOL_GROUPS).toHaveProperty("group:memory");
    expect(TOOL_GROUPS).toHaveProperty("group:scheduling");
    expect(TOOL_GROUPS).toHaveProperty("group:messaging");
    expect(TOOL_GROUPS).toHaveProperty("group:sessions");
    expect(TOOL_GROUPS).toHaveProperty("group:platform_actions");
    expect(TOOL_GROUPS).toHaveProperty("group:supervisor");
  });

  it("group:supervisor contains all 10 privileged tools", () => {
    const supervisor = TOOL_GROUPS["group:supervisor"]!;
    expect(supervisor).toHaveLength(10);
    expect(supervisor).toContain("agents_manage");
    expect(supervisor).toContain("obs_query");
    expect(supervisor).toContain("sessions_manage");
    expect(supervisor).toContain("memory_manage");
    expect(supervisor).toContain("channels_manage");
    expect(supervisor).toContain("tokens_manage");
    expect(supervisor).toContain("models_manage");
    expect(supervisor).toContain("skills_manage");
    expect(supervisor).toContain("mcp_manage");
    expect(supervisor).toContain("heartbeat_manage");
  });

  it("group:sessions contains all 9 session tools including session_search", () => {
    const sessions = TOOL_GROUPS["group:sessions"]!;
    expect(sessions).toHaveLength(8);
    expect(sessions).toContain("sessions_list");
    expect(sessions).toContain("sessions_history");
    expect(sessions).toContain("sessions_send");
    expect(sessions).toContain("sessions_spawn");
    expect(sessions).toContain("session_status");
    expect(sessions).toContain("session_search");
    expect(sessions).toContain("subagents");
    expect(sessions).toContain("pipeline");
  });

  it("group:scheduling contains only cron", () => {
    expect(TOOL_GROUPS["group:scheduling"]).toEqual(["cron"]);
  });

  it("group:messaging contains only message", () => {
    expect(TOOL_GROUPS["group:messaging"]).toEqual(["message"]);
  });

  it("group:coding includes apply_patch", () => {
    expect(TOOL_GROUPS["group:coding"]).toContain("apply_patch");
    expect(TOOL_GROUPS["group:coding"]).toHaveLength(9);
  });
});

describe("applyToolPolicy - coding profile", () => {
  it("coding profile includes all 9 coding tools", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, { profile: "coding", allow: [], deny: [] });

    const names = result.tools.map((t) => t.name);
    expect(names).toHaveLength(9);
    expect(names).toContain("read");
    expect(names).toContain("edit");
    expect(names).toContain("write");
    expect(names).toContain("grep");
    expect(names).toContain("find");
    expect(names).toContain("ls");
    expect(names).toContain("apply_patch");
    expect(names).toContain("exec");
    expect(names).toContain("process");
  });
});

describe("applyToolPolicy - supervisor profile", () => {
  it("supervisor profile only allows privileged tools that exist in tool array", () => {
    const tools = [
      ...createMockTools(),
      mockTool("agents_manage"),
      mockTool("obs_query"),
    ];
    const result = applyToolPolicy(tools, { profile: "supervisor", allow: [], deny: [] });
    const names = result.tools.map((t) => t.name);
    expect(names).toHaveLength(2);
    expect(names).toContain("agents_manage");
    expect(names).toContain("obs_query");
  });

  it("supervisor profile does not grant non-privileged tools", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, { profile: "supervisor", allow: [], deny: [] });
    expect(result.tools).toHaveLength(0);
  });

  it("coding profile with group:supervisor allow grants both sets", () => {
    const tools = [
      ...createMockTools(),
      mockTool("agents_manage"),
      mockTool("memory_manage"),
    ];
    const result = applyToolPolicy(tools, {
      profile: "coding",
      allow: ["group:supervisor"],
      deny: [],
    });
    const names = result.tools.map((t) => t.name);
    // coding (9 tools) + 2 privileged tools present in array
    expect(names).toContain("read");
    expect(names).toContain("exec");
    expect(names).toContain("agents_manage");
    expect(names).toContain("memory_manage");
  });

  it("full profile does not implicitly include privileged tools not in tools array", () => {
    const tools = createMockTools();
    const result = applyToolPolicy(tools, { profile: "full", allow: [], deny: [] });
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain("agents_manage");
    expect(names).not.toContain("sessions_manage");
  });

  it("group:supervisor expansion works in allow list", () => {
    const result = expandGroups(["group:supervisor"]);
    expect(result).toHaveLength(10);
    expect(result).toContain("agents_manage");
    expect(result).toContain("tokens_manage");
    expect(result).toContain("skills_manage");
    expect(result).toContain("mcp_manage");
    expect(result).toContain("heartbeat_manage");
  });
});

// ---------------------------------------------------------------------------
// Operational profiles (cron-minimal + heartbeat-minimal)
// ---------------------------------------------------------------------------

/** Tools representative of a real cron context: includes tools in cron-minimal
 *  plus tools that should get filtered out (e.g. subagents, sessions_spawn). */
function createCronTools(): AgentTool<any>[] {
  return [
    mockTool("web_search"),
    mockTool("message"),
    mockTool("read"),
    mockTool("write"),
    mockTool("ls"),
    mockTool("memory_store"),
    mockTool("memory_search"),
    mockTool("cron"),
    mockTool("discover_tools"),
    // Out-of-profile tools that should be filtered
    mockTool("exec"),
    mockTool("browser"),
    mockTool("subagents"),
    mockTool("sessions_spawn"),
    mockTool("yfinance"),
  ];
}

describe("TOOL_PROFILES operational presets", () => {
  it("cron-minimal profile is defined with the documented tool set", () => {
    expect(TOOL_PROFILES["cron-minimal"]).toEqual([
      "web_search",
      "message",
      "read",
      "write",
      "ls",
      "memory_store",
      "memory_search",
      "cron",
      "discover_tools",
    ]);
  });

  it("heartbeat-minimal profile is defined with the documented tool set", () => {
    expect(TOOL_PROFILES["heartbeat-minimal"]).toEqual([
      "message",
      "memory_store",
      "memory_search",
      "discover_tools",
    ]);
  });
});

describe("applyToolPolicy - operational opt-in behavior", () => {
  it("opt-in inheritance: cron job without toolPolicy keeps every tool via agent-level 'full' policy", () => {
    // Scenario: cron job.toolPolicy is undefined, agent.toolPolicy = full
    // Resolution: { profile: "full", allow: [], deny: [] } -> passthrough
    const allTools = createCronTools();
    const fallbackPolicy = { profile: "full", allow: [], deny: [] };
    const result: ToolPolicyResult = applyToolPolicy(allTools, fallbackPolicy);

    expect(result.tools.length).toBe(allTools.length);
    expect(result.filtered.length).toBe(0);
  });

  it("cron-minimal preset filters out-of-profile tools with not_in_profile reason", () => {
    const allTools = createCronTools();
    const result = applyToolPolicy(allTools, {
      profile: "cron-minimal",
      allow: [],
      deny: [],
    });

    const names = result.tools.map((t) => t.name);
    // Tools from TOOL_PROFILES["cron-minimal"] should be present
    for (const allowed of TOOL_PROFILES["cron-minimal"]!) {
      expect(names).toContain(allowed);
    }
    // Out-of-profile tools should be filtered
    expect(names).not.toContain("exec");
    expect(names).not.toContain("browser");
    expect(names).not.toContain("subagents");
    expect(names).not.toContain("yfinance");

    // Each filtered tool should report the profile by name
    expect(result.filtered.length).toBeGreaterThan(0);
    const execFiltered = result.filtered.find((f) => f.toolName === "exec");
    expect(execFiltered).toBeDefined();
    expect(execFiltered!.reason).toEqual({
      kind: "not_in_profile",
      profile: "cron-minimal",
      toolName: "exec",
    });
  });

  it("profile + allow composition: cron-minimal + yfinance keeps yfinance in the tool set", () => {
    const allTools = createCronTools();
    const result = applyToolPolicy(allTools, {
      profile: "cron-minimal",
      allow: ["yfinance"],
      deny: [],
    });

    const names = result.tools.map((t) => t.name);
    expect(names).toContain("yfinance");
    // Still keeps the cron-minimal baseline
    expect(names).toContain("web_search");
    expect(names).toContain("memory_store");
    // Still filters out-of-profile, non-allowed tools
    expect(names).not.toContain("exec");
    expect(names).not.toContain("subagents");
  });

  it("heartbeat-minimal preset keeps only the 4 narrow tools", () => {
    const allTools = createCronTools();
    const result = applyToolPolicy(allTools, {
      profile: "heartbeat-minimal",
      allow: [],
      deny: [],
    });

    const names = result.tools.map((t) => t.name);
    expect(names.sort()).toEqual(["discover_tools", "memory_search", "memory_store", "message"]);
  });
});

describe("gateway denylist invariant", () => {
  it("no profile or group exposes 'gateway' AND SUB_AGENT_TOOL_DENYLIST contains it", () => {
    // Denylist membership — sub-agent-tool-denylist.ts in @comis/core must include 'gateway'.
    expect(SUB_AGENT_TOOL_DENYLIST.has("gateway")).toBe(true);

    // No named profile (except 'full' which means all-tools-allowed and is
    // constrained by the denylist filter in buildExecuteSubAgent) exposes gateway
    for (const [profileName, tools] of Object.entries(TOOL_PROFILES)) {
      if (profileName === "full") continue;
      expect(tools, `profile '${profileName}' must not contain 'gateway'`).not.toContain("gateway");
    }

    // No tool group exposes gateway
    for (const [groupName, tools] of Object.entries(TOOL_GROUPS)) {
      expect(tools, `group '${groupName}' must not contain 'gateway'`).not.toContain("gateway");
    }
  });
});

describe("SUB_AGENT_TOOL_PROFILES drift-guard", () => {
  it("core classification data is consistent with skills canonical TOOL_PROFILES (no drift)", () => {
    // Every profile name in @comis/core must exist in the skills canonical TOOL_PROFILES
    for (const profileName of Object.keys(SUB_AGENT_TOOL_PROFILES)) {
      expect(
        Object.keys(TOOL_PROFILES),
        `SUB_AGENT_TOOL_PROFILES has profile '${profileName}' not present in TOOL_PROFILES — rename in both`,
      ).toContain(profileName);
    }
    // Every tool in a core profile entry must also be present in the skills canonical entry
    // (core copy may be a subset for minimal classification; it must not reference phantom tools)
    for (const [profileName, coreTools] of Object.entries(SUB_AGENT_TOOL_PROFILES)) {
      const canonicalTools = TOOL_PROFILES[profileName] ?? [];
      for (const tool of coreTools) {
        expect(
          canonicalTools,
          `SUB_AGENT_TOOL_PROFILES['${profileName}'] contains '${tool}' but TOOL_PROFILES['${profileName}'] does not — update both`,
        ).toContain(tool);
      }
    }
  });

  // Bidirectional drift guard — catches when canonical adds a tool but core copy doesn't.
  // Also asserts TOOL_GROUPS consistency for the groups that @comis/core mirrors via
  // SUB_AGENT_TOOL_GROUPS.
  it("bidirectional — every canonical TOOL_PROFILES tool also exists in core copy (guards against over-rejection)", () => {
    // For every profile the core copy mirrors, require EXACT equality
    // so divergence in EITHER direction is caught.
    for (const profileName of Object.keys(SUB_AGENT_TOOL_PROFILES)) {
      const core = [...(SUB_AGENT_TOOL_PROFILES[profileName] ?? [])].sort();
      const canon = [...(TOOL_PROFILES[profileName] ?? [])].sort();
      expect(
        core,
        `core/canonical bidirectional drift for profile '${profileName}': sets must be equal`,
      ).toEqual(canon);
    }
  });

  it("SUB_AGENT_TOOL_GROUPS in @comis/core mirrors TOOL_GROUPS from @comis/skills (no drift)", () => {
    // SUB_AGENT_TOOL_GROUPS is exported from @comis/core to gate TOOL_GROUPS expansion.
    // Assert the import is defined (not undefined/empty).
    expect(SUB_AGENT_TOOL_GROUPS, "SUB_AGENT_TOOL_GROUPS must be exported from @comis/core").toBeDefined();
    expect(Object.keys(SUB_AGENT_TOOL_GROUPS).length).toBeGreaterThan(0);

    // Every key/value in SUB_AGENT_TOOL_GROUPS must match TOOL_GROUPS exactly (bidirectional)
    for (const [groupKey, coreTools] of Object.entries(SUB_AGENT_TOOL_GROUPS)) {
      const canonicalTools = TOOL_GROUPS[groupKey];
      expect(
        canonicalTools,
        `SUB_AGENT_TOOL_GROUPS['${groupKey}'] exists in core but not in TOOL_GROUPS — update both`,
      ).toBeDefined();
      expect(
        [...coreTools].sort(),
        `SUB_AGENT_TOOL_GROUPS['${groupKey}'] core/canonical drift — sets must be equal`,
      ).toEqual([...(canonicalTools ?? [])].sort());
    }

    // Every TOOL_GROUPS key must exist in SUB_AGENT_TOOL_GROUPS
    for (const groupKey of Object.keys(TOOL_GROUPS)) {
      expect(
        Object.keys(SUB_AGENT_TOOL_GROUPS),
        `TOOL_GROUPS['${groupKey}'] exists in skills but not in SUB_AGENT_TOOL_GROUPS — update core`,
      ).toContain(groupKey);
    }
  });
});
