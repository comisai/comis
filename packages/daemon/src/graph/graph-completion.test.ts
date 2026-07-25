// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for graph-completion module: truncatePreview helper and
 * buildGraphAnnouncement announcement builder.
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { err, ok } from "@comis/shared";
import {
  createInteractiveCallbackRouter,
  type CompletionAnnouncementSendRequest,
  type GraphReportCallbackRegistration,
} from "@comis/orchestrator";
import { buildGraphAnnouncement, truncatePreview, extractAnnouncementPreview, handleGraphCompletion, handleBudgetExceeded, computeSubtreeCost } from "./graph-completion.js";
import {
  type ValidatedGraph,
  type ExecutionGraph,
  validateAndSortGraph,
  createConversationLocator,
} from "@comis/core";
import { createGraphStateMachine } from "./graph-state-machine.js";
import type { GraphRunState } from "./graph-coordinator-state.js";

const SIGNED_REPORT_CALLBACK = "v1.details.abc123XYZ789.deadbeefdeadbeef";

// ---------------------------------------------------------------------------
// Module mock for node:fs (buildGraphAnnouncement indirectly lives in a
// module that imports writeFileSync, so we need to mock it)
// ---------------------------------------------------------------------------

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildValidatedGraph(
  nodes: Array<{ nodeId: string; task?: string; dependsOn?: string[] }>,
): ValidatedGraph {
  const graph: ExecutionGraph = {
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      task: n.task ?? `Task ${n.nodeId}`,
      dependsOn: n.dependsOn ?? [],
    })),
  };
  const result = validateAndSortGraph(graph);
  if (!result.ok) {
    throw new Error(`Invalid test graph: ${result.error.message}`);
  }
  return result.value;
}

function createMinimalGraphRunState(
  nodes: Array<{ nodeId: string; output?: string; status?: "completed" | "failed" | "skipped"; error?: string }>,
): GraphRunState {
  const validatedGraph = buildValidatedGraph(
    nodes.map((n) => ({ nodeId: n.nodeId })),
  );
  const sm = createGraphStateMachine(validatedGraph);

  // Transition each node through the state machine
  for (const n of nodes) {
    // Mark running first
    sm.markNodeRunning(n.nodeId, `run-${n.nodeId}`);

    if (n.status === "completed" || n.status === undefined) {
      sm.markNodeCompleted(n.nodeId, n.output);
    } else if (n.status === "failed") {
      sm.markNodeFailed(n.nodeId, n.error ?? "test error");
    }
    // "skipped" is handled by cascade; for simplicity, mark as failed
  }

  return {
    graphId: "test-graph-id",
    graphTraceId: "test-trace-id",
    graph: validatedGraph,
    stateMachine: sm,
    runIdToNode: new Map(),
    nodeOutputs: new Map(),
    nodeTimers: new Map(),
    retryTimers: new Map(),
    graphTimer: undefined,
    startedAt: Date.now() - 5000,
    completedAt: Date.now(),
    runningCount: 0,
    nodeProgress: false,
    skippedNodesEmitted: new Set(),
    cumulativeTokens: 0,
    cumulativeCost: 0,
    sharedDir: "/tmp/test-graph",
    driverStates: new Map(),
    driverRunIdMap: new Map(),
    waitHandlers: new Map(),
    syntheticRunResults: new Map(),
    nodeCacheData: new Map(),
    nodeTokenSpend: new Map(),
    nodeCost: new Map(),
  };
}

function authorizeGraphState(
  gs: GraphRunState,
  channelType: string,
  conversationId: string,
  threadId?: string,
): void {
  const endpoint = {
    channelType,
    channelInstanceId: "test-instance",
    conversationId,
    ...(threadId === undefined ? {} : { threadId }),
    conversationKind: "direct" as const,
  };
  const locator = createConversationLocator({
    tenantId: "tenant-a",
    agentId: "agent-1",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint,
      principalId: "user-a",
    },
  });
  if (!locator.ok) throw locator.error;
  gs.callerConversationLocator = locator.value;
  gs.callerPrincipalId = "user-a";
  gs.callerEndpoint = endpoint;
}

// ---------------------------------------------------------------------------
// truncatePreview tests
// ---------------------------------------------------------------------------

