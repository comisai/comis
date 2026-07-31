// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  partsToMessage,
  type ContextStoreScope,
  type ConversationRef,
  type NormalizedMessage,
} from "@comis/core";
import Database from "better-sqlite3";
import { createLcdStore, initSchema } from "@comis/memory";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import {
  appendInboundMessageProvenance,
  planInboundMessageProvenance,
  projectInboundConversation,
} from "../session/inbound-message-provenance.js";
import * as contextHistoryReplacement from "../session/context-history-replacement.js";
import * as lcdIngest from "./lcd-ingest.js";

const NOW = 1_789_000_000_100;
const SCOPE: ContextStoreScope = {
  conversationRef: `cv_${"b".repeat(43)}` as ConversationRef,
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: "tenant_a:agent_a:user_a:telegram",
};

type ReconcileResult = {
  ok: true;
  value: {
    mode: "steady" | "replaced_dirty_epoch";
    deletedMessages: number;
  };
};

const ingestProjectedConversationHistory = (
  contextHistoryReplacement as unknown as {
    ingestProjectedConversationHistory(args: {
      store: ReturnType<typeof createLcdStore>;
      scope: ContextStoreScope;
      sourceMessages: AgentMessage[];
      projectedMessages: AgentMessage[];
      now: number;
      logger: ReturnType<typeof createMockLogger>;
    }): Promise<ReconcileResult>;
  }
).ingestProjectedConversationHistory;

function assistant(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "responses",
    provider: "example",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as unknown as AgentMessage;
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object"
      && block !== null
      && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("");
}

describe("projected conversation LCD reconciliation", () => {
  it("replaces the matching wrapped epoch with physical inbound history", async () => {
    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const logger = createMockLogger();
    const rawUser = {
      role: "user",
      content:
        "[System context]\nlarge runtime preamble\n[End system context]\n\n"
        + "[telegram] sender-a (5:00 PM):\nswitch back",
      timestamp: NOW,
    } as unknown as AgentMessage;
    const rawHistory = [rawUser, assistant("done", NOW + 1)];
    lcdIngest.ingestTurnGuarded(store, SCOPE, rawHistory, NOW, logger);

    const sessionManager = SessionManager.inMemory("/workspace");
    const inbound = {
      id: "11111111-1111-4111-8111-111111111111",
      channelId: "chat-a",
      channelType: "telegram",
      senderId: "sender-a",
      text: "switch back",
      timestamp: NOW,
      attachments: [],
      metadata: {},
    } satisfies NormalizedMessage;
    const planned = planInboundMessageProvenance(inbound, NOW);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(appendInboundMessageProvenance(sessionManager, planned.value).ok).toBe(true);
    sessionManager.appendMessage(rawUser as never);
    sessionManager.appendMessage(rawHistory[1] as never);
    const projection = projectInboundConversation(sessionManager);
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;

    const result = await ingestProjectedConversationHistory({
      store,
      scope: SCOPE,
      sourceMessages: projection.value.sourceMessages,
      projectedMessages: projection.value.messages,
      now: NOW + 2,
      logger,
    });

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      mode: "replaced_dirty_epoch",
      deletedMessages: 2,
    });
    const rows = store.getMessages(SCOPE);
    expect(rows).toHaveLength(2);
    expect(messageText(partsToMessage(rows[0]!) as AgentMessage)).toBe(
      "[telegram] sender-a (2026-09-10T00:26:40.100Z):\nswitch back",
    );
    expect(messageText(partsToMessage(rows[0]!) as AgentMessage)).not.toContain(
      "System context",
    );
    expect(store.getIngestCursor(SCOPE)).toEqual({
      epochAnchor: lcdIngest.messageEpochAnchor(projection.value.messages[0]!),
      ingestedLiveLen: 2,
    });
  });

  it("keeps prior LCD rows when the cursor belongs to an unrelated epoch", async () => {
    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const logger = createMockLogger();
    const unrelated = [
      {
        role: "user",
        content: "an earlier independent epoch",
        timestamp: NOW - 100,
      } as unknown as AgentMessage,
      assistant("earlier answer", NOW - 99),
    ];
    lcdIngest.ingestTurnGuarded(store, SCOPE, unrelated, NOW, logger);
    const source = [{
      role: "user",
      content: "[System context]\ntransient\n[End system context]\nnew epoch",
      timestamp: NOW,
    } as unknown as AgentMessage];
    const projected = [{
      role: "user",
      content: "[telegram] sender-a (2026-09-10T00:26:40.100Z):\nnew epoch",
      timestamp: NOW,
    } as unknown as AgentMessage];

    const result = await ingestProjectedConversationHistory({
      store,
      scope: SCOPE,
      sourceMessages: source,
      projectedMessages: projected,
      now: NOW + 1,
      logger,
    });

    expect(result.ok).toBe(true);
    expect(result.value.mode).toBe("steady");
    expect(result.value.deletedMessages).toBe(0);
    expect(store.getMessages(SCOPE)).toHaveLength(3);
  });

  it("replaces a rendered epoch hidden behind the same compaction prefix only once", async () => {
    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const logger = createMockLogger();
    const compactedPrefix = {
      role: "compactionSummary",
      content: "bounded summary",
      timestamp: NOW - 10,
    } as unknown as AgentMessage;
    const rawUser = {
      role: "user",
      content:
        "[System context]\ntransient\n[End system context]\n\n"
        + "[telegram] sender-a (5:00 PM):\ncurrent request",
      timestamp: NOW,
    } as unknown as AgentMessage;
    const generatedRepair = {
      role: "user",
      content: "<response-locale-repair locale=\"und-Latn\">rewrite</response-locale-repair>",
      timestamp: NOW + 2,
    } as unknown as AgentMessage;
    const sourceMessages = [
      compactedPrefix,
      rawUser,
      assistant("draft", NOW + 1),
      generatedRepair,
      assistant("repair", NOW + 3),
    ];
    const projectedMessages = [
      compactedPrefix,
      {
        ...rawUser,
        content:
          "[telegram] sender-a (2026-09-10T00:26:40.100Z):\ncurrent request",
      } as AgentMessage,
      assistant("draft", NOW + 1),
    ];
    lcdIngest.ingestTurnGuarded(
      store,
      SCOPE,
      sourceMessages,
      NOW,
      logger,
    );

    const first = await ingestProjectedConversationHistory({
      store,
      scope: SCOPE,
      sourceMessages,
      projectedMessages,
      now: NOW + 4,
      logger,
    });
    const second = await ingestProjectedConversationHistory({
      store,
      scope: SCOPE,
      sourceMessages,
      projectedMessages,
      now: NOW + 5,
      logger,
    });

    expect(first).toEqual({
      ok: true,
      value: { mode: "replaced_dirty_epoch", deletedMessages: 5 },
    });
    expect(second).toEqual({
      ok: true,
      value: { mode: "steady", deletedMessages: 0 },
    });
    expect(store.getMessages(SCOPE)).toHaveLength(3);
    expect(store.getIngestCursor(SCOPE)?.epochAnchor).toMatch(
      /^projected-conversation-v1:/,
    );
  });
});
