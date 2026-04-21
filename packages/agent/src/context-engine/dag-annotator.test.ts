// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for DAG tool result annotator: threshold bypass, keep window,
 * immutability, protected tools, double-annotation guard, placeholder
 * format, and role filtering.
 *
 * Standalone tests (no store needed) -- mocks AgentMessage objects directly.
 *
 * DAG Assembly & Annotation.
 */

import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createDagAnnotatorLayer } from "./dag-annotator.js";
import type { TokenBudget } from "./types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const defaultBudget: TokenBudget = {
  windowTokens: 100_000,
  systemTokens: 5_000,
  outputReserveTokens: 4_096,
  safetyMarginTokens: 2_048,
  contextRotBufferTokens: 25_000,
  availableHistoryTokens: 50_000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeToolResult(toolName: string, content: string, opts?: { toolCallId?: string }): AgentMessage {
  return {
    role: "toolResult",
    toolName,
    toolCallId: opts?.toolCallId ?? `call_${toolName}_${Math.random().toString(36).slice(2, 8)}`,
    content: [{ type: "text", text: content }],
  } as unknown as AgentMessage;
}

function makeUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function makeAssistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function getTextFromMessage(msg: any): string {
  if (Array.isArray(msg.content) && msg.content[0]?.text) {
    return msg.content[0].text;
  }
  return "";
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDagAnnotatorLayer", () => {
  it("returns messages unchanged when below trigger threshold", async () => {
    const annotator = createDagAnnotatorLayer(
      { annotationKeepWindow: 3, annotationTriggerChars: 100_000 },
      { estimateTokens },
    );

    const messages = [
      makeUserMessage("Hello"),
      makeAssistantMessage("Hi there"),
      makeToolResult("bash", "command output"),
    ];

    const result = await annotator.apply(messages, defaultBudget);
    expect(result).toBe(messages); // exact same reference (below threshold)
  });

  it("annotates old tool results beyond keep window", async () => {
    const annotator = createDagAnnotatorLayer(
      { annotationKeepWindow: 3, annotationTriggerChars: 0 }, // always trigger
      { estimateTokens },
    );

    // 10 tool results interspersed with user/assistant
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeUserMessage(`Question ${i + 1}`));
      messages.push(makeAssistantMessage(`Let me check...`));
      messages.push(makeToolResult("bash", `Tool output ${i + 1} with some content`));
    }

    const result = await annotator.apply(messages, defaultBudget);

    // Count annotated vs preserved tool results
    let annotatedCount = 0;
    let preservedCount = 0;
    for (const msg of result) {
      if (msg.role !== "toolResult") continue;
      const text = getTextFromMessage(msg);
      if (text.startsWith("[Tool result from")) {
        annotatedCount++;
      } else {
        preservedCount++;
      }
    }

    // Newest 3 preserved, oldest 7 annotated
    expect(preservedCount).toBe(3);
    expect(annotatedCount).toBe(7);
  });

  it("preserves original messages (immutability check)", async () => {
    const annotator = createDagAnnotatorLayer(
      { annotationKeepWindow: 1, annotationTriggerChars: 0 },
      { estimateTokens },
    );

    const originalContent = "Original tool output content";
    const messages = [
      makeUserMessage("Hello"),
      makeToolResult("bash", originalContent),
      makeUserMessage("More"),
      makeToolResult("bash", "Recent tool output"),
    ];

    // Capture original state
    const originalToolContent = getTextFromMessage(messages[1]);

    const result = await annotator.apply(messages, defaultBudget);

    // Original messages not mutated
    expect(getTextFromMessage(messages[1])).toBe(originalToolContent);
    expect(getTextFromMessage(messages[1])).toBe(originalContent);

    // Annotated messages are different objects
    expect(result[1]).not.toBe(messages[1]);
    expect(getTextFromMessage(result[1])).toContain("[Tool result from");

    // Non-annotated messages are the same object
    expect(result[0]).toBe(messages[0]); // user message
    expect(result[3]).toBe(messages[3]); // recent tool result (within keep window)
  });

  it("protects memory_search and file_read tools from annotation", async () => {
    const annotator = createDagAnnotatorLayer(
      { annotationKeepWindow: 0, annotationTriggerChars: 0, ephemeralAnnotationKeepWindow: 0 }, // annotate all beyond window
      { estimateTokens },
    );

    const messages = [
      makeToolResult("memory_search", "Found 3 relevant memories"),
      makeToolResult("file_read", "/etc/config.yaml contents here"),
      makeToolResult("memory_get", "Retrieved specific memory"),
      makeToolResult("bash", "command output that should be annotated"),
      makeToolResult("web_search", "web results that should be annotated"),
    ];

    const result = await annotator.apply(messages, defaultBudget);

    // Protected tools preserved
    expect(getTextFromMessage(result[0])).toBe("Found 3 relevant memories");
    expect(getTextFromMessage(result[1])).toBe("/etc/config.yaml contents here");
    expect(getTextFromMessage(result[2])).toBe("Retrieved specific memory");

    // Non-protected tools annotated (bash=standard, web_search=ephemeral)
    expect(getTextFromMessage(result[3])).toContain("[Tool result from bash:");
    expect(getTextFromMessage(result[4])).toContain("[Tool result from web_search:");
  });

  it("skips already-annotated results (double annotation guard)", async () => {
    const annotator = createDagAnnotatorLayer(
      { annotationKeepWindow: 0, annotationTriggerChars: 0 },
      { estimateTokens },
    );

    const alreadyAnnotated = {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "call_1",
      content: [{ type: "text", text: "[Tool result from bash: 50 tokens. Use ctx_inspect to view.]" }],
    } as unknown as AgentMessage;

    const messages = [alreadyAnnotated];
    const result = await annotator.apply(messages, defaultBudget);

    // Should not be re-annotated -- same content
    expect(getTextFromMessage(result[0])).toBe("[Tool result from bash: 50 tokens. Use ctx_inspect to view.]");
  });

  it("skips already-masked results from observation masker", async () => {
    const annotator = createDagAnnotatorLayer(
      { annotationKeepWindow: 0, annotationTriggerChars: 0 },
      { estimateTokens },
    );

    const alreadyMasked = {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "call_2",
      content: [{ type: "text", text: "[Tool result cleared: bash -- see assistant analysis above]" }],
    } as unknown as AgentMessage;

    const offloaded = {
      role: "toolResult",
      toolName: "file_write",
      toolCallId: "call_3",
      content: [{ type: "text", text: "[Tool result offloaded to disk: /tmp/results/output.json]" }],
    } as unknown as AgentMessage;

    const messages = [alreadyMasked, offloaded];
    const result = await annotator.apply(messages, defaultBudget);

    // Neither should be annotated
    expect(getTextFromMessage(result[0])).toContain("[Tool result cleared:");
    expect(getTextFromMessage(result[1])).toContain("[Tool result offloaded to disk:");
  });

  it("skips already-summarized results from observation masker (new prefix)", async () => {
    const annotator = createDagAnnotatorLayer(
      { annotationKeepWindow: 0, annotationTriggerChars: 0 },
      { estimateTokens },
    );

    const alreadySummarized = {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "call_summarized",
      content: [{ type: "text", text: "[Tool result summarized: bash \u2014 5000 chars cleared]\nThe data shows X and Y" }],
    } as unknown as AgentMessage;

    const messages = [alreadySummarized];
    const result = await annotator.apply(messages, defaultBudget);

    // Should not be annotated -- recognized as already-masked via new prefix
    expect(getTextFromMessage(result[0])).toContain("[Tool result summarized:");
    expect(getTextFromMessage(result[0])).not.toContain("[Tool result from");
  });

  it("annotation placeholder includes tool name and token count", async () => {
    const annotator = createDagAnnotatorLayer(
      { annotationKeepWindow: 0, annotationTriggerChars: 0 },
      { estimateTokens },
    );

    const toolContent = "This is a tool result with some content that will be annotated.";
    const expectedTokens = estimateTokens(toolContent);

    const messages = [makeToolResult("my_tool", toolContent)];
    const result = await annotator.apply(messages, defaultBudget);

    const text = getTextFromMessage(result[0]);
    expect(text).toBe(`[Tool result from my_tool: ${expectedTokens} tokens. Use ctx_inspect to view.]`);
  });

  it("non-toolResult messages are never annotated", async () => {
    const annotator = createDagAnnotatorLayer(
      { annotationKeepWindow: 0, annotationTriggerChars: 0 },
      { estimateTokens },
    );

    const messages = [
      makeUserMessage("User question about something"),
      makeAssistantMessage("Let me check that for you"),
      makeToolResult("bash", "some output"),
      makeAssistantMessage("Based on the results..."),
      makeUserMessage("Thanks, can you also..."),
    ];

    const result = await annotator.apply(messages, defaultBudget);

    // User and assistant messages should pass through unchanged
    expect(result[0]).toBe(messages[0]);
    expect(getTextFromMessage(result[0])).toBe("User question about something");

    expect(result[1]).toBe(messages[1]);
    expect(getTextFromMessage(result[1])).toBe("Let me check that for you");

    expect(result[3]).toBe(messages[3]);
    expect(getTextFromMessage(result[3])).toBe("Based on the results...");

    expect(result[4]).toBe(messages[4]);
    expect(getTextFromMessage(result[4])).toBe("Thanks, can you also...");

    // Tool result is annotated (keepWindow=0)
    expect(getTextFromMessage(result[2])).toContain("[Tool result from bash:");
  });

  it("has name 'dag-annotator'", () => {
    const annotator = createDagAnnotatorLayer(
      { annotationKeepWindow: 3, annotationTriggerChars: 100_000 },
      { estimateTokens },
    );
    expect(annotator.name).toBe("dag-annotator");
  });

  // -------------------------------------------------------------------------
  // Tier-aware annotation
  // -------------------------------------------------------------------------

  describe("tier-aware annotation", () => {
    it("ephemeral tools annotated after ephemeral keep window", async () => {
      const annotator = createDagAnnotatorLayer(
        { annotationKeepWindow: 25, annotationTriggerChars: 0, ephemeralAnnotationKeepWindow: 10 },
        { estimateTokens },
      );

      // 12 web_search results (ephemeral tier)
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 12; i++) {
        messages.push(makeUserMessage(`Search query ${i + 1}`));
        messages.push(makeToolResult("web_search", `Search result ${i + 1} with content`));
      }

      const result = await annotator.apply(messages, defaultBudget);

      let annotatedCount = 0;
      let preservedCount = 0;
      for (const msg of result) {
        if (msg.role !== "toolResult") continue;
        const text = getTextFromMessage(msg);
        if (text.startsWith("[Tool result from")) annotatedCount++;
        else preservedCount++;
      }

      // 10 most recent kept, 2 oldest annotated
      expect(preservedCount).toBe(10);
      expect(annotatedCount).toBe(2);
    });

    it("protected tools never annotated even at deep positions", async () => {
      const annotator = createDagAnnotatorLayer(
        { annotationKeepWindow: 0, annotationTriggerChars: 0, ephemeralAnnotationKeepWindow: 0 },
        { estimateTokens },
      );

      // Protected tools at various positions
      const messages: AgentMessage[] = [
        makeToolResult("memory_search", "Memory search result 1"),
        makeToolResult("memory_get", "Memory get result"),
        makeToolResult("file_read", "File read content"),
        makeToolResult("session_search", "Session search result"),
        makeToolResult("memory_store", "Memory stored"),
      ];

      const result = await annotator.apply(messages, defaultBudget);

      // All protected tools should be preserved (not annotated)
      for (const msg of result) {
        const text = getTextFromMessage(msg);
        expect(text).not.toContain("[Tool result from");
      }
    });

    it("interleaved protected + ephemeral: protected does not shift ephemeral counter", async () => {
      const annotator = createDagAnnotatorLayer(
        { annotationKeepWindow: 25, annotationTriggerChars: 0, ephemeralAnnotationKeepWindow: 2 },
        { estimateTokens },
      );

      // Interleaved: [web_search, memory_search, web_search, memory_search, web_search]
      const messages: AgentMessage[] = [
        makeToolResult("web_search", "Oldest web search result"),
        makeToolResult("memory_search", "Memory result 1"),
        makeToolResult("web_search", "Middle web search result"),
        makeToolResult("memory_search", "Memory result 2"),
        makeToolResult("web_search", "Newest web search result"),
      ];

      const result = await annotator.apply(messages, defaultBudget);

      // memory_search: all preserved (protected)
      expect(getTextFromMessage(result[1])).toBe("Memory result 1");
      expect(getTextFromMessage(result[3])).toBe("Memory result 2");

      // web_search: 2 most recent kept, oldest annotated
      expect(getTextFromMessage(result[4])).toBe("Newest web search result");
      expect(getTextFromMessage(result[2])).toBe("Middle web search result");
      expect(getTextFromMessage(result[0])).toContain("[Tool result from web_search:");
    });

    it("interleaved protected + standard: protected does not shift standard counter", async () => {
      const annotator = createDagAnnotatorLayer(
        { annotationKeepWindow: 2, annotationTriggerChars: 0 },
        { estimateTokens },
      );

      // Interleaved: [bash, file_read, bash, file_read, bash]
      const messages: AgentMessage[] = [
        makeToolResult("bash", "Oldest bash output"),
        makeToolResult("file_read", "File content 1"),
        makeToolResult("bash", "Middle bash output"),
        makeToolResult("file_read", "File content 2"),
        makeToolResult("bash", "Newest bash output"),
      ];

      const result = await annotator.apply(messages, defaultBudget);

      // file_read: all preserved (protected)
      expect(getTextFromMessage(result[1])).toBe("File content 1");
      expect(getTextFromMessage(result[3])).toBe("File content 2");

      // bash: 2 most recent kept, oldest annotated
      expect(getTextFromMessage(result[4])).toBe("Newest bash output");
      expect(getTextFromMessage(result[2])).toBe("Middle bash output");
      expect(getTextFromMessage(result[0])).toContain("[Tool result from bash:");
    });

    it("unknown tool uses standard window (annotationKeepWindow)", async () => {
      const annotator = createDagAnnotatorLayer(
        { annotationKeepWindow: 3, annotationTriggerChars: 0 },
        { estimateTokens },
      );

      // 5 unknown tools
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 5; i++) {
        messages.push(makeToolResult("custom_tool", `Custom output ${i + 1}`));
      }

      const result = await annotator.apply(messages, defaultBudget);

      let annotatedCount = 0;
      let preservedCount = 0;
      for (const msg of result) {
        const text = getTextFromMessage(msg);
        if (text.startsWith("[Tool result from")) annotatedCount++;
        else preservedCount++;
      }

      // 3 most recent kept (annotationKeepWindow=3), 2 oldest annotated
      expect(preservedCount).toBe(3);
      expect(annotatedCount).toBe(2);
    });

    it("MCP tool uses ephemeral window (ephemeralAnnotationKeepWindow)", async () => {
      const annotator = createDagAnnotatorLayer(
        { annotationKeepWindow: 3, annotationTriggerChars: 0, ephemeralAnnotationKeepWindow: 2 },
        { estimateTokens },
      );

      // 5 MCP tools -- now classified as ephemeral tier
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 5; i++) {
        messages.push(makeToolResult("mcp__server__tool", `MCP output ${i + 1}`));
      }

      const result = await annotator.apply(messages, defaultBudget);

      let annotatedCount = 0;
      let preservedCount = 0;
      for (const msg of result) {
        const text = getTextFromMessage(msg);
        if (text.startsWith("[Tool result from")) annotatedCount++;
        else preservedCount++;
      }

      // 2 most recent kept (ephemeralAnnotationKeepWindow=2), 3 oldest annotated
      expect(preservedCount).toBe(2);
      expect(annotatedCount).toBe(3);
    });

    it("ephemeral and standard counters are independent", async () => {
      const annotator = createDagAnnotatorLayer(
        { annotationKeepWindow: 2, annotationTriggerChars: 0, ephemeralAnnotationKeepWindow: 1 },
        { estimateTokens },
      );

      // Mix of ephemeral (web_search) and standard (bash)
      const messages: AgentMessage[] = [
        makeToolResult("web_search", "Old web result 1"),
        makeToolResult("bash", "Old bash output 1"),
        makeToolResult("web_search", "Old web result 2"),
        makeToolResult("bash", "Middle bash output"),
        makeToolResult("web_search", "Newest web result"),
        makeToolResult("bash", "Newest bash output"),
      ];

      const result = await annotator.apply(messages, defaultBudget);

      // web_search (ephemeral, window=1): only newest kept, 2 annotated
      expect(getTextFromMessage(result[4])).toBe("Newest web result");
      expect(getTextFromMessage(result[2])).toContain("[Tool result from web_search:");
      expect(getTextFromMessage(result[0])).toContain("[Tool result from web_search:");

      // bash (standard, window=2): 2 newest kept, oldest annotated
      expect(getTextFromMessage(result[5])).toBe("Newest bash output");
      expect(getTextFromMessage(result[3])).toBe("Middle bash output");
      expect(getTextFromMessage(result[1])).toContain("[Tool result from bash:");
    });
  });
});
