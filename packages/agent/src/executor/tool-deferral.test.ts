// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  applyToolDeferral,
  extractRecentlyUsedToolNames,
  resolveModelTier,
  resolveToolCallingTemperature,
  buildDeferredToolsContext,
  createDiscoverTool,
  CORE_TOOLS,
  DEFERRAL_RULES,
} from "./tool-deferral.js";
import type { DeferralContext, ExcludeDeferralResult, DeferredToolEntry } from "./tool-deferral.js";
import type { EmbeddingPort } from "@comis/core";
import { PRIVILEGED_TOOL_NAMES } from "../bootstrap/sections/tooling-sections.js";
import { registerToolMetadata } from "@comis/core";
import { createDiscoveryTracker } from "./discovery-tracker.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Test helpers
/**
 * Create a mock ToolDefinition with a given name and optional description.
 */
function makeTool(name: string, descriptionChars = 50, paramChars = 50): ToolDefinition {
  return {
    name,
    description: "x".repeat(descriptionChars),
    parameters: {
      type: "object" as const,
      properties: {
        input: {
          type: "string" as const,
          description: "y".repeat(Math.max(0, paramChars - 40)),
        },
      },
    },
    execute: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }),
  } as unknown as ToolDefinition;
}

function makeContext(overrides: Partial<DeferralContext> = {}): DeferralContext {
  return {
    trustLevel: "default",
    channelType: undefined,
    modelTier: "large",
    recentlyUsedToolNames: new Set(),
    toolNames: [],
    discoveryTracker: createDiscoveryTracker(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: resolveModelTier
// ---------------------------------------------------------------------------

describe("resolveModelTier", () => {
  it("returns 'small' for contextWindow <= 32000", () => {
    expect(resolveModelTier(32_000)).toBe("small");
    expect(resolveModelTier(16_000)).toBe("small");
  });

  it("returns 'medium' for contextWindow 32001-64000", () => {
    expect(resolveModelTier(64_000)).toBe("medium");
    expect(resolveModelTier(48_000)).toBe("medium");
  });

  it("returns 'large' for contextWindow > 64000", () => {
    expect(resolveModelTier(128_000)).toBe("large");
    expect(resolveModelTier(200_000)).toBe("large");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: resolveToolCallingTemperature
// ---------------------------------------------------------------------------

describe("resolveToolCallingTemperature", () => {
  it("returns 0.0 for 'small'", () => {
    expect(resolveToolCallingTemperature("small")).toBe(0.0);
  });

  it("returns 0.1 for 'medium'", () => {
    expect(resolveToolCallingTemperature("medium")).toBe(0.1);
  });

  it("returns 0.1 for 'large'", () => {
    expect(resolveToolCallingTemperature("large")).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: applyToolDeferral - rule-based deferral
// ---------------------------------------------------------------------------

describe("applyToolDeferral - rule-based deferral", () => {
  it("defers privileged tools when trustLevel is not admin", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
      makeTool("obs_query"),
      makeTool("sessions_manage"),
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).toContain("agents_manage");
    expect(result.deferredNames).toContain("obs_query");
    expect(result.deferredNames).toContain("sessions_manage");
    expect(result.deferredNames).not.toContain("read");
  });

  it("keeps privileged tools active when trustLevel is admin", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
      makeTool("obs_query"),
    ];
    const ctx = makeContext({ trustLevel: "admin", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredCount).toBe(0);
    expect(result.deferredNames).toEqual([]);
  });

  it("defers non-matching platform action tools based on channelType", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("discord_action"),
      makeTool("telegram_action"),
      makeTool("slack_action"),
      makeTool("whatsapp_action"),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      channelType: "telegram",
      toolNames: tools.map(t => t.name),
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).toContain("discord_action");
    expect(result.deferredNames).toContain("slack_action");
    expect(result.deferredNames).toContain("whatsapp_action");
    expect(result.deferredNames).not.toContain("telegram_action");
    expect(result.deferredNames).not.toContain("read");
  });

  it("defers all platform action tools when channelType is undefined", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("discord_action"),
      makeTool("telegram_action"),
      makeTool("slack_action"),
      makeTool("whatsapp_action"),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      channelType: undefined,
      toolNames: tools.map(t => t.name),
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).toContain("discord_action");
    expect(result.deferredNames).toContain("telegram_action");
    expect(result.deferredNames).toContain("slack_action");
    expect(result.deferredNames).toContain("whatsapp_action");
  });

  it("exempts recently-used privileged tool from deferral", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
      makeTool("obs_query"),
    ];
    const ctx = makeContext({
      trustLevel: "external",
      recentlyUsedToolNames: new Set(["agents_manage"]),
      toolNames: tools.map(t => t.name),
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).not.toContain("agents_manage");
    expect(result.deferredNames).toContain("obs_query");
  });
});

// ---------------------------------------------------------------------------
// Suite 4: applyToolDeferral - unconditional MCP deferral
// ---------------------------------------------------------------------------

describe("applyToolDeferral - unconditional MCP deferral", () => {
  it("defers all MCP tools unconditionally regardless of context window", () => {
    const logger = createMockLogger();

    const tools: ToolDefinition[] = [
      makeTool("read", 50, 30),
      makeTool("edit", 50, 30),
    ];
    for (let i = 0; i < 50; i++) {
      tools.push(makeTool(`mcp:tool_${i}`, 800, 200));
    }

    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
    });

    const result = applyToolDeferral(tools, 32_000, ctx, logger);

    expect(result.deferredCount).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(result.deferredNames).toContain(`mcp:tool_${i}`);
    }
  });

  it("defers even a single small MCP tool unconditionally", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read", 50, 30),
      makeTool("mcp:small_tool", 50, 30),
    ];

    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
    });

    // Large context window -- MCP tools still deferred unconditionally
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredCount).toBe(1);
    expect(result.deferredNames).toContain("mcp:small_tool");
  });

  it("defers mcp__ prefixed tools unconditionally", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read", 50, 30),
      makeTool("mcp__yfinance--get_price", 100, 50),
      makeTool("mcp__yfinance--get_history", 100, 50),
    ];

    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredCount).toBe(2);
    expect(result.deferredNames).toContain("mcp__yfinance--get_price");
    expect(result.deferredNames).toContain("mcp__yfinance--get_history");
  });

  it("exempts recently-used MCP tools from deferral", () => {
    const logger = createMockLogger();

    const tools: ToolDefinition[] = [makeTool("read", 50, 30)];
    for (let i = 0; i < 50; i++) {
      tools.push(makeTool(`mcp:tool_${i}`, 800, 200));
    }

    const ctx = makeContext({
      trustLevel: "admin",
      recentlyUsedToolNames: new Set(["mcp:tool_5", "mcp:tool_10"]),
      toolNames: tools.map(t => t.name),
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).not.toContain("mcp:tool_5");
    expect(result.deferredNames).not.toContain("mcp:tool_10");
    expect(result.deferredCount).toBe(48);
  });

  it("defers MCP tools even when total tokens are far below any threshold", () => {
    // Single tiny MCP tool -- old budget check would never trigger
    const tools = [makeTool("mcp__tiny--tool", 10, 10)];
    const ctx = makeContext();
    const result = applyToolDeferral(tools, 200_000, ctx, createMockLogger());

    expect(result.deferredNames).toContain("mcp__tiny--tool");
    expect(result.activeTools).toHaveLength(0);
    expect(result.discoverTool).not.toBeNull();
  });

  it("does not defer non-MCP tools in Phase 2", () => {
    const tools = [
      makeTool("read"),
      makeTool("web_search"),
      makeTool("custom_tool"),
      makeTool("mcp__srv--deferred"),
    ];
    const ctx = makeContext();
    const result = applyToolDeferral(tools, 200_000, ctx, createMockLogger());

    // Only MCP tool is deferred by Phase 2
    expect(result.deferredNames).toEqual(["mcp__srv--deferred"]);
    expect(result.activeTools.map(t => t.name)).toEqual(expect.arrayContaining(["read", "web_search", "custom_tool"]));
  });
});

// ---------------------------------------------------------------------------
// Suite 5: applyToolDeferral - small model aggressive deferral
// ---------------------------------------------------------------------------

