// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the post-batch continuation handler (L4 silent-termination
 * recovery). Replaces the legacy SEP one-shot completeness nudge.
 *
 * @module
 */

import { describe, it, expect, vi, type Mock } from "vitest";
import { runPostBatchContinuation } from "./post-batch-continuation.js";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal mock logger satisfying ComisLogger for handler tests. */
function mockLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    audit: vi.fn(),
  } as unknown as ComisLogger;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Build a mock session whose `followUp` is a `vi.fn()` that, on each call,
 * appends a new assistant message containing `followUpResponses[i]` to
 * `session.messages`. When the response is the empty string, an empty
 * assistant turn is appended (to simulate a still-silent followUp).
 *
 * `getVisibleAssistantText` (passed into the handler) reads the most recent
 * assistant turn's first text block, mirroring the post-batch pattern at
 * executor-prompt-runner.ts:793.
 */
function makeSession(messages: any[], followUpResponses: string[]) {
  const session: any = {
    messages,
    followUp: vi.fn(),
  };
  let callIdx = 0;
  session.followUp.mockImplementation(async () => {
    const text = followUpResponses[callIdx] ?? "";
    callIdx++;
    if (text === "") {
      session.messages.push({ role: "assistant", content: [] });
    } else {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
      });
    }
  });
  return session;
}

/**
 * Read visible text from the latest assistant turn — first text block with
 * non-empty `.text`. Returns "" when the latest assistant turn has no
 * visible text content.
 */
function getVisibleAssistantText(session: any): string {
  const messages: any[] = session?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (
          block?.type === "text" &&
          typeof block.text === "string" &&
          block.text.length > 0
        ) {
          return block.text;
        }
      }
      // Last assistant turn was empty.
      return "";
    }
  }
  return "";
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Build a conversation ending with an empty assistant turn after N
 *  successful agents_manage tool calls. */
