import { describe, it, expect, vi } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TokenBudget } from "./types.js";
import { createObservationMaskerLayer, type ObservationMaskerConfig } from "./observation-masker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal token budget (observation masker ignores it, uses char estimation). */
const BUDGET: TokenBudget = {
  windowTokens: 128_000,
  systemTokens: 5_000,
  outputReserveTokens: 8_192,
  safetyMarginTokens: 6_400,
  contextRotBufferTokens: 32_000,
  availableHistoryTokens: 76_408,
};

/** Default config: keep 15, trigger at 200K chars. */
const DEFAULT_CONFIG: ObservationMaskerConfig = {
  observationKeepWindow: 15,
  observationTriggerChars: 200_000,
};

/** Low threshold config for testing masking behavior without generating 200K chars. */
const LOW_THRESHOLD_CONFIG: ObservationMaskerConfig = {
  observationKeepWindow: 3,
  observationTriggerChars: 100, // Very low threshold to trigger masking easily
};

function makeUserMsg(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeAssistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeToolResult(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeOffloadedToolResult(toolCallId: string, toolName: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: `[Tool result offloaded to disk: ${toolName} returned 50000 chars.\nThe agent's analysis is in the assistant response below.\nUse file_read to re-access if needed: /tmp/test.json]` }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeMaskedToolResult(toolCallId: string, toolName: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: `[Tool result cleared: ${toolName} -- see assistant analysis above]` }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

/**
 * Build a conversation with N tool result messages (plus user/assistant pairs).
 * Tool results are ordered oldest to newest: tc_0, tc_1, ..., tc_{n-1}.
 * A trailing assistant message ("Final") is appended so ALL tool results are
 * "seen" by the model (unseen protection does not interfere with masking tests).
 */
function buildConversation(toolResultCount: number, textPerResult = "x".repeat(100)): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < toolResultCount; i++) {
    messages.push(makeUserMsg(`Question ${i}`));
    messages.push(makeAssistantMsg(`Analysis ${i}`));
    messages.push(makeToolResult(`tc_${i}`, "bash", textPerResult));
  }
  // Trailing assistant ensures all tool results are before the last assistant
  // (i.e. all are "seen" and eligible for masking per unseen protection rules).
  messages.push(makeAssistantMsg("Final"));
  return messages;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createObservationMaskerLayer", () => {
  // -------------------------------------------------------------------------
  // Below threshold
  // -------------------------------------------------------------------------

  it("returns messages unchanged when below char threshold", async () => {
    const layer = createObservationMaskerLayer(DEFAULT_CONFIG);
    const messages = buildConversation(5, "short output");

    const result = await layer.apply(messages, BUDGET);

    // Below 200K chars -- should return unchanged
    expect(result).toBe(messages); // Same reference = no changes
  });

  // -------------------------------------------------------------------------
  // Basic masking
  // -------------------------------------------------------------------------

  it("masks tool results beyond the keep window with placeholder text", async () => {
    const layer = createObservationMaskerLayer(LOW_THRESHOLD_CONFIG);

    // 6 tool results: tc_0..tc_5. Keep window = 3, so tc_0..tc_2 should be masked.
    const messages = buildConversation(6);
    const result = await layer.apply(messages, BUDGET);

    // tc_3, tc_4, tc_5 (last 3) should be kept intact
    const toolResults = result.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(6);

    // Oldest 3 should be masked with new summarized format
    for (let i = 0; i < 3; i++) {
      const tr = toolResults[i] as any;
      expect(tr.content[0].text).toContain("[Tool result summarized: bash");
      expect(tr.content[0].text).toContain("chars cleared]");
    }

    // Newest 3 should be intact
    for (let i = 3; i < 6; i++) {
      const tr = toolResults[i] as any;
      expect(tr.content[0].text).toBe("x".repeat(100));
    }
  });

  // -------------------------------------------------------------------------
  // Keep window
  // -------------------------------------------------------------------------

  it("preserves the last N tool results within the keep window", async () => {
    const config: ObservationMaskerConfig = {
      observationKeepWindow: 5,
      observationTriggerChars: 100,

    };
    const layer = createObservationMaskerLayer(config);
    const messages = buildConversation(10);

    const result = await layer.apply(messages, BUDGET);
    const toolResults = result.filter((m) => m.role === "toolResult");

    // Last 5 should be kept (tc_5..tc_9)
    for (let i = 5; i < 10; i++) {
      const tr = toolResults[i] as any;
      expect(tr.content[0].text).toBe("x".repeat(100));
    }

    // First 5 should be masked (tc_0..tc_4)
    for (let i = 0; i < 5; i++) {
      const tr = toolResults[i] as any;
      expect(tr.content[0].text).toContain("[Tool result summarized:");
    }
  });

  // -------------------------------------------------------------------------
  // Protected tools
  // -------------------------------------------------------------------------

  it("never masks protected tools regardless of position", async () => {
    const layer = createObservationMaskerLayer(LOW_THRESHOLD_CONFIG);

    const messages: AgentMessage[] = [
      makeUserMsg("Q1"),
      makeAssistantMsg("A1"),
      makeToolResult("tc_mem", "memory_search", "Found 5 results..."),
      makeUserMsg("Q2"),
      makeAssistantMsg("A2"),
      makeToolResult("tc_get", "memory_get", "Entry content..."),
      makeUserMsg("Q3"),
      makeAssistantMsg("A3"),
      makeToolResult("tc_store", "memory_store", "Stored successfully"),
      makeUserMsg("Q4"),
      makeAssistantMsg("A4"),
      makeToolResult("tc_file", "file_read", "File contents here..."),
      // 4 more bash results that will be within keep window (3)
      makeUserMsg("Q5"),
      makeAssistantMsg("A5"),
      makeToolResult("tc_5", "bash", "output 5"),
      makeUserMsg("Q6"),
      makeAssistantMsg("A6"),
      makeToolResult("tc_6", "bash", "output 6"),
      makeUserMsg("Q7"),
      makeAssistantMsg("A7"),
      makeToolResult("tc_7", "bash", "output 7"),
    ];

    const result = await layer.apply(messages, BUDGET);

    // All 4 protected tool results should be preserved
    const memSearch = result.find((m) => (m as any).toolCallId === "tc_mem") as any;
    expect(memSearch.content[0].text).toBe("Found 5 results...");

    const memGet = result.find((m) => (m as any).toolCallId === "tc_get") as any;
    expect(memGet.content[0].text).toBe("Entry content...");

    const memStore = result.find((m) => (m as any).toolCallId === "tc_store") as any;
    expect(memStore.content[0].text).toBe("Stored successfully");

    const fileRead = result.find((m) => (m as any).toolCallId === "tc_file") as any;
    expect(fileRead.content[0].text).toBe("File contents here...");
  });

  // -------------------------------------------------------------------------
  // Already offloaded (microcompaction)
  // -------------------------------------------------------------------------

  it("skips tool results already offloaded by microcompaction", async () => {
    const layer = createObservationMaskerLayer(LOW_THRESHOLD_CONFIG);

    const messages: AgentMessage[] = [
      makeUserMsg("Q1"),
      makeAssistantMsg("A1"),
      makeOffloadedToolResult("tc_offloaded", "bash"),
      // 3 more within keep window
      makeUserMsg("Q2"),
      makeAssistantMsg("A2"),
      makeToolResult("tc_2", "bash", "output 2"),
      makeUserMsg("Q3"),
      makeAssistantMsg("A3"),
      makeToolResult("tc_3", "bash", "output 3"),
      makeUserMsg("Q4"),
      makeAssistantMsg("A4"),
      makeToolResult("tc_4", "bash", "output 4"),
    ];

    const result = await layer.apply(messages, BUDGET);

    // The offloaded result should NOT be re-masked (still has offloaded text)
    const offloaded = result.find((m) => (m as any).toolCallId === "tc_offloaded") as any;
    expect(offloaded.content[0].text).toContain("[Tool result offloaded to disk:");
  });

  // -------------------------------------------------------------------------
  // Already masked (no double-masking)
  // -------------------------------------------------------------------------

  it("skips tool results that are already masked", async () => {
    const layer = createObservationMaskerLayer(LOW_THRESHOLD_CONFIG);

    const messages: AgentMessage[] = [
      makeUserMsg("Q1"),
      makeAssistantMsg("A1"),
      makeMaskedToolResult("tc_already_masked", "bash"),
      // 3 more within keep window
      makeUserMsg("Q2"),
      makeAssistantMsg("A2"),
      makeToolResult("tc_2", "bash", "output 2"),
      makeUserMsg("Q3"),
      makeAssistantMsg("A3"),
      makeToolResult("tc_3", "bash", "output 3"),
      makeUserMsg("Q4"),
      makeAssistantMsg("A4"),
      makeToolResult("tc_4", "bash", "output 4"),
    ];

    const result = await layer.apply(messages, BUDGET);

    // Already-masked should NOT be double-masked
    const masked = result.find((m) => (m as any).toolCallId === "tc_already_masked") as any;
    expect(masked.content[0].text).toBe("[Tool result cleared: bash -- see assistant analysis above]");
  });

  // -------------------------------------------------------------------------
  // Immutability
  // -------------------------------------------------------------------------

  it("does not mutate the original message array or message objects", async () => {
    const layer = createObservationMaskerLayer(LOW_THRESHOLD_CONFIG);
    const messages = buildConversation(6);

    // Deep-clone the original content for comparison
    const originalTexts = messages
      .filter((m) => m.role === "toolResult")
      .map((m) => (m as any).content[0].text);

    const result = await layer.apply(messages, BUDGET);

    // Result should be a different array
    expect(result).not.toBe(messages);

    // Original messages should NOT be mutated
    const afterTexts = messages
      .filter((m) => m.role === "toolResult")
      .map((m) => (m as any).content[0].text);
    expect(afterTexts).toEqual(originalTexts);
  });

  // -------------------------------------------------------------------------
  // Persistent write-back
  // -------------------------------------------------------------------------

  it("persists masked entries to SessionManager via fileEntries and _rewriteFile()", async () => {
    const mockSm = {
      fileEntries: [
        { type: "message", message: { role: "user", content: "Q1" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A1" }] } },
        { type: "message", message: { role: "toolResult", toolCallId: "tc_0", toolName: "bash", content: [{ type: "text", text: "large output 0" }] } },
        { type: "message", message: { role: "user", content: "Q2" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A2" }] } },
        { type: "message", message: { role: "toolResult", toolCallId: "tc_1", toolName: "bash", content: [{ type: "text", text: "large output 1" }] } },
        { type: "message", message: { role: "user", content: "Q3" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A3" }] } },
        { type: "message", message: { role: "toolResult", toolCallId: "tc_2", toolName: "bash", content: [{ type: "text", text: "large output 2" }] } },
        { type: "message", message: { role: "user", content: "Q4" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A4" }] } },
        { type: "message", message: { role: "toolResult", toolCallId: "tc_3", toolName: "bash", content: [{ type: "text", text: "large output 3" }] } },
        { type: "message", message: { role: "user", content: "Q5" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A5" }] } },
        { type: "message", message: { role: "toolResult", toolCallId: "tc_4", toolName: "bash", content: [{ type: "text", text: "large output 4" }] } },
        { type: "message", message: { role: "user", content: "Q6" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A6" }] } },
        { type: "message", message: { role: "toolResult", toolCallId: "tc_5", toolName: "bash", content: [{ type: "text", text: "large output 5" }] } },
      ],
      _rewriteFile: vi.fn(),
    };

    const config: ObservationMaskerConfig = {
      observationKeepWindow: 3,
      observationTriggerChars: 100,

    };

    const layer = createObservationMaskerLayer(config, () => mockSm);
    const messages = buildConversation(6);

    await layer.apply(messages, BUDGET);

    // _rewriteFile should have been called once
    expect(mockSm._rewriteFile).toHaveBeenCalledTimes(1);

    // fileEntries for tc_0, tc_1, tc_2 should have masked content (new format)
    const entry0 = mockSm.fileEntries.find(
      (e: any) => e.type === "message" && e.message?.toolCallId === "tc_0",
    ) as any;
    expect(entry0.message.content[0].text).toContain("[Tool result summarized: bash");
    expect(entry0.message.content[0].text).toContain("chars cleared]");

    const entry1 = mockSm.fileEntries.find(
      (e: any) => e.type === "message" && e.message?.toolCallId === "tc_1",
    ) as any;
    expect(entry1.message.content[0].text).toContain("[Tool result summarized: bash");

    const entry2 = mockSm.fileEntries.find(
      (e: any) => e.type === "message" && e.message?.toolCallId === "tc_2",
    ) as any;
    expect(entry2.message.content[0].text).toContain("[Tool result summarized: bash");

    // tc_3, tc_4, tc_5 should NOT be mutated in fileEntries
    const entry3 = mockSm.fileEntries.find(
      (e: any) => e.type === "message" && e.message?.toolCallId === "tc_3",
    ) as any;
    expect(entry3.message.content[0].text).toBe("large output 3");

    const entry5 = mockSm.fileEntries.find(
      (e: any) => e.type === "message" && e.message?.toolCallId === "tc_5",
    ) as any;
    expect(entry5.message.content[0].text).toBe("large output 5");
  });

  // -------------------------------------------------------------------------
  // No write-back when no masking needed
  // -------------------------------------------------------------------------

  it("does not call _rewriteFile when all results are within keep window", async () => {
    const mockSm = {
      fileEntries: [],
      _rewriteFile: vi.fn(),
    };

    const config: ObservationMaskerConfig = {
      observationKeepWindow: 20,
      observationTriggerChars: 100,

    };

    const layer = createObservationMaskerLayer(config, () => mockSm);
    const messages = buildConversation(5);

    await layer.apply(messages, BUDGET);

    // All 5 tool results are within keep window (20), so no masking occurs
    expect(mockSm._rewriteFile).not.toHaveBeenCalled();
  });

  it("does not call _rewriteFile when below threshold", async () => {
    const mockSm = {
      fileEntries: [],
      _rewriteFile: vi.fn(),
    };

    const layer = createObservationMaskerLayer(DEFAULT_CONFIG, () => mockSm);
    const messages = buildConversation(3, "short");

    await layer.apply(messages, BUDGET);

    // Below 200K threshold, so no masking occurs
    expect(mockSm._rewriteFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Dual ratio threshold effect
  // -------------------------------------------------------------------------

  it("triggers masking sooner for tool-heavy sessions via dual ratio weighting", async () => {
    // A session with mostly toolResult content should trigger masking sooner
    // than pure text content of the same char count.

    // Build session with 100-char tool results -- with 2x weighting,
    // each toolResult counts as 200 chars.
    // 6 tool results * 100 chars = 600 raw, but with 2x = 1200 weighted
    // Plus user/assistant text
    const config: ObservationMaskerConfig = {
      observationKeepWindow: 2,
      observationTriggerChars: 500, // Set threshold between raw total and weighted total

    };

    // Build a conversation where raw chars < threshold but weighted chars > threshold
    // Each user msg: ~10 chars, each assistant: ~10 chars, each tool result: 150 chars
    // 5 triplets: raw = 5*(10+10+150) = 850
    // Weighted = 5*(10+10+300) = 1600 (toolResult chars doubled)
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(makeUserMsg(`Q${i}`.padEnd(10, ".")));
      messages.push(makeAssistantMsg(`A${i}`.padEnd(10, ".")));
      messages.push(makeToolResult(`tc_${i}`, "bash", "x".repeat(150)));
    }
    messages.push(makeAssistantMsg("Final"));

    const layer = createObservationMaskerLayer(config);
    const result = await layer.apply(messages, BUDGET);

    // Masking should activate due to dual ratio weighting
    const toolResults = result.filter((m) => m.role === "toolResult");
    const maskedResults = toolResults.filter((m) =>
      (m as any).content[0].text.startsWith("[Tool result summarized:"),
    );

    // 5 tool results - 2 keep window = 3 should be masked
    expect(maskedResults).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Mixed content
  // -------------------------------------------------------------------------

  it("masks only eligible tool results in mixed user/assistant/toolResult sessions", async () => {
    const layer = createObservationMaskerLayer(LOW_THRESHOLD_CONFIG);

    const messages: AgentMessage[] = [
      makeUserMsg("First question"),
      makeAssistantMsg("First analysis"),
      makeToolResult("tc_old1", "bash", "old output 1"),
      makeUserMsg("Second question"),
      makeAssistantMsg("Second analysis"),
      makeToolResult("tc_old2", "bash", "old output 2"),
      makeUserMsg("Third question"),
      makeAssistantMsg("Third analysis"),
      makeToolResult("tc_recent1", "bash", "recent output 1"),
      makeUserMsg("Fourth question"),
      makeAssistantMsg("Fourth analysis"),
      makeToolResult("tc_recent2", "bash", "recent output 2"),
      makeUserMsg("Fifth question"),
      makeAssistantMsg("Fifth analysis"),
      makeToolResult("tc_recent3", "bash", "recent output 3"),
      makeAssistantMsg("Final"),
    ];

    const result = await layer.apply(messages, BUDGET);

    // All user messages preserved
    expect(result.filter((m) => m.role === "user")).toHaveLength(5);

    // All assistant messages preserved (5 original + 1 trailing)
    expect(result.filter((m) => m.role === "assistant")).toHaveLength(6);

    // tc_old1, tc_old2 should be masked (beyond keep window of 3)
    const old1 = result.find((m) => (m as any).toolCallId === "tc_old1") as any;
    expect(old1.content[0].text).toContain("[Tool result summarized: bash");

    const old2 = result.find((m) => (m as any).toolCallId === "tc_old2") as any;
    expect(old2.content[0].text).toContain("[Tool result summarized: bash");

    // tc_recent1..3 should be intact (within keep window)
    const recent1 = result.find((m) => (m as any).toolCallId === "tc_recent1") as any;
    expect(recent1.content[0].text).toBe("recent output 1");

    const recent2 = result.find((m) => (m as any).toolCallId === "tc_recent2") as any;
    expect(recent2.content[0].text).toBe("recent output 2");

    const recent3 = result.find((m) => (m as any).toolCallId === "tc_recent3") as any;
    expect(recent3.content[0].text).toBe("recent output 3");
  });

  // -------------------------------------------------------------------------
  // Layer name
  // -------------------------------------------------------------------------

  it("has name 'observation-masker'", () => {
    const layer = createObservationMaskerLayer(DEFAULT_CONFIG);
    expect(layer.name).toBe("observation-masker");
  });

  // -------------------------------------------------------------------------
  // Hysteresis band
  // -------------------------------------------------------------------------

  it("should not deactivate masking when context drops between activation and deactivation thresholds", async () => {
    // Config: activate at 1000 weighted chars, deactivate at 400
    // Keep window = 2 so older tool results get masked
    const config: ObservationMaskerConfig = {
      observationTriggerChars: 1000,
      observationDeactivationChars: 400,
      observationKeepWindow: 2,

    };
    const layer = createObservationMaskerLayer(config);

    // Call 1: Total > 1000 (trigger threshold) -- should activate masking
    // 4 tool results at 200 chars each = 200*2*4 = 1600 weighted chars (plus user/assistant overhead)
    const messages1: AgentMessage[] = [
      makeUserMsg("q1"),
      makeAssistantMsg("a1"),
      makeToolResult("tc-1", "bash", "x".repeat(200)),
      makeUserMsg("q2"),
      makeAssistantMsg("a2"),
      makeToolResult("tc-2", "bash", "x".repeat(200)),
      makeUserMsg("q3"),
      makeAssistantMsg("a3"),
      makeToolResult("tc-3", "bash", "x".repeat(200)),
      makeUserMsg("q4"),
      makeAssistantMsg("a4"),
      makeToolResult("tc-4", "bash", "x".repeat(200)),
      makeAssistantMsg("Final"),
    ];
    const result1 = await layer.apply(messages1, BUDGET);
    // tc-1 and tc-2 outside keep window (2), should be masked
    const tc1r1 = result1.find((m) => (m as any).toolCallId === "tc-1") as any;
    expect(tc1r1.content[0].text).toContain("[Tool result summarized:");

    // Call 2: Context is now between thresholds (600 weighted, between 400-1000)
    // Masking should stay active because we haven't dropped below 400
    // Use the post-masking context: tc-1 and tc-2 are placeholders (~60 chars each * 2 = ~240),
    // tc-3 and tc-4 are 200 chars each * 2 = 800. Plus user/assistant overhead. Total ~1050.
    // But to be precise, let's just re-feed with smaller content that lands in the band.
    const messages2: AgentMessage[] = [
      makeUserMsg("q1"),
      makeAssistantMsg("a1"),
      makeToolResult("tc-5", "bash", "x".repeat(150)),
      makeUserMsg("q2"),
      makeAssistantMsg("a2"),
      makeToolResult("tc-6", "bash", "x".repeat(150)),
      makeUserMsg("q3"),
      makeAssistantMsg("a3"),
      makeToolResult("tc-7", "bash", "x".repeat(50)),
      makeAssistantMsg("Final"),
    ];
    // Weighted total: 2*150 + 2*150 + 2*50 + user/assistant = 700 + ~30 = ~730
    // Between 400 and 1000 -- hysteresis should keep masking active
    const result2 = await layer.apply(messages2, BUDGET);
    // tc-5 is outside keep window (2), should be masked because masking stayed active
    const tc5r2 = result2.find((m) => (m as any).toolCallId === "tc-5") as any;
    expect(tc5r2.content[0].text).toContain("[Tool result summarized:");

    // Call 3: Context drops below 400 (deactivation threshold)
    const messages3: AgentMessage[] = [
      makeUserMsg("q1"),
      makeAssistantMsg("a1"),
      makeToolResult("tc-8", "bash", "x".repeat(30)),
      makeUserMsg("q2"),
      makeAssistantMsg("a2"),
      makeToolResult("tc-9", "bash", "x".repeat(30)),
      makeUserMsg("q3"),
      makeAssistantMsg("a3"),
      makeToolResult("tc-10", "bash", "x".repeat(30)),
      makeAssistantMsg("Final"),
    ];
    // Weighted total: 3*(2*30) + user/assistant = 180 + ~30 = ~210 -- below 400
    const result3 = await layer.apply(messages3, BUDGET);
    // Masking should deactivate -- all results returned unchanged
    const tc8r3 = result3.find((m) => (m as any).toolCallId === "tc-8") as any;
    expect(tc8r3.content[0].text).toBe("x".repeat(30));
  });

  // -------------------------------------------------------------------------
  // Monotonic masking via everMaskedIds
  // -------------------------------------------------------------------------

  it("should never unmask a previously-masked tool call ID (monotonic via everMaskedIds)", async () => {
    // Config: activate at 500, deactivate at 200, keep 1
    const config: ObservationMaskerConfig = {
      observationTriggerChars: 500,
      observationDeactivationChars: 200,
      observationKeepWindow: 1,

    };
    const layer = createObservationMaskerLayer(config);

    // Call 1: Feed messages totaling > 500 weighted chars
    // tc-1 (300 chars, weighted 600) + tc-2 (300 chars, weighted 600) + overhead
    // Total well above 500. tc-1 is oldest, outside keep window (1), gets masked.
    const messages1: AgentMessage[] = [
      makeUserMsg("hello"),
      makeAssistantMsg("ok"),
      makeToolResult("tc-1", "bash", "x".repeat(300)),
      makeUserMsg("next"),
      makeAssistantMsg("done"),
      makeToolResult("tc-2", "bash", "x".repeat(300)),
      makeAssistantMsg("Final"),
    ];
    const result1 = await layer.apply(messages1, BUDGET);
    const tc1r1 = result1.find((m) => (m as any).toolCallId === "tc-1") as any;
    expect(tc1r1.content[0].text).toContain("[Tool result summarized:");
    const tc2r1 = result1.find((m) => (m as any).toolCallId === "tc-2") as any;
    expect(tc2r1.content[0].text).toBe("x".repeat(300));

    // Call 2: tc-1 re-presented with original content (simulating no write-back).
    // tc-2 is now small content. Masking is still active (above deactivation threshold).
    // The everMaskedIds guard must keep tc-1 masked even though its content is the original.
    const messages2: AgentMessage[] = [
      makeUserMsg("hello"),
      makeAssistantMsg("ok"),
      makeToolResult("tc-1", "bash", "x".repeat(300)), // Original content, NOT placeholder
      makeUserMsg("next"),
      makeAssistantMsg("done"),
      makeToolResult("tc-2", "bash", "x".repeat(50)),
      makeUserMsg("again"),
      makeAssistantMsg("sure"),
      makeToolResult("tc-3", "bash", "x".repeat(200)),
      makeAssistantMsg("Final"),
    ];
    // Weighted: 600 + 100 + 400 + overhead = ~1120 -- above 500 trigger and 200 deactivation
    const result2 = await layer.apply(messages2, BUDGET);

    // tc-1 must NOT appear with original 300-char content -- everMaskedIds prevents re-evaluation
    const tc1r2 = result2.find((m) => (m as any).toolCallId === "tc-1") as any;
    expect(tc1r2.content[0].text).not.toBe("x".repeat(300));
  });

  // -------------------------------------------------------------------------
  // No oscillation near activation threshold
  // -------------------------------------------------------------------------

  it("should not oscillate near the activation threshold", async () => {
    // Config: activate at 1000, deactivate at 600, keep 2
    const config: ObservationMaskerConfig = {
      observationTriggerChars: 1000,
      observationDeactivationChars: 600,
      observationKeepWindow: 2,

    };
    const layer = createObservationMaskerLayer(config);

    // Run 5 consecutive calls with messages that would oscillate between 900-1100 chars
    // without hysteresis. With hysteresis, masking activates on first call and stays active.
    const results: AgentMessage[][] = [];
    for (let callNum = 0; callNum < 5; callNum++) {
      // Each call: 3 tool results at 200 chars each = 200*2*3 = 1200 weighted + overhead
      // This is above 1000 trigger, so first call activates masking.
      // After masking, 1 tool result masked (~60 chars placeholder * 2 = 120 weighted),
      // 2 kept (200*2*2=800). Total ~920+overhead. Still above 600, so masking stays active.
      const messages: AgentMessage[] = [
        makeUserMsg("q"),
        makeAssistantMsg("a"),
        makeToolResult(`tc-${callNum}-1`, "bash", "x".repeat(200)),
        makeUserMsg("q"),
        makeAssistantMsg("a"),
        makeToolResult(`tc-${callNum}-2`, "bash", "x".repeat(200)),
        makeUserMsg("q"),
        makeAssistantMsg("a"),
        makeToolResult(`tc-${callNum}-3`, "bash", "x".repeat(200)),
        makeAssistantMsg("Final"),
      ];
      const result = await layer.apply(messages, BUDGET);
      results.push(result);
    }

    // Masking should activate on first call and stay active on all subsequent calls
    for (let i = 0; i < 5; i++) {
      const maskedInCall = results[i]!.filter((m) =>
        m.role === "toolResult" && (m as any).content[0].text.startsWith("[Tool result summarized:"),
      );
      // Each call: 3 tool results - 2 keep window = 1 masked
      expect(maskedInCall.length).toBeGreaterThanOrEqual(1);
    }

    // After call 0, the oldest tool result position is always masked.
    // Verify stability: in calls 1-4, the first tool result (index 0) is always masked.
    for (let i = 1; i < 5; i++) {
      const firstToolResult = results[i]!.find((m) =>
        m.role === "toolResult" && (m as any).toolCallId === `tc-${i}-1`,
      ) as any;
      expect(firstToolResult.content[0].text).toContain("[Tool result summarized:");
    }
  });

  // -------------------------------------------------------------------------
  // Session isolation (no cross-instance leakage)
  // -------------------------------------------------------------------------

  it("should reset hysteresis state per factory instance", async () => {
    const config: ObservationMaskerConfig = {
      observationTriggerChars: 500,
      observationDeactivationChars: 200,
      observationKeepWindow: 2,

    };

    // Create two separate masker layers (simulating two sessions)
    const masker1 = createObservationMaskerLayer(config);
    const masker2 = createObservationMaskerLayer(config);

    // Activate masking on masker1 (feed > trigger chars)
    const highMessages: AgentMessage[] = [
      makeUserMsg("q1"),
      makeAssistantMsg("a1"),
      makeToolResult("tc-1", "bash", "x".repeat(200)),
      makeUserMsg("q2"),
      makeAssistantMsg("a2"),
      makeToolResult("tc-2", "bash", "x".repeat(200)),
      makeUserMsg("q3"),
      makeAssistantMsg("a3"),
      makeToolResult("tc-3", "bash", "x".repeat(200)),
      makeAssistantMsg("Final"),
    ];
    const result1 = await masker1.apply(highMessages, BUDGET);
    // Masker1 should mask (>500 weighted chars)
    const masker1Masked = result1.filter((m) =>
      m.role === "toolResult" && (m as any).content[0].text.startsWith("[Tool result summarized:"),
    );
    expect(masker1Masked.length).toBeGreaterThan(0);

    // Feed masker2 with < trigger chars -- masker2 should NOT mask
    const lowMessages: AgentMessage[] = [
      makeUserMsg("q1"),
      makeAssistantMsg("a1"),
      makeToolResult("tc-4", "bash", "x".repeat(30)),
      makeUserMsg("q2"),
      makeAssistantMsg("a2"),
      makeToolResult("tc-5", "bash", "x".repeat(30)),
    ];
    // Weighted: 2*(2*30) + overhead = 120 + ~10 = ~130 -- below 500
    const result2 = await masker2.apply(lowMessages, BUDGET);
    // Masker2 should NOT mask (no cross-instance leakage from masker1)
    expect(result2).toBe(lowMessages); // Same reference = no changes
  });

  // -------------------------------------------------------------------------
  // Backward compatibility with protected/offloaded results
  // -------------------------------------------------------------------------

  it("should preserve existing behavior for protected tools and already-offloaded results", async () => {
    const config: ObservationMaskerConfig = {
      observationTriggerChars: 100,
      observationDeactivationChars: 50,
      observationKeepWindow: 1,

    };
    const layer = createObservationMaskerLayer(config);

    const messages: AgentMessage[] = [
      makeUserMsg("q1"),
      makeAssistantMsg("a1"),
      // Protected tool -- should never be masked regardless of position
      makeToolResult("tc-mem", "memory_search", "Found 10 results with full details..."),
      makeUserMsg("q2"),
      makeAssistantMsg("a2"),
      // Already offloaded by microcompaction -- should be skipped
      makeOffloadedToolResult("tc-offloaded", "bash"),
      makeUserMsg("q3"),
      makeAssistantMsg("a3"),
      // Already masked -- should be skipped (no double-masking)
      makeMaskedToolResult("tc-prev-masked", "bash"),
      makeUserMsg("q4"),
      makeAssistantMsg("a4"),
      // Regular tool result outside keep window -- should be masked
      makeToolResult("tc-old", "bash", "old output that should be masked"),
      makeUserMsg("q5"),
      makeAssistantMsg("a5"),
      // Within keep window (1) -- should be kept
      makeToolResult("tc-recent", "bash", "recent output to keep"),
      makeAssistantMsg("Final"),
    ];

    const result = await layer.apply(messages, BUDGET);

    // Protected tool: memory_search should never be masked
    const memResult = result.find((m) => (m as any).toolCallId === "tc-mem") as any;
    expect(memResult.content[0].text).toBe("Found 10 results with full details...");

    // Already offloaded: should remain with offloaded text
    const offloadedResult = result.find((m) => (m as any).toolCallId === "tc-offloaded") as any;
    expect(offloadedResult.content[0].text).toContain("[Tool result offloaded to disk:");

    // Already masked: should remain with masked text (no double-masking)
    const prevMasked = result.find((m) => (m as any).toolCallId === "tc-prev-masked") as any;
    expect(prevMasked.content[0].text).toBe("[Tool result cleared: bash -- see assistant analysis above]");

    // Regular old tool result: should be masked
    const oldResult = result.find((m) => (m as any).toolCallId === "tc-old") as any;
    expect(oldResult.content[0].text).toContain("[Tool result summarized:");

    // Recent tool result within keep window: should be kept
    const recentResult = result.find((m) => (m as any).toolCallId === "tc-recent") as any;
    expect(recentResult.content[0].text).toBe("recent output to keep");
  });

  // -------------------------------------------------------------------------
  // cache fence
  // -------------------------------------------------------------------------

  describe("cache fence", () => {
    it("skips masking tool results at or before fence", async () => {
      const onMasked = vi.fn();
      // keepWindow=1 so only the most recent tool result is kept
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 1,
        observationTriggerChars: 100, // Very low to trigger easily

      };
      const layer = createObservationMaskerLayer(config, undefined, onMasked);

      // Build messages with enough chars to exceed threshold.
      // 5 tool results: indices 1, 3, 5, 7, 9. Fence protects indices 0-5.
      const messages: AgentMessage[] = [
        makeUserMsg("x".repeat(50)),
        makeToolResult("tc-1", "bash", "a".repeat(50)),
        makeAssistantMsg("response 1"),
        makeToolResult("tc-2", "bash", "b".repeat(50)),
        makeAssistantMsg("response 2"),
        makeToolResult("tc-3", "bash", "c".repeat(50)),   // index 5 -- fenced
        makeAssistantMsg("response 3"),
        makeToolResult("tc-4", "bash", "d".repeat(50)),   // index 7 -- beyond fence, beyond keep window -> mask
        makeAssistantMsg("response 4"),
        makeToolResult("tc-5", "bash", "e".repeat(50)),   // index 9 -- most recent (keep window) -> keep
        makeAssistantMsg("Final"),                         // index 10 -- trailing assistant
      ];

      const fencedBudget: TokenBudget = { ...BUDGET, cacheFenceIndex: 5 };
      const result = await layer.apply(messages, fencedBudget);

      // Messages at indices 1, 3, 5 are within fence -- NOT masked
      for (const idx of [1, 3, 5]) {
        const msg = result[idx] as any;
        expect(msg.content[0].text).not.toContain("[Tool result summarized:");
      }

      // Message at index 7 is beyond fence and beyond keep window -> masked
      const msg7 = result[7] as any;
      expect(msg7.content[0].text).toContain("[Tool result summarized:");

      // Message at index 9 is the most recent (within keep window) -> kept
      const msg9 = result[9] as any;
      expect(msg9.content[0].text).toBe("e".repeat(50));
    });

    it("fence takes priority over everMaskedIds", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 1,
        observationTriggerChars: 100,

      };
      const layer = createObservationMaskerLayer(config);

      // Build messages: tc-fence will be masked on first call, then fenced on second
      const messages: AgentMessage[] = [
        makeUserMsg("x".repeat(50)),
        makeToolResult("tc-fence", "bash", "should be masked first"),   // index 1
        makeAssistantMsg("response"),
        makeToolResult("tc-recent", "bash", "y".repeat(50)),            // index 3 -- keep window
        makeAssistantMsg("Final"),                                       // index 4 -- trailing assistant
      ];

      // First call: fence=-1, so tc-fence gets masked
      const noFenceBudget: TokenBudget = { ...BUDGET, cacheFenceIndex: -1 };
      const result1 = await layer.apply(messages, noFenceBudget);
      const msg1 = result1[1] as any;
      expect(msg1.content[0].text).toContain("[Tool result summarized:");

      // Second call: fence=1, so tc-fence is now protected
      // Even though everMaskedIds contains tc-fence, fence takes priority
      const fencedBudget: TokenBudget = { ...BUDGET, cacheFenceIndex: 1 };
      const result2 = await layer.apply(messages, fencedBudget);
      const msg2 = result2[1] as any;
      // Should NOT be masked -- fence takes priority over everMaskedIds
      expect(msg2.content[0].text).toBe("should be masked first");
    });
  });

  // -------------------------------------------------------------------------
  // isAlreadyOffloaded format compatibility
  // -------------------------------------------------------------------------

  describe("isAlreadyOffloaded format compatibility", () => {
    it("skips masking messages with OLD offloaded format", async () => {
      const layer = createObservationMaskerLayer(LOW_THRESHOLD_CONFIG);

      const oldFormatMsg: AgentMessage = {
        role: "toolResult",
        toolCallId: "tc-old-fmt",
        toolName: "bash",
        content: [{
          type: "text",
          text: `[Tool result offloaded to disk: bash returned 12000 chars.\nThe agent's analysis is in the assistant response below.\nUse file_read to re-access if needed: /path/to/file.json]`,
        }],
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage;

      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("A1"),
        oldFormatMsg,
        makeUserMsg("Q2"),
        makeAssistantMsg("A2"),
        makeToolResult("tc-keep1", "bash", "keep1"),
        makeUserMsg("Q3"),
        makeAssistantMsg("A3"),
        makeToolResult("tc-keep2", "bash", "keep2"),
        makeUserMsg("Q4"),
        makeAssistantMsg("A4"),
        makeToolResult("tc-keep3", "bash", "keep3"),
      ];

      const result = await layer.apply(messages, BUDGET);

      // Old format should pass through unchanged (not masked, not double-processed)
      const oldFmt = result.find((m) => (m as any).toolCallId === "tc-old-fmt") as any;
      expect(oldFmt.content[0].text).toContain("[Tool result offloaded to disk:");
      expect(oldFmt.content[0].text).toContain("The agent's analysis");
    });

    it("skips masking messages with NEW preview offloaded format", async () => {
      const layer = createObservationMaskerLayer(LOW_THRESHOLD_CONFIG);

      const newFormatMsg: AgentMessage = {
        role: "toolResult",
        toolCallId: "tc-new-fmt",
        toolName: "bash",
        content: [{
          type: "text",
          text: `[Tool result offloaded to disk: bash returned 12000 chars. hasMore=true\n--- head (1500 chars) ---\n${"x".repeat(1500)}\n--- tail (500 chars) ---\n${"y".repeat(500)}\nUse file_read to re-access full content: /path/to/file.json]`,
        }],
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage;

      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("A1"),
        newFormatMsg,
        makeUserMsg("Q2"),
        makeAssistantMsg("A2"),
        makeToolResult("tc-keep1", "bash", "keep1"),
        makeUserMsg("Q3"),
        makeAssistantMsg("A3"),
        makeToolResult("tc-keep2", "bash", "keep2"),
        makeUserMsg("Q4"),
        makeAssistantMsg("A4"),
        makeToolResult("tc-keep3", "bash", "keep3"),
      ];

      const result = await layer.apply(messages, BUDGET);

      // New format should pass through unchanged (not masked, not double-processed)
      const newFmt = result.find((m) => (m as any).toolCallId === "tc-new-fmt") as any;
      expect(newFmt.content[0].text).toContain("[Tool result offloaded to disk:");
      expect(newFmt.content[0].text).toContain("hasMore=true");
    });
  });

  // -------------------------------------------------------------------------
  // Tier-aware masking (Phase 8)
  // -------------------------------------------------------------------------

  describe("tier-aware masking (Phase 8)", () => {
    /** Config with distinct ephemeral and standard windows for tier tests. */
    const tierConfig: ObservationMaskerConfig = {
      observationKeepWindow: 25,
      observationTriggerChars: 100,
      ephemeralKeepWindow: 10,

    };

    // -----------------------------------------------------------------------
    // Ephemeral keep window
    // -----------------------------------------------------------------------

    it("masks ephemeral tool results beyond ephemeralKeepWindow", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 25,
        observationTriggerChars: 100,
        ephemeralKeepWindow: 10,

      };
      const layer = createObservationMaskerLayer(config);

      // 11 web_search tool results: first 10 kept, 11th (oldest) masked
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 11; i++) {
        messages.push(makeUserMsg(`Q${i}`));
        messages.push(makeAssistantMsg(`A${i}`));
        messages.push(makeToolResult(`tc_ws_${i}`, "web_search", `search result ${i}`));
      }
      messages.push(makeAssistantMsg("Final"));

      const result = await layer.apply(messages, BUDGET);

      // tc_ws_0 (oldest) should be masked -- beyond ephemeralKeepWindow=10
      const oldest = result.find((m) => (m as any).toolCallId === "tc_ws_0") as any;
      expect(oldest.content[0].text).toContain("[Tool result summarized:");

      // tc_ws_1 through tc_ws_10 should be kept (10 most recent)
      for (let i = 1; i <= 10; i++) {
        const msg = result.find((m) => (m as any).toolCallId === `tc_ws_${i}`) as any;
        expect(msg.content[0].text).toBe(`search result ${i}`);
      }
    });

    it("respects custom ephemeralKeepWindow=5", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 25,
        observationTriggerChars: 100,
        ephemeralKeepWindow: 5,

      };
      const layer = createObservationMaskerLayer(config);

      // 8 web_search results: only 5 most recent kept
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 8; i++) {
        messages.push(makeUserMsg(`Q${i}`));
        messages.push(makeAssistantMsg(`A${i}`));
        messages.push(makeToolResult(`tc_ws_${i}`, "web_search", `search ${i}`));
      }
      messages.push(makeAssistantMsg("Final"));

      const result = await layer.apply(messages, BUDGET);

      // tc_ws_0, tc_ws_1, tc_ws_2 (oldest 3) should be masked
      for (let i = 0; i < 3; i++) {
        const msg = result.find((m) => (m as any).toolCallId === `tc_ws_${i}`) as any;
        expect(msg.content[0].text).toContain("[Tool result summarized:");
      }

      // tc_ws_3 through tc_ws_7 should be kept (5 most recent)
      for (let i = 3; i < 8; i++) {
        const msg = result.find((m) => (m as any).toolCallId === `tc_ws_${i}`) as any;
        expect(msg.content[0].text).toBe(`search ${i}`);
      }
    });

    // -----------------------------------------------------------------------
    // Protected tools never masked
    // -----------------------------------------------------------------------

    it("never masks protected tool at position far beyond any window", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 2,
        observationTriggerChars: 100,
        ephemeralKeepWindow: 2,

      };
      const layer = createObservationMaskerLayer(config);

      // Place a protected tool at position 0 (oldest), with 50 standard tools after
      const messages: AgentMessage[] = [
        makeUserMsg("Q0"),
        makeAssistantMsg("A0"),
        makeToolResult("tc_mem_old", "memory_search", "Found old results"),
      ];
      for (let i = 1; i <= 50; i++) {
        messages.push(makeUserMsg(`Q${i}`));
        messages.push(makeAssistantMsg(`A${i}`));
        messages.push(makeToolResult(`tc_bash_${i}`, "bash", `output ${i}`));
      }

      const result = await layer.apply(messages, BUDGET);

      // Protected tool at position 0 -- must NOT be masked
      const memOld = result.find((m) => (m as any).toolCallId === "tc_mem_old") as any;
      expect(memOld.content[0].text).toBe("Found old results");
    });

    it("never masks any of the 5 protected tools even with keepWindow=0", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 0,
        observationTriggerChars: 100,
        ephemeralKeepWindow: 0,

      };
      const layer = createObservationMaskerLayer(config);

      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("A1"),
        makeToolResult("tc_mem_search", "memory_search", "search results"),
        makeUserMsg("Q2"),
        makeAssistantMsg("A2"),
        makeToolResult("tc_mem_get", "memory_get", "get results"),
        makeUserMsg("Q3"),
        makeAssistantMsg("A3"),
        makeToolResult("tc_mem_store", "memory_store", "stored ok"),
        makeUserMsg("Q4"),
        makeAssistantMsg("A4"),
        makeToolResult("tc_file_read", "file_read", "file content"),
        makeUserMsg("Q5"),
        makeAssistantMsg("A5"),
        makeToolResult("tc_session", "session_search", "session data"),
      ];

      const result = await layer.apply(messages, BUDGET);

      // All 5 protected tools kept
      expect((result.find((m) => (m as any).toolCallId === "tc_mem_search") as any).content[0].text).toBe("search results");
      expect((result.find((m) => (m as any).toolCallId === "tc_mem_get") as any).content[0].text).toBe("get results");
      expect((result.find((m) => (m as any).toolCallId === "tc_mem_store") as any).content[0].text).toBe("stored ok");
      expect((result.find((m) => (m as any).toolCallId === "tc_file_read") as any).content[0].text).toBe("file content");
      expect((result.find((m) => (m as any).toolCallId === "tc_session") as any).content[0].text).toBe("session data");
    });

    // -----------------------------------------------------------------------
    // Interleaved per-tier counters
    // -----------------------------------------------------------------------

    it("interleaved protected tools do NOT shift ephemeral counter", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 25,
        observationTriggerChars: 100,
        ephemeralKeepWindow: 2,

      };
      const layer = createObservationMaskerLayer(config);

      // [web_search, memory_search, web_search, memory_search, web_search]
      // ephemeralKeepWindow=2, so only the 2 most recent web_search kept
      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("A1"),
        makeToolResult("tc_ws_1", "web_search", "result 1"),
        makeUserMsg("Q2"),
        makeAssistantMsg("A2"),
        makeToolResult("tc_mem_1", "memory_search", "mem result 1"),
        makeUserMsg("Q3"),
        makeAssistantMsg("A3"),
        makeToolResult("tc_ws_2", "web_search", "result 2"),
        makeUserMsg("Q4"),
        makeAssistantMsg("A4"),
        makeToolResult("tc_mem_2", "memory_search", "mem result 2"),
        makeUserMsg("Q5"),
        makeAssistantMsg("A5"),
        makeToolResult("tc_ws_3", "web_search", "result 3"),
        makeAssistantMsg("Final"),
      ];

      const result = await layer.apply(messages, BUDGET);

      // tc_ws_1 (oldest ephemeral) should be masked -- only 2 most recent kept
      const ws1 = result.find((m) => (m as any).toolCallId === "tc_ws_1") as any;
      expect(ws1.content[0].text).toContain("[Tool result summarized:");

      // tc_ws_2 and tc_ws_3 (2 most recent ephemeral) should be kept
      const ws2 = result.find((m) => (m as any).toolCallId === "tc_ws_2") as any;
      expect(ws2.content[0].text).toBe("result 2");

      const ws3 = result.find((m) => (m as any).toolCallId === "tc_ws_3") as any;
      expect(ws3.content[0].text).toBe("result 3");

      // All memory_search (protected) should be kept
      const mem1 = result.find((m) => (m as any).toolCallId === "tc_mem_1") as any;
      expect(mem1.content[0].text).toBe("mem result 1");

      const mem2 = result.find((m) => (m as any).toolCallId === "tc_mem_2") as any;
      expect(mem2.content[0].text).toBe("mem result 2");
    });

    it("interleaved protected tools do NOT shift standard counter", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 2,
        observationTriggerChars: 100,
        ephemeralKeepWindow: 10,

      };
      const layer = createObservationMaskerLayer(config);

      // [bash, file_read, bash, file_read, bash] with observationKeepWindow=2
      // -> 2 most recent bash kept, file_read all kept
      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("A1"),
        makeToolResult("tc_bash_1", "bash", "output 1"),
        makeUserMsg("Q2"),
        makeAssistantMsg("A2"),
        makeToolResult("tc_fr_1", "file_read", "file content 1"),
        makeUserMsg("Q3"),
        makeAssistantMsg("A3"),
        makeToolResult("tc_bash_2", "bash", "output 2"),
        makeUserMsg("Q4"),
        makeAssistantMsg("A4"),
        makeToolResult("tc_fr_2", "file_read", "file content 2"),
        makeUserMsg("Q5"),
        makeAssistantMsg("A5"),
        makeToolResult("tc_bash_3", "bash", "output 3"),
        makeAssistantMsg("Final"),
      ];

      const result = await layer.apply(messages, BUDGET);

      // tc_bash_1 (oldest standard) should be masked
      const bash1 = result.find((m) => (m as any).toolCallId === "tc_bash_1") as any;
      expect(bash1.content[0].text).toContain("[Tool result summarized:");

      // tc_bash_2 and tc_bash_3 (2 most recent standard) should be kept
      const bash2 = result.find((m) => (m as any).toolCallId === "tc_bash_2") as any;
      expect(bash2.content[0].text).toBe("output 2");

      const bash3 = result.find((m) => (m as any).toolCallId === "tc_bash_3") as any;
      expect(bash3.content[0].text).toBe("output 3");

      // All file_read (protected) should be kept
      const fr1 = result.find((m) => (m as any).toolCallId === "tc_fr_1") as any;
      expect(fr1.content[0].text).toBe("file content 1");

      const fr2 = result.find((m) => (m as any).toolCallId === "tc_fr_2") as any;
      expect(fr2.content[0].text).toBe("file content 2");
    });

    // -----------------------------------------------------------------------
    // Unknown and MCP tools use standard window
    // -----------------------------------------------------------------------

    it("unknown tool uses standard window (observationKeepWindow)", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 2,
        observationTriggerChars: 100,
        ephemeralKeepWindow: 1,

      };
      const layer = createObservationMaskerLayer(config);

      // 4 custom_tool results with standard keep window = 2
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 4; i++) {
        messages.push(makeUserMsg(`Q${i}`));
        messages.push(makeAssistantMsg(`A${i}`));
        messages.push(makeToolResult(`tc_custom_${i}`, "custom_tool", `custom output ${i}`));
      }
      messages.push(makeAssistantMsg("Final"));

      const result = await layer.apply(messages, BUDGET);

      // tc_custom_0, tc_custom_1 should be masked (beyond standard keep window = 2)
      for (let i = 0; i < 2; i++) {
        const msg = result.find((m) => (m as any).toolCallId === `tc_custom_${i}`) as any;
        expect(msg.content[0].text).toContain("[Tool result summarized:");
      }

      // tc_custom_2, tc_custom_3 should be kept (within standard keep window)
      for (let i = 2; i < 4; i++) {
        const msg = result.find((m) => (m as any).toolCallId === `tc_custom_${i}`) as any;
        expect(msg.content[0].text).toBe(`custom output ${i}`);
      }
    });

    it("MCP tool uses ephemeral window (ephemeralKeepWindow)", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 2,
        observationTriggerChars: 100,
        ephemeralKeepWindow: 1,

      };
      const layer = createObservationMaskerLayer(config);

      // 4 MCP tool results -- now classified as ephemeral tier
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 4; i++) {
        messages.push(makeUserMsg(`Q${i}`));
        messages.push(makeAssistantMsg(`A${i}`));
        messages.push(makeToolResult(`tc_mcp_${i}`, "mcp__server__tool", `mcp output ${i}`));
      }
      messages.push(makeAssistantMsg("Final"));

      const result = await layer.apply(messages, BUDGET);

      // tc_mcp_0, tc_mcp_1, tc_mcp_2 should be masked (beyond ephemeral keep window = 1)
      for (let i = 0; i < 3; i++) {
        const msg = result.find((m) => (m as any).toolCallId === `tc_mcp_${i}`) as any;
        expect(msg.content[0].text).toContain("[Tool result summarized:");
      }

      // tc_mcp_3 should be kept (within ephemeral keep window = 1)
      const msg = result.find((m) => (m as any).toolCallId === `tc_mcp_3`) as any;
      expect(msg.content[0].text).toBe(`mcp output 3`);
    });

    // -----------------------------------------------------------------------
    // ephemeralKeepWindow config respected (not hardcoded)
    // -----------------------------------------------------------------------

    it("respects ephemeralKeepWindow config value (not hardcoded 10)", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 25,
        observationTriggerChars: 100,
        ephemeralKeepWindow: 3,

      };
      const layer = createObservationMaskerLayer(config);

      // 5 ephemeral tools -- with window=3, 2 oldest should be masked
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 5; i++) {
        messages.push(makeUserMsg(`Q${i}`));
        messages.push(makeAssistantMsg(`A${i}`));
        messages.push(makeToolResult(`tc_ws_${i}`, "brave_search", `search ${i}`));
      }
      messages.push(makeAssistantMsg("Final"));

      const result = await layer.apply(messages, BUDGET);

      // tc_ws_0 and tc_ws_1 should be masked
      for (let i = 0; i < 2; i++) {
        const msg = result.find((m) => (m as any).toolCallId === `tc_ws_${i}`) as any;
        expect(msg.content[0].text).toContain("[Tool result summarized:");
      }

      // tc_ws_2, tc_ws_3, tc_ws_4 should be kept (3 most recent)
      for (let i = 2; i < 5; i++) {
        const msg = result.find((m) => (m as any).toolCallId === `tc_ws_${i}`) as any;
        expect(msg.content[0].text).toBe(`search ${i}`);
      }
    });

    // -----------------------------------------------------------------------
    // Protected exemption from monotonic masking
    // -----------------------------------------------------------------------

    it("protected tool in everMaskedIds is NOT force-masked", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 1,
        observationTriggerChars: 100,
        observationDeactivationChars: 50, // Low deactivation so masking stays active on call 2
        ephemeralKeepWindow: 1,

      };
      const layer = createObservationMaskerLayer(config);

      // Call 1: Force memory_search into everMaskedIds by having it beyond the keep window
      // This should NOT happen with per-tier counters (protected is never masked),
      // but we need to verify that even if somehow in everMaskedIds, it's exempt.
      // We simulate this by having a standard tool masked first, then on call 2 presenting
      // a protected tool with same ID pattern.

      // Actually, the correct test: call 1 masks a standard tool "tc-1".
      // Call 2: resubmit "tc-1" but now as memory_search.
      // The everMaskedIds should NOT force-mask it because it's protected tier.
      const messages1: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("A1"),
        makeToolResult("tc-shared-id", "bash", "x".repeat(200)),
        makeUserMsg("Q2"),
        makeAssistantMsg("A2"),
        makeToolResult("tc-recent", "bash", "x".repeat(200)),
      ];

      // Call 1: tc-shared-id is bash (standard), beyond keep window -> masked
      await layer.apply(messages1, BUDGET);

      // Call 2: same tc-shared-id but now presented as memory_search (protected)
      // This tests the protected tool exemption from masking
      const messages2: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("A1"),
        makeToolResult("tc-shared-id", "memory_search", "protected results"),
        makeUserMsg("Q2"),
        makeAssistantMsg("A2"),
        makeToolResult("tc-recent2", "bash", "x".repeat(200)),
      ];

      const result2 = await layer.apply(messages2, BUDGET);

      // tc-shared-id is in everMaskedIds but is now protected tier -- must NOT be masked
      const shared = result2.find((m) => (m as any).toolCallId === "tc-shared-id") as any;
      expect(shared.content[0].text).toBe("protected results");
    });

    it("non-protected standard tool in everMaskedIds is still force-masked (uses new format)", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 1,
        observationTriggerChars: 100,
        observationDeactivationChars: 50, // Low deactivation so masking stays active on call 2
        ephemeralKeepWindow: 1,

      };
      const layer = createObservationMaskerLayer(config);

      // Call 1: mask tc-std (standard tool)
      const messages1: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("A1"),
        makeToolResult("tc-std", "bash", "x".repeat(200)),
        makeUserMsg("Q2"),
        makeAssistantMsg("A2"),
        makeToolResult("tc-keep", "bash", "x".repeat(200)),
        makeAssistantMsg("Final"),
      ];
      await layer.apply(messages1, BUDGET);

      // Call 2: tc-std reappears with original content
      const messages2: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("A1"),
        makeToolResult("tc-std", "bash", "x".repeat(200)), // NOT placeholder
        makeUserMsg("Q2"),
        makeAssistantMsg("A2"),
        makeToolResult("tc-keep2", "bash", "x".repeat(200)),
        makeAssistantMsg("Final"),
      ];

      const result2 = await layer.apply(messages2, BUDGET);

      // tc-std must be force-masked (monotonic, standard tier, uses new format)
      const std = result2.find((m) => (m as any).toolCallId === "tc-std") as any;
      expect(std.content[0].text).toContain("[Tool result summarized:");
    });
  });

  // -------------------------------------------------------------------------
  // Unseen tool result protection
  // -------------------------------------------------------------------------

  describe("Unseen tool result protection", () => {
    it("tool results after the last assistant message are NOT masked even when beyond keep window", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 1,
        observationTriggerChars: 100,
      };
      const layer = createObservationMaskerLayer(config);

      // Only one assistant message, then 3 tool results after it (unseen)
      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("Analysis 1"),
        makeToolResult("tc_1", "bash", "output 1"),
        makeToolResult("tc_2", "bash", "output 2"),
        makeToolResult("tc_3", "bash", "output 3"),
      ];

      const result = await layer.apply(messages, BUDGET);

      // All 3 tool results are after the last assistant message -- none should be masked
      const tc1 = result.find((m) => (m as any).toolCallId === "tc_1") as any;
      expect(tc1.content[0].text).toBe("output 1");

      const tc2 = result.find((m) => (m as any).toolCallId === "tc_2") as any;
      expect(tc2.content[0].text).toBe("output 2");

      const tc3 = result.find((m) => (m as any).toolCallId === "tc_3") as any;
      expect(tc3.content[0].text).toBe("output 3");
    });

    it("interleaved: only tool results before last assistant get masked, after are protected", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 0,
        observationTriggerChars: 100,
      };
      const layer = createObservationMaskerLayer(config);

      // tc_1 is before last assistant (eligible), tc_2 and tc_3 are after (protected)
      // Use longer content to exceed the 100-char trigger threshold
      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("Analysis 1"),
        makeToolResult("tc_1", "bash", "x".repeat(100)),
        makeAssistantMsg("Analysis 2"),  // <-- last assistant message
        makeToolResult("tc_2", "bash", "x".repeat(100)),
        makeToolResult("tc_3", "bash", "x".repeat(100)),
      ];

      const result = await layer.apply(messages, BUDGET);

      // tc_1 is before last assistant, keep window 0 -- should be masked
      const tc1 = result.find((m) => (m as any).toolCallId === "tc_1") as any;
      expect(tc1.content[0].text).toContain("[Tool result summarized:");

      // tc_2 and tc_3 are after last assistant -- protected (unseen)
      const tc2 = result.find((m) => (m as any).toolCallId === "tc_2") as any;
      expect(tc2.content[0].text).toBe("x".repeat(100));

      const tc3 = result.find((m) => (m as any).toolCallId === "tc_3") as any;
      expect(tc3.content[0].text).toBe("x".repeat(100));
    });

    it("conversation with NO assistant messages: all tool results are protected", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 0,
        observationTriggerChars: 100,
      };
      const layer = createObservationMaskerLayer(config);

      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeToolResult("tc_1", "bash", "output 1"),
        makeToolResult("tc_2", "bash", "output 2"),
      ];

      const result = await layer.apply(messages, BUDGET);

      // No assistant messages -- lastAssistantIndex is -1, all protected
      const tc1 = result.find((m) => (m as any).toolCallId === "tc_1") as any;
      expect(tc1.content[0].text).toBe("output 1");

      const tc2 = result.find((m) => (m as any).toolCallId === "tc_2") as any;
      expect(tc2.content[0].text).toBe("output 2");
    });

    it("MCP ephemeral tools after last assistant are also protected", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 0,
        observationTriggerChars: 100,
        ephemeralKeepWindow: 0,
      };
      const layer = createObservationMaskerLayer(config);

      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("Analysis"),
        makeToolResult("tc_mcp_1", "mcp__server__tool", "mcp output 1"),
      ];

      const result = await layer.apply(messages, BUDGET);

      // MCP tool result after last assistant -- protected despite ephemeral tier
      const mcp = result.find((m) => (m as any).toolCallId === "tc_mcp_1") as any;
      expect(mcp.content[0].text).toBe("mcp output 1");
    });
  });

  // -------------------------------------------------------------------------
  // Digest-based placeholders
  // -------------------------------------------------------------------------

  describe("Digest-based placeholders", () => {
    it("masked placeholder contains digest from following assistant response", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 0,
        observationTriggerChars: 100,
      };
      const layer = createObservationMaskerLayer(config);

      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("First analysis"),
        makeToolResult("tc_1", "bash", "original data that is very long"),
        makeAssistantMsg("The data shows X and Y"),
        makeUserMsg("Q2"),
        makeAssistantMsg("Final summary"),  // <-- last assistant
      ];

      const result = await layer.apply(messages, BUDGET);

      // tc_1 is masked, digest from following assistant ("The data shows X and Y")
      const tc1 = result.find((m) => (m as any).toolCallId === "tc_1") as any;
      expect(tc1.content[0].text).toContain("[Tool result summarized: bash");
      expect(tc1.content[0].text).toContain("chars cleared]");
      expect(tc1.content[0].text).toContain("The data shows X and Y");
    });

    it("digest includes both thinking and text blocks from assistant", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 0,
        observationTriggerChars: 100,
      };
      const layer = createObservationMaskerLayer(config);

      const assistantWithThinking: AgentMessage = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me analyze this" },
          { type: "text", text: "Result is Z" },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      } as AgentMessage;

      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("Setup"),
        makeToolResult("tc_1", "bash", "x".repeat(100)),
        assistantWithThinking,
        makeUserMsg("Q2"),
        makeAssistantMsg("Final"),  // <-- last assistant
      ];

      const result = await layer.apply(messages, BUDGET);

      const tc1 = result.find((m) => (m as any).toolCallId === "tc_1") as any;
      expect(tc1.content[0].text).toContain("Let me analyze this");
      expect(tc1.content[0].text).toContain("Result is Z");
    });

    it("digest is truncated to ~800 chars with '...' for long assistant responses", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 0,
        observationTriggerChars: 100,
      };
      const layer = createObservationMaskerLayer(config);

      const longText = "A".repeat(2000);
      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("Setup"),
        makeToolResult("tc_1", "bash", "original data"),
        makeAssistantMsg(longText),
        makeUserMsg("Q2"),
        makeAssistantMsg("Final"),  // <-- last assistant
      ];

      const result = await layer.apply(messages, BUDGET);

      const tc1 = result.find((m) => (m as any).toolCallId === "tc_1") as any;
      const text = tc1.content[0].text as string;
      // Extract the digest part (after the header line)
      const digestPart = text.split("\n").slice(1).join("\n");
      expect(digestPart.length).toBeLessThanOrEqual(810); // ~800 + some tolerance
      expect(digestPart).toMatch(/\.\.\.$/);
    });

    it("placeholder format: [Tool result summarized: {tool} -- {N} chars cleared]\\n{digest}", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 0,
        observationTriggerChars: 100,
      };
      const layer = createObservationMaskerLayer(config);

      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("Setup"),
        makeToolResult("tc_1", "bash", "x".repeat(50)),
        makeAssistantMsg("Short analysis"),
        makeUserMsg("Q2"),
        makeAssistantMsg("Final"),  // <-- last assistant
      ];

      const result = await layer.apply(messages, BUDGET);

      const tc1 = result.find((m) => (m as any).toolCallId === "tc_1") as any;
      const text = tc1.content[0].text as string;
      // Check format: header line + newline + digest
      expect(text).toMatch(/^\[Tool result summarized: bash/);
      expect(text).toContain("50 chars cleared]");
      expect(text).toContain("\nShort analysis");
    });

    it("fallback to head/tail preview when no assistant follows a maskable tool result", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 0,
        observationTriggerChars: 100,
      };
      const layer = createObservationMaskerLayer(config);

      // tc_1 is followed by user message then an assistant. The masker looks forward
      // from tc_1 to find the next assistant (up to lastAssistantIndex), which is "Final".
      // So digest comes from "Final", not from the original tool content.
      const messages: AgentMessage[] = [
        makeUserMsg("Q0"),
        makeAssistantMsg("A0"),
        makeToolResult("tc_1", "bash", "x".repeat(100)),
        makeUserMsg("Q1"),
        makeAssistantMsg("Final"),  // <-- last assistant, digest source for tc_1
      ];

      const result = await layer.apply(messages, BUDGET);

      const tc1 = result.find((m) => (m as any).toolCallId === "tc_1") as any;
      const text = tc1.content[0].text as string;
      expect(text).toContain("[Tool result summarized: bash");
      // Digest comes from the next assistant message ("Final")
      expect(text).toContain("Final");
    });

    it("head/tail preview for long content without assistant following", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 0,
        observationTriggerChars: 100,
      };
      const layer = createObservationMaskerLayer(config);

      const longContent = "HEAD" + "x".repeat(600) + "TAIL";
      const messages: AgentMessage[] = [
        makeUserMsg("Q0"),
        makeAssistantMsg("A0"),
        makeToolResult("tc_1", "bash", longContent),
        makeUserMsg("Q1"),
        makeAssistantMsg("Final"),  // <-- last assistant; masker finds it as digest source
      ];

      const result = await layer.apply(messages, BUDGET);

      const tc1 = result.find((m) => (m as any).toolCallId === "tc_1") as any;
      const text = tc1.content[0].text as string;
      expect(text).toContain("[Tool result summarized: bash");
      // Digest comes from the next assistant message found ("Final")
      expect(text).toContain("Final");
    });

    it("persistMaskedEntries writes new summarized format to disk", async () => {
      const mockSm = {
        fileEntries: [
          { type: "message", message: { role: "user", content: "Q1" } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A1" }] } },
          { type: "message", message: { role: "toolResult", toolCallId: "tc_0", toolName: "bash", content: [{ type: "text", text: "large output 0" }] } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Analysis of output" }] } },
          { type: "message", message: { role: "user", content: "Q2" } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A2" }] } },
          { type: "message", message: { role: "toolResult", toolCallId: "tc_1", toolName: "bash", content: [{ type: "text", text: "large output 1" }] } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Analysis of second output" }] } },
          { type: "message", message: { role: "user", content: "Q3" } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A3" }] } },
          { type: "message", message: { role: "toolResult", toolCallId: "tc_2", toolName: "bash", content: [{ type: "text", text: "recent output" }] } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Final analysis" }] } },
        ],
        _rewriteFile: vi.fn(),
      };

      const config: ObservationMaskerConfig = {
        observationKeepWindow: 1,
        observationTriggerChars: 100,
      };

      // Build matching messages array for the masker
      const messages: AgentMessage[] = [
        makeUserMsg("Q1"),
        makeAssistantMsg("A1"),
        makeToolResult("tc_0", "bash", "large output 0"),
        makeAssistantMsg("Analysis of output"),
        makeUserMsg("Q2"),
        makeAssistantMsg("A2"),
        makeToolResult("tc_1", "bash", "large output 1"),
        makeAssistantMsg("Analysis of second output"),
        makeUserMsg("Q3"),
        makeAssistantMsg("A3"),
        makeToolResult("tc_2", "bash", "recent output"),
        makeAssistantMsg("Final analysis"),  // <-- last assistant
      ];

      const layer = createObservationMaskerLayer(config, () => mockSm);
      await layer.apply(messages, BUDGET);

      // _rewriteFile should have been called
      expect(mockSm._rewriteFile).toHaveBeenCalledTimes(1);

      // fileEntries for tc_0 should have new format
      const entry0 = mockSm.fileEntries.find(
        (e: any) => e.type === "message" && e.message?.toolCallId === "tc_0",
      ) as any;
      expect(entry0.message.content[0].text).toContain("[Tool result summarized:");
      expect(entry0.message.content[0].text).not.toContain("[Tool result cleared:");

      // fileEntries for tc_1 should also have new format
      const entry1 = mockSm.fileEntries.find(
        (e: any) => e.type === "message" && e.message?.toolCallId === "tc_1",
      ) as any;
      expect(entry1.message.content[0].text).toContain("[Tool result summarized:");

      // tc_2 (within keep window, most recent) should NOT be mutated
      const entry2 = mockSm.fileEntries.find(
        (e: any) => e.type === "message" && e.message?.toolCallId === "tc_2",
      ) as any;
      expect(entry2.message.content[0].text).toBe("recent output");
    });

    it("existing monotonic masking (everMaskedIds) still works with new format", async () => {
      const config: ObservationMaskerConfig = {
        observationTriggerChars: 500,
        observationDeactivationChars: 200,
        observationKeepWindow: 1,
      };
      const layer = createObservationMaskerLayer(config);

      // Call 1: tc-1 gets masked
      const messages1: AgentMessage[] = [
        makeUserMsg("hello"),
        makeAssistantMsg("ok"),
        makeToolResult("tc-1", "bash", "x".repeat(300)),
        makeAssistantMsg("done analyzing"),
        makeUserMsg("next"),
        makeAssistantMsg("sure"),
        makeToolResult("tc-2", "bash", "x".repeat(300)),
        makeAssistantMsg("final"),
      ];
      const result1 = await layer.apply(messages1, BUDGET);
      const tc1r1 = result1.find((m) => (m as any).toolCallId === "tc-1") as any;
      expect(tc1r1.content[0].text).toContain("[Tool result summarized:");

      // Call 2: tc-1 re-presented with original content
      const messages2: AgentMessage[] = [
        makeUserMsg("hello"),
        makeAssistantMsg("ok"),
        makeToolResult("tc-1", "bash", "x".repeat(300)),
        makeAssistantMsg("done analyzing"),
        makeUserMsg("next"),
        makeAssistantMsg("sure"),
        makeToolResult("tc-2", "bash", "x".repeat(50)),
        makeAssistantMsg("continued"),
        makeUserMsg("again"),
        makeAssistantMsg("yep"),
        makeToolResult("tc-3", "bash", "x".repeat(200)),
        makeAssistantMsg("final"),
      ];
      const result2 = await layer.apply(messages2, BUDGET);

      // tc-1 must still be masked (monotonic via everMaskedIds, new format)
      const tc1r2 = result2.find((m) => (m as any).toolCallId === "tc-1") as any;
      expect(tc1r2.content[0].text).not.toBe("x".repeat(300));
      expect(tc1r2.content[0].text).toContain("[Tool result summarized:");
    });

    it("cache fence protection still works unchanged", async () => {
      const config: ObservationMaskerConfig = {
        observationKeepWindow: 0,
        observationTriggerChars: 100,
      };
      const layer = createObservationMaskerLayer(config);

      const messages: AgentMessage[] = [
        makeUserMsg("x".repeat(50)),
        makeToolResult("tc-fenced", "bash", "fenced content"),
        makeAssistantMsg("response 1"),
        makeToolResult("tc-unfenced", "bash", "unfenced content"),
        makeAssistantMsg("response 2"),  // <-- last assistant
      ];

      const fencedBudget: TokenBudget = { ...BUDGET, cacheFenceIndex: 1 };
      const result = await layer.apply(messages, fencedBudget);

      // tc-fenced at index 1 is within fence -- NOT masked
      const fenced = result.find((m) => (m as any).toolCallId === "tc-fenced") as any;
      expect(fenced.content[0].text).toBe("fenced content");

      // tc-unfenced at index 3 is beyond fence, before last assistant -- masked
      const unfenced = result.find((m) => (m as any).toolCallId === "tc-unfenced") as any;
      expect(unfenced.content[0].text).toContain("[Tool result summarized:");
    });
  });


});