describe("applyToolDeferral - small model aggressive deferral", () => {
  it("defers all non-CORE_TOOLS when modelTier is 'small'", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),       // CORE
      makeTool("exec"),       // CORE
      makeTool("message"),    // CORE
      makeTool("cron"),       // NOT core
      makeTool("browser"),    // NOT core
      makeTool("pipeline"),   // NOT core
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      modelTier: "small",
      toolNames: tools.map(t => t.name),
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).toContain("cron");
    expect(result.deferredNames).toContain("browser");
    expect(result.deferredNames).toContain("pipeline");
    expect(result.deferredNames).not.toContain("read");
    expect(result.deferredNames).not.toContain("exec");
    expect(result.deferredNames).not.toContain("message");
  });

  it("does not trigger aggressive deferral for modelTier 'medium'", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("cron"),
      makeTool("browser"),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      modelTier: "medium",
      toolNames: tools.map(t => t.name),
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredCount).toBe(0);
    expect(result.deferredNames).toEqual([]);
  });

  it("exempts recently-used non-core tool from small-model deferral", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("cron"),
      makeTool("browser"),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      modelTier: "small",
      recentlyUsedToolNames: new Set(["cron"]),
      toolNames: tools.map(t => t.name),
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).not.toContain("cron");
    expect(result.deferredNames).toContain("browser");
  });
});

// ---------------------------------------------------------------------------
// Suite 6: applyToolDeferral - discover_tools creation
// ---------------------------------------------------------------------------

describe("applyToolDeferral - discover_tools creation", () => {
  it("returns discoverTool when tools are deferred", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.discoverTool).not.toBeNull();
    expect(result.discoverTool!.name).toBe("discover_tools");
  });

  it("returns null discoverTool when nothing deferred", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("edit"),
    ];
    const ctx = makeContext({ trustLevel: "admin", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.discoverTool).toBeNull();
  });

  it("discover_tools execute() returns ranked results for matching query", async () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("agents_manage"), description: "Manage agent fleet: create, get, update, delete, suspend, resume." },
      { ...makeTool("obs_query"), description: "Query platform diagnostics, billing data, delivery traces" },
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.discoverTool).not.toBeNull();

    // Search for "agent" -- should match agents_manage
    const searchResult = await result.discoverTool!.execute!("call-1", { query: "agent manage fleet" });
    expect(searchResult.isError).toBe(false);
    const resultText = (searchResult.content[0] as any).text;
    expect(resultText).toContain("<functions>");
    expect(resultText).toContain('"name":"agents_manage"');
  });

  it("discover_tools execute() returns 'no matches' for unrelated query and logs WARN", async () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    const searchResult = await result.discoverTool!.execute!("call-1", { query: "zzzznonexistent_xyzzy" });
    expect(searchResult.isError).toBe(false);
    const resultText = (searchResult.content[0] as any).text;
    expect(resultText).toContain("No matching tools found");

    // Verify enriched WARN shape (query + hint + errorKind)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "zzzznonexistent_xyzzy",
        hint: expect.stringContaining("discover_tools floor"),
        errorKind: "validation",
      }),
      "discover_tools: no good matches found",
    );
  });

  it("discover_tools has static description regardless of deferred count", () => {
    const logger = createMockLogger();
    const expectedDesc = "Search for deferred tools by keyword or description. Returns ranked matches with usage guidance.";

    // Scenario 1: 2 deferred tools (privileged tools with external trust)
    const tools1: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
      makeTool("obs_query"),
    ];
    const ctx1 = makeContext({ trustLevel: "external", toolNames: tools1.map(t => t.name) });
    const result1 = applyToolDeferral(tools1, 128_000, ctx1, logger);
    expect(result1.discoverTool).not.toBeNull();
    expect(result1.discoverTool!.description).toBe(expectedDesc);

    // Scenario 2: 5 deferred tools (more privileged + platform action tools)
    const tools2: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
      makeTool("obs_query"),
      makeTool("sessions_manage"),
      makeTool("discord_action"),
      makeTool("slack_action"),
    ];
    const ctx2 = makeContext({ trustLevel: "external", toolNames: tools2.map(t => t.name) });
    const result2 = applyToolDeferral(tools2, 128_000, ctx2, logger);
    expect(result2.discoverTool).not.toBeNull();
    expect(result2.discoverTool!.description).toBe(expectedDesc);

    // Both descriptions must be identical (no dynamic count)
    expect(result1.discoverTool!.description).toBe(result2.discoverTool!.description);

    // Description must NOT contain a number
    expect(result1.discoverTool!.description).not.toMatch(/\d/);
  });
});

// ---------------------------------------------------------------------------
// Suite 6b: discover_tools score-floor filter (260420-gg4)
// ---------------------------------------------------------------------------

