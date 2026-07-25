// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the complete-conversation-reset factory: a DAG conversation
 * survived every existing "forget" surface because `session.reset_conversation`
 * skipped the runtime layer (resurrection via lcd-ingest epoch rebase) while
 * `/new`//`/reset` skipped the LCD layer (old context items re-presented).
 *
 * Pins:
 *   - destroyConversationCompletely clears ALL THREE layers and reports
 *     per-layer counts (lcd rows, session messages, runtime destroyed)
 *   - LCD delete runs INSIDE runOnConversation (serialized vs live ingest)
 *   - sessionStore cleared with [] + original metadata preserved
 *   - absent layers degrade to honest zeros/false with WARN — never throw
 *   - a failing layer never undoes the others (best-effort isolation)
 *   - destroyRuntimeSession parses the formatted key and destroys via the
 *     agent's adapter; unparseable key → false + WARN, no throw
 *   - missing adapter for the agent → false + WARN naming the resurrection
 *     consequence
 *
 * Use-case shape: operator or user asks the platform to forget a
 * conversation; the system either fully severs it or says honestly which
 * layer survived.
 */

import { describe, it, expect, vi } from "vitest";
import { createConversationReset } from "./conversation-reset.js";
import type { ConversationResetDeps, ResetRuntimeAdapter } from "./conversation-reset.js";
import { createConversationRef, formatSessionKey, type ConversationScope, type SessionKey } from "@comis/core";
import { ok } from "@comis/shared";

const KEY: SessionKey = { tenantId: "t1", agentId: "agent-a", userId: "u1", channelId: "c1" };
const SCOPE: ConversationScope = {
  tenantId: "t1",
  agentId: "agent-a",
  partition: { kind: "principal", principalId: "u1" },
};
const conversationRef = createConversationRef(SCOPE);
if (!conversationRef.ok) throw conversationRef.error;
const CONVERSATION_REF = conversationRef.value;
const FORMATTED = formatSessionKey(KEY);

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function makeLcdStore(deleteCount = 7) {
  return {
    runOnConversation: vi.fn().mockImplementation(
      async (_id: string, fn: () => unknown) => fn(),
    ),
    deleteConversationLcd: vi.fn().mockReturnValue(deleteCount),
  };
}

function makeSessionStore(messages: unknown[] = [{ role: "user" }, { role: "assistant" }]) {
  const metadata = { channelType: "openai" };
  return {
    load: vi.fn(() => ok({ messages, metadata })),
    save: vi.fn(() => ok(undefined)),
    metadata,
  };
}

function makeAdapter(): ResetRuntimeAdapter & { destroySession: ReturnType<typeof vi.fn> } {
  return { destroySession: vi.fn().mockResolvedValue(undefined) };
}

function makeDeps(overrides: Partial<ConversationResetDeps> = {}): ConversationResetDeps & { logger: ReturnType<typeof makeLogger> } {
  const logger = makeLogger();
  return { logger, ...overrides } as ConversationResetDeps & { logger: ReturnType<typeof makeLogger> };
}

