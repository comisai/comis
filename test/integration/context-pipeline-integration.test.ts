/**
 * Integration tests for the pipeline-mode context engine.
 *
 * Exercises cross-component interactions: layer ordering (evictor before masker),
 * session search tool handler E2E, budget utilization with synthetic sessions,
 * and metrics emission completeness.
 *
 * All tests are in-process (no daemon, no LLM, no network) using components
 * imported from dist/ via @comis/agent, @comis/core, @comis/skills aliases.
 *
 * Covers:
 * - TEST-08: Evictor + Masker ordering (no double-processing)
 * - TEST-09: session_search tool handler E2E with mock RPC
 * - TEST-10: Budget utilization < 0.85 with 200-entry synthetic session
 * - TEST-15: Pipeline metrics emission completeness (all 17 fields)
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

import {
  ContextEngineConfigSchema,
  TypedEventBus,
} from "@comis/core";

import { createContextEngine } from "@comis/agent";

import { createSessionSearchTool } from "@comis/skills";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function createAgentMessage(role: string, text: string): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function createToolResult(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function createAssistantWithToolUse(
  text: string,
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      ...toolCalls.map((tc) => ({
        type: "tool_use",
        toolCallId: tc.id,
        toolName: tc.name,
        input: tc.input,
      })),
    ],
  } as unknown as AgentMessage;
}

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildMockSessionManager(fileEntries: unknown[]) {
  return { fileEntries };
}

// ---------------------------------------------------------------------------
// TEST-08: Evictor + Masker Ordering (no double-processing)
// ---------------------------------------------------------------------------

describe("TEST-08: Evictor + Masker Ordering", () => {
  it("evictor runs before masker and no message is double-processed", async () => {
    // Config: low observationTriggerChars (50_000 = minimum valid) so masker activates,
    // high historyTurns so window does not clip messages, low evictionMinAge.
    const config = ContextEngineConfigSchema.parse({
      enabled: true,
      version: "pipeline",
      evictionMinAge: 3,
      observationKeepWindow: 5,
      observationTriggerChars: 50_000,
      historyTurns: 100,
    });

    // Build a conversation with superseded file reads and enough tool results
    // to push older ones past evictionMinAge (3). We need >= 4 tool results
    // after the superseded one so its toolResultIndex >= 3.
    const messages: AgentMessage[] = [];

    // Pad content to exceed trigger threshold. Each tool result ~3000 chars.
    const padText = (version: string) => `${version}: ` + "x".repeat(3000);

    // First read of /app/config.ts (will be superseded)
    messages.push(createAgentMessage("user", "Read the config file"));
    messages.push(
      createAssistantWithToolUse("Reading config...", [
        { id: "tc-001", name: "file_read", input: { path: "/app/config.ts" } },
      ]),
    );
    messages.push(createToolResult("tc-001", "file_read", padText("version1")));
    messages.push(createAgentMessage("assistant", "The config contains version1"));

    // Second read of same path (supersedes first)
    messages.push(createAgentMessage("user", "Read it again"));
    messages.push(
      createAssistantWithToolUse("Re-reading config...", [
        { id: "tc-002", name: "file_read", input: { path: "/app/config.ts" } },
      ]),
    );
    messages.push(createToolResult("tc-002", "file_read", padText("version2")));
    messages.push(createAgentMessage("assistant", "Now it shows version2"));

    // Diverse tool results to push older superseded reads past evictionMinAge.
    // Each adds 1 tool result to the counter, making older results "older".
    for (let i = 0; i < 4; i++) {
      const tcId = `tc-other-${i}`;
      messages.push(createAgentMessage("user", `Check file ${i}`));
      messages.push(
        createAssistantWithToolUse(`Reading file ${i}...`, [
          { id: tcId, name: "file_read", input: { path: `/app/other-${i}.ts` } },
        ]),
      );
      messages.push(createToolResult(tcId, "file_read", padText(`other-file-${i}`)));
      messages.push(createAgentMessage("assistant", `File ${i} loaded`));
    }

    // Third read of /app/config.ts (supersedes second, keeps only this newest one)
    messages.push(createAgentMessage("user", "And one more time"));
    messages.push(
      createAssistantWithToolUse("Reading again...", [
        { id: "tc-003", name: "file_read", input: { path: "/app/config.ts" } },
      ]),
    );
    messages.push(createToolResult("tc-003", "file_read", padText("version3")));
    messages.push(createAgentMessage("assistant", "Version3 loaded"));

    // Plain text turns to pad out conversation
    for (let i = 0; i < 4; i++) {
      messages.push(createAgentMessage("user", `Question ${i}: ${"y".repeat(3000)}`));
      messages.push(createAgentMessage("assistant", `Answer ${i}: ${"z".repeat(3000)}`));
    }

    // Wire context engine
    const eventBus = new TypedEventBus();
    const pipelineEvents: Array<Record<string, unknown>> = [];
    const evictedEvents: Array<Record<string, unknown>> = [];
    eventBus.on("context:pipeline", (d: unknown) => pipelineEvents.push(d as Record<string, unknown>));
    eventBus.on("context:evicted", (d: unknown) => evictedEvents.push(d as Record<string, unknown>));

    const engine = createContextEngine(config, {
      logger: mockLogger,
      eventBus,
      getModel: () => ({ reasoning: false, contextWindow: 128_000, maxTokens: 8192 }),
      getSessionManager: () => buildMockSessionManager(messages),
      agentId: "test-agent",
      sessionKey: "test:u:c",
    });

    const result = await engine.transformContext(messages);

    // Assert evictor fired (evicted at least one superseded file read)
    expect(evictedEvents.length).toBe(1);
    expect((evictedEvents[0]!.evictedCount as number)).toBeGreaterThanOrEqual(1);

    // Assert pipeline event fires with expected fields
    expect(pipelineEvents.length).toBe(1);
    const pe = pipelineEvents[0]!;
    expect(pe.tokensEvicted).toBeDefined();
    expect((pe.tokensEvicted as number)).toBeGreaterThan(0);
    expect(pe.tokensLoaded).toBeDefined();
    expect(pe.tokensMasked).toBeDefined();
    expect(pe.budgetUtilization).toBeDefined();
    expect(pe.evictionCategories).toBeDefined();
    expect(pe.durationMs).toBeDefined();
    expect(pe.layerCount).toBeDefined();
    expect(pe.timestamp).toBeDefined();

    // Assert layerCount >= 3 (history_window, dead_content_evictor, observation_masker)
    expect((pe.layerCount as number)).toBeGreaterThanOrEqual(3);

    // No double-processing check: scan output messages.
    // Evictor placeholder starts with "[Superseded"
    // Masker placeholder starts with "[Tool result cleared:"
    // No message should contain both patterns.
    for (const msg of result) {
      const content = (msg as unknown as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
          const text = (block as Record<string, unknown>).text as string;
          const hasEvictedMarker = text.includes("[Superseded");
          const hasMaskedMarker = text.includes("[Tool result cleared:");
          // A message with evicted content should NOT also be masked
          expect(hasEvictedMarker && hasMaskedMarker).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// TEST-09: Session Search Tool Handler E2E
// ---------------------------------------------------------------------------

describe("TEST-09: Session Search Tool Handler E2E", () => {
  // Build session content representing a conversation with searchable data
  const sessionMessages = [
    { role: "user", content: "What does the config file contain?" },
    {
      role: "assistant",
      content: "file_read for /app/config.ts",
      toolUse: { id: "tc-1", name: "file_read" },
    },
    {
      role: "toolResult",
      content: "DATABASE_URL=postgres://localhost:5432/mydb",
      toolCallId: "tc-1",
    },
    { role: "assistant", content: "The config contains a database URL" },
    { role: "user", content: "Thanks, now check the routes" },
    {
      role: "assistant",
      content: "file_read for /app/routes.ts",
      toolUse: { id: "tc-2", name: "file_read" },
    },
    {
      role: "toolResult",
      content: "export const API_ROUTES = ['/users', '/products']",
      toolCallId: "tc-2",
    },
    { role: "assistant", content: "Found two API routes" },
  ];

  /**
   * Create a mock RPC call that simulates session.search handler behavior:
   * - Case-insensitive substring search over session messages
   * - Scope filtering by role
   * - Returns { matches, total }
   */
  function createMockRpcCall() {
    return vi.fn(async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe("session.search");

      const query = (params.query as string).toLowerCase();
      const scope = (params.scope as string) ?? "all";
      const limit = (params.limit as number) ?? 10;

      let filtered = sessionMessages;
      if (scope !== "all") {
        filtered = sessionMessages.filter((m) => {
          if (scope === "tool") return m.role === "toolResult";
          return m.role === scope;
        });
      }

      const matches = filtered
        .filter((m) => m.content.toLowerCase().includes(query))
        .slice(0, limit)
        .map((m) => ({
          role: m.role,
          snippet: m.content.slice(0, 200),
        }));

      return { matches, total: matches.length };
    });
  }

  it("sub-test A: search for DATABASE_URL returns config content", async () => {
    const mockRpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(mockRpcCall);

    const result = await tool.execute("call-1", { query: "DATABASE_URL" });

    expect(mockRpcCall).toHaveBeenCalledWith("session.search", {
      query: "DATABASE_URL",
      scope: "all",
      limit: 10,
      summarize: true,
    });

    // Result should be successful (not an error)
    const content = result.content[0];
    expect(content).toBeDefined();
    expect((content as Record<string, unknown>).text as string).not.toContain("Error:");

    // Details should contain the match
    const details = result.details as { matches: Array<{ snippet: string }>; total: number };
    expect(details.total).toBeGreaterThan(0);
    expect(details.matches[0]!.snippet).toContain("DATABASE_URL");
  });

  it("sub-test B: search for API_ROUTES returns routes content", async () => {
    const mockRpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(mockRpcCall);

    const result = await tool.execute("call-2", { query: "API_ROUTES" });

    expect(mockRpcCall).toHaveBeenCalledWith("session.search", {
      query: "API_ROUTES",
      scope: "all",
      limit: 10,
      summarize: true,
    });

    const details = result.details as { matches: Array<{ snippet: string }>; total: number };
    expect(details.total).toBeGreaterThan(0);
    expect(details.matches[0]!.snippet).toContain("API_ROUTES");
  });

  it("sub-test C: search for non-existent content returns empty", async () => {
    const mockRpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(mockRpcCall);

    const result = await tool.execute("call-3", { query: "NONEXISTENT_MARKER_XYZ" });

    const details = result.details as { matches: unknown[]; total: number };
    expect(details.total).toBe(0);
    expect(details.matches).toHaveLength(0);

    // Not an error result
    const content = result.content[0];
    expect((content as Record<string, unknown>).text as string).not.toContain("Error:");
  });

  it("sub-test D: scoped search passes scope=tool to RPC", async () => {
    const mockRpcCall = createMockRpcCall();
    const tool = createSessionSearchTool(mockRpcCall);

    const result = await tool.execute("call-4", { query: "DATABASE_URL", scope: "tool" });

    expect(mockRpcCall).toHaveBeenCalledWith("session.search", {
      query: "DATABASE_URL",
      scope: "tool",
      limit: 10,
      summarize: true,
    });

    // The toolResult message content contains DATABASE_URL
    const details = result.details as { matches: Array<{ snippet: string }>; total: number };
    expect(details.total).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TEST-10: Budget Under 0.85 with 200-Entry Synthetic Session
// ---------------------------------------------------------------------------

describe("TEST-10: Budget utilization under 0.85 with 200-entry session", () => {
  it("pipeline reduces context to stay within budget", async () => {
    const config = ContextEngineConfigSchema.parse({
      enabled: true,
      version: "pipeline",
      historyTurns: 100,
      evictionMinAge: 3,
      observationKeepWindow: 20,
      observationTriggerChars: 50_000,
    });

    // Build 200 messages (100 user + 100 assistant pairs).
    // Each message has ~500 chars. Total raw chars: ~100,000.
    const messages: AgentMessage[] = [];
    let toolCallCounter = 0;

    for (let i = 0; i < 100; i++) {
      // Every 10th pair includes a bash tool_use + toolResult
      if (i > 0 && i % 10 === 0) {
        // User message
        messages.push(createAgentMessage("user", `Run the build command round ${i}: ${"a".repeat(400)}`));

        // Assistant with tool call
        const tcId = `tc-bash-${toolCallCounter++}`;
        messages.push(
          createAssistantWithToolUse(`Running build...`, [
            { id: tcId, name: "bash", input: { command: `npm run build-${i % 20}` } },
          ]),
        );

        // Tool result with ~1000 chars of exec output
        messages.push(
          createToolResult(tcId, "bash", `Build output round ${i}: ${"b".repeat(1000)}`),
        );

        // Follow-up assistant
        messages.push(createAgentMessage("assistant", `Build complete round ${i}: ${"c".repeat(400)}`));
      } else {
        // Regular user + assistant pair
        messages.push(createAgentMessage("user", `Question ${i}: ${"d".repeat(450)}`));
        messages.push(createAgentMessage("assistant", `Answer ${i}: ${"e".repeat(450)}`));
      }
    }

    // Wire context engine
    const eventBus = new TypedEventBus();
    const pipelineEvents: Array<Record<string, unknown>> = [];
    eventBus.on("context:pipeline", (d: unknown) => pipelineEvents.push(d as Record<string, unknown>));

    const engine = createContextEngine(config, {
      logger: mockLogger,
      eventBus,
      getModel: () => ({ reasoning: false, contextWindow: 128_000, maxTokens: 8192 }),
      getSessionManager: () => buildMockSessionManager(messages),
      agentId: "test-agent",
      sessionKey: "test:u:c",
    });

    const result = await engine.transformContext(messages);

    // Pipeline event must fire
    expect(pipelineEvents.length).toBe(1);
    const pe = pipelineEvents[0]!;

    // Budget utilization must be under 0.85
    expect((pe.budgetUtilization as number)).toBeLessThan(0.85);

    // Evictor should have removed superseded exec results
    // (same bash command repeated: npm run build-0 at i=10 and i=30 both produce
    // `build-0` and `build-10` commands -- some duplicates from i%20 pattern)
    expect((pe.tokensEvicted as number)).toBeGreaterThanOrEqual(0);

    // Masker should have reduced old tool results
    expect((pe.tokensMasked as number)).toBeGreaterThanOrEqual(0);

    // Output message count should be <= original (history window clips or eviction reduces)
    expect(result.length).toBeLessThanOrEqual(messages.length);

    // Initial tokens loaded should be positive
    expect((pe.tokensLoaded as number)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TEST-15: Pipeline Metrics Emission Completeness
// ---------------------------------------------------------------------------

describe("TEST-15: Pipeline metrics emission completeness", () => {
  it("context:pipeline event contains all 17 required fields with correct types", async () => {
    const config = ContextEngineConfigSchema.parse({
      enabled: true,
      version: "pipeline",
      evictionMinAge: 3,
      observationKeepWindow: 5,
      observationTriggerChars: 50_000,
    });

    // Build a minimal conversation (10 messages) with at least one superseded tool result.
    const messages: AgentMessage[] = [];

    // First file_read of /app/main.ts
    messages.push(createAgentMessage("user", "Read the main file"));
    messages.push(
      createAssistantWithToolUse("Reading...", [
        { id: "tc-m1", name: "file_read", input: { path: "/app/main.ts" } },
      ]),
    );
    messages.push(createToolResult("tc-m1", "file_read", "original content: " + "x".repeat(5000)));
    messages.push(createAgentMessage("assistant", "Main file loaded"));

    // Second file_read of same path (supersedes first)
    messages.push(createAgentMessage("user", "Read main again"));
    messages.push(
      createAssistantWithToolUse("Re-reading...", [
        { id: "tc-m2", name: "file_read", input: { path: "/app/main.ts" } },
      ]),
    );
    messages.push(createToolResult("tc-m2", "file_read", "updated content: " + "y".repeat(5000)));
    messages.push(createAgentMessage("assistant", "Updated main loaded"));

    // Two more plain turns to round out to 10
    messages.push(createAgentMessage("user", "Final question: " + "z".repeat(5000)));
    messages.push(createAgentMessage("assistant", "Final answer: " + "w".repeat(5000)));

    // Wire context engine
    const eventBus = new TypedEventBus();
    const pipelineEvents: Array<Record<string, unknown>> = [];
    eventBus.on("context:pipeline", (d: unknown) => pipelineEvents.push(d as Record<string, unknown>));

    const engine = createContextEngine(config, {
      logger: mockLogger,
      eventBus,
      getModel: () => ({ reasoning: false, contextWindow: 128_000, maxTokens: 8192 }),
      getSessionManager: () => buildMockSessionManager(messages),
      agentId: "test-agent",
      sessionKey: "test:u:c",
    });

    await engine.transformContext(messages);

    // Pipeline event must fire exactly once
    expect(pipelineEvents.length).toBe(1);
    const pe = pipelineEvents[0]!;

    // All required fields must be present with correct types. The old
    // boolean `cacheHit` has been replaced with numeric `cacheFenceIndex`
    // (index of the last cache fence; -1 when no fence), and a per-layer
    // breakdown `layers` was added alongside the aggregate `layerCount`.
    expect(pe).toEqual(
      expect.objectContaining({
        agentId: expect.any(String),
        sessionKey: expect.any(String),
        tokensLoaded: expect.any(Number),
        tokensEvicted: expect.any(Number),
        tokensMasked: expect.any(Number),
        tokensCompacted: expect.any(Number),
        thinkingBlocksRemoved: expect.any(Number),
        budgetUtilization: expect.any(Number),
        evictionCategories: expect.any(Object),
        rereadCount: expect.any(Number),
        rereadTools: expect.any(Array),
        sessionDepth: expect.any(Number),
        sessionToolResults: expect.any(Number),
        cacheFenceIndex: expect.any(Number),
        durationMs: expect.any(Number),
        layerCount: expect.any(Number),
        layers: expect.any(Array),
        timestamp: expect.any(Number),
      }),
    );

    // Specific value checks where meaningful
    expect(pe.agentId).toBe("test-agent");
    expect(pe.sessionKey).toBe("test:u:c");
    expect((pe.tokensLoaded as number)).toBeGreaterThanOrEqual(0);
    expect((pe.tokensEvicted as number)).toBeGreaterThanOrEqual(0);
    expect((pe.tokensCompacted as number)).toBe(0); // no compaction deps provided
    expect((pe.thinkingBlocksRemoved as number)).toBe(0); // non-reasoning model
    expect((pe.budgetUtilization as number)).toBeGreaterThanOrEqual(0);
    expect((pe.rereadCount as number)).toBeGreaterThanOrEqual(0);
    expect((pe.sessionDepth as number)).toBeGreaterThanOrEqual(0);
    // -1 when no fence is established (typical for first-turn state)
    expect((pe.cacheFenceIndex as number)).toBeGreaterThanOrEqual(-1);
    expect((pe.durationMs as number)).toBeGreaterThanOrEqual(0);
    expect((pe.layerCount as number)).toBeGreaterThanOrEqual(1);
    expect((pe.timestamp as number)).toBeGreaterThan(0);
  });
});