describe("truncatePreview", () => {
  it("returns short text unchanged (no ellipsis)", () => {
    expect(truncatePreview("short text", 500)).toBe("short text");
  });

  it("returns '(no output)' for empty string", () => {
    expect(truncatePreview("", 500)).toBe("(no output)");
  });

  it("returns '(no output)' for undefined", () => {
    expect(truncatePreview(undefined, 500)).toBe("(no output)");
  });

  it("returns '(no output)' for whitespace-only string", () => {
    expect(truncatePreview("   \n  ", 500)).toBe("(no output)");
  });

  it("truncates long text at word boundary with ellipsis", () => {
    const longText = "The analysis reveals several key findings about the market. "
      .repeat(20);
    const result = truncatePreview(longText, 500);

    // Must end with ellipsis character
    expect(result.endsWith("\u2026")).toBe(true);
    // Must be within limit (maxLen + 1 for ellipsis char)
    expect(result.length).toBeLessThanOrEqual(501);
    // Must not cut mid-word: the char before ellipsis should end a word
    const beforeEllipsis = result.slice(0, -1).trimEnd();
    expect(beforeEllipsis).toMatch(/[a-zA-Z.)\]]$/);
  });

  it("never cuts mid-word: 'Hello wonderful world' with limit 8 returns 'Hello...'", () => {
    const result = truncatePreview("Hello wonderful world", 8);
    expect(result).toBe("Hello\u2026");
  });

  it("extracts first paragraph if it fits within limit", () => {
    // Full text must exceed limit so truncation logic triggers
    const secondParagraph = "Second paragraph with lots of detail. ".repeat(20);
    const text = "First paragraph here.\n\n" + secondParagraph;
    const result = truncatePreview(text, 500);
    // First paragraph fits within 500, so should use it with ellipsis
    expect(result).toBe("First paragraph here.\u2026");
  });

  it("does not truncate text exactly at limit", () => {
    const exactText = "a".repeat(500);
    expect(truncatePreview(exactText, 500)).toBe(exactText);
  });

  it("handles single massive word with hard-cut", () => {
    const noSpaces = "x".repeat(600);
    const result = truncatePreview(noSpaces, 500);
    expect(result.length).toBe(501); // 500 chars + ellipsis
    expect(result.endsWith("\u2026")).toBe(true);
  });

  it("uses default maxLen of 500", () => {
    const longText = "word ".repeat(200); // 1000 chars
    const result = truncatePreview(longText);
    expect(result.length).toBeLessThanOrEqual(501);
    expect(result.endsWith("\u2026")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractAnnouncementPreview tests
// ---------------------------------------------------------------------------

describe("extractAnnouncementPreview", () => {
  it("strips leading --- separators and returns substantive content", () => {
    const text = "---\n\n# INVESTMENT MEMO\n\nBuy NVDA at $183.\n\n---\n\n## Details\n\n" + "x".repeat(5000);
    const result = extractAnnouncementPreview(text, 200);
    // Must NOT start with "---"
    expect(result.startsWith("---")).toBe(false);
    // Must contain the heading
    expect(result).toContain("INVESTMENT MEMO");
  });

  it("returns full cleaned text if under limit", () => {
    const text = "---\n\nShort summary here.";
    const result = extractAnnouncementPreview(text, 500);
    expect(result).toBe("Short summary here.");
  });

  it("cuts at markdown section boundary when possible", () => {
    const text = "# Title\n\nFirst section content here.\n\n## Second Section\n\n" + "x".repeat(5000);
    const result = extractAnnouncementPreview(text, 100);
    // Should cut at the "## Second Section" boundary, not mid-content
    expect(result).toContain("First section content");
    expect(result).not.toContain("xxxx");
  });

  it("handles empty/whitespace input", () => {
    expect(extractAnnouncementPreview("", 500)).toBe("(no output)");
    expect(extractAnnouncementPreview("  \n  ", 500)).toBe("(no output)");
  });
});

// ---------------------------------------------------------------------------
// buildGraphAnnouncement tests
// ---------------------------------------------------------------------------

describe("buildGraphAnnouncement", () => {
  it("includes GraphId and node count in footer", () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: "Result A" },
    ]);
    const { text: announcement } = buildGraphAnnouncement(gs);

    expect(announcement).toContain("GraphId: test-graph-id");
    expect(announcement).toContain("1/1 nodes");
  });

  it("includes full output for leaf node (no downstream dependents)", () => {
    const leafOutput = "BUY NVDA at $183.74 with hard stop at $172.";
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: leafOutput },
    ]);
    const { text: announcement } = buildGraphAnnouncement(gs);

    // Leaf node output appears in full as primary content
    expect(announcement).toContain(leafOutput);
  });

  it("shows intermediate nodes as summary checkmarks, leaf nodes as full output", () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: "Intermediate analysis..." },
      { nodeId: "B", output: "Final trading decision: BUY." },
    ]);
    // Make B depend on A so A is intermediate, B is leaf
    gs.graph = buildValidatedGraph([
      { nodeId: "A" },
      { nodeId: "B", dependsOn: ["A"] },
    ]);
    // Re-create state machine with dependency graph
    const sm = createGraphStateMachine(gs.graph);
    sm.markNodeRunning("A", "run-A");
    sm.markNodeCompleted("A", "Intermediate analysis...");
    sm.markNodeRunning("B", "run-B");
    sm.markNodeCompleted("B", "Final trading decision: BUY.");
    gs.stateMachine = sm;

    const { text: announcement } = buildGraphAnnouncement(gs);

    // A is intermediate — shown as checkmark summary, not full output
    expect(announcement).toContain("\u2705 A");
    expect(announcement).not.toContain("Intermediate analysis...");
    // B is leaf — full output surfaced
    expect(announcement).toContain("Final trading decision: BUY.");
  });

  it("includes long leaf node output without truncation", () => {
    const longLeafOutput = "The analysis reveals several key findings. "
      .repeat(40); // ~1760 chars
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: longLeafOutput },
    ]);
    const { text: announcement } = buildGraphAnnouncement(gs);

    // Leaf node — full output included even when long
    expect(announcement).toContain(longLeafOutput);
  });

  it("shows '(no output)' for leaf node with undefined output", () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: undefined },
    ]);
    const { text: announcement } = buildGraphAnnouncement(gs);
    expect(announcement).toContain("(no output)");
  });

  it("shows failed nodes in summary", () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "A", status: "failed", error: "timeout" },
    ]);
    const { text: announcement } = buildGraphAnnouncement(gs);
    expect(announcement).toContain("\u274C A: timeout");
    expect(announcement).toContain("1 failed");
  });

  it("returns no buttons for short leaf output", () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: "Short result" },
    ]);
    const result = buildGraphAnnouncement(gs, () => SIGNED_REPORT_CALLBACK);
    expect(result.text).toContain("Short result");
    expect(result.buttons).toBeUndefined();
  });

  it("truncates long leaf output and adds Full Report button", () => {
    // Simulate a realistic markdown report with leading --- separators
    const longOutput = "---\n\n# INVESTMENT MEMO\n\n## EXECUTIVE SUMMARY\n\n" +
      "Decision: BUY NVDA at $183.91 with 8/10 conviction.\n\n" +
      "---\n\n## POSITION PARAMETERS\n\n" +
      "| Param | Value |\n|-------|-------|\n| Size | 3% |\n\n" +
      "Detailed analysis follows. ".repeat(200); // ~6000+ chars
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: longOutput },
    ]);
    const result = buildGraphAnnouncement(gs, () => SIGNED_REPORT_CALLBACK);

    // Text should be truncated — not contain the full output
    expect(result.text.length).toBeLessThan(longOutput.length);
    // Should contain substantive content, NOT just "---…"
    expect(result.text).toContain("INVESTMENT MEMO");
    expect(result.text).toContain("EXECUTIVE SUMMARY");
    // Should contain truncation footer
    expect(result.text).toContain("Full report available");
    expect(result.text).toContain("chars");
    // Should have buttons
    expect(result.buttons).toBeDefined();
    expect(result.buttons![0][0].callback_data).toBe(SIGNED_REPORT_CALLBACK);
    expect(result.buttons![0][0].text).toContain("Full Report");
  });

  it("preserves full output when exactly at threshold", () => {
    // Build output that's under 3000 chars total (output + footer)
    const shortEnough = "x".repeat(2500);
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: shortEnough },
    ]);
    const result = buildGraphAnnouncement(gs);
    expect(result.text).toContain(shortEnough);
    expect(result.buttons).toBeUndefined();
  });

  it("uses only the callback payload minted by the signed report registry", () => {
    const longOutput = "Analysis ".repeat(500); // ~4500 chars
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: longOutput },
    ]);
    gs.graphId = "custom-uuid-1234";
    const result = buildGraphAnnouncement(gs, () => SIGNED_REPORT_CALLBACK);
    expect(result.buttons![0][0].callback_data).toBe(SIGNED_REPORT_CALLBACK);
    expect(result.buttons![0][0].callback_data).not.toContain(gs.graphId);
  });

  it("does not render an unsigned report button when callback registration is unavailable", () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: "Analysis ".repeat(500) },
    ]);

    const result = buildGraphAnnouncement(gs);

    expect(result.buttons).toBeUndefined();
    expect(result.text).toContain("Full report is unavailable");
    expect(result.text).not.toContain("tap below");
  });

  it("uses custom maxAnnouncementChars from GraphRunState", () => {
    const output = "x".repeat(200);
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output },
    ]);
    gs.maxAnnouncementChars = 100;
    const result = buildGraphAnnouncement(gs, () => SIGNED_REPORT_CALLBACK);
    // With threshold of 100, this 200-char output should be truncated
    expect(result.buttons).toBeDefined();
    expect(result.text).toContain("Full report available");
  });
});