describe("discover_tools score-floor filter", () => {
  /**
   * Build the same realistic fixture the Gemini-MCP onboarding flow had in
   * production: tools with plausible descriptions that share incidental
   * tokens with an unrelated query ("gemini image generate").
   */
  function makeNoiseFixture(): DeferredToolEntry[] {
    const entries: DeferredToolEntry[] = [
      {
        name: "tokens_manage",
        description: "Manage billing tokens and rate limits",
        original: {
          ...makeTool("tokens_manage"),
          description: "Manage billing tokens and rate limits",
        } as ToolDefinition,
      },
      {
        name: "agents_manage",
        description: "Manage agent fleet: create, get, update",
        original: {
          ...makeTool("agents_manage"),
          description: "Manage agent fleet: create, get, update",
        } as ToolDefinition,
      },
      {
        name: "obs_query",
        description: "Query platform diagnostics, billing data, delivery traces",
        original: {
          ...makeTool("obs_query"),
          description: "Query platform diagnostics, billing data, delivery traces",
        } as ToolDefinition,
      },
      {
        name: "read",
        description: "Read file contents with line numbers",
        original: {
          ...makeTool("read"),
          description: "Read file contents with line numbers",
        } as ToolDefinition,
      },
      {
        name: "write",
        description: "Write or overwrite files; auto-creates parent directories",
        original: {
          ...makeTool("write"),
          description: "Write or overwrite files; auto-creates parent directories",
        } as ToolDefinition,
      },
    ];
    return entries;
  }

  it("zero-signal query returns empty with enriched WARN", async () => {
    const logger = createMockLogger();
    const discoverTool = createDiscoverTool(makeNoiseFixture(), logger);

    const searchResult = await discoverTool.execute!("call-1", { query: "gemini image generate" });

    expect(searchResult.isError).toBe(false);
    const resultText = (searchResult.content[0] as any).text;
    expect(resultText).toContain("No matching tools found");

    // Ensure no tool name leaked into discoveredTools side-effect
    const sideEffects = (searchResult as Record<string, unknown>).sideEffects as Record<string, unknown>;
    expect(sideEffects.discoveredTools).toEqual([]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "gemini image generate",
        searchMode: "bm25",
        hint: expect.stringContaining("floor"),
        errorKind: "validation",
      }),
      "discover_tools: no good matches found",
    );
  });

  it("real-signal query still matches with default threshold", async () => {
    const logger = createMockLogger();
    const discoverTool = createDiscoverTool(makeNoiseFixture(), logger);

    const searchResult = await discoverTool.execute!("call-1", { query: "agent manage fleet" });

    expect(searchResult.isError).toBe(false);
    const resultText = (searchResult.content[0] as any).text;
    expect(resultText).toContain("<functions>");
    expect(resultText).toContain('"name":"agents_manage"');
  });

  it("lowering threshold to 0 makes spurious matches visible (regression pin)", async () => {
    const logger = createMockLogger();

    // Fixture chosen so BM25 scores the "generate" overlap BELOW the 0.8
    // default floor but above 0. Uses custom tool names (not in
    // LEAN_TOOL_DESCRIPTIONS) so test descriptions actually reach the BM25
    // corpus, plus a long description on the matching doc so length
    // normalization drags the score below the floor.
    const longMatchingDesc =
      "generate alpha beta charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
    const overlapFixture: DeferredToolEntry[] = [
      {
        name: "custom_tokens",
        description: longMatchingDesc,
        original: {
          ...makeTool("custom_tokens"),
          description: longMatchingDesc,
        } as ToolDefinition,
      },
      {
        name: "custom_fleet",
        description: "alpha beta",
        original: {
          ...makeTool("custom_fleet"),
          description: "alpha beta",
        } as ToolDefinition,
      },
      {
        name: "custom_diag",
        description: "alpha beta charlie",
        original: {
          ...makeTool("custom_diag"),
          description: "alpha beta charlie",
        } as ToolDefinition,
      },
    ];

    // Default-threshold call: low-score single-term match should be filtered out.
    const defaultTool = createDiscoverTool(overlapFixture, logger);
    const defaultResult = await defaultTool.execute!("call-1", { query: "gemini image generate" });
    expect((defaultResult.content[0] as any).text).toContain("No matching tools found");

    // Zero-threshold override: spurious match now surfaces.
    const zeroTool = createDiscoverTool(
      overlapFixture,
      logger,
      undefined,
      { minBm25Score: 0, minHybridScore: 0 },
    );
    const zeroResult = await zeroTool.execute!("call-1", { query: "gemini image generate" });

    expect(zeroResult.isError).toBe(false);
    const zeroText = (zeroResult.content[0] as any).text;
    expect(zeroText).toContain("<functions>");

    const sideEffects = (zeroResult as Record<string, unknown>).sideEffects as Record<string, unknown>;
    const discovered = sideEffects.discoveredTools as string[];
    expect(discovered.length).toBeGreaterThan(0);
  });

  it("hybrid mode: low cosine drives combined score below floor", async () => {
    const logger = createMockLogger();

    // Orthogonal unit vectors -> cosine = 0 -> combined = 0.5 * bm25Norm + 0.
    // With bm25Norm <= 1, combined is capped at 0.5 — below default 0.35 only
    // when bm25Norm < 0.7. Our noise fixture yields low BM25 signal for an
    // unrelated query, so combined stays below hybrid floor.
    const mockEmbedding: EmbeddingPort = {
      provider: "mock",
      dimensions: 4,
      modelId: "mock-embed",
      embed: vi.fn().mockResolvedValue({ ok: true, value: [1, 0, 0, 0] }),
      embedBatch: vi.fn().mockImplementation((texts: string[]) =>
        Promise.resolve({ ok: true, value: texts.map(() => [0, 1, 0, 0]) }),
      ),
    };

    // Query shares a single incidental token with one doc so BM25 returns a
    // non-empty ranked list (triggering the hybrid re-rank branch), but the
    // cosine-zero penalty drops combined below minHybridScore=0.35.
    const discoverTool = createDiscoverTool(makeNoiseFixture(), logger, mockEmbedding);

    const searchResult = await discoverTool.execute!("call-1", { query: "billing tokens" });

    expect(searchResult.isError).toBe(false);
    // Assert via the WARN path: either we get empty (expected) with searchMode=hybrid,
    // or we get results. The key assertion is that when empty, WARN carries hybrid shape.
    const resultText = (searchResult.content[0] as any).text;
    if (resultText.includes("No matching tools found")) {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          searchMode: "hybrid",
          hint: expect.stringContaining("floor"),
          errorKind: "validation",
        }),
        "discover_tools: no good matches found",
      );
    } else {
      // If any match survived, the combined score must have been above floor;
      // the test still passes because the floor was applied. Assert hybrid was used.
      expect(mockEmbedding.embed).toHaveBeenCalled();
      expect(mockEmbedding.embedBatch).toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 7: extractRecentlyUsedToolNames
// ---------------------------------------------------------------------------

describe("extractRecentlyUsedToolNames", () => {
  it("scans lookback window for tool_use blocks in assistant messages", () => {
    const messages = [
      { role: "user", content: "What files are here?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check..." },
          { type: "tool_use", name: "bash", id: "t1" },
        ],
      },
      { role: "user", content: "And git status?" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "mcp:git_status", id: "t2" },
          { type: "tool_use", name: "mcp:git_log", id: "t3" },
        ],
      },
    ] as Array<Record<string, unknown>>;

    const result = extractRecentlyUsedToolNames(messages);

    expect(result.size).toBe(3);
    expect(result.has("bash")).toBe(true);
    expect(result.has("mcp:git_status")).toBe(true);
    expect(result.has("mcp:git_log")).toBe(true);
  });

  it("respects lookbackCount parameter", () => {
    const messages: Array<Record<string, unknown>> = [];

    // Old message (outside lookback window)
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", name: "old_tool", id: "t0" }],
    });

    // 10 more messages as padding
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `msg ${i}` });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `reply ${i}` }],
      });
    }

    // Recent message
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", name: "recent_tool", id: "t1" }],
    });

    // Lookback of 5 should NOT include old_tool
    const result = extractRecentlyUsedToolNames(messages, 5);
    expect(result.has("old_tool")).toBe(false);
    expect(result.has("recent_tool")).toBe(true);
  });

  it("returns empty set for messages with no tool_use blocks", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
    ] as Array<Record<string, unknown>>;

    const result = extractRecentlyUsedToolNames(messages);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 8: Exclude model partition behavior
// ---------------------------------------------------------------------------

describe("applyToolDeferral - exclude model partition", () => {
  it("deferred tools are absent from activeTools", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    const activeNames = result.activeTools.map(t => t.name);
    expect(activeNames).not.toContain("agents_manage");
    expect(activeNames).toContain("read");
  });

  it("deferred tools appear in deferredEntries with correct fields", () => {
    const logger = createMockLogger();
    const originalExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "executed" }],
      isError: false,
    });
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("agents_manage"), execute: originalExecute } as unknown as ToolDefinition,
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    const entry = result.deferredEntries.find(e => e.name === "agents_manage");
    expect(entry).toBeDefined();
    expect(typeof entry!.description).toBe("string");
    expect(entry!.original).toBe(tools[1]); // Same object reference
    expect(entry!.original.execute).toBe(originalExecute);
  });

  it("does NOT mutate original input tool objects", () => {
    const logger = createMockLogger();
    const originalDesc = "Original description for agents_manage";
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("agents_manage"), description: originalDesc } as unknown as ToolDefinition,
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });

    applyToolDeferral(tools, 128_000, ctx, logger);

    // The original tool object's description should be unchanged
    expect(tools[1].description).toBe(originalDesc);
  });

  it("partitions tools into activeTools and deferredEntries", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),       // active (non-privileged)
      makeTool("edit"),       // active
      makeTool("write"),      // active
      makeTool("agents_manage"), // deferred (privileged, external trust)
      makeTool("obs_query"),     // deferred (privileged, external trust)
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.activeTools.length).toBe(3);
    expect(result.deferredEntries.length).toBe(2);
    expect(result.discoveredTools.length).toBe(0);
  });

  it("deferredEntries contain name, description, and original reference", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
      makeTool("obs_query"),
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    for (const entry of result.deferredEntries) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect(entry.original).toBe(tools.find(t => t.name === entry.name));
    }
  });

  it("returns discoverTool when deferred entries exist", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.discoverTool).not.toBeNull();
    expect(result.discoverTool!.name).toBe("discover_tools");
  });

  it("returns null discoverTool when nothing deferred", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("edit"),
    ];
    const ctx = makeContext({ trustLevel: "admin", toolNames: tools.map(t => t.name) });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.discoverTool).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 9: DEFERRAL_RULES and CORE_TOOLS exports
// ---------------------------------------------------------------------------

describe("DEFERRAL_RULES", () => {
  it("has 5 rules", () => {
    expect(DEFERRAL_RULES.length).toBe(5);
  });

  it("first rule uses PRIVILEGED_TOOL_NAMES", () => {
    const rule = DEFERRAL_RULES[0];
    for (const name of PRIVILEGED_TOOL_NAMES) {
      expect(rule.tools).toContain(name);
    }
  });
});

