// SPDX-License-Identifier: Apache-2.0
import {
  computeWorkspacePolicyCombinedHash,
  createConversationRef,
  hashWorkspacePolicyContent,
  type TaskExtractionTurn,
} from "@comis/core";
import { ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createTaskExtractionQueue } from "./task-extraction-queue.js";

function turn(overrides: Partial<TaskExtractionTurn> = {}): TaskExtractionTurn {
  const conversation = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: { kind: "agent" as const },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  const content = "# Policy\n\nUse the configured scope.";
  const section = {
    id: "workspace:role",
    sourceKind: "operator" as const,
    trust: "trusted" as const,
    stability: "stable" as const,
    content,
    contentHash: hashWorkspacePolicyContent(content),
    maxChars: 20_000,
  };
  return {
    sourceExecutionId: "execution-a",
    origin: {
      turnScope: {
        conversation,
        principal: { principalId: "user-a" },
        endpoint: {
          channelType: "echo",
          channelInstanceId: "echo-main",
          conversationId: "conversation-a",
          conversationKind: "direct",
        },
      },
      conversationRef: conversationRef.value,
      deliveryOrigin: {
        tenantId: "tenant-a",
        channelType: "echo",
        channelId: "conversation-a",
        userId: "user-a",
      },
      traceId: "trace-a",
      backgroundHopCount: 0,
    },
    workspacePolicySnapshot: {
      agentId: "agent-a",
      sections: [section],
      combinedHash: computeWorkspacePolicyCombinedHash([section]),
    },
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    capturedAtMs: 1_000,
    userText: "Please check this later.",
    deliveredAssistantText: "I will follow up.",
    ...overrides,
  };
}

function setup() {
  const timers = createFakeTimers();
  const batches: unknown[][] = [];
  let sequence = 0;
  const onBatch = vi.fn((_agentId: string, batch: readonly unknown[]) => {
    batches.push([...batch]);
    return ok(undefined);
  });
  const queue = createTaskExtractionQueue({
    timers,
    idFactory: () => `item-${++sequence}`,
    getConfig: () => ({ debounceMs: 1_000, batchMax: 8, heartbeatIntervalMs: 60_000 }),
    onBatch,
    onBatchFailed: vi.fn(),
  });
  return { queue, timers, batches, onBatch };
}

describe("task extraction queue", () => {
  it("rejects admission before activation and after closure", () => {
    const { queue } = setup();
    expect(queue.enqueue(turn())).toMatchObject({ ok: false, error: { code: "not_accepting" } });
    expect(queue.activate()).toEqual(ok(undefined));
    queue.close();
    expect(queue.enqueue(turn())).toMatchObject({ ok: false, error: { code: "not_accepting" } });
  });

  it("rejects empty text and hash-invalid policy snapshots", () => {
    const { queue } = setup();
    queue.activate();
    expect(queue.enqueue(turn({ userText: "" }))).toMatchObject({
      ok: false,
      error: { code: "invalid_turn" },
    });
    expect(queue.enqueue(turn({
      workspacePolicySnapshot: {
        ...turn().workspacePolicySnapshot,
        combinedHash: "f".repeat(64),
      },
    }))).toMatchObject({ ok: false, error: { code: "invalid_turn" } });
  });

  it("debounces per agent and transfers opaque bounded items", () => {
    const { queue, timers, batches } = setup();
    queue.activate();
    expect(queue.enqueue(turn())).toEqual(ok("enqueued"));
    expect(timers.unrefRecord()).toMatchObject([{ delay: 1_000, unrefCalled: true }]);

    timers.advance(999);
    expect(batches).toHaveLength(0);
    timers.advance(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([expect.objectContaining({
      itemId: "item-1",
      sourceExecutionId: "execution-a",
      minimumDueAtMs: 61_000,
      userText: "Please check this later.",
      deliveredAssistantText: "I will follow up.",
    })]);
  });

  it("drops the oldest item when the fixed queue count is full", () => {
    const { queue } = setup();
    queue.activate();
    for (let index = 0; index < 64; index++) {
      expect(queue.enqueue(turn({ sourceExecutionId: `execution-${index}` }))).toEqual(ok("enqueued"));
    }
    expect(queue.enqueue(turn({ sourceExecutionId: "execution-new" }))).toEqual(ok("oldest_dropped"));
    expect(queue.getStatus()).toMatchObject({ itemCount: 64, droppedCount: 1 });
  });

  it("keeps source-text batches under the fixed byte ceiling", () => {
    const { queue, timers, batches } = setup();
    queue.activate();
    const text = "x".repeat(64 * 1_024);
    expect(queue.enqueue(turn({ userText: text, deliveredAssistantText: "a" }))).toEqual(ok("enqueued"));
    expect(queue.enqueue(turn({ sourceExecutionId: "execution-b", userText: text, deliveredAssistantText: "b" }))).toEqual(ok("enqueued"));

    timers.advance(1_000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    timers.advance(1_000);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
  });

  it("never mixes immutable workspace policies in one model batch", () => {
    const { queue, timers, batches } = setup();
    queue.activate();
    const alternateContent = "# Policy\n\nUse the updated configured scope.";
    const alternateSection = {
      id: "workspace:role",
      sourceKind: "operator" as const,
      trust: "trusted" as const,
      stability: "stable" as const,
      content: alternateContent,
      contentHash: hashWorkspacePolicyContent(alternateContent),
      maxChars: 20_000,
    };
    const alternateSnapshot = {
      agentId: "agent-a",
      sections: [alternateSection],
      combinedHash: computeWorkspacePolicyCombinedHash([alternateSection]),
    };

    expect(queue.enqueue(turn({ sourceExecutionId: "execution-old" }))).toEqual(ok("enqueued"));
    expect(queue.enqueue(turn({
      sourceExecutionId: "execution-new",
      workspacePolicySnapshot: alternateSnapshot,
    }))).toEqual(ok("enqueued"));

    timers.advance(1_000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([expect.objectContaining({ sourceExecutionId: "execution-old" })]);
    timers.advance(1_000);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([expect.objectContaining({ sourceExecutionId: "execution-new" })]);
  });

  it("cancels timers and reports dropped items during closure", () => {
    const { queue, timers, batches } = setup();
    queue.activate();
    queue.enqueue(turn());

    expect(queue.close()).toEqual({ droppedCount: 1 });
    expect(timers.unrefRecord()[0]).toMatchObject({ cancelled: true });
    timers.advance(2_000);
    expect(batches).toHaveLength(0);
  });
});
