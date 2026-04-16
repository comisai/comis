import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import { applyToolPolicy, TOOL_PROFILES, TOOL_GROUPS, expandGroups } from "./tool-policy.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolFilterReason, ToolPolicyResult } from "./tool-policy.js";

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
    mockTool("agents_list"),
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
    expect(sessions).toHaveLength(9);
    expect(sessions).toContain("sessions_list");
    expect(sessions).toContain("sessions_history");
    expect(sessions).toContain("sessions_send");
    expect(sessions).toContain("sessions_spawn");
    expect(sessions).toContain("session_status");
    expect(sessions).toContain("session_search");
    expect(sessions).toContain("subagents");
    expect(sessions).toContain("agents_list");
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