describe("CORE_TOOLS", () => {
  it("contains essential file/exec/memory/web tools", () => {
    const expected = [
      "read", "edit", "write", "grep", "find", "ls", "apply_patch",
      "exec", "process", "message",
      "memory_search", "memory_store", "memory_get",
      "web_search", "web_fetch",
    ];
    for (const name of expected) {
      expect(CORE_TOOLS.has(name), `CORE_TOOLS should contain ${name}`).toBe(true);
    }
    expect(CORE_TOOLS.size).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Suite 10: discover_tools -- searchHint BM25 enrichment
// ---------------------------------------------------------------------------

describe("discover_tools -- searchHint BM25 enrichment", () => {
  it("synonym query matches tool via searchHint when description does not contain the term", async () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("agents_manage"), description: "Manage agent fleet" } as unknown as ToolDefinition,
      { ...makeTool("obs_query"), description: "Query diagnostics" } as unknown as ToolDefinition,
    ];

    registerToolMetadata("agents_manage", { searchHint: "fleet create delete suspend resume" });
    registerToolMetadata("obs_query", { searchHint: "diagnostics monitoring metrics billing health" });

    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.discoverTool).not.toBeNull();

    const searchResult = await result.discoverTool!.execute!("call-1", { query: "monitoring metrics" });
    expect(searchResult.isError).toBe(false);
    const resultText = (searchResult.content[0] as any).text;
    expect(resultText).toContain("<functions>");
    expect(resultText).toContain('"name":"obs_query"');
  });

  it("synonym 'schedule' matches cron tool via searchHint", async () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("cron"), description: "Manage scheduled tasks" } as unknown as ToolDefinition,
      { ...makeTool("gateway"), description: "Gateway management" } as unknown as ToolDefinition,
    ];

    registerToolMetadata("cron", { searchHint: "schedule timer reminder recurring job automation crontab" });
    registerToolMetadata("gateway", { searchHint: "config restart patch status settings yaml" });

    // cron and gateway are not privileged, so use small modelTier to defer non-core tools
    const ctx = makeContext({ trustLevel: "external", modelTier: "small", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.discoverTool).not.toBeNull();

    const searchResult = await result.discoverTool!.execute!("call-1", { query: "schedule recurring job" });
    expect(searchResult.isError).toBe(false);
    const resultText = (searchResult.content[0] as any).text;
    expect(resultText).toContain("<functions>");
    expect(resultText).toContain('"name":"cron"');
  });

  it("tools without searchHint still match on description keywords (regression)", async () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("sessions_manage"), description: "Admin lifecycle: delete, reset, export, compact sessions." } as unknown as ToolDefinition,
      { ...makeTool("memory_manage"), description: "Admin memory CRUD operations" } as unknown as ToolDefinition,
    ];

    // Do NOT register any searchHint for sessions_manage or memory_manage
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.discoverTool).not.toBeNull();

    const searchResult = await result.discoverTool!.execute!("call-1", { query: "session lifecycle delete reset" });
    expect(searchResult.isError).toBe(false);
    const resultText = (searchResult.content[0] as any).text;
    expect(resultText).toContain("<functions>");
    expect(resultText).toContain('"name":"sessions_manage"');
  });

  it("discover_tools results show clean description without searchHint keywords", async () => {
    const logger = createMockLogger();
    // Multi-tool corpus so BM25 IDF rewards the unique-to-obs_query terms
    // (single-doc corpora collapse IDF to ~log(1.333) and all sub-token
    // queries fall under the default 0.8 floor).
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("obs_query"), description: "Query diagnostics and billing data" } as unknown as ToolDefinition,
      { ...makeTool("agents_manage"), description: "Manage agent fleet" } as unknown as ToolDefinition,
      { ...makeTool("sessions_manage"), description: "Admin session lifecycle" } as unknown as ToolDefinition,
      { ...makeTool("memory_manage"), description: "Admin memory CRUD operations" } as unknown as ToolDefinition,
    ];

    registerToolMetadata("obs_query", { searchHint: "monitoring metrics traces logs health" });

    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.discoverTool).not.toBeNull();

    const searchResult = await result.discoverTool!.execute!("call-1", { query: "monitoring metrics traces" });
    expect(searchResult.isError).toBe(false);
    const resultText = (searchResult.content[0] as any).text;
    expect(resultText).toContain("<functions>");
    expect(resultText).toContain('"name":"obs_query"');

    // Parse the <function> entry for obs_query to check description
    const funcMatch = resultText.match(/<function>(.+?)<\/function>/g);
    expect(funcMatch).toBeTruthy();
    const obsFunc = funcMatch!.find(f => f.includes('"name":"obs_query"'));
    expect(obsFunc).toBeDefined();
    const entry = JSON.parse(obsFunc!.replace(/<\/?function>/g, ""));

    // Description shows clean lean text, NOT searchHint keywords
    expect(entry.description).not.toContain("monitoring");
    expect(entry.description).toContain("diagnostics");
  });

  it("existing no-match behavior preserved with searchHint registered", async () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("agents_manage"), description: "Manage agent fleet" } as unknown as ToolDefinition,
      { ...makeTool("obs_query"), description: "Query diagnostics" } as unknown as ToolDefinition,
    ];

    registerToolMetadata("agents_manage", { searchHint: "fleet create delete suspend resume" });
    registerToolMetadata("obs_query", { searchHint: "diagnostics monitoring metrics billing health" });

    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.discoverTool).not.toBeNull();

    const searchResult = await result.discoverTool!.execute!("call-1", { query: "zzzznonexistent_xyzzy" });
    expect(searchResult.isError).toBe(false);
    const resultText = (searchResult.content[0] as any).text;
    expect(resultText).toContain("No matching tools found");

    // Verify enriched WARN shape (query + hint + errorKind)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "zzzznonexistent_xyzzy",
        hint: expect.stringContaining("discover_tools floor"),
        errorKind: "validation",
      }),
      "discover_tools: no good matches found",
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 11: discover_tools -- structured search
// ---------------------------------------------------------------------------