describe("user asks the platform to completely forget a conversation", () => {
  it("severs all three transcript layers and reports per-layer counts", async () => {
    const lcdStore = makeLcdStore(7);
    const sessionStore = makeSessionStore();
    const adapter = makeAdapter();
    const deps = makeDeps({
      lcdStore,
      sessionStore,
      piSessionAdapters: new Map([["agent-a", adapter]]),
    });

    const reset = createConversationReset(deps);
    const result = await reset.destroyConversationCompletely(SCOPE, KEY);

    expect(result).toEqual({ lcdRowsDeleted: 7, sessionMessagesCleared: 2, runtimeSessionDestroyed: true });
    expect(adapter.destroySession).toHaveBeenCalledWith(KEY);
  });

  it("runs the LCD delete inside runOnConversation with the full scope", async () => {
    const lcdStore = makeLcdStore();
    const deps = makeDeps({ lcdStore });

    await createConversationReset(deps).destroyConversationCompletely(SCOPE, KEY);

    expect(lcdStore.runOnConversation).toHaveBeenCalledWith(CONVERSATION_REF, expect.any(Function));
    expect(lcdStore.deleteConversationLcd).toHaveBeenCalledWith({
      conversationRef: CONVERSATION_REF,
      agentId: "agent-a",
      tenantId: "t1",
      sessionKey: FORMATTED,
    });
  });

  it("clears the session transcript to [] while preserving metadata", async () => {
    const sessionStore = makeSessionStore();
    const deps = makeDeps({ sessionStore });

    await createConversationReset(deps).destroyConversationCompletely(SCOPE, KEY);

    expect(sessionStore.save).toHaveBeenCalledWith(SCOPE, [], sessionStore.metadata);
  });

  it("degrades to honest zeros/false when no layer is wired — never throws", async () => {
    const deps = makeDeps();

    const result = await createConversationReset(deps).destroyConversationCompletely(SCOPE, KEY);

    expect(result).toEqual({ lcdRowsDeleted: 0, sessionMessagesCleared: 0, runtimeSessionDestroyed: false });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.stringContaining("resurrect") }),
      expect.stringContaining("runtime layer unavailable"),
    );
  });

  // A reset that clears 0 across all three layers is almost always a
  // session_key-format mismatch (the LCD is keyed by the formatted key, not the
  // trajectory-filename "<chat>~peer~<chat>" form). Surface it as a WARN naming
  // the formatted key instead of a silent 0-count info line.
  it("WARNs with the formatted-key hint when the reset clears NOTHING across all layers", async () => {
    const deps = makeDeps({ lcdStore: makeLcdStore(0), sessionStore: makeSessionStore([]) });

    const result = await createConversationReset(deps).destroyConversationCompletely(SCOPE, KEY);

    expect(result).toEqual({ lcdRowsDeleted: 0, sessionMessagesCleared: 0, runtimeSessionDestroyed: false });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "validation",
        hint: expect.stringContaining("lcd_messages.session_key"),
      }),
      expect.stringContaining("no-op"),
    );
    // The silent 0-count info line must NOT fire for a no-op reset.
    expect(deps.logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Conversation reset (complete three-layer forget)",
    );
  });

  it("logs info (not the no-op WARN) when a real clear happened", async () => {
    const adapter = makeAdapter();
    const deps = makeDeps({
      lcdStore: makeLcdStore(7),
      sessionStore: makeSessionStore(),
      piSessionAdapters: new Map([["agent-a", adapter]]),
    });

    await createConversationReset(deps).destroyConversationCompletely(SCOPE, KEY);

    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.anything(),
      "Conversation reset (complete three-layer forget)",
    );
    expect(deps.logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "validation" }),
      expect.anything(),
    );
  });

  it("a failing LCD layer does not undo the runtime destroy (best-effort isolation)", async () => {
    const lcdStore = {
      runOnConversation: vi.fn().mockRejectedValue(new Error("db locked")),
      deleteConversationLcd: vi.fn(),
    };
    const adapter = makeAdapter();
    const deps = makeDeps({ lcdStore, piSessionAdapters: new Map([["agent-a", adapter]]) });

    const result = await createConversationReset(deps).destroyConversationCompletely(SCOPE, KEY);

    expect(result.lcdRowsDeleted).toBe(0);
    expect(result.runtimeSessionDestroyed).toBe(true);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency" }),
      "Conversation reset: LCD layer failed",
    );
  });

  it("a failing runtime destroy reports false and warns with the resurrection consequence", async () => {
    const adapter = { destroySession: vi.fn().mockRejectedValue(new Error("fs error")) };
    const deps = makeDeps({ piSessionAdapters: new Map([["agent-a", adapter]]) });

    const result = await createConversationReset(deps).destroyConversationCompletely(SCOPE, KEY);

    expect(result.runtimeSessionDestroyed).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.stringContaining("resurrect") }),
      "Conversation reset: runtime destroy failed",
    );
  });
});

describe("session.reset_conversation severs the runtime layer it used to skip", () => {
  it("passes explicit conversation and display authority to the runtime adapter", async () => {
    const adapter = makeAdapter();
    const deps = makeDeps({ piSessionAdapters: new Map([["agent-a", adapter]]) });

    const destroyed = await createConversationReset(deps).destroyRuntimeSession(SCOPE, KEY);

    expect(destroyed).toBe(true);
    expect(adapter.destroySession).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", userId: "u1", channelId: "c1" }),
    );
  });

  it("does not reconstruct authority from the display key", async () => {
    const adapter = makeAdapter();
    const deps = makeDeps({ piSessionAdapters: new Map([["agent-a", adapter]]) });
    const colonBearingKey = { ...KEY, channelId: "nested:conversation" };

    const destroyed = await createConversationReset(deps).destroyRuntimeSession(SCOPE, colonBearingKey);

    expect(destroyed).toBe(true);
    expect(adapter.destroySession).toHaveBeenCalledWith(colonBearingKey);
  });

  it("a missing adapter for the agent degrades to false + WARN naming the consequence", async () => {
    const deps = makeDeps({ piSessionAdapters: new Map() });
    const ghostScope = { ...SCOPE, agentId: "ghost-agent" };
    const ghostKey = { ...KEY, agentId: "ghost-agent" };

    const destroyed = await createConversationReset(deps).destroyRuntimeSession(ghostScope, ghostKey);

    expect(destroyed).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.stringContaining("resurrect") }),
      "Conversation reset: runtime layer unavailable",
    );
  });
});
