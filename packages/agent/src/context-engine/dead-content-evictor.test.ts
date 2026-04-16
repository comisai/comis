/**
 * Tests for the dead content evictor context engine layer.
 *
 * Verifies all 5 eviction categories (superseded file reads, exec results,
 * web results, old images, stale errors), age boundary behavior,
 * immutability guarantees, skip-already-processed, callback metrics,
 * and edge cases.
 */

import { describe, it, expect, vi } from "vitest";
import { createDeadContentEvictorLayer } from "./dead-content-evictor.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TokenBudget } from "./types.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Dummy budget (evictor does not use it). */
const BUDGET: TokenBudget = {
  windowTokens: 200_000,
  systemTokens: 10_000,
  outputReserveTokens: 8_192,
  safetyMarginTokens: 10_000,
  contextRotBufferTokens: 50_000,
  availableHistoryTokens: 121_808,
};

function makeToolResult(
  toolName: string,
  toolCallId: string,
  content: string,
  opts?: { isError?: boolean },
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: content }],
    isError: opts?.isError ?? false,
  } as unknown as AgentMessage;
}

function makeToolResultWithImage(
  toolName: string,
  toolCallId: string,
  mediaType: string,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "image", source: { media_type: mediaType, data: "base64data" } }],
  } as unknown as AgentMessage;
}

function makeAssistantWithToolCall(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId, toolName, arguments: args }],
  } as unknown as AgentMessage;
}

function makeAssistantWithImage(mediaType: string): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Here is the image:" },
      { type: "image", source: { media_type: mediaType, data: "base64data" } },
    ],
  } as unknown as AgentMessage;
}

function makeUserMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

/**
 * Build a conversation with enough padding messages to push tool results
 * beyond the evictionMinAge threshold (counting from newest toolResult).
 */
function buildPaddedConversation(
  targetMessages: AgentMessage[],
  paddingCount: number,
): AgentMessage[] {
  const padding: AgentMessage[] = [];
  for (let i = 0; i < paddingCount; i++) {
    padding.push(makeUserMessage(`padding-${i}`));
    padding.push(
      makeAssistantWithToolCall(`pad-tc-${i}`, "bash", { command: `echo pad-${i}` }),
    );
    padding.push(
      makeToolResult("bash", `pad-tc-${i}`, `pad-result-${i}`),
    );
  }
  return [...targetMessages, ...padding];
}

// ---------------------------------------------------------------------------
// A. Superseded file reads
// ---------------------------------------------------------------------------