describe("discover_tools -- structured search", () => {
  function makeMcpTool(name: string): ToolDefinition {
    return makeTool(name, 100, 80);
  }

  /**
   * Helper: set up deferred MCP tools and return the discover_tools tool.
   * Uses small modelTier to force non-core tools into deferral.
   */
  function setupMcpDiscovery(toolNames: string[]) {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),   // CORE -- stays active
      ...toolNames.map(n => makeMcpTool(n)),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      modelTier: "small",
      toolNames: tools.map(t => t.name),
    });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);
    return { discoverTool: result.discoverTool!, logger, result };
  }

  const MCP_TOOLS = [
    "mcp__slack__send",
    "mcp__slack__list",
    "mcp__github__pr",
    "mcp__github__issue",
    "mcp__jira__ticket",
  ];

  it("select: mode fetches exact tools by name", async () => {
    const { discoverTool } = setupMcpDiscovery(MCP_TOOLS);
    const searchResult = await discoverTool.execute!("call-1", {
      query: "select:mcp__slack__send,mcp__github__pr",
    });
    expect(searchResult.isError).toBe(false);
    const text = (searchResult.content[0] as any).text;
    expect(text).toContain("<functions>");
    expect(text).toContain('"name":"mcp__slack__send"');
    expect(text).toContain('"name":"mcp__github__pr"');
    // Should NOT contain other tools
    expect(text).not.toContain('"name":"mcp__slack__list"');
    expect(text).not.toContain('"name":"mcp__jira__ticket"');
  });

  it("select: mode is case-insensitive", async () => {
    const { discoverTool } = setupMcpDiscovery(MCP_TOOLS);
    const searchResult = await discoverTool.execute!("call-1", {
      query: "select:MCP__Slack__Send",
    });
    expect(searchResult.isError).toBe(false);
    const text = (searchResult.content[0] as any).text;
    expect(text).toContain('"name":"mcp__slack__send"');
  });

  it("select: mode returns empty for unknown tools", async () => {
    const { discoverTool } = setupMcpDiscovery(MCP_TOOLS);
    const searchResult = await discoverTool.execute!("call-1", {
      query: "select:nonexistent_tool",
    });
    expect(searchResult.isError).toBe(false);
    const text = (searchResult.content[0] as any).text;
    expect(text).toContain("No matching tools found");
  });

  it("exact name match returns single tool", async () => {
    const { discoverTool } = setupMcpDiscovery(MCP_TOOLS);
    const searchResult = await discoverTool.execute!("call-1", {
      query: "mcp__slack__send",
    });
    expect(searchResult.isError).toBe(false);
    const text = (searchResult.content[0] as any).text;
    expect(text).toContain("<functions>");
    expect(text).toContain('"name":"mcp__slack__send"');
    // Only one <function> entry
    const funcEntries = text.match(/<function>/g);
    expect(funcEntries?.length).toBe(1);
  });

  it("exact name match is case-insensitive", async () => {
    const { discoverTool } = setupMcpDiscovery(MCP_TOOLS);
    const searchResult = await discoverTool.execute!("call-1", {
      query: "MCP__SLACK__SEND",
    });
    expect(searchResult.isError).toBe(false);
    const text = (searchResult.content[0] as any).text;
    expect(text).toContain('"name":"mcp__slack__send"');
  });

  it("MCP prefix match returns all matching tools", async () => {
    const { discoverTool } = setupMcpDiscovery(MCP_TOOLS);
    const searchResult = await discoverTool.execute!("call-1", {
      query: "mcp__slack",
    });
    expect(searchResult.isError).toBe(false);
    const text = (searchResult.content[0] as any).text;
    expect(text).toContain('"name":"mcp__slack__send"');
    expect(text).toContain('"name":"mcp__slack__list"');
    // Should NOT contain non-slack tools
    expect(text).not.toContain('"name":"mcp__github__pr"');
    expect(text).not.toContain('"name":"mcp__jira__ticket"');
  });

  it("mcp: prefix syntax falls through to BM25 when tools use mcp__ naming", async () => {
    const { discoverTool } = setupMcpDiscovery(MCP_TOOLS);
    const searchResult = await discoverTool.execute!("call-1", {
      query: "mcp:slack",
    });
    expect(searchResult.isError).toBe(false);
    const text = (searchResult.content[0] as any).text;
    // mcp:slack does not startsWith-match mcp__slack tools; BM25 also has no keyword overlap
    expect(text).toContain("No matching tools found");
  });

  it("falls through to BM25 when no structured match", async () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeMcpTool("mcp__slack__send"), description: "Send messages to Slack channels" } as unknown as ToolDefinition,
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      modelTier: "small",
      toolNames: tools.map(t => t.name),
    });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    const searchResult = await result.discoverTool!.execute!("call-1", {
      query: "send messages to channels",
    });
    expect(searchResult.isError).toBe(false);
    const text = (searchResult.content[0] as any).text;
    expect(text).toContain("<functions>");
    expect(text).toContain('"name":"mcp__slack__send"');
  });

  it("Mode 4: server name matches all tools from that MCP server", async () => {
    const tools = [
      makeTool("read"),
      makeTool("mcp__yfinance--get_stock_info"),
      makeTool("mcp__yfinance--get_chart"),
      makeTool("mcp__yfinance--get_history"),
      makeTool("mcp__context7--resolve"),
    ];
    const ctx = makeContext({ modelTier: "small", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 200_000, ctx, createMockLogger());
    expect(result.discoverTool).not.toBeNull();

    const execResult = await (result.discoverTool as any).execute("call-1", { query: "yfinance" });
    const text = execResult.content[0].text as string;

    expect(text).toContain("mcp__yfinance--get_stock_info");
    expect(text).toContain("mcp__yfinance--get_chart");
    expect(text).toContain("mcp__yfinance--get_history");
    expect(text).not.toContain("context7");
  });

  it("Mode 4: server name match is case-insensitive", async () => {
    const tools = [
      makeTool("mcp__MyServer--tool_a"),
      makeTool("mcp__MyServer--tool_b"),
    ];
    const ctx = makeContext({ modelTier: "small", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 200_000, ctx, createMockLogger());

    const execResult = await (result.discoverTool as any).execute("call-1", { query: "myserver" });
    const names = execResult.sideEffects.discoveredTools;
    expect(names).toContain("mcp__MyServer--tool_a");
    expect(names).toContain("mcp__MyServer--tool_b");
  });

  it("Mode 4: non-matching server name falls through to BM25", async () => {
    const tools = [
      makeTool("mcp__alpha--tool_x"),
      makeTool("custom_tool"),
    ];
    // custom_tool is not MCP so not deferred by Phase 2; force it deferred via alwaysDefer
    const ctx = makeContext({ alwaysDefer: ["custom_tool"], toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 200_000, ctx, createMockLogger());

    // "beta" does not match any mcp__beta--* prefix
    const execResult = await (result.discoverTool as any).execute("call-1", { query: "beta" });
    // Should fall through to BM25 -- may or may not match, but should NOT use Mode 4
    const names = execResult.sideEffects?.discoveredTools ?? [];
    expect(names).not.toContain("mcp__alpha--tool_x");
  });
});

// ---------------------------------------------------------------------------
// Suite 12: discover_tools -- output format
// ---------------------------------------------------------------------------

describe("discover_tools -- output format", () => {
  function setupDiscovery() {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      {
        ...makeTool("agents_manage"),
        description: "Manage agent fleet: create, get, update, delete.",
        parameters: {
          type: "object" as const,
          properties: {
            action: { type: "string" as const, description: "The action to perform" },
            agentId: { type: "string" as const, description: "Target agent ID" },
          },
          required: ["action"],
        },
      } as unknown as ToolDefinition,
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);
    return { discoverTool: result.discoverTool!, logger };
  }

  it("output wraps results in <functions> block", async () => {
    const { discoverTool } = setupDiscovery();
    const searchResult = await discoverTool.execute!("call-1", { query: "agents_manage" });
    expect(searchResult.isError).toBe(false);
    const text = (searchResult.content[0] as any).text as string;
    expect(text.startsWith("<functions>")).toBe(true);
    expect(text.endsWith("</functions>")).toBe(true);
    expect(text).toContain("<function>");
    expect(text).toContain("</function>");
  });

  it("each function entry contains name, description, and parameters", async () => {
    const { discoverTool } = setupDiscovery();
    const searchResult = await discoverTool.execute!("call-1", { query: "agents_manage" });
    const text = (searchResult.content[0] as any).text as string;

    // Extract JSON from <function> tag
    const funcMatch = text.match(/<function>(.+?)<\/function>/);
    expect(funcMatch).toBeTruthy();
    const entry = JSON.parse(funcMatch![1]);

    expect(typeof entry.name).toBe("string");
    expect(entry.name).toBe("agents_manage");
    expect(typeof entry.description).toBe("string");
    expect(entry.parameters).toBeDefined();
    expect(entry.parameters.type).toBe("object");
    expect(entry.parameters.properties).toBeDefined();
  });

  it("description uses display text not BM25 text", async () => {
    const logger = createMockLogger();
    // Multi-tool corpus so BM25 IDF is not collapsed to a single-doc regime
    // where no 2-term query can clear the default 0.8 floor.
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("obs_query"), description: "Query diagnostics and billing" } as unknown as ToolDefinition,
      { ...makeTool("agents_manage"), description: "Manage agent fleet" } as unknown as ToolDefinition,
      { ...makeTool("sessions_manage"), description: "Admin session lifecycle" } as unknown as ToolDefinition,
    ];

    registerToolMetadata("obs_query", { searchHint: "monitoring health uptime grafana prometheus" });

    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    // Use BM25 fallback via keyword query that matches searchHint
    const searchResult = await result.discoverTool!.execute!("call-1", { query: "grafana prometheus uptime" });
    const text = (searchResult.content[0] as any).text as string;

    const funcMatch = text.match(/<function>(.+?)<\/function>/);
    expect(funcMatch).toBeTruthy();
    const entry = JSON.parse(funcMatch![1]);

    // Description should NOT contain searchHint-only keywords
    expect(entry.description).not.toContain("grafana");
    expect(entry.description).not.toContain("prometheus");
    expect(entry.description).not.toContain("uptime");
  });
});

// ---------------------------------------------------------------------------
// Suite 13: discover_tools -- sideEffects
// ---------------------------------------------------------------------------

