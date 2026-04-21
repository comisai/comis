// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import {
  LEAN_TOOL_DESCRIPTIONS,
  TOOL_SUMMARIES,
  TOOL_GUIDES,
  TOOL_ORDER,
  resolveDescription,
  getToolGuideWithSchema,
  type ToolDescriptionContext,
} from "./tool-descriptions.js";
import { registerToolMetadata } from "@comis/core";

// ---------------------------------------------------------------------------
// Map invariants
// ---------------------------------------------------------------------------

describe("LEAN_TOOL_DESCRIPTIONS", () => {
  it("all entries resolve to <=300 chars", () => {
    const ctx: ToolDescriptionContext = { modelTier: "large", trustLevel: "default" };
    for (const [name, entry] of Object.entries(LEAN_TOOL_DESCRIPTIONS)) {
      const resolved = typeof entry === "function" ? entry(ctx) : entry;
      expect(resolved.length, `${name} is ${resolved.length} chars: "${resolved}"`).toBeLessThanOrEqual(300);
    }
  });

  it("has entries for all 46 tools (excludes 6 native file tools)", () => {
    expect(Object.keys(LEAN_TOOL_DESCRIPTIONS).length).toBe(46);
  });
});

describe("TOOL_SUMMARIES", () => {
  it("entries are 4-8 words", () => {
    for (const [name, summary] of Object.entries(TOOL_SUMMARIES)) {
      const words = summary.split(/\s+/).filter(Boolean);
      expect(words.length, `${name} has ${words.length} words: "${summary}"`).toBeGreaterThanOrEqual(4);
      expect(words.length, `${name} has ${words.length} words: "${summary}"`).toBeLessThanOrEqual(8);
    }
  });

  it("has entries for all 52 tools", () => {
    expect(Object.keys(TOOL_SUMMARIES).length).toBe(52);
  });
});

// ---------------------------------------------------------------------------
// TOOL_GUIDES map invariants
// ---------------------------------------------------------------------------