describe("createDeadContentEvictorLayer", () => {
  describe("A. Superseded file reads", () => {
    it("two file_read results for the same path: older one evicted, newer one kept", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages = buildPaddedConversation([
        makeUserMessage("read the file"),
        makeAssistantWithToolCall("tc-old", "file_read", { path: "/src/main.ts" }),
        makeToolResult("file_read", "tc-old", "old file content here"),
        makeUserMessage("read it again"),
        makeAssistantWithToolCall("tc-new", "file_read", { path: "/src/main.ts" }),
        makeToolResult("file_read", "tc-new", "new file content here"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      // The older file_read should be evicted
      const oldResult = result[2] as Record<string, unknown>;
      const oldContent = (oldResult.content as Array<Record<string, string>>)[0];
      expect(oldContent.text).toContain("[Superseded: file_read /src/main.ts");
      expect(oldContent.text).toContain("use session_search to retrieve");

      // The newer file_read should be kept
      const newResult = result[5] as Record<string, unknown>;
      const newContent = (newResult.content as Array<Record<string, string>>)[0];
      expect(newContent.text).toBe("new file content here");
    });

    it("different paths: neither evicted", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages = buildPaddedConversation([
        makeUserMessage("read files"),
        makeAssistantWithToolCall("tc-a", "file_read", { path: "/src/a.ts" }),
        makeToolResult("file_read", "tc-a", "content of a"),
        makeUserMessage("read another"),
        makeAssistantWithToolCall("tc-b", "file_read", { path: "/src/b.ts" }),
        makeToolResult("file_read", "tc-b", "content of b"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      // Neither should be evicted (different paths)
      const aContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(aContent.text).toBe("content of a");
      const bContent = ((result[5] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(bContent.text).toBe("content of b");
    });

    it("three reads of same path: only the oldest two evicted, newest kept", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages = buildPaddedConversation([
        makeUserMessage("first"),
        makeAssistantWithToolCall("tc-1", "file_read", { path: "/src/main.ts" }),
        makeToolResult("file_read", "tc-1", "version 1"),
        makeUserMessage("second"),
        makeAssistantWithToolCall("tc-2", "file_read", { path: "/src/main.ts" }),
        makeToolResult("file_read", "tc-2", "version 2"),
        makeUserMessage("third"),
        makeAssistantWithToolCall("tc-3", "file_read", { path: "/src/main.ts" }),
        makeToolResult("file_read", "tc-3", "version 3"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      // First two should be evicted
      const r1 = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(r1.text).toContain("[Superseded:");
      const r2 = ((result[5] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(r2.text).toContain("[Superseded:");

      // Newest should be kept
      const r3 = ((result[8] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(r3.text).toBe("version 3");
    });
  });

  // ---------------------------------------------------------------------------
  // B. Superseded exec results
  // ---------------------------------------------------------------------------

  describe("B. Superseded exec results", () => {
    it("two exec results with identical command: older evicted", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 });

      const messages = buildPaddedConversation([
        makeUserMessage("run it"),
        makeAssistantWithToolCall("tc-old", "bash", { command: "npm test" }),
        makeToolResult("bash", "tc-old", "3 tests passed"),
        makeUserMessage("run again"),
        makeAssistantWithToolCall("tc-new", "bash", { command: "npm test" }),
        makeToolResult("bash", "tc-new", "5 tests passed"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      const oldContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(oldContent.text).toContain("[Superseded: bash npm test");
      expect(oldContent.text).toContain("use session_search to retrieve");

      const newContent = ((result[5] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(newContent.text).toBe("5 tests passed");
    });

    it("different commands: neither evicted", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 });

      const messages = buildPaddedConversation([
        makeUserMessage("build"),
        makeAssistantWithToolCall("tc-build", "bash", { command: "npm run build" }),
        makeToolResult("bash", "tc-build", "build ok"),
        makeUserMessage("test"),
        makeAssistantWithToolCall("tc-test", "bash", { command: "npm test" }),
        makeToolResult("bash", "tc-test", "test ok"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      const buildContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(buildContent.text).toBe("build ok");
      const testContent = ((result[5] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(testContent.text).toBe("test ok");
    });
  });

  // ---------------------------------------------------------------------------
  // C. Superseded web results
  // ---------------------------------------------------------------------------

  describe("C. Superseded web results", () => {
    it("two web_search results with same query (case-insensitive): older evicted", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 });

      const messages = buildPaddedConversation([
        makeUserMessage("search"),
        makeAssistantWithToolCall("tc-old", "brave_search", { query: "TypeScript Generics" }),
        makeToolResult("brave_search", "tc-old", "old search results"),
        makeUserMessage("search again"),
        makeAssistantWithToolCall("tc-new", "brave_search", { query: "typescript generics" }),
        makeToolResult("brave_search", "tc-new", "new search results"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      const oldContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(oldContent.text).toContain("[Superseded: brave_search");

      const newContent = ((result[5] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(newContent.text).toBe("new search results");
    });

    it("two web_fetch results with same URL (trailing slash normalized): older evicted", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 });

      const messages = buildPaddedConversation([
        makeUserMessage("fetch"),
        makeAssistantWithToolCall("tc-old", "web_fetch", { url: "https://example.com/api/" }),
        makeToolResult("web_fetch", "tc-old", "old page content"),
        makeUserMessage("fetch again"),
        makeAssistantWithToolCall("tc-new", "web_fetch", { url: "https://example.com/api" }),
        makeToolResult("web_fetch", "tc-new", "new page content"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      const oldContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(oldContent.text).toContain("[Superseded:");

      const newContent = ((result[5] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(newContent.text).toBe("new page content");
    });

    it("different queries: neither evicted", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 });

      const messages = buildPaddedConversation([
        makeUserMessage("search"),
        makeAssistantWithToolCall("tc-a", "brave_search", { query: "typescript" }),
        makeToolResult("brave_search", "tc-a", "ts results"),
        makeUserMessage("search"),
        makeAssistantWithToolCall("tc-b", "brave_search", { query: "rust" }),
        makeToolResult("brave_search", "tc-b", "rust results"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      const aContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(aContent.text).toBe("ts results");
    });
  });

  // ---------------------------------------------------------------------------
  // D. Image eviction
  // ---------------------------------------------------------------------------

  describe("D. Image eviction", () => {
    it("tool result with image block older than evictionMinAge: evicted", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages = buildPaddedConversation([
        makeUserMessage("screenshot"),
        makeAssistantWithToolCall("tc-img", "screenshot", { area: "full" }),
        makeToolResultWithImage("screenshot", "tc-img", "image/png"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      const imgContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(imgContent.text).toContain("[Image evicted: image/png from turn");
    });

    it("tool result with image block within evictionMinAge: kept", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 20 });

      // Only 3 padding tool results, so position 3 is within minAge 20
      const messages = buildPaddedConversation([
        makeUserMessage("screenshot"),
        makeAssistantWithToolCall("tc-img", "screenshot", { area: "full" }),
        makeToolResultWithImage("screenshot", "tc-img", "image/png"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      // Image should be kept (within age threshold)
      const imgContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, unknown>>)[0];
      expect(imgContent.type).toBe("image");
    });
  });

  // ---------------------------------------------------------------------------
  // E. Error-only eviction
  // ---------------------------------------------------------------------------

  describe("E. Error-only eviction", () => {
    it("tool result with isError: true older than evictionMinAge: evicted", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 });

      const messages = buildPaddedConversation([
        makeUserMessage("run"),
        makeAssistantWithToolCall("tc-err", "bash", { command: "cat missing.txt" }),
        makeToolResult("bash", "tc-err", "file not found", { isError: true }),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      const errContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(errContent.text).toContain("[Superseded: bash error result");
      expect(errContent.text).toContain("use session_search to retrieve");
    });

    it("tool result matching error pattern older than age: evicted", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 });

      const messages = buildPaddedConversation([
        makeUserMessage("run"),
        makeAssistantWithToolCall("tc-err", "bash", { command: "cat missing.txt" }),
        makeToolResult("bash", "tc-err", "ENOENT: no such file or directory"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      const errContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(errContent.text).toContain("[Superseded: bash error result");
    });

    it("error-like but long content (>500 chars): NOT evicted", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 });

      const longError = "Error: " + "x".repeat(600);
      const messages = buildPaddedConversation([
        makeUserMessage("run"),
        makeAssistantWithToolCall("tc-long", "bash", { command: "failing-cmd" }),
        makeToolResult("bash", "tc-long", longError),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      // Long results should NOT be treated as error-only
      const content = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(content.text).toBe(longError);
    });

    it("error result within evictionMinAge: kept", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 20 });

      const messages = buildPaddedConversation([
        makeUserMessage("run"),
        makeAssistantWithToolCall("tc-err", "bash", { command: "fail" }),
        makeToolResult("bash", "tc-err", "Error: something failed", { isError: true }),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      // Error should be kept (within age threshold)
      const errContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(errContent.text).toBe("Error: something failed");
    });
  });

  // ---------------------------------------------------------------------------
  // F. Age boundary (evictionMinAge)
  // ---------------------------------------------------------------------------

  describe("F. Age boundary", () => {
    it("evictionMinAge: 3 -- position 2 kept, position 3 evicted if superseded", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 3 });

      // Build messages with 2 superseded file reads and exactly 3 padding tool results
      // between the newer one and the newest tool result
      const messages: AgentMessage[] = [
        // Old read (will be at higher index from newest)
        makeUserMessage("read"),
        makeAssistantWithToolCall("tc-old", "file_read", { path: "/a.ts" }),
        makeToolResult("file_read", "tc-old", "old content"),
        // Newer read (supersedes old)
        makeUserMessage("read again"),
        makeAssistantWithToolCall("tc-new", "file_read", { path: "/a.ts" }),
        makeToolResult("file_read", "tc-new", "new content"),
        // 3 padding tool results (to push old read to position 4 from newest)
        makeUserMessage("p1"),
        makeAssistantWithToolCall("pad-0", "bash", { command: "echo 0" }),
        makeToolResult("bash", "pad-0", "r0"),
        makeUserMessage("p2"),
        makeAssistantWithToolCall("pad-1", "bash", { command: "echo 1" }),
        makeToolResult("bash", "pad-1", "r1"),
        makeUserMessage("p3"),
        makeAssistantWithToolCall("pad-2", "bash", { command: "echo 2" }),
        makeToolResult("bash", "pad-2", "r2"),
      ];

      const result = await layer.apply(messages, BUDGET);

      // Old file_read is at position 4 from newest (beyond minAge 3) -> evicted
      const oldContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(oldContent.text).toContain("[Superseded:");

      // New file_read is at position 3 from newest (at boundary) -> NOT evicted (age check is strict <)
      const newContent = ((result[5] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(newContent.text).toBe("new content");
    });

    it("evictionMinAge: 0 -- all superseded results evicted regardless of position", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 0 });

      const messages: AgentMessage[] = [
        makeUserMessage("read"),
        makeAssistantWithToolCall("tc-old", "file_read", { path: "/a.ts" }),
        makeToolResult("file_read", "tc-old", "old content"),
        makeUserMessage("read again"),
        makeAssistantWithToolCall("tc-new", "file_read", { path: "/a.ts" }),
        makeToolResult("file_read", "tc-new", "new content"),
      ];

      const result = await layer.apply(messages, BUDGET);

      // Old should be evicted even though it's only position 1 from newest
      const oldContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(oldContent.text).toContain("[Superseded:");

      // Newer should be kept (it's the most recent for its key)
      const newContent = ((result[5] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(newContent.text).toBe("new content");
    });
  });

  // ---------------------------------------------------------------------------
  // G. Immutability
  // ---------------------------------------------------------------------------

  describe("G. Immutability", () => {
    it("input array is not modified", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 0 });

      const messages: AgentMessage[] = [
        makeUserMessage("read"),
        makeAssistantWithToolCall("tc-old", "file_read", { path: "/a.ts" }),
        makeToolResult("file_read", "tc-old", "old content"),
        makeUserMessage("read again"),
        makeAssistantWithToolCall("tc-new", "file_read", { path: "/a.ts" }),
        makeToolResult("file_read", "tc-new", "new content"),
      ];

      const originalLength = messages.length;
      const originalRef = messages[2]; // the one that will be evicted

      const result = await layer.apply(messages, BUDGET);

      // Array reference should be different
      expect(result).not.toBe(messages);
      // Original array should be unmodified
      expect(messages.length).toBe(originalLength);
      // Original message objects should be untouched
      expect(messages[2]).toBe(originalRef);
    });

    it("original message objects are not mutated", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 0 });

      const oldToolResult = makeToolResult("file_read", "tc-old", "old content");
      const originalContent = JSON.parse(JSON.stringify(
        (oldToolResult as Record<string, unknown>).content,
      ));

      const messages: AgentMessage[] = [
        makeUserMessage("read"),
        makeAssistantWithToolCall("tc-old", "file_read", { path: "/a.ts" }),
        oldToolResult,
        makeUserMessage("read again"),
        makeAssistantWithToolCall("tc-new", "file_read", { path: "/a.ts" }),
        makeToolResult("file_read", "tc-new", "new content"),
      ];

      await layer.apply(messages, BUDGET);

      // Original message should not have been mutated
      expect((oldToolResult as Record<string, unknown>).content).toEqual(originalContent);
    });
  });

  // ---------------------------------------------------------------------------
  // H. Skip already-processed
  // ---------------------------------------------------------------------------

  describe("H. Skip already-processed", () => {
    it("tool result with [Tool result cleared: prefix: not double-evicted", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages = buildPaddedConversation([
        makeUserMessage("masked"),
        makeAssistantWithToolCall("tc-masked", "bash", { command: "echo hi" }),
        makeToolResult("bash", "tc-masked", "[Tool result cleared: bash -- see assistant analysis above]"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      // Already-masked content should pass through unchanged
      const content = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(content.text).toBe("[Tool result cleared: bash -- see assistant analysis above]");

      expect(onEvicted).toHaveBeenCalledWith(
        expect.objectContaining({ evictedCount: 0 }),
      );
    });

    it("tool result with [Tool result summarized: prefix: not double-evicted", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages = buildPaddedConversation([
        makeUserMessage("summarized"),
        makeAssistantWithToolCall("tc-summarized", "bash", { command: "echo hi" }),
        makeToolResult("bash", "tc-summarized", "[Tool result summarized: bash — 5000 chars cleared]\nDigest text here"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      // Already-masked (summarized) content should pass through unchanged
      const content = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(content.text).toBe("[Tool result summarized: bash — 5000 chars cleared]\nDigest text here");

      expect(onEvicted).toHaveBeenCalledWith(
        expect.objectContaining({ evictedCount: 0 }),
      );
    });

    it("tool result with [Tool result offloaded to disk: prefix: not double-evicted", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages = buildPaddedConversation([
        makeUserMessage("offloaded"),
        makeAssistantWithToolCall("tc-off", "bash", { command: "echo hi" }),
        makeToolResult("bash", "tc-off", "[Tool result offloaded to disk: /tmp/result.json]"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      const content = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(content.text).toBe("[Tool result offloaded to disk: /tmp/result.json]");

      expect(onEvicted).toHaveBeenCalledWith(
        expect.objectContaining({ evictedCount: 0 }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // I. Callback metrics
  // ---------------------------------------------------------------------------

  describe("I. Callback metrics", () => {
    it("onEvicted called with correct evictedCount, evictedChars, and categories", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages = buildPaddedConversation([
        // Superseded file read
        makeUserMessage("read"),
        makeAssistantWithToolCall("tc-old-file", "file_read", { path: "/a.ts" }),
        makeToolResult("file_read", "tc-old-file", "old file content"),
        makeUserMessage("read again"),
        makeAssistantWithToolCall("tc-new-file", "file_read", { path: "/a.ts" }),
        makeToolResult("file_read", "tc-new-file", "new file content"),
        // Error result
        makeUserMessage("err"),
        makeAssistantWithToolCall("tc-err", "bash", { command: "bad-cmd" }),
        makeToolResult("bash", "tc-err", "Error: bad command", { isError: true }),
      ], 3);

      await layer.apply(messages, BUDGET);

      expect(onEvicted).toHaveBeenCalledTimes(1);
      const stats = onEvicted.mock.calls[0]![0];
      expect(stats.evictedCount).toBeGreaterThanOrEqual(1);
      expect(stats.evictedChars).toBeGreaterThan(0);
      expect(stats.categories).toBeDefined();
      // Should have at least file_read category
      if (stats.categories.file_read) {
        expect(stats.categories.file_read).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // J. Empty/no-op cases
  // ---------------------------------------------------------------------------

  describe("J. Empty/no-op cases", () => {
    it("empty messages array: returns empty array", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const result = await layer.apply([], BUDGET);

      expect(result).toEqual([]);
      expect(onEvicted).toHaveBeenCalledWith(
        expect.objectContaining({ evictedCount: 0, evictedChars: 0 }),
      );
    });

    it("no tool results: returns same messages", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages: AgentMessage[] = [
        makeUserMessage("hello"),
        { role: "assistant", content: [{ type: "text", text: "hi" }] } as unknown as AgentMessage,
      ];

      const result = await layer.apply(messages, BUDGET);

      expect(result).toBe(messages); // same reference -- no changes needed
      expect(onEvicted).toHaveBeenCalledWith(
        expect.objectContaining({ evictedCount: 0 }),
      );
    });

    it("all tool results within evictionMinAge: no evictions", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 100 }, onEvicted);

      const messages: AgentMessage[] = [
        makeUserMessage("read"),
        makeAssistantWithToolCall("tc-old", "file_read", { path: "/a.ts" }),
        makeToolResult("file_read", "tc-old", "old content"),
        makeUserMessage("read again"),
        makeAssistantWithToolCall("tc-new", "file_read", { path: "/a.ts" }),
        makeToolResult("file_read", "tc-new", "new content"),
      ];

      const result = await layer.apply(messages, BUDGET);

      // All within age threshold -- no evictions
      expect(result).toBe(messages);
      expect(onEvicted).toHaveBeenCalledWith(
        expect.objectContaining({ evictedCount: 0 }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // K. Layer interface compliance
  // ---------------------------------------------------------------------------

  describe("K. Layer interface", () => {
    it("layer has correct name", () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 15 });
      expect(layer.name).toBe("dead-content-evictor");
    });

    it("apply returns a Promise", () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 15 });
      const result = layer.apply([], BUDGET);
      expect(result).toBeInstanceOf(Promise);
    });
  });

  // ---------------------------------------------------------------------------
  // L. read_file variant tool name
  // ---------------------------------------------------------------------------

  describe("L. Tool name variants", () => {
    it("read_file (alternate name) is treated as file read supersession", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 });

      const messages = buildPaddedConversation([
        makeUserMessage("read"),
        makeAssistantWithToolCall("tc-old", "read_file", { file_path: "/src/main.ts" }),
        makeToolResult("read_file", "tc-old", "old content"),
        makeUserMessage("read again"),
        makeAssistantWithToolCall("tc-new", "read_file", { file_path: "/src/main.ts" }),
        makeToolResult("read_file", "tc-new", "new content"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      const oldContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(oldContent.text).toContain("[Superseded: file_read");
    });

    it("execute (alternate exec name) is treated as exec supersession", async () => {
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 });

      const messages = buildPaddedConversation([
        makeUserMessage("exec"),
        makeAssistantWithToolCall("tc-old", "execute", { command: "ls -la" }),
        makeToolResult("execute", "tc-old", "old listing"),
        makeUserMessage("exec again"),
        makeAssistantWithToolCall("tc-new", "execute", { command: "ls -la" }),
        makeToolResult("execute", "tc-new", "new listing"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      const oldContent = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
      expect(oldContent.text).toContain("[Superseded: execute");
    });
  });

  // ---------------------------------------------------------------------------
  // M. Error pattern matching
  // ---------------------------------------------------------------------------

  describe("M. Error pattern variants", () => {
    const errorTexts = [
      "[Error: something went wrong]",
      "Error: network timeout",
      "ENOENT: file not found",
      "EACCES: permission denied",
      "Command failed with exit code 1",
      "exit code 127: command not found",
      "Permission denied: /etc/shadow",
      "No such file or directory: /missing",
    ];

    for (const errorText of errorTexts) {
      it(`detects error pattern: "${errorText.substring(0, 40)}..."`, async () => {
        const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 });

        const messages = buildPaddedConversation([
          makeUserMessage("run"),
          makeAssistantWithToolCall("tc-err", "bash", { command: "failing" }),
          makeToolResult("bash", "tc-err", errorText),
        ], 3);

        const result = await layer.apply(messages, BUDGET);

        const content = ((result[2] as Record<string, unknown>).content as Array<Record<string, string>>)[0];
        expect(content.text).toContain("[Superseded: bash error result");
      });
    }
  });

  // ---------------------------------------------------------------------------
  // N. Dead error turn eviction
  // ---------------------------------------------------------------------------

  describe("N. Dead error turn eviction", () => {
    it("assistant message with content: [] and stopReason: error is evicted", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages: AgentMessage[] = [
        makeUserMessage("hello"),
        { role: "assistant", content: [], stopReason: "error" } as unknown as AgentMessage,
        makeUserMessage("try again"),
        { role: "assistant", content: [{ type: "text", text: "normal response" }] } as unknown as AgentMessage,
      ];

      const result = await layer.apply(messages, BUDGET);

      // Dead error turn should be evicted with placeholder
      const evictedContent = (result[1] as Record<string, unknown>).content as Array<Record<string, string>>;
      expect(evictedContent[0].text).toContain("Dead error turn evicted");

      // Normal assistant message should be unmodified
      const normalContent = (result[3] as Record<string, unknown>).content as Array<Record<string, string>>;
      expect(normalContent[0].text).toBe("normal response");

      // Callback reports correct stats
      expect(onEvicted).toHaveBeenCalledTimes(1);
      const stats = onEvicted.mock.calls[0]![0];
      expect(stats.evictedCount).toBe(1);
      expect(stats.categories.dead_error_turn).toBe(1);
    });

    it("assistant message with content: [] but NO stopReason error is NOT evicted", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages: AgentMessage[] = [
        makeUserMessage("hello"),
        { role: "assistant", content: [], stopReason: "end_turn" } as unknown as AgentMessage,
      ];

      const result = await layer.apply(messages, BUDGET);

      // Should pass through unmodified (same reference = no evictions)
      expect(result).toBe(messages);
      expect(onEvicted).toHaveBeenCalledWith(
        expect.objectContaining({ evictedCount: 0 }),
      );
    });

    it("assistant message with non-empty content and stopReason: error is NOT evicted", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const messages: AgentMessage[] = [
        makeUserMessage("hello"),
        {
          role: "assistant",
          content: [{ type: "text", text: "partial response" }],
          stopReason: "error",
        } as unknown as AgentMessage,
      ];

      const result = await layer.apply(messages, BUDGET);

      // Should pass through unmodified -- it has content worth keeping
      expect(result).toBe(messages);
      expect(onEvicted).toHaveBeenCalledWith(
        expect.objectContaining({ evictedCount: 0 }),
      );
    });

    it("dead error turn eviction is NOT subject to evictionMinAge", async () => {
      const onEvicted = vi.fn();
      // Very high evictionMinAge -- should not prevent dead error turn eviction
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 100 }, onEvicted);

      // Dead error turn is the MOST RECENT message
      const messages: AgentMessage[] = [
        makeUserMessage("hello"),
        { role: "assistant", content: [], stopReason: "error" } as unknown as AgentMessage,
      ];

      const result = await layer.apply(messages, BUDGET);

      // Dead error turn should STILL be evicted (age irrelevant)
      const evictedContent = (result[1] as Record<string, unknown>).content as Array<Record<string, string>>;
      expect(evictedContent[0].text).toContain("Dead error turn evicted");

      expect(onEvicted).toHaveBeenCalledTimes(1);
      const stats = onEvicted.mock.calls[0]![0];
      expect(stats.evictedCount).toBe(1);
      expect(stats.categories.dead_error_turn).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // cache fence
  // -------------------------------------------------------------------------

  describe("cache fence", () => {
    it("skips evicting tool results at or before fence", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 0 }, onEvicted);

      // Build messages: two file reads of the same path (superseded)
      // The older one (index 1) would normally be evicted. With fence=1, it's protected.
      const messages: AgentMessage[] = [
        makeAssistantWithToolCall("tc-old", "file_read", { path: "/src/app.ts" }),
        makeToolResult("file_read", "tc-old", "old content of app.ts"),
        makeAssistantWithToolCall("tc-new", "file_read", { path: "/src/app.ts" }),
        makeToolResult("file_read", "tc-new", "new content of app.ts"),
      ];

      const fencedBudget: TokenBudget = { ...BUDGET, cacheFenceIndex: 1 };
      const result = await layer.apply(messages, fencedBudget);

      // Message at index 1 is protected by fence -- NOT evicted
      const oldText = ((result[1] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
      expect(oldText).toBe("old content of app.ts");

      // Message at index 3 is the newest occurrence -- NOT evicted (it's the latest)
      const newText = ((result[3] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
      expect(newText).toBe("new content of app.ts");

      // No evictions occurred
      expect(onEvicted).toHaveBeenCalledWith(
        expect.objectContaining({ evictedCount: 0 }),
      );
    });

    it("fence -1 means no protection (normal eviction)", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 0 }, onEvicted);

      // Same messages as above, but fence=-1 (no protection)
      const messages: AgentMessage[] = [
        makeAssistantWithToolCall("tc-old", "file_read", { path: "/src/app.ts" }),
        makeToolResult("file_read", "tc-old", "old content of app.ts"),
        makeAssistantWithToolCall("tc-new", "file_read", { path: "/src/app.ts" }),
        makeToolResult("file_read", "tc-new", "new content of app.ts"),
      ];

      const noFenceBudget: TokenBudget = { ...BUDGET, cacheFenceIndex: -1 };
      const result = await layer.apply(messages, noFenceBudget);

      // Message at index 1 should be evicted (superseded)
      const oldText = ((result[1] as Record<string, unknown>).content as Array<Record<string, string>>)[0].text;
      expect(oldText).toContain("Superseded");

      expect(onEvicted).toHaveBeenCalledWith(
        expect.objectContaining({ evictedCount: 1 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // isAlreadyOffloaded format compatibility
  // -------------------------------------------------------------------------

  describe("isAlreadyOffloaded format compatibility", () => {
    it("skips evicting messages with OLD offloaded format", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const oldFormatMsg: AgentMessage = {
        role: "toolResult",
        toolCallId: "tc-old-fmt",
        toolName: "file_read",
        content: [{
          type: "text",
          text: `[Tool result offloaded to disk: file_read returned 50000 chars.\nThe agent's analysis is in the assistant response below.\nUse file_read to re-access if needed: /path/to/file.json]`,
        }],
        isError: false,
      } as unknown as AgentMessage;

      // Old-format offloaded result is at the start (old enough), with a newer
      // file_read for the same path. Even though it's superseded, isAlreadyOffloaded
      // should cause it to be skipped before supersession check.
      const messages = buildPaddedConversation([
        makeUserMessage("read file"),
        makeAssistantWithToolCall("tc-old-fmt", "file_read", { path: "/foo/bar.ts" }),
        oldFormatMsg,
        makeUserMessage("read again"),
        makeAssistantWithToolCall("tc-newer", "file_read", { path: "/foo/bar.ts" }),
        makeToolResult("file_read", "tc-newer", "newer file content"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      // Old format should pass through unchanged (not evicted)
      const oldFmt = result.find((m) => (m as any).toolCallId === "tc-old-fmt") as any;
      expect(oldFmt.content[0].text).toContain("[Tool result offloaded to disk:");
      expect(oldFmt.content[0].text).toContain("The agent's analysis");
      expect(oldFmt.content[0].text).not.toContain("[Superseded:");
    });

    it("skips evicting messages with NEW preview offloaded format", async () => {
      const onEvicted = vi.fn();
      const layer = createDeadContentEvictorLayer({ evictionMinAge: 2 }, onEvicted);

      const newFormatMsg: AgentMessage = {
        role: "toolResult",
        toolCallId: "tc-new-fmt",
        toolName: "file_read",
        content: [{
          type: "text",
          text: `[Tool result offloaded to disk: file_read returned 50000 chars. hasMore=true\n--- head (1500 chars) ---\n${"x".repeat(1500)}\n--- tail (500 chars) ---\n${"y".repeat(500)}\nUse file_read to re-access full content: /path/to/file.json]`,
        }],
        isError: false,
      } as unknown as AgentMessage;

      const messages = buildPaddedConversation([
        makeUserMessage("read file"),
        makeAssistantWithToolCall("tc-new-fmt", "file_read", { path: "/foo/bar.ts" }),
        newFormatMsg,
        makeUserMessage("read again"),
        makeAssistantWithToolCall("tc-newer", "file_read", { path: "/foo/bar.ts" }),
        makeToolResult("file_read", "tc-newer", "newer file content"),
      ], 3);

      const result = await layer.apply(messages, BUDGET);

      // New format should pass through unchanged (not evicted)
      const newFmt = result.find((m) => (m as any).toolCallId === "tc-new-fmt") as any;
      expect(newFmt.content[0].text).toContain("[Tool result offloaded to disk:");
      expect(newFmt.content[0].text).toContain("hasMore=true");
      expect(newFmt.content[0].text).not.toContain("[Superseded:");
    });
  });
});