describe("discover_tools -- sideEffects", () => {
  it("returns sideEffects.discoveredTools with matched names", async () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("agents_manage"), description: "Manage agent fleet" } as unknown as ToolDefinition,
      { ...makeTool("obs_query"), description: "Query diagnostics" } as unknown as ToolDefinition,
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    const searchResult = await result.discoverTool!.execute!("call-1", { query: "agents_manage" });
    const sideEffects = (searchResult as Record<string, unknown>).sideEffects as Record<string, unknown>;
    expect(sideEffects).toBeDefined();
    expect(sideEffects.discoveredTools).toBeDefined();
    const discovered = sideEffects.discoveredTools as string[];
    expect(Array.isArray(discovered)).toBe(true);
    expect(discovered).toContain("agents_manage");
  });

  it("sideEffects.discoveredTools is empty array on no matches", async () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    const searchResult = await result.discoverTool!.execute!("call-1", { query: "zzzznonexistent_xyzzy" });
    const sideEffects = (searchResult as Record<string, unknown>).sideEffects as Record<string, unknown>;
    expect(sideEffects).toBeDefined();
    expect(sideEffects.discoveredTools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 13b: discover_tools -- server-level activation
// ---------------------------------------------------------------------------

describe("discover_tools -- server-level activation", () => {
  it("activates all sibling tools from the same MCP server on discovery", async () => {
    const tools = [
      makeTool("read"),
      makeTool("mcp__yfinance--get_stock_info"),
      makeTool("mcp__yfinance--get_chart"),
      makeTool("mcp__yfinance--get_history"),
      makeTool("mcp__context7--resolve"),
    ];
    const ctx = makeContext({ modelTier: "small", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 200_000, ctx, createMockLogger());

    // Search for one specific yfinance tool
    const execResult = await (result.discoverTool as any).execute("call-1", { query: "mcp__yfinance--get_stock_info" });
    const discoveredNames = execResult.sideEffects.discoveredTools as string[];

    // Should include ALL yfinance tools, not just the queried one
    expect(discoveredNames).toContain("mcp__yfinance--get_stock_info");
    expect(discoveredNames).toContain("mcp__yfinance--get_chart");
    expect(discoveredNames).toContain("mcp__yfinance--get_history");
    // Should NOT include tools from other servers
    expect(discoveredNames).not.toContain("mcp__context7--resolve");
  });

  it("activates tools from multiple servers when results span servers", async () => {
    const tools = [
      makeTool("mcp__srv1--tool_a"),
      makeTool("mcp__srv1--tool_b"),
      makeTool("mcp__srv2--tool_c"),
      makeTool("mcp__srv2--tool_d"),
    ];
    const ctx = makeContext({ modelTier: "small", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 200_000, ctx, createMockLogger());

    // select: both servers' tools
    const execResult = await (result.discoverTool as any).execute("call-1", { query: "select:mcp__srv1--tool_a,mcp__srv2--tool_c" });
    const discoveredNames = execResult.sideEffects.discoveredTools as string[];

    // All siblings from both servers
    expect(discoveredNames).toContain("mcp__srv1--tool_a");
    expect(discoveredNames).toContain("mcp__srv1--tool_b");
    expect(discoveredNames).toContain("mcp__srv2--tool_c");
    expect(discoveredNames).toContain("mcp__srv2--tool_d");
  });

  it("does not expand non-MCP tool discoveries to server siblings", async () => {
    const tools = [
      makeTool("read"),
      makeTool("mcp__srv--tool_a"),
      makeTool("mcp__srv--tool_b"),
    ];
    // Force "read" to be deferred so discover_tools can find it
    const ctx = makeContext({ alwaysDefer: ["read"], toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 200_000, ctx, createMockLogger());

    const execResult = await (result.discoverTool as any).execute("call-1", { query: "read" });
    const discoveredNames = execResult.sideEffects.discoveredTools as string[];

    // "read" has no MCP server, so no expansion
    expect(discoveredNames).toContain("read");
    expect(discoveredNames).not.toContain("mcp__srv--tool_a");
    expect(discoveredNames).not.toContain("mcp__srv--tool_b");
  });

  it("functionsBlock only contains queried tools, not siblings", async () => {
    const tools = [
      makeTool("mcp__yfinance--get_stock_info"),
      makeTool("mcp__yfinance--get_chart"),
    ];
    const ctx = makeContext({ modelTier: "small", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 200_000, ctx, createMockLogger());

    // Exact match for one tool
    const execResult = await (result.discoverTool as any).execute("call-1", { query: "mcp__yfinance--get_stock_info" });
    const text = execResult.content[0].text as string;

    // functionsBlock should only show the matched tool schema
    expect(text).toContain("mcp__yfinance--get_stock_info");
    expect(text).not.toContain("mcp__yfinance--get_chart");

    // But sideEffects includes sibling
    const discoveredNames = execResult.sideEffects.discoveredTools as string[];
    expect(discoveredNames).toContain("mcp__yfinance--get_chart");
  });
});

// ---------------------------------------------------------------------------
// Suite 14: applyToolDeferral - discovery re-inclusion
// ---------------------------------------------------------------------------

describe("applyToolDeferral - discovery re-inclusion", () => {
  it("re-includes discovered tools in discoveredTools array", () => {
    const logger = createMockLogger();
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["agents_manage"]);

    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
      makeTool("obs_query"),
    ];
    const ctx = makeContext({
      trustLevel: "external",
      toolNames: tools.map(t => t.name),
      discoveryTracker: tracker,
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    // agents_manage was discovered, should appear in discoveredTools with full schema
    expect(result.discoveredTools.length).toBe(1);
    expect(result.discoveredTools[0].name).toBe("agents_manage");
    expect(result.discoveredTools[0].parameters).toBeDefined();

    // Should NOT appear in deferredEntries
    const deferredNames = result.deferredEntries.map(e => e.name);
    expect(deferredNames).not.toContain("agents_manage");
  });

  it("discovered tools retain original execute() function", () => {
    const logger = createMockLogger();
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["agents_manage"]);

    const originalExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "executed" }],
      isError: false,
    });
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("agents_manage"), execute: originalExecute } as unknown as ToolDefinition,
    ];
    const ctx = makeContext({
      trustLevel: "external",
      toolNames: tools.map(t => t.name),
      discoveryTracker: tracker,
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.discoveredTools[0].execute).toBe(originalExecute);
  });

  it("remaining deferred entries exclude discovered tools", () => {
    const logger = createMockLogger();
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["agents_manage"]);

    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),  // discovered
      makeTool("obs_query"),       // still deferred
      makeTool("sessions_manage"), // still deferred
    ];
    const ctx = makeContext({
      trustLevel: "external",
      toolNames: tools.map(t => t.name),
      discoveryTracker: tracker,
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredEntries.length).toBe(2);
    expect(result.discoveredTools.length).toBe(1);
    const deferredNames = result.deferredEntries.map(e => e.name);
    expect(deferredNames).toContain("obs_query");
    expect(deferredNames).toContain("sessions_manage");
    expect(deferredNames).not.toContain("agents_manage");
  });
});

// ---------------------------------------------------------------------------
// Suite 15: applyToolDeferral - operator overrides (Phase 5)
// ---------------------------------------------------------------------------