function emptyAfterToolBatch(toolCallCount: number, isError = false): any[] {
  const userMsg = {
    role: "user",
    content: [{ type: "text", text: "create some agents" }],
  };
  const assistantToolCalls = {
    role: "assistant",
    content: [
      { type: "text", text: "I'll create them now." },
      ...Array.from({ length: toolCallCount }, (_, i) => ({
        type: "toolCall",
        id: `t${i + 1}`,
        name: "agents_manage",
        arguments: { action: "create", agent_id: `agent-${i + 1}` },
      })),
    ],
  };
  // pi-coding-agent session shape uses role: "toolResult" (NOT role: "user"
  // with tool_result blocks). See executor-response-filter.test.ts for the
  // canonical fixture pattern.
  const toolResults = Array.from({ length: toolCallCount }, (_, i) => ({
    role: "toolResult",
    toolCallId: `t${i + 1}`,
    toolName: "agents_manage",
    content: [{ type: "text", text: isError ? "error: failed" : "ok" }],
    isError,
  }));
  const emptyFinal = { role: "assistant", content: [] };
  return [userMsg, assistantToolCalls, ...toolResults, emptyFinal];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPostBatchContinuation", () => {
  it("Test 1 — fires once after agents_manage × 3 batch and recovers", async () => {
    const messages = emptyAfterToolBatch(3);
    const session = makeSession(messages, ["Created 3 agents successfully"]);
    const logger = mockLogger();

    const result = await runPostBatchContinuation({
      session,
      messages: session.messages,
      config: { enabled: true, maxRetries: 2 },
      logger,
      agentId: "agent-test",
      getVisibleAssistantText,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      recovered: true,
      response: "Created 3 agents successfully",
      attempts: 1,
      outcome: "recovered",
      priorToolCallCount: 3,
      priorToolNames: ["agents_manage"],
    });
    expect(session.followUp).toHaveBeenCalledTimes(1);
    const directive = session.followUp.mock.calls[0][0] as string;
    expect(directive).toContain("post-batch continuation");
    expect(directive).toContain("3 successful tool calls");
    expect(directive).toContain("agents_manage");
  });

  it("Test 2 — fires after a FAILED tool batch (is_error=true)", async () => {
    const messages = emptyAfterToolBatch(2, /* isError */ true);
    const session = makeSession(messages, ["The 2 calls failed; aborting."]);

    const result = await runPostBatchContinuation({
      session,
      messages: session.messages,
      config: { enabled: true, maxRetries: 2 },
      logger: mockLogger(),
      getVisibleAssistantText,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recovered).toBe(true);
    expect(result.value.outcome).toBe("recovered");
    expect(result.value.priorToolCallCount).toBe(2);
    expect(session.followUp).toHaveBeenCalledTimes(1);
  });

  it("Test 3 — no tool calls in window → no_match (followUp NOT called)", async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [] }, // empty final, no tool calls anywhere
    ];
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const session = makeSession(messages, ["should not be used"]);

    const result = await runPostBatchContinuation({
      session,
      messages: session.messages,
      config: { enabled: true, maxRetries: 2 },
      logger: mockLogger(),
      getVisibleAssistantText,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      recovered: false,
      outcome: "no_match",
      attempts: 0,
      priorToolCallCount: 0,
      priorToolNames: [],
    });
    expect(session.followUp).not.toHaveBeenCalled();
  });

  it("Test 4 — final assistant turn has visible text → no_match", async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "do it" }] },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "agents_manage", arguments: { action: "create" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] },
      { role: "assistant", content: [{ type: "text", text: "Done — agent created." }] },
    ];
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const session = makeSession(messages, ["should not be used"]);

    const result = await runPostBatchContinuation({
      session,
      messages: session.messages,
      config: { enabled: true, maxRetries: 2 },
      logger: mockLogger(),
      getVisibleAssistantText,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recovered).toBe(false);
    expect(result.value.outcome).toBe("no_match");
    expect(session.followUp).not.toHaveBeenCalled();
  });

  it("Test 5 — multi-shot retry: first followUp empty, second returns text", async () => {
    const messages = emptyAfterToolBatch(1);
    const session = makeSession(messages, ["", "Recovered on attempt 2"]);

    const result = await runPostBatchContinuation({
      session,
      messages: session.messages,
      config: { enabled: true, maxRetries: 2 },
      logger: mockLogger(),
      getVisibleAssistantText,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      recovered: true,
      attempts: 2,
      outcome: "recovered",
      response: "Recovered on attempt 2",
    });
    expect(session.followUp).toHaveBeenCalledTimes(2);
  });

  it("Test 6 — max retries exhausted: all followUps empty", async () => {
    const messages = emptyAfterToolBatch(2);
    const session = makeSession(messages, ["", ""]);

    const result = await runPostBatchContinuation({
      session,
      messages: session.messages,
      config: { enabled: true, maxRetries: 2 },
      logger: mockLogger(),
      getVisibleAssistantText,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      recovered: false,
      attempts: 2,
      outcome: "max_attempts_exhausted",
    });
    // Critically: exactly 2 calls, NOT 3.
    expect(session.followUp).toHaveBeenCalledTimes(2);
  });

  it("Test 7 — structured Pino INFO logs: decision-log on entry + per-attempt log", async () => {
    const messages = emptyAfterToolBatch(3);
    const session = makeSession(messages, ["recovered text"]);
    const logger = mockLogger();

    await runPostBatchContinuation({
      session,
      messages: session.messages,
      config: { enabled: true, maxRetries: 2 },
      logger,
      agentId: "agent-7",
      getVisibleAssistantText,
    });

    const infoCalls = (logger.info as Mock).mock.calls;

    // Decision-log on entry: fire / empty_after_tool_batch.
    const decisionCall = infoCalls.find(
      (c) => c[0]?.decision === "fire",
    );
    expect(decisionCall).toBeDefined();
    expect(decisionCall![0]).toMatchObject({
      module: "agent.executor.post-batch-continuation",
      decision: "fire",
      reason: "empty_after_tool_batch",
      priorToolCallCount: 3,
      priorToolNames: ["agents_manage"],
    });

    // Per-attempt INFO log.
    const attemptCall = infoCalls.find(
      (c) => typeof c[0]?.attempt === "number",
    );
    expect(attemptCall).toBeDefined();
    expect(attemptCall![0]).toMatchObject({
      module: "agent.executor.post-batch-continuation",
      attempt: 1,
      maxAttempts: 2,
      priorToolCallCount: 3,
      priorToolNames: ["agents_manage"],
      outcome: "recovered",
    });
  });

  it("Test 8 — disabled via enabled:false OR maxRetries:0", async () => {
    // 8a: enabled=false
    const messages8a = emptyAfterToolBatch(2);
    const session8a = makeSession(messages8a, ["should not run"]);
    const result8a = await runPostBatchContinuation({
      session: session8a,
      messages: session8a.messages,
      config: { enabled: false, maxRetries: 2 },
      logger: mockLogger(),
      getVisibleAssistantText,
    });
    expect(result8a.ok).toBe(true);
    if (!result8a.ok) return;
    expect(result8a.value).toMatchObject({
      recovered: false,
      attempts: 0,
      outcome: "disabled",
    });
    expect(session8a.followUp).not.toHaveBeenCalled();

    // 8b: maxRetries=0
    const messages8b = emptyAfterToolBatch(2);
    const session8b = makeSession(messages8b, ["should not run"]);
    const result8b = await runPostBatchContinuation({
      session: session8b,
      messages: session8b.messages,
      config: { enabled: true, maxRetries: 0 },
      logger: mockLogger(),
      getVisibleAssistantText,
    });
    expect(result8b.ok).toBe(true);
    if (!result8b.ok) return;
    expect(result8b.value).toMatchObject({
      recovered: false,
      attempts: 0,
      outcome: "disabled",
    });
    expect(session8b.followUp).not.toHaveBeenCalled();
  });

  it("Test 9 — returns err({kind:'followup_error'}) when session.followUp throws", async () => {
    const messages = emptyAfterToolBatch(2);
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const session: any = {
      messages,
      followUp: vi.fn().mockRejectedValueOnce(new Error("network down")),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const result = await runPostBatchContinuation({
      session,
      messages: session.messages,
      config: { enabled: true, maxRetries: 2 },
      logger: mockLogger(),
      getVisibleAssistantText: () => "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("followup_error");
    expect(String((result.error.cause as Error)?.message ?? result.error.cause)).toContain(
      "network down",
    );
  });
});