describe("handleGraphCompletion report ownership and parent identity", () => {
  function completionDeps(options: { batcher?: { enqueue: ReturnType<typeof vi.fn> } } = {}) {
    const announceToParent = vi.fn(async () => "rewritten graph result");
    const sendToChannel = vi.fn(async () => true);
    const sendGovernedAnnouncement = vi.fn(async () => ok({
      delivered: true as const,
      identity: { agentId: "agent-1", rootRunId: "root-1", stepIndex: 1 },
    }));
    const registerGraphReportCallback = vi.fn((_registration: GraphReportCallbackRegistration) => ({
      ok: true as const,
      value: SIGNED_REPORT_CALLBACK,
    }));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    return {
      deps: {
        eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
        announceToParent,
        sendToChannel,
        sendGovernedAnnouncement,
        registerGraphReportCallback,
        tenantId: "tenant-a",
        graphRetentionMs: 60_000,
        activeRunRegistry: { has: vi.fn(() => true) },
        ...(options.batcher ? { batcher: options.batcher } : {}),
        logger,
      } as never,
      announceToParent,
      sendToChannel,
      sendGovernedAnnouncement,
      registerGraphReportCallback,
      logger,
    };
  }

  it("registers a signed report for the parsed owner and delivers the button to its exact route", async () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "final", output: "Analysis ".repeat(500) },
    ]);
    gs.completedAt = undefined;
    gs.callerSessionKey = "tenant-a:user-a:chat-1:thread:topic-1";
    gs.callerAgentId = "agent-1";
    gs.announceChannelType = "telegram";
    gs.announceChannelId = "chat-1";
    authorizeGraphState(gs, "telegram", "chat-1", "topic-1");
    const {
      deps,
      registerGraphReportCallback,
      announceToParent,
      sendToChannel,
      sendGovernedAnnouncement,
    } = completionDeps();

    await handleGraphCompletion({} as never, deps, gs);

    expect(registerGraphReportCallback).toHaveBeenCalledWith(expect.objectContaining({
      graphId: "test-graph-id",
      tenantId: "tenant-a",
      userId: "user-a",
      sessionKey: "tenant-a:user-a:chat-1:thread:topic-1",
      agentId: "agent-1",
      channelType: "telegram",
      channelKey: "chat-1",
    }));
    expect(announceToParent).not.toHaveBeenCalled();
    expect(sendGovernedAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        callerSessionKey: "tenant-a:user-a:chat-1:thread:topic-1",
        runId: "test-graph-id",
        channelType: "telegram",
        channelId: "chat-1",
        text: expect.any(String),
        options: {
        threadId: "topic-1",
        extra: {
          buttons: [[{
            text: expect.stringContaining("Full Report"),
            callback_data: SIGNED_REPORT_CALLBACK,
          }]],
        },
        },
      }),
    );
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it("rebuilds the identical governed report payload after a completion crash", async () => {
    const sent: CompletionAnnouncementSendRequest[] = [];
    const makeReportRouter = () => createInteractiveCallbackRouter({
      gate: { getRequestByShortId: () => undefined } as never,
      getSecret: () => "test-signing-secret-32-bytes-aaaaaaaaaaaa",
      clock: { now: () => Date.now() } as never,
    });
    const startedAt = Date.now();

    for (const reportRouter of [makeReportRouter(), makeReportRouter()]) {
      const gs = createMinimalGraphRunState([
        { nodeId: "final", output: "Analysis ".repeat(500) },
      ]);
      gs.completedAt = undefined;
      gs.startedAt = startedAt;
      gs.callerSessionKey = "tenant-a:user-a:chat-1:thread:topic-1";
      gs.callerAgentId = "agent-1";
      gs.announceChannelType = "telegram";
      gs.announceChannelId = "chat-1";
      authorizeGraphState(gs, "telegram", "chat-1", "topic-1");
      const {
        deps,
        registerGraphReportCallback,
        sendGovernedAnnouncement,
      } = completionDeps();
      registerGraphReportCallback.mockImplementation((registration) =>
        reportRouter.registerGraphReport(registration)
      );
      sendGovernedAnnouncement.mockImplementation(async (request) => {
        sent.push(request);
        return ok({
          delivered: true as const,
          identity: { agentId: "agent-1", rootRunId: "root-1", stepIndex: 1 },
        });
      });

      await expect(handleGraphCompletion({} as never, deps, gs))
        .resolves.toEqual(ok(undefined));
    }

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it("logs a content-safe error when governed report delivery rejects", async () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "final", output: "Analysis ".repeat(500) },
    ]);
    gs.completedAt = undefined;
    gs.callerSessionKey = "tenant-a:user-a:chat-1";
    gs.callerAgentId = "agent-1";
    gs.announceChannelType = "telegram";
    gs.announceChannelId = "chat-1";
    authorizeGraphState(gs, "telegram", "chat-1");
    const { deps, sendGovernedAnnouncement, sendToChannel, logger } = completionDeps();
    sendGovernedAnnouncement.mockResolvedValueOnce(err(
      new Error("Authorization: Bearer PRIVATE_GRAPH_DELIVERY_SENTINEL"),
    ));

    const result = await handleGraphCompletion({} as never, deps, gs);
    expect(result.ok).toBe(false);
    const failure = logger.error.mock.calls.find((call) =>
      call[1] === "Graph governed announcement boundary failed"
    );
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_GRAPH_DELIVERY_SENTINEL");
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it("governs the deterministic short result without parent or batch execution", async () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "final", output: "Short result" },
    ]);
    gs.completedAt = undefined;
    gs.callerSessionKey = "tenant-a:user-a:chat-1:thread:topic-1";
    gs.callerAgentId = "agent-1";
    gs.announceChannelType = "telegram";
    gs.announceChannelId = "chat-1";
    authorizeGraphState(gs, "telegram", "chat-1", "topic-1");
    const batcher = { enqueue: vi.fn(), flush: vi.fn() };
    const { deps, announceToParent, sendGovernedAnnouncement, sendToChannel } = completionDeps({ batcher });

    const result = await handleGraphCompletion({} as never, deps, gs);

    expect(result).toEqual(ok(undefined));
    expect(announceToParent).not.toHaveBeenCalled();
    expect(batcher.enqueue).not.toHaveBeenCalled();
    expect(batcher.flush).not.toHaveBeenCalled();
    expect(sendGovernedAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-1",
      callerSessionKey: "tenant-a:user-a:chat-1:thread:topic-1",
      runId: "test-graph-id",
      channelType: "telegram",
      channelId: "chat-1",
      text: expect.stringContaining("Short result"),
      options: { threadId: "topic-1" },
    }));
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it("keeps plugin channel announcements on the governed extensible path", async () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "final", output: "Short result" },
    ]);
    gs.completedAt = undefined;
    gs.callerSessionKey = "tenant-a:user-a:chat-1";
    gs.callerAgentId = "agent-1";
    gs.announceChannelType = "custom-plugin";
    gs.announceChannelId = "chat-1";
    authorizeGraphState(gs, "custom-plugin", "chat-1");
    const batcher = { enqueue: vi.fn() };
    const { deps, announceToParent, sendGovernedAnnouncement, sendToChannel } = completionDeps({ batcher });

    const result = await handleGraphCompletion({} as never, deps, gs);

    expect(result).toEqual(ok(undefined));
    expect(batcher.enqueue).not.toHaveBeenCalled();
    expect(announceToParent).not.toHaveBeenCalled();
    expect(sendGovernedAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      runId: "test-graph-id",
      channelType: "custom-plugin",
      channelId: "chat-1",
      text: expect.stringContaining("Short result"),
    }));
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it("does not raw-send or claim delivery when the governed graph send returns false", async () => {
    const gs = createMinimalGraphRunState([{ nodeId: "final", output: "Short result" }]);
    gs.completedAt = undefined;
    gs.callerSessionKey = "tenant-a:user-a:chat-1";
    gs.callerAgentId = "agent-1";
    gs.announceChannelType = "telegram";
    gs.announceChannelId = "chat-1";
    authorizeGraphState(gs, "telegram", "chat-1");
    const { deps, sendGovernedAnnouncement, sendToChannel, logger } = completionDeps();
    sendGovernedAnnouncement.mockResolvedValueOnce(ok({
      delivered: false as const,
      identity: { agentId: "agent-1", rootRunId: "root-1", stepIndex: 1 },
      failure: "transport_rejected" as const,
    }));

    const result = await handleGraphCompletion({} as never, deps, gs);

    expect(result).toEqual(ok(undefined));
    expect(sendGovernedAnnouncement).toHaveBeenCalledOnce();
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: "test-graph-id",
        failure: "transport_rejected",
        errorKind: "dependency",
        hint: expect.any(String),
      }),
      "Graph announcement was not receipt-committed",
    );
  });

  it("fails closed without canonical caller authority even when a display key is present", async () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "final", output: "Analysis ".repeat(500) },
    ]);
    gs.completedAt = undefined;
    gs.callerSessionKey = "not-a-formatted-session";
    gs.callerAgentId = "agent-1";
    gs.announceChannelType = "telegram";
    gs.announceChannelId = "chat-1";
    const {
      deps,
      registerGraphReportCallback,
      announceToParent,
      sendToChannel,
      sendGovernedAnnouncement,
      logger,
    } = completionDeps();

    const result = await handleGraphCompletion({} as never, deps, gs);

    expect(result.ok).toBe(false);
    expect(registerGraphReportCallback).not.toHaveBeenCalled();
    expect(announceToParent).not.toHaveBeenCalled();
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(sendGovernedAnnouncement).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "precondition", hint: expect.any(String) }),
      expect.any(String),
    );
  });

  it("fails closed when the declared announcement route differs from the parsed caller session", async () => {
    const gs = createMinimalGraphRunState([{ nodeId: "final", output: "Short result" }]);
    gs.completedAt = undefined;
    gs.callerSessionKey = "tenant-a:user-a:owner-chat";
    gs.callerAgentId = "agent-1";
    gs.announceChannelType = "telegram";
    gs.announceChannelId = "other-chat";
    authorizeGraphState(gs, "telegram", "owner-chat");
    const { deps, announceToParent, sendToChannel, sendGovernedAnnouncement } = completionDeps();

    const result = await handleGraphCompletion({} as never, deps, gs);

    expect(result.ok).toBe(false);
    expect(announceToParent).not.toHaveBeenCalled();
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(sendGovernedAnnouncement).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// graph-completion honors the owner-only 0o600 file-mode invariant on
// substrate-routed writes
//
// The graph-completion writer's _run-metadata.json write is routed
// through `writeRegularFile`. The substrate uses `fs.openSync` +
// `fs.fchmodSync(fd, 0o600)` internally — distinct from the `writeFileSync`
// path mocked above — so real fs writes succeed even with the workspace-
// level `vi.mock("node:fs", ...)`. The substrate's chmod-by-fd is the
// load-bearing primitive the file-mode invariant relies on.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// nodeTokenSpend must have a production READER. It is surfaced as a
// per-node spend breakdown on the graph:completed event (mirroring the sibling
// nodeEffectiveness cache breakdown), so the per-node spend recorded by
// applyNodeBudgetBreach is not a dead write.
// ---------------------------------------------------------------------------
describe("graph:completed surfaces the per-node token-spend breakdown", () => {
  function runCompletion(spend: Record<string, number>) {
    const gs = createMinimalGraphRunState([
      { nodeId: "n1", status: "completed" },
      { nodeId: "n2", status: "completed" },
    ]);
    gs.completedAt = undefined; // not yet completed (the helper pre-stamps it)
    for (const [nodeId, n] of Object.entries(spend)) gs.nodeTokenSpend.set(nodeId, n);

    const emit = vi.fn();
    const deps = {
      eventBus: { emit, on: vi.fn(), off: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    } as never;
    handleGraphCompletion({} as never, deps, gs);
    const completed = emit.mock.calls.find((c) => c[0] === "graph:completed");
    return completed?.[1] as Record<string, unknown> | undefined;
  }

  it("includes nodeTokenSpend on graph:completed when per-node spend was recorded", () => {
    const payload = runCompletion({ n1: 1_200, n2: 3_400 });
    expect(payload).toBeDefined();
    expect(payload!.nodeTokenSpend).toEqual({ n1: 1_200, n2: 3_400 });
  });

  it("omits nodeTokenSpend when no per-node spend was recorded (payload shape unchanged)", () => {
    const payload = runCompletion({});
    expect(payload).toBeDefined();
    expect(payload!.nodeTokenSpend).toBeUndefined();
  });
});

describe("graph-completion honors the owner-only 0o600 file-mode invariant", () => {
  it("write_regular_file_substrate_produces_run_metadata_at_mode_0o600", async () => {
    // Direct substrate-level test: write to a tmp file using the same
    // primitive the migrated graph-completion code uses; assert the
    // resulting file mode is 0o600. Proves the substrate produces the
    // mode invariant; the writer's migration to the substrate makes
    // the writer inherit it.
    const { mkdtempSync, statSync, rmSync, mkdirSync: realMkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeRegularFile } = await import("@comis/observability");

    const baseDir = mkdtempSync(join(tmpdir(), "comis-graph-completion-mode-"));
    const sharedDir = join(baseDir, "graph-shared");
    realMkdirSync(sharedDir, { recursive: true, mode: 0o700 });
    try {
      const target = join(sharedDir, "_run-metadata.json");
      const result = writeRegularFile({
        path: target,
        content: JSON.stringify({ graphId: "mode-test" }),
        confinedBaseDir: sharedDir,
      });
      expect(result.ok).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Graph maxCost ↔ spend-ceiling interop.
//
// handleBudgetExceeded takes an OPEN `reason: string` and is the SINGLE
// seam the graph cumulative-budget path (graph-driver-handler.ts →
// handleBudgetExceeded(gs, tokenExceeded ? "tokens" : "cost")) routes through. A
// spend-ceiling breach in a graph context interoperates by routing through the
// SAME seam with "spend_exceeded" — NO parallel graph kill-path, NO signature
// change. These tests pin that contract: the spend reason is honored (running
// nodes marked `Budget exceeded (spend_exceeded)`, graph cancelled/completed, WARN
// fired) AND the "cost"/"tokens" reasons still work (coexistence). The
// WARN stays content-free (no `$` body — counts + hint + errorKind only).
// ---------------------------------------------------------------------------

describe("handleBudgetExceeded interoperates with graph maxCost via an open reason", () => {
  /** A GraphRunState with ONE running node (in runIdToNode, marked running on the
   *  state machine, NOT yet terminal, completedAt undefined) — the shape
   *  handleBudgetExceeded acts on. */
  function runningGraphRunState(): GraphRunState {
    const validatedGraph = buildValidatedGraph([{ nodeId: "n1" }]);
    const sm = createGraphStateMachine(validatedGraph);
    sm.markNodeRunning("n1", "run-n1");
    return {
      graphId: "spend-interop-graph",
      graphTraceId: "trace-spend",
      graph: validatedGraph,
      stateMachine: sm,
      runIdToNode: new Map([["run-n1", "n1"]]),
      nodeOutputs: new Map(),
      nodeTimers: new Map(),
      retryTimers: new Map(),
      graphTimer: undefined,
      startedAt: Date.now() - 1000,
      completedAt: undefined,
      runningCount: 1,
      nodeProgress: false,
      skippedNodesEmitted: new Set(),
      cumulativeTokens: 1000,
      cumulativeCost: 5.5,
      sharedDir: "/tmp/test-spend-interop",
      driverStates: new Map(),
      driverRunIdMap: new Map(),
      waitHandlers: new Map(),
      syntheticRunResults: new Map(),
      nodeCacheData: new Map(),
      nodeTokenSpend: new Map(),
      nodeCost: new Map(),
    };
  }

  function makeDeps() {
    const killRun = vi.fn(() => ({ killed: true }));
    const warn = vi.fn();
    const emit = vi.fn();
    const deps = {
      subAgentRunner: { killRun } as unknown as Parameters<typeof handleBudgetExceeded>[1]["subAgentRunner"],
      eventBus: { emit } as unknown as Parameters<typeof handleBudgetExceeded>[1]["eventBus"],
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
      sendToChannel: vi.fn(async () => true),
      tenantId: "tenant-a",
    } as unknown as Parameters<typeof handleBudgetExceeded>[1];
    return { deps, killRun, warn, emit };
  }

  const state = { graphs: new Map(), globalActiveSubAgents: 0, spawnQueue: [] };

  it("propagates the 'spend_exceeded' reason: marks the running node failed, kills the run, cancels + completes, WARNs with a SPEND-specific hint", () => {
    const gs = runningGraphRunState();
    const { deps, killRun, warn } = makeDeps();

    handleBudgetExceeded(state, deps, gs, "spend_exceeded");

    // The running node is marked failed with the SPEND reason carried through.
    const snap = gs.stateMachine.snapshot();
    expect(snap.nodes.get("n1")?.status).toBe("failed");
    expect(snap.nodes.get("n1")?.error).toBe("Budget exceeded (spend_exceeded)");
    // The sub-agent run was killed and the graph cancelled (budget) + completed.
    expect(killRun).toHaveBeenCalledWith("run-n1");
    expect(gs.cancelReason).toBe("budget");
    expect(gs.completedAt).toBeDefined();
    expect(gs.runningCount).toBe(0);
    // A content-free WARN fired (counts + hint + errorKind — NO `$` amount body).
    expect(warn).toHaveBeenCalled();
    const warnArg = warn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(warnArg["errorKind"]).toBe("resource");
    // A spend-ceiling breach names the spend kill-switch knob, NOT the
    // graph's own maxTokens/maxCost (those are a different ceiling).
    expect(warnArg["hint"]).toMatch(/observability\.spend|spend ceiling/i);
    expect(warnArg["hint"]).not.toMatch(/graph\.budget\.maxTokens\/maxCost/);
    // Content-free: no `$` amount echoed as a body.
    expect(JSON.stringify(warnArg)).not.toMatch(/\$\d/);
  });

  it("coexists with the existing 'cost' reason: a cost breach still marks 'Budget exceeded (cost)' and keeps the graph.budget.maxCost hint (interop, not replacement)", () => {
    const gs = runningGraphRunState();
    const { deps, warn } = makeDeps();

    handleBudgetExceeded(state, deps, gs, "cost");

    const snap = gs.stateMachine.snapshot();
    expect(snap.nodes.get("n1")?.status).toBe("failed");
    expect(snap.nodes.get("n1")?.error).toBe("Budget exceeded (cost)");
    expect(gs.cancelReason).toBe("budget");
    // The existing graph-budget hint is UNCHANGED for the cost/token reasons.
    const warnArg = warn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(warnArg["hint"]).toMatch(/graph\.budget\.maxTokens\/maxCost/);
  });

  it("keeps the graph.budget.maxTokens/maxCost hint for the 'tokens' reason too (only spend_exceeded gets the spend-specific hint)", () => {
    const gs = runningGraphRunState();
    const { deps, warn } = makeDeps();

    handleBudgetExceeded(state, deps, gs, "tokens");

    expect(gs.stateMachine.snapshot().nodes.get("n1")?.error).toBe("Budget exceeded (tokens)");
    const warnArg = warn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(warnArg["hint"]).toMatch(/graph\.budget\.maxTokens\/maxCost/);
  });

  it("routes the spend breach through the SINGLE existing seam — no parallel kill-path (handleBudgetExceeded is reused for both reasons)", () => {
    // Both reasons drive the SAME function (the arch invariant: spend reuses the
    // one seam). A spy on the seam proves graph-driver-handler-style callers route
    // here for "spend_exceeded" exactly as they do for "cost".
    const gsCost = runningGraphRunState();
    const gsSpend = runningGraphRunState();
    const { deps } = makeDeps();

    // Same callable, two reasons — coexistence with no signature change.
    expect(() => handleBudgetExceeded(state, deps, gsCost, "cost")).not.toThrow();
    expect(() => handleBudgetExceeded(state, deps, gsSpend, "spend_exceeded")).not.toThrow();
    expect(gsCost.stateMachine.snapshot().nodes.get("n1")?.error).toBe("Budget exceeded (cost)");
    expect(gsSpend.stateMachine.snapshot().nodes.get("n1")?.error).toBe("Budget exceeded (spend_exceeded)");
  });
});

// ---------------------------------------------------------------------------
// Subtree rollup over corrected $ + per-node surfacing.
//
// The rollup sums a node + every DESCENDANT (a child rolls into its parent's
// subtree total) over the per-node corrected-$ ledger gs.nodeCost, walking the
// existing node→children edges (the reverse of dependsOn). It is PURE +
// deterministic (no IO) so it is unit-testable and reusable by read-side cost
// reporting. The rollup uses ONLY the per-graph gs (which IS the (tenant,agent)
// scope), so two graphs in different scopes never cross-contaminate. The
// per-node cumulative cost is also surfaced on graph:completed (the
// nodeTokenSpend precedent): present only when gs.nodeCost is non-empty.
// ---------------------------------------------------------------------------

describe("subtree rollup over corrected $ (computeSubtreeCost)", () => {
  /** A GraphRunState carrying a parent + 2 children + 1 grandchild graph and a
   *  per-node corrected-$ ledger, for rollup assertions (no completion drive). */
  function rollupGs(nodeCost: Record<string, number>): GraphRunState {
    const graph = buildValidatedGraph([
      { nodeId: "parent" },
      { nodeId: "childA", dependsOn: ["parent"] },
      { nodeId: "childB", dependsOn: ["parent"] },
      { nodeId: "grandchild", dependsOn: ["childA"] },
    ]);
    const gs = createMinimalGraphRunState([{ nodeId: "parent" }]);
    gs.graph = graph;
    gs.nodeCost = new Map(Object.entries(nodeCost));
    return gs;
  }

  it("rolls up a node + all its descendants — a child's cost rolls into its parent's subtree total", () => {
    // parent $0.02, childA $0.10, childB $0.05, grandchild $0.01.
    const gs = rollupGs({ parent: 0.02, childA: 0.10, childB: 0.05, grandchild: 0.01 });

    // parent's subtree = parent + childA + childB + grandchild = 0.18.
    expect(computeSubtreeCost(gs, "parent")).toBeCloseTo(0.18, 10);
    // childA's subtree = childA + grandchild = 0.11 (childB is NOT under childA).
    expect(computeSubtreeCost(gs, "childA")).toBeCloseTo(0.11, 10);
    // a leaf's subtree is its own cost.
    expect(computeSubtreeCost(gs, "childB")).toBeCloseTo(0.05, 10);
    expect(computeSubtreeCost(gs, "grandchild")).toBeCloseTo(0.01, 10);
  });

  it("is additive: rollup(parent) === own(parent) + rollup(childA) + rollup(childB) (recursion composes)", () => {
    const gs = rollupGs({ parent: 0.02, childA: 0.10, childB: 0.05, grandchild: 0.01 });

    const own = (id: string) => gs.nodeCost.get(id) ?? 0;
    const rollup = (id: string) => computeSubtreeCost(gs, id);

    expect(rollup("parent")).toBeCloseTo(own("parent") + rollup("childA") + rollup("childB"), 10);
    expect(rollup("childA")).toBeCloseTo(own("childA") + rollup("grandchild"), 10);
  });

  it("counts a node with no recorded cost as 0 in the rollup (no NaN)", () => {
    // Only childA reported a cost; the rest are absent from the ledger.
    const gs = rollupGs({ childA: 0.10 });
    expect(computeSubtreeCost(gs, "parent")).toBeCloseTo(0.10, 10);
    expect(computeSubtreeCost(gs, "grandchild")).toBe(0);
  });

  it("is (tenant,agent)-scoped: two graphs in different scopes do not cross-contaminate", () => {
    // Each gs IS its own (tenant,agent) scope; the rollup reads only its own gs.
    const gsA = rollupGs({ parent: 1.0, childA: 2.0, childB: 3.0, grandchild: 4.0 });
    const gsB = rollupGs({ parent: 0.01, childA: 0.02, childB: 0.03, grandchild: 0.04 });

    expect(computeSubtreeCost(gsA, "parent")).toBeCloseTo(10.0, 10);
    expect(computeSubtreeCost(gsB, "parent")).toBeCloseTo(0.10, 10);
    // gsA's totals are unaffected by gsB (separate gs instances, no global map).
    expect(computeSubtreeCost(gsA, "childA")).toBeCloseTo(6.0, 10);
  });
});

describe("graph:completed surfaces the per-node cost ledger", () => {
  function runCompletion(nodeCost: Record<string, number>) {
    const gs = createMinimalGraphRunState([
      { nodeId: "parent", status: "completed" },
      { nodeId: "childA", status: "completed" },
    ]);
    gs.graph = buildValidatedGraph([
      { nodeId: "parent" },
      { nodeId: "childA", dependsOn: ["parent"] },
    ]);
    gs.completedAt = undefined; // not yet completed (helper pre-stamps it)
    gs.nodeCost = new Map(Object.entries(nodeCost));

    const emit = vi.fn();
    const deps = {
      eventBus: { emit, on: vi.fn(), off: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    } as never;
    handleGraphCompletion({} as never, deps, gs);
    const completed = emit.mock.calls.find((c) => c[0] === "graph:completed");
    return completed?.[1] as Record<string, unknown> | undefined;
  }

  it("includes nodeCost on graph:completed when per-node cost was recorded", () => {
    const payload = runCompletion({ parent: 0.02, childA: 0.10 });
    expect(payload).toBeDefined();
    // Per-node corrected-$ ledger surfaced (content-free: nodeId → number only).
    expect(payload!.nodeCost).toEqual({ parent: 0.02, childA: 0.10 });
  });

  it("omits nodeCost when no per-node cost was recorded (payload shape unchanged)", () => {
    const payload = runCompletion({});
    expect(payload).toBeDefined();
    expect(payload!.nodeCost).toBeUndefined();
  });
});