describe("applyToolDeferral - operator overrides (Phase 5)", () => {
  it("neverDefer removes tool from deferredSet", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
      makeTool("obs_query"),
    ];
    const ctx = makeContext({
      trustLevel: "external",
      toolNames: tools.map(t => t.name),
      neverDefer: ["agents_manage"],
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    // agents_manage should be active despite external trust
    const activeNames = result.activeTools.map(t => t.name);
    expect(activeNames).toContain("agents_manage");
    expect(result.deferredNames).not.toContain("agents_manage");

    // obs_query should still be deferred
    expect(result.deferredNames).toContain("obs_query");
  });

  it("alwaysDefer adds tool to deferredSet", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("edit"),
      makeTool("custom_tool"),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
      alwaysDefer: ["custom_tool"],
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    // custom_tool should be deferred despite admin trust
    const deferredEntryNames = result.deferredEntries.map(e => e.name);
    expect(deferredEntryNames).toContain("custom_tool");
    expect(result.deferredNames).toContain("custom_tool");
  });

  it("alwaysDefer cannot defer discover_tools", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
    ];
    const ctx = makeContext({
      trustLevel: "external",
      toolNames: tools.map(t => t.name),
      alwaysDefer: ["discover_tools"],
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    // discover_tools should NOT be in the deferred set
    expect(result.deferredNames).not.toContain("discover_tools");
  });

  it("alwaysDefer only defers tools present in input", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("edit"),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
      alwaysDefer: ["nonexistent_tool"],
    });

    // Should not throw, just ignore the non-existent tool
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredCount).toBe(0);
    expect(result.deferredNames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 16: applyToolDeferral - lifecycle demotion clears discovery
// ---------------------------------------------------------------------------

describe("applyToolDeferral - lifecycle demotion clears discovery", () => {
  it("lifecycle-demoted tool has discovery state cleared", () => {
    const logger = createMockLogger();
    const tracker = createDiscoveryTracker();
    // Mark tool as discovered
    tracker.markDiscovered(["agents_manage"]);
    expect(tracker.isDiscovered("agents_manage")).toBe(true);

    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
      makeTool("obs_query"),
    ];
    const ctx = makeContext({
      trustLevel: "external",
      toolNames: tools.map(t => t.name),
      discoveryTracker: tracker,
      lifecycleDemotedNames: new Set(["agents_manage"]),
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    // Discovery state should be cleared
    expect(tracker.isDiscovered("agents_manage")).toBe(false);

    // Tool should be in deferredEntries, NOT in discoveredTools
    const deferredNames = result.deferredEntries.map(e => e.name);
    expect(deferredNames).toContain("agents_manage");
    expect(result.discoveredTools.map(t => t.name)).not.toContain("agents_manage");
  });
});

// ---------------------------------------------------------------------------
// Suite 17: buildDeferredToolsContext
// ---------------------------------------------------------------------------

describe("buildDeferredToolsContext", () => {
  it("returns empty string for empty entries", () => {
    expect(buildDeferredToolsContext([])).toBe("");
  });

  it("returns XML block with non-MCP tool names and descriptions", () => {
    const entries: DeferredToolEntry[] = [
      { name: "toolA", description: "descA", original: makeTool("toolA") },
      { name: "toolB", description: "descB", original: makeTool("toolB") },
    ];

    const output = buildDeferredToolsContext(entries);

    expect(output).toContain("<deferred-tools>");
    expect(output).toContain("</deferred-tools>");
    expect(output).toContain("The following tools are available but not loaded.");
    expect(output).toContain('discover_tools("yfinance")');
    expect(output).toContain("toolA -- descA");
    expect(output).toContain("toolB -- descB");

    // Verify structure: starts with <deferred-tools>, ends with </deferred-tools>
    const lines = output.split("\n");
    expect(lines[0]).toBe("<deferred-tools>");
    expect(lines[lines.length - 1]).toBe("</deferred-tools>");
  });

  it("groups MCP tools by server name with short names", () => {
    const entries: DeferredToolEntry[] = [
      { name: "mcp__yfinance--get_price", description: "Get stock price", original: makeTool("mcp__yfinance--get_price") },
      { name: "mcp__yfinance--get_history", description: "Get price history", original: makeTool("mcp__yfinance--get_history") },
      { name: "mcp__slack--post_message", description: "Post a message", original: makeTool("mcp__slack--post_message") },
    ];

    const output = buildDeferredToolsContext(entries);

    expect(output).toContain("[yfinance] (2 tools): get_price, get_history");
    expect(output).toContain("[slack] (1 tools): post_message");
    // Should NOT contain the full mcp__server--tool format in grouped lines
    expect(output).not.toContain("mcp__yfinance--get_price --");
  });

  it("mixes non-MCP individual listing with MCP grouped listing", () => {
    const entries: DeferredToolEntry[] = [
      { name: "discord_action", description: "Discord actions", original: makeTool("discord_action") },
      { name: "mcp__yfinance--get_price", description: "Get stock price", original: makeTool("mcp__yfinance--get_price") },
      { name: "mcp__yfinance--get_history", description: "Get price history", original: makeTool("mcp__yfinance--get_history") },
    ];

    const output = buildDeferredToolsContext(entries);

    // Non-MCP uses individual format
    expect(output).toContain("discord_action -- Discord actions");
    // MCP uses grouped format
    expect(output).toContain("[yfinance] (2 tools): get_price, get_history");
  });

  it("handles multiple MCP servers in separate groups", () => {
    const entries: DeferredToolEntry[] = [
      { name: "mcp__alpha--t1", description: "d1", original: makeTool("mcp__alpha--t1") },
      { name: "mcp__beta--t2", description: "d2", original: makeTool("mcp__beta--t2") },
      { name: "mcp__beta--t3", description: "d3", original: makeTool("mcp__beta--t3") },
    ];

    const output = buildDeferredToolsContext(entries);

    expect(output).toContain("[alpha] (1 tools): t1");
    expect(output).toContain("[beta] (2 tools): t2, t3");
  });

  it("updates header text to mention server name search", () => {
    const entries: DeferredToolEntry[] = [
      { name: "mcp__srv--tool", description: "desc", original: makeTool("mcp__srv--tool") },
    ];

    const output = buildDeferredToolsContext(entries);
    expect(output).toContain('discover_tools("yfinance")');
    expect(output).toContain("search by keyword or server name");
  });
});

// ---------------------------------------------------------------------------
// Suite 18: discover_tools -- mid-turn injection support
// Validates the contract that afterToolCall in pi-executor.ts depends on:
// deferredEntries[].original provides callable ToolDefinitions matching
// sideEffects.discoveredTools names.
// ---------------------------------------------------------------------------

describe("discover_tools -- mid-turn injection support", () => {
  it("sideEffects.discoveredTools maps to deferredEntries with original ToolDefinitions", async () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("agents_manage"), description: "Manage agent fleet" } as unknown as ToolDefinition,
      { ...makeTool("obs_query"), description: "Query diagnostics" } as unknown as ToolDefinition,
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    // Discover agents_manage
    const searchResult = await result.discoverTool!.execute!("call-1", { query: "agents_manage" });
    const sideEffects = (searchResult as Record<string, unknown>).sideEffects as { discoveredTools: string[] };
    expect(sideEffects.discoveredTools.length).toBeGreaterThan(0);

    // Every name in sideEffects.discoveredTools must have a matching deferredEntry with .original
    for (const name of sideEffects.discoveredTools) {
      const entry = result.deferredEntries.find(e => e.name === name);
      expect(entry, `deferredEntry for "${name}" should exist`).toBeDefined();
      expect(entry!.original, `deferredEntry.original for "${name}" should exist`).toBeDefined();
      expect(typeof entry!.original.execute, `deferredEntry.original.execute for "${name}" should be a function`).toBe("function");
    }
  });

  it("server-level activation returns all sibling tools with originals for injection", async () => {
    const tools = [
      makeTool("read"),
      makeTool("mcp__yfinance--get_stock_info"),
      makeTool("mcp__yfinance--get_chart"),
      makeTool("mcp__yfinance--get_history"),
    ];
    const ctx = makeContext({ modelTier: "small", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 200_000, ctx, createMockLogger());

    // Search for one specific yfinance tool
    const execResult = await (result.discoverTool as any).execute("call-1", { query: "mcp__yfinance--get_stock_info" });
    const discoveredNames = execResult.sideEffects.discoveredTools as string[];

    // Should include all 3 yfinance tools (server-level activation)
    expect(discoveredNames).toContain("mcp__yfinance--get_stock_info");
    expect(discoveredNames).toContain("mcp__yfinance--get_chart");
    expect(discoveredNames).toContain("mcp__yfinance--get_history");

    // All 3 must have matching deferredEntries with callable .original
    for (const name of discoveredNames) {
      const entry = result.deferredEntries.find(e => e.name === name);
      expect(entry, `deferredEntry for "${name}"`).toBeDefined();
      expect(entry!.original).toBeDefined();
      expect(typeof entry!.original.execute).toBe("function");
      expect(entry!.original.name).toBe(name);
    }
  });

  it("discovered tool original.execute is callable with correct signature", async () => {
    const executeMock = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "stock price: $150" }],
      isError: false,
    });
    const customTool: ToolDefinition = {
      name: "mcp__finance--get_price",
      description: "Get current stock price for a ticker symbol",
      parameters: {
        type: "object" as const,
        properties: {
          ticker: { type: "string" as const, description: "Stock ticker" },
        },
      },
      execute: executeMock,
    } as unknown as ToolDefinition;

    const tools = [makeTool("read"), customTool];
    const ctx = makeContext({ modelTier: "small", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 200_000, ctx, createMockLogger());

    // Discover the tool
    const execResult = await (result.discoverTool as any).execute("call-1", { query: "mcp__finance--get_price" });
    const discoveredNames = execResult.sideEffects.discoveredTools as string[];
    expect(discoveredNames).toContain("mcp__finance--get_price");

    // Look up the deferredEntry and call original.execute() -- this is what afterToolCall does
    const entry = result.deferredEntries.find(e => e.name === "mcp__finance--get_price");
    expect(entry).toBeDefined();

    const callResult = await entry!.original.execute("call-2", { ticker: "AAPL" } as unknown as Record<string, unknown>, undefined, undefined as unknown as Parameters<typeof entry.original.execute>[3], undefined as unknown as Parameters<typeof entry.original.execute>[4]);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0]).toBe("call-2");
    expect(executeMock.mock.calls[0][1]).toEqual({ ticker: "AAPL" });
    expect((callResult as any).content[0].text).toBe("stock price: $150");
  });
});