describe("TOOL_GUIDES", () => {
  it("has entries for all 12 guided tools", () => {
    const expected = [
      "agents_manage", "apply_patch", "channels_manage", "edit", "exec",
      "gateway", "grep", "message", "pipeline", "read", "sessions_spawn", "write",
    ].sort();
    expect(Object.keys(TOOL_GUIDES).sort()).toEqual(expected);
  });

  it("all guide entries are non-empty strings", () => {
    for (const [name, guide] of Object.entries(TOOL_GUIDES)) {
      expect(typeof guide, `${name} should be a string`).toBe("string");
      expect(guide.length, `${name} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("each guide entry is at least 50 chars", () => {
    for (const [name, guide] of Object.entries(TOOL_GUIDES)) {
      expect(guide.length, `${name} is ${guide.length} chars`).toBeGreaterThanOrEqual(50);
    }
  });

  // Credential Discovery rule — appended to the gateway guide so the LLM
  // probes env_list BEFORE asking the user for an API key / token / secret.
  // Closes the prompt-engineering half of the 2026-04-20 Telegram repro where
  // the agent asked for GEMINI_API_KEY despite it being in ~/.comis/.env.
  it("gateway guide includes credential discovery rule", () => {
    expect(TOOL_GUIDES.gateway).toMatch(/env_list/);
    expect(TOOL_GUIDES.gateway).toMatch(/before asking/i);
  });

  it("gateway guide preserves existing security language", () => {
    expect(TOOL_GUIDES.gateway).toMatch(/## Gateway Security/);
    expect(TOOL_GUIDES.gateway).toMatch(/CRITICAL/);
  });

  it("gateway guide adds Credential Discovery section header", () => {
    expect(TOOL_GUIDES.gateway).toMatch(/## Credential Discovery/);
  });

  // MCP Output Directory rule -- Layer 2 of COMIS-MCP-OUTPUT-SANDBOXING-DESIGN.md.
  // Closes the session 9eb85fdf cascade where gemini-image-mcp wrote outputs
  // outside the workspace and message.attach + sandbox-exec (correctly) rejected them.
  it("gateway guide includes MCP output directory rule", () => {
    expect(TOOL_GUIDES.gateway).toMatch(/workspace\/output\//);
    expect(TOOL_GUIDES.gateway).toMatch(/OUTPUT_DIR/);
    expect(TOOL_GUIDES.gateway).toMatch(/\[a-zA-Z0-9_-\]/);
  });

  it("gateway guide adds MCP Output Directory section header", () => {
    expect(TOOL_GUIDES.gateway).toMatch(/## MCP Output Directory/);
  });

  // Sandbox-forbidden-paths hint -- preventive JIT guide that teaches the agent
  // the rule on first exec use, before sandbox-exec EPERMs trigger the
  // tool-retry-breaker redirect. Paired with the runtime redirect in
  // packages/agent/src/safety/tool-retry-breaker.ts (buildSandboxRedirectMessage).
  it("exec guide includes sandbox-forbidden-paths hint", () => {
    expect(TOOL_GUIDES.exec).toMatch(/skills_manage/);
    expect(TOOL_GUIDES.exec).toMatch(/discover_tools/);
    expect(TOOL_GUIDES.exec).toMatch(/\.comis\/skills/);
    expect(TOOL_GUIDES.exec).toMatch(/node_modules/);
  });

  it("exec guide adds Sandbox-Forbidden Paths section header", () => {
    expect(TOOL_GUIDES.exec).toMatch(/## Sandbox-Forbidden Paths/);
  });
});

describe("key set parity", () => {
  it("LEAN_TOOL_DESCRIPTIONS keys are a subset of TOOL_SUMMARIES keys", () => {
    const leanKeys = Object.keys(LEAN_TOOL_DESCRIPTIONS);
    const summaryKeys = new Set(Object.keys(TOOL_SUMMARIES));
    for (const key of leanKeys) {
      expect(summaryKeys.has(key), `LEAN key "${key}" missing from SUMMARIES`).toBe(true);
    }
  });

  it("TOOL_SUMMARIES keys not in LEAN are accounted for by NATIVE_TOOLS", () => {
    const nativeTools = new Set(["read", "edit", "write", "grep", "find", "ls"]);
    const leanKeys = new Set(Object.keys(LEAN_TOOL_DESCRIPTIONS));
    const summaryKeys = Object.keys(TOOL_SUMMARIES);
    for (const key of summaryKeys) {
      if (!leanKeys.has(key)) {
        expect(nativeTools.has(key), `SUMMARIES key "${key}" not in LEAN and not in NATIVE_TOOLS`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Confusable pair disambiguation
// ---------------------------------------------------------------------------

describe("confusable pair disambiguation", () => {
  const ctx: ToolDescriptionContext = { modelTier: "large", trustLevel: "default" };
  const resolve = (name: string): string => {
    const entry = LEAN_TOOL_DESCRIPTIONS[name];
    return typeof entry === "function" ? entry(ctx) : entry as string;
  };

  it("memory_search mentions session_search", () => {
    expect(resolve("memory_search")).toContain("session_search");
  });

  it("session_search mentions memory_search", () => {
    expect(resolve("session_search")).toContain("memory_search");
  });

  it("sessions_list mentions agents_list", () => {
    expect(resolve("sessions_list")).toContain("agents_list");
  });

  it("agents_list mentions sessions_list", () => {
    expect(resolve("agents_list")).toContain("sessions_list");
  });

  it("sessions_send mentions message", () => {
    expect(resolve("sessions_send")).toContain("message");
  });

  it("message mentions sessions_send", () => {
    expect(resolve("message")).toContain("sessions_send");
  });

  it("sessions_manage mentions sessions_list", () => {
    expect(resolve("sessions_manage")).toContain("sessions_list");
  });

  it("memory_manage mentions memory_search", () => {
    expect(resolve("memory_manage")).toContain("memory_search");
  });
});

// ---------------------------------------------------------------------------
// resolveDescription fallback chain
// ---------------------------------------------------------------------------

describe("resolveDescription", () => {
  it("returns dynamic result for function entry with ctx", () => {
    const ctx: ToolDescriptionContext = { channelType: "telegram", modelTier: "large" };
    const result = resolveDescription({ name: "message" }, LEAN_TOOL_DESCRIPTIONS, ctx);
    expect(result).toContain("telegram");
    expect(result).toContain("sessions_send");
  });

  it("returns tool name for removed native tool (fallback)", () => {
    const result = resolveDescription({ name: "read" }, LEAN_TOOL_DESCRIPTIONS);
    expect(result).toBe("read");
  });

  it("returns tool name for unknown tool", () => {
    const result = resolveDescription({ name: "zzz_unknown" }, LEAN_TOOL_DESCRIPTIONS);
    expect(result).toBe("zzz_unknown");
  });

  it("message tool returns channel-adapted text", () => {
    const discord = resolveDescription(
      { name: "message" },
      LEAN_TOOL_DESCRIPTIONS,
      { channelType: "discord", modelTier: "large" },
    );
    expect(discord).toContain("discord");

    const fallback = resolveDescription(
      { name: "message" },
      LEAN_TOOL_DESCRIPTIONS,
      { modelTier: "large" },
    );
    expect(fallback).toContain("chat");
  });

  it("message tool uses 'chat' fallback when no ctx provided", () => {
    const result = resolveDescription({ name: "message" }, LEAN_TOOL_DESCRIPTIONS);
    expect(result).toContain("chat");
  });

  it("agents_manage omits 'Admin required' when trustLevel is admin", () => {
    const result = resolveDescription(
      { name: "agents_manage" },
      LEAN_TOOL_DESCRIPTIONS,
      { trustLevel: "admin", modelTier: "large" },
    );
    expect(result).not.toContain("Admin required");
  });

  it("agents_manage includes 'Admin required' when trustLevel is not admin", () => {
    const result = resolveDescription(
      { name: "agents_manage" },
      LEAN_TOOL_DESCRIPTIONS,
      { trustLevel: "default", modelTier: "large" },
    );
    expect(result).toContain("Admin required");
  });

  it("all privileged tool dynamic builders follow admin suffix pattern", () => {
    const privileged = [
      "agents_manage", "obs_query", "sessions_manage", "memory_manage",
      "channels_manage", "tokens_manage", "skills_manage", "mcp_manage", "heartbeat_manage",
    ];
    for (const name of privileged) {
      const admin = resolveDescription(
        { name },
        LEAN_TOOL_DESCRIPTIONS,
        { trustLevel: "admin", modelTier: "large" },
      );
      const nonAdmin = resolveDescription(
        { name },
        LEAN_TOOL_DESCRIPTIONS,
        { trustLevel: "default", modelTier: "large" },
      );
      expect(admin, `${name} admin`).not.toContain("Admin required");
      expect(nonAdmin, `${name} non-admin`).toContain("Admin required");
    }
  });
});

// ---------------------------------------------------------------------------
// TOOL_ORDER sanity
// ---------------------------------------------------------------------------

describe("TOOL_ORDER", () => {
  it("contains no duplicates", () => {
    const unique = new Set(TOOL_ORDER);
    expect(unique.size).toBe(TOOL_ORDER.length);
  });

  it("high-frequency tools are at the start", () => {
    const highFreq = ["read", "edit", "notebook_edit", "write", "exec", "message", "memory_search", "web_search"];
    for (let i = 0; i < highFreq.length; i++) {
      expect(TOOL_ORDER[i]).toBe(highFreq[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// getToolGuideWithSchema
// ---------------------------------------------------------------------------

describe("getToolGuideWithSchema", () => {
  // Use a unique tool name for test-only schema registration to avoid
  // leaking into other tests. The __test_schema_tool__ name will never
  // appear in TOOL_GUIDES, so it isolates the schema-only path.
  const TEST_TOOL = "__test_schema_tool__";

  afterEach(() => {
    // Overwrite test schema to prevent cross-test leakage.
    // Spread-merge with undefined values does not delete the key, but
    // the tests only check for non-undefined outputSchema, which is fine.
    registerToolMetadata(TEST_TOOL, { outputSchema: undefined });
  });

  it("returns undefined for tool with no guide and no schema", () => {
    // "ls" has no TOOL_GUIDES entry and no outputSchema registered
    expect(getToolGuideWithSchema("ls")).toBeUndefined();
  });

  it("returns guide text for tool with TOOL_GUIDES entry but no schema", () => {
    // "pipeline" has a TOOL_GUIDES entry but no outputSchema
    const result = getToolGuideWithSchema("pipeline");
    expect(result).toBeDefined();
    expect(result).toContain("Pipeline Usage Guide");
  });

  it("returns schema-only text for tool with outputSchema but no TOOL_GUIDES entry", () => {
    registerToolMetadata(TEST_TOOL, {
      outputSchema: { type: "object", description: "Test schema" },
    });
    const result = getToolGuideWithSchema(TEST_TOOL);
    expect(result).toBeDefined();
    expect(result).toContain("Output Schema");
    expect(result).toContain('"type": "object"');
  });

  it("returns combined guide + schema for tool with both", () => {
    // "exec" has a TOOL_GUIDES entry. Register a test outputSchema for it.
    registerToolMetadata("exec", {
      outputSchema: { type: "string", description: "Test exec schema" },
    });
    const result = getToolGuideWithSchema("exec");
    expect(result).toBeDefined();
    expect(result).toContain("Exec Guide");
    expect(result).toContain("Output Schema");
  });

  it("schema text includes JSON code fence markers", () => {
    registerToolMetadata(TEST_TOOL, {
      outputSchema: { type: "object", description: "Fence test" },
    });
    const result = getToolGuideWithSchema(TEST_TOOL)!;
    expect(result).toContain("```json");
    expect(result).toContain("```");
  });
});
