// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  ContextEngineConfigSchema,
  createConversationRef,
  type ContextStorePort,
} from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createContextEngine } from "./context-engine.js";
import type { CanonicalContextEngineDeps } from "./context-engine.js";

function makeStore(): ContextStorePort {
  return {
    append: vi.fn(),
    getMessages: vi.fn(() => []),
    appendLeafSummary: vi.fn(() => "summary-leaf"),
    appendCondensedSummary: vi.fn(() => "summary-condensed"),
    getContextItems: vi.fn(() => []),
    getSummaries: vi.fn(() => []),
    getMessagesByIds: vi.fn(() => []),
    getSummariesByIds: vi.fn(() => []),
    countMessages: vi.fn(() => 0),
    getSummaryChildren: vi.fn(() => []),
    getSummaryMessages: vi.fn(() => []),
    searchLcd: vi.fn(() => ({ hits: [], lane: "word", matchErrored: false, cjkZeroHit: false, scanCapped: false })),
    runOnConversation: vi.fn(async (_conversationRef, fn) => fn()),
    getIngestCursor: vi.fn(() => null),
    upsertIngestCursor: vi.fn(),
    deleteConversationLcd: vi.fn(() => 0),
  };
}

function makeDeps(): CanonicalContextEngineDeps {
  const conversation = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: { kind: "agent" as const },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    logger: {
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), audit: vi.fn(), child: vi.fn(),
    } as never,
    getModel: () => ({ reasoning: false, contextWindow: 128_000, maxTokens: 8_192 }),
    contextStore: makeStore(),
    conversationRef: conversationRef.value,
    tenantId: conversation.tenantId,
    agentId: conversation.agentId,
    sessionKey: "tenant-a:agent:agent-a:user-a:channel-a",
    clock: createFakeClock(1_700_000_000_000),
  };
}

describe("canonical context engine", () => {
  it("assembles every enabled turn through the canonical durable-context path", async () => {
    const engine = createContextEngine(ContextEngineConfigSchema.parse({}), makeDeps());
    const live = [{ role: "user", content: "current request", timestamp: 1 }] as AgentMessage[];

    const assembled = await engine.transformContext(live);

    expect(assembled).toEqual(live);
  });

  it("keeps disabled context assembly as an exact pass-through", async () => {
    const engine = createContextEngine(ContextEngineConfigSchema.parse({ enabled: false }), makeDeps());
    const live = [{ role: "user", content: "current request", timestamp: 1 }] as AgentMessage[];

    await expect(engine.transformContext(live)).resolves.toBe(live);
  });

  it("requires explicit store and conversation authority at construction", () => {
    if (false) {
      // @ts-expect-error a canonical assembler cannot start without a context store
      createContextEngine(ContextEngineConfigSchema.parse({}), { ...makeDeps(), contextStore: undefined });
      // @ts-expect-error a canonical assembler cannot start without an opaque conversation reference
      createContextEngine(ContextEngineConfigSchema.parse({}), { ...makeDeps(), conversationRef: undefined });
    }
    expect(true).toBe(true);
  });

  it("rejects context implementation selectors from configuration", () => {
    expect(ContextEngineConfigSchema.safeParse({ version: "pipeline" }).success).toBe(false);
    expect(ContextEngineConfigSchema.safeParse({ version: "dag" }).success).toBe(false);
  });
});