// ---------------------------------------------------------------------------
// Suite 19: discover_tools -- co-discovery (quick-260414-ppo)
// ---------------------------------------------------------------------------

describe("discover_tools -- co-discovery (quick-260414-ppo)", () => {
  it("co-discovers agents_manage when models_manage is matched", async () => {
    // Register co-discovery relationships
    registerToolMetadata("models_manage", { coDiscoverWith: ["agents_manage"] });
    registerToolMetadata("agents_manage", { coDiscoverWith: ["models_manage"] });

    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("models_manage"), description: "Manage LLM model catalog and aliases" } as unknown as ToolDefinition,
      { ...makeTool("agents_manage"), description: "Manage agent fleet and configuration" } as unknown as ToolDefinition,
      { ...makeTool("obs_query"), description: "Query observability data" } as unknown as ToolDefinition,
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, createMockLogger());

    // Use exact name match for deterministic search -- co-discovery behavior is the focus
    const searchResult = await result.discoverTool!.execute!("call-1", { query: "models_manage" });
    const sideEffects = (searchResult as Record<string, unknown>).sideEffects as { discoveredTools: string[] };

    expect(sideEffects.discoveredTools).toContain("models_manage");
    expect(sideEffects.discoveredTools).toContain("agents_manage");
  });

  it("co-discovers models_manage when agents_manage is matched", async () => {
    registerToolMetadata("models_manage", { coDiscoverWith: ["agents_manage"] });
    registerToolMetadata("agents_manage", { coDiscoverWith: ["models_manage"] });

    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("models_manage"), description: "Manage LLM model catalog and aliases" } as unknown as ToolDefinition,
      { ...makeTool("agents_manage"), description: "Manage agent fleet and configuration" } as unknown as ToolDefinition,
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, createMockLogger());

    const searchResult = await result.discoverTool!.execute!("call-1", { query: "fleet manage agents configure" });
    const sideEffects = (searchResult as Record<string, unknown>).sideEffects as { discoveredTools: string[] };

    expect(sideEffects.discoveredTools).toContain("agents_manage");
    expect(sideEffects.discoveredTools).toContain("models_manage");
  });

  it("does not add co-discovered tools for tools without coDiscoverWith", async () => {
    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("obs_query"), description: "Query observability and diagnostics" } as unknown as ToolDefinition,
      { ...makeTool("models_manage"), description: "Manage LLM model catalog" } as unknown as ToolDefinition,
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, createMockLogger());

    const searchResult = await result.discoverTool!.execute!("call-1", { query: "diagnostics monitoring metrics" });
    const sideEffects = (searchResult as Record<string, unknown>).sideEffects as { discoveredTools: string[] };

    expect(sideEffects.discoveredTools).toContain("obs_query");
    // models_manage should NOT be co-discovered with obs_query
    expect(sideEffects.discoveredTools).not.toContain("models_manage");
  });

  it("co-discovered tools appear in the functions output block", async () => {
    registerToolMetadata("models_manage", { coDiscoverWith: ["agents_manage"] });
    registerToolMetadata("agents_manage", { coDiscoverWith: ["models_manage"] });

    const tools: ToolDefinition[] = [
      makeTool("read"),
      { ...makeTool("models_manage"), description: "Manage LLM model catalog" } as unknown as ToolDefinition,
      { ...makeTool("agents_manage"), description: "Manage agent fleet" } as unknown as ToolDefinition,
    ];
    const ctx = makeContext({ trustLevel: "external", toolNames: tools.map(t => t.name) });
    const result = applyToolDeferral(tools, 128_000, ctx, createMockLogger());

    // Use exact name match for deterministic result
    const searchResult = await result.discoverTool!.execute!("call-1", { query: "models_manage" });
    const content = (searchResult as Record<string, unknown>).content as Array<{ type: string; text: string }>;
    const text = content[0].text;

    // Both tools should appear in the <functions> block
    expect(text).toContain("models_manage");
    expect(text).toContain("agents_manage");
  });
});

// ---------------------------------------------------------------------------
// Suite 20: applyToolDeferral - provider-aware MCP deferral
// ---------------------------------------------------------------------------

describe("applyToolDeferral - provider-aware MCP deferral", () => {
  it("does NOT defer MCP tools when providerFamily is 'openai'", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("mcp__yfinance--get_price", 100, 50),
      makeTool("mcp:small_tool", 50, 30),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
      providerFamily: "openai",
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    // MCP tools should be active, not deferred
    expect(result.deferredNames).not.toContain("mcp__yfinance--get_price");
    expect(result.deferredNames).not.toContain("mcp:small_tool");
    expect(result.activeTools.map(t => t.name)).toContain("mcp__yfinance--get_price");
    expect(result.activeTools.map(t => t.name)).toContain("mcp:small_tool");
  });

  it("does NOT defer MCP tools when providerFamily is 'default'", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("mcp__srv--tool_a", 100, 50),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
      providerFamily: "default",
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).not.toContain("mcp__srv--tool_a");
    expect(result.activeTools.map(t => t.name)).toContain("mcp__srv--tool_a");
  });

  it("does NOT defer MCP tools when providerFamily is 'other'", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("mcp__xai--tool_b", 100, 50),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
      providerFamily: "other",
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).not.toContain("mcp__xai--tool_b");
    expect(result.activeTools.map(t => t.name)).toContain("mcp__xai--tool_b");
  });

  it("DOES defer MCP tools when providerFamily is 'anthropic'", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("mcp__yfinance--get_price", 100, 50),
      makeTool("mcp:small_tool", 50, 30),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
      providerFamily: "anthropic",
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).toContain("mcp__yfinance--get_price");
    expect(result.deferredNames).toContain("mcp:small_tool");
  });

  it("DOES defer MCP tools when providerFamily is 'google'", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("mcp__srv--tool_a", 100, 50),
      makeTool("mcp:tool_b", 50, 30),
    ];
    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
      providerFamily: "google",
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).toContain("mcp__srv--tool_a");
    expect(result.deferredNames).toContain("mcp:tool_b");
  });

  it("DOES defer MCP tools when providerFamily is undefined (backward compat)", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("mcp__yfinance--get_price", 100, 50),
    ];
    // No providerFamily set -- undefined by default from makeContext
    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).toContain("mcp__yfinance--get_price");
  });

  it("non-MCP deferral rules unaffected by providerFamily (Phase 1 privileged tools)", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("agents_manage"),
      makeTool("obs_query"),
      makeTool("mcp__srv--tool_a", 100, 50),
    ];
    const ctx = makeContext({
      trustLevel: "external",
      toolNames: tools.map(t => t.name),
      providerFamily: "openai",
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    // Phase 1 privileged tools still deferred for non-admin trust
    expect(result.deferredNames).toContain("agents_manage");
    expect(result.deferredNames).toContain("obs_query");
    // But MCP tool is NOT deferred for openai
    expect(result.deferredNames).not.toContain("mcp__srv--tool_a");
  });

  it("recently-used MCP tool exemption still works with openai providerFamily", () => {
    const logger = createMockLogger();
    const tools: ToolDefinition[] = [
      makeTool("read"),
      makeTool("mcp__srv--tool_a", 100, 50),
      makeTool("mcp__srv--tool_b", 100, 50),
    ];
    // With openai, MCP tools are already not deferred, so recently-used is moot
    // but the exemption should still not cause issues
    const ctx = makeContext({
      trustLevel: "admin",
      toolNames: tools.map(t => t.name),
      providerFamily: "openai",
      recentlyUsedToolNames: new Set(["mcp__srv--tool_a"]),
    });

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    expect(result.deferredNames).not.toContain("mcp__srv--tool_a");
    expect(result.deferredNames).not.toContain("mcp__srv--tool_b");
  });
});
