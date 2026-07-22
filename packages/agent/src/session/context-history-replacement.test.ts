// SPDX-License-Identifier: Apache-2.0
import type { ContextStorePort, ContextStoreScope } from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { replaceContextStoreHistory } from "./context-history-replacement.js";

const scope = {
  conversationRef: "cv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  tenantId: "tenant-a",
  agentId: "agent-a",
  sessionKey: "tenant-a:agent:agent-a:conversation:scheduler:job-a:cron-job-job-a",
} as ContextStoreScope;

function history(): AgentMessage[] {
  return [
    { role: "user", content: "question", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "example.txt" } }],
      api: "messages",
      provider: "example",
      model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 2,
    } as never,
    {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 3,
    } as never,
    {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "messages",
      provider: "example",
      model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 4,
    } as never,
  ];
}

function store() {
  const rows: Array<{ seq: number; role: string; parts: Array<{ kind: string }> }> = [];
  let cursor: { epochAnchor: string; ingestedLiveLen: number } | null = null;
  const port = {
    append: vi.fn((entry) => rows.push({ seq: entry.seq, role: entry.role, parts: entry.parts })),
    getMessages: vi.fn(() => rows.map((row, index) => ({
      id: `message-${index}`,
      conversationRef: scope.conversationRef,
      seq: row.seq,
      role: row.role,
      tokenCount: 1,
      createdAt: 1,
      parts: row.parts,
    }))),
    runOnConversation: vi.fn(async (_ref, fn) => fn()),
    deleteConversationLcd: vi.fn(() => {
      const count = rows.length;
      rows.splice(0);
      cursor = null;
      return count;
    }),
    getIngestCursor: vi.fn(() => cursor),
    upsertIngestCursor: vi.fn((_scope, next) => { cursor = next; }),
  } as unknown as ContextStorePort;
  return { port, rows, getCursor: () => cursor };
}

const logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), audit: vi.fn(),
} as never;

describe("canonical context history replacement", () => {
  it("replaces one scope under its serializer and preserves structured tool messages", async () => {
    const fixture = store();

    const result = await replaceContextStoreHistory(
      fixture.port,
      scope,
      history(),
      1_800_000_000_000,
      logger,
    );

    expect(result).toEqual({ ok: true, value: { retainedMessages: 4 } });
    expect(fixture.port.runOnConversation).toHaveBeenCalledWith(scope.conversationRef, expect.any(Function));
    expect(fixture.port.deleteConversationLcd).toHaveBeenCalledWith(scope);
    expect(fixture.rows.map((row) => row.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(fixture.rows.flatMap((row) => row.parts.map((part) => part.kind))).toEqual(
      expect.arrayContaining(["tool_use", "tool_result"]),
    );
    expect(fixture.getCursor()?.ingestedLiveLen).toBe(4);
  });

  it("reports a failed strict replacement when any append is missing", async () => {
    const fixture = store();
    vi.mocked(fixture.port.append).mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const result = await replaceContextStoreHistory(
      fixture.port,
      scope,
      history(),
      1_800_000_000_000,
      logger,
    );

    expect(result).toEqual({
      ok: false,
      error: { errorKind: "resource", message: "Canonical history replacement was incomplete" },
    });
  });
});
