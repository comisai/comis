// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the session-archive RPC handlers:
 *   - session.delete (admin-gated, transcript archive)
 *   - session.reset (message clear, metadata preserved)
 *   - session.export (admin-gated, full payload dump)
 *   - session.reset_conversation (admin-gated, COMPLETE cross-mode forget — Phase 164-06)
 *     Replaces the Phase 164-03 context.reset_lcd which was LCD-only.
 *
 * Tests for session.reset_conversation cover:
 *   H1: non-admin caller is rejected (defense-in-depth)
 *   H1b: caller with no _trustLevel is also rejected
 *   H2: missing session_key is rejected
 *   H3: absent deps.lcdStore fails-closed with explicit error
 *   H4: dag case — sessionStore populated + LCD populated → both cleared, counts returned
 *   H4b: deleteConversationLcd is called inside runOnConversation (scope threaded correctly)
 *   H4c: sessionStore saveByFormattedKey called with empty messages ([] + original metadata)
 *   H5: pipeline case — sessionStore populated, LCD returns 0 (no LCD rows) → session cleared, lcdRowsDeleted:0, no throw
 *   H6: absent session case — LCD rows exist, no session in store → LCD cleared, sessionMessagesCleared:0, no throw
 *   H7: --memory flag accepted; memoriesDeleted OMITTED (not-implemented); WARN logged
 *   H7b: --memory omitted; memoriesDeleted is OMITTED
 *   H8: approvalGate.clearApprovalCache called with sessionKey after both clears
 *   H9: response includes both lcdRowsDeleted and sessionMessagesCleared
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { bindSessionArchiveHandlers } from "./session-archive.js";
import type { SessionHandlerDeps } from "./session-helpers.js";
import type { ContextStorePort } from "@comis/core";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SESSION_KEY = "tenant1:user1:chan1";

/** Minimal logger stub — every handler reads logger.info or logger.warn. */
function makeLogger(): SessionHandlerDeps["logger"] {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as SessionHandlerDeps["logger"];
}

/** Minimal session store stub. */
function makeSessionStore(): SessionHandlerDeps["sessionStore"] {
  return {
    listDetailed: vi.fn().mockReturnValue([]),
    loadByFormattedKey: vi.fn().mockReturnValue({
      messages: [{ role: "user", content: "hi" }],
      metadata: {},
      createdAt: 0,
      updatedAt: 0,
    }),
    deleteByFormattedKey: vi.fn().mockReturnValue(true),
    saveByFormattedKey: vi.fn(),
  };
}

/** Minimal lcdStore stub that returns `deleteCount` for deleteConversationLcd. */
function makeLcdStore(deleteCount = 5): ContextStorePort {
  return {
    append: vi.fn(),
    getMessages: vi.fn().mockReturnValue([]),
    appendLeafSummary: vi.fn().mockReturnValue("sum-1"),
    appendCondensedSummary: vi.fn().mockReturnValue("sum-2"),
    getContextItems: vi.fn().mockReturnValue([]),
    getSummaries: vi.fn().mockReturnValue([]),
    getSummaryChildren: vi.fn().mockReturnValue([]),
    getSummaryMessages: vi.fn().mockReturnValue([]),
    searchLcd: vi.fn().mockReturnValue([]),
    runOnConversation: vi.fn().mockImplementation(
      (_conversationId: string, fn: () => unknown) => Promise.resolve(fn()),
    ),
    getIngestCursor: vi.fn().mockReturnValue(null),
    upsertIngestCursor: vi.fn(),
    deleteConversationLcd: vi.fn().mockReturnValue(deleteCount),
  } as unknown as ContextStorePort;
}

/** Build a minimal SessionHandlerDeps for context.reset_lcd tests. */
function makeDeps(overrides: Partial<SessionHandlerDeps> = {}): SessionHandlerDeps {
  const base: Partial<SessionHandlerDeps> = {
    defaultAgentId: "default",
    agents: { default: { name: "TestAgent", model: "test-model" } as SessionHandlerDeps["agents"][string] },
    costTrackers: new Map(),
    stepCounters: new Map(),
    defaultWorkspaceDir: "",
    sessionStore: makeSessionStore(),
    crossSessionSender: { send: vi.fn() } as never,
    subAgentRunner: { spawn: vi.fn(), getRunStatus: vi.fn() } as never,
    securityConfig: { agentToAgent: { enabled: true, waitTimeoutMs: 5000 } },
    tenantId: "tenant1",
    logger: makeLogger(),
  };
  return { ...base, ...overrides } as SessionHandlerDeps;
}

// ---------------------------------------------------------------------------
// session.reset_conversation tests (Phase 164-06)
// Complete cross-mode forget: clears BOTH LCD store AND daemon sessionStore.
// Replaces the Phase 164-03 context.reset_lcd (LCD-only) handler.
// ---------------------------------------------------------------------------

describe("session.reset_conversation handler", () => {
  it("H1: non-admin caller is rejected with an 'Admin' error", async () => {
    const deps = makeDeps({ lcdStore: makeLcdStore() });
    const handlers = bindSessionArchiveHandlers(deps);

    await expect(
      handlers["session.reset_conversation"]!({
        session_key: SESSION_KEY,
        _trustLevel: "rpc",
      }),
    ).rejects.toThrow(/Admin/i);
  });

  it("H1b: caller with no _trustLevel is also rejected", async () => {
    const deps = makeDeps({ lcdStore: makeLcdStore() });
    const handlers = bindSessionArchiveHandlers(deps);

    await expect(
      handlers["session.reset_conversation"]!({ session_key: SESSION_KEY }),
    ).rejects.toThrow(/Admin/i);
  });

  it("H2: missing session_key throws 'Missing required parameter: session_key'", async () => {
    const deps = makeDeps({ lcdStore: makeLcdStore() });
    const handlers = bindSessionArchiveHandlers(deps);

    await expect(
      handlers["session.reset_conversation"]!({ _trustLevel: "admin" }),
    ).rejects.toThrow("Missing required parameter: session_key");
  });

  it("H3: absent deps.lcdStore fails-closed with explicit error", async () => {
    const deps = makeDeps({ lcdStore: undefined });
    const handlers = bindSessionArchiveHandlers(deps);

    await expect(
      handlers["session.reset_conversation"]!({
        session_key: SESSION_KEY,
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/LCD store not available/i);
  });

  it("H4: dag case — sessionStore and LCD both populated → both cleared, counts returned", async () => {
    const lcdStore = makeLcdStore(5);
    // sessionStore has 3 messages
    const sessionStore = {
      ...makeSessionStore(),
      loadByFormattedKey: vi.fn().mockReturnValue({
        messages: [{ role: "user", content: "msg1" }, { role: "assistant", content: "msg2" }, { role: "user", content: "msg3" }],
        metadata: { someKey: "someVal" },
        createdAt: 1000,
        updatedAt: 2000,
      }),
      saveByFormattedKey: vi.fn(),
    };
    const deps = makeDeps({ lcdStore, sessionStore });
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as { sessionKey: string; lcdRowsDeleted: number; sessionMessagesCleared: number };

    expect(result.sessionKey).toBe(SESSION_KEY);
    expect(result.lcdRowsDeleted).toBe(5);
    expect(result.sessionMessagesCleared).toBe(3);
    expect(lcdStore.deleteConversationLcd).toHaveBeenCalledTimes(1);
  });

  it("H4b: deleteConversationLcd called inside runOnConversation (scope threaded correctly)", async () => {
    const lcdStore = makeLcdStore(5);
    const deps = makeDeps({ lcdStore });
    const handlers = bindSessionArchiveHandlers(deps);

    await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    });

    // runOnConversation MUST have been called (single-flight guard)
    expect(lcdStore.runOnConversation).toHaveBeenCalledTimes(1);
    // The scope passed to deleteConversationLcd must contain all three columns
    const deleteArgs = (lcdStore.deleteConversationLcd as ReturnType<typeof vi.fn>).mock.calls[0] as [{
      conversationId: string;
      agentId: string;
      tenantId: string;
      sessionKey: string;
    }];
    expect(deleteArgs[0].conversationId).toBe(SESSION_KEY);
    expect(deleteArgs[0].agentId).toBe("default");
    expect(deleteArgs[0].tenantId).toBe("tenant1");
    expect(deleteArgs[0].sessionKey).toBe(SESSION_KEY);
  });

  it("H4c: sessionStore.saveByFormattedKey called with empty messages preserving metadata", async () => {
    const lcdStore = makeLcdStore(2);
    const originalMetadata = { someKey: "someVal", agentId: "default" };
    const sessionStore = {
      ...makeSessionStore(),
      loadByFormattedKey: vi.fn().mockReturnValue({
        messages: [{ role: "user", content: "hi" }],
        metadata: originalMetadata,
        createdAt: 1000,
        updatedAt: 2000,
      }),
      saveByFormattedKey: vi.fn(),
    };
    const deps = makeDeps({ lcdStore, sessionStore });
    const handlers = bindSessionArchiveHandlers(deps);

    await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    });

    // MUST have been called with empty messages array and original metadata
    expect(sessionStore.saveByFormattedKey).toHaveBeenCalledTimes(1);
    const [calledKey, calledMessages, calledMeta] =
      (sessionStore.saveByFormattedKey as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[], Record<string, unknown>];
    expect(calledKey).toBe(SESSION_KEY);
    expect(calledMessages).toEqual([]);
    expect(calledMeta).toEqual(originalMetadata);
  });

  it("H5: pipeline case — sessionStore populated, LCD returns 0 → session cleared, no throw", async () => {
    // Pipeline mode: LCD is empty (lcdRowsDeleted = 0) but sessionStore has messages
    const lcdStore = makeLcdStore(0);
    const sessionStore = {
      ...makeSessionStore(),
      loadByFormattedKey: vi.fn().mockReturnValue({
        messages: [{ role: "user", content: "pipeline msg" }],
        metadata: { mode: "pipeline" },
        createdAt: 1000,
        updatedAt: 2000,
      }),
      saveByFormattedKey: vi.fn(),
    };
    const deps = makeDeps({ lcdStore, sessionStore });
    const handlers = bindSessionArchiveHandlers(deps);

    // Must not throw even though LCD rows = 0
    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as { sessionKey: string; lcdRowsDeleted: number; sessionMessagesCleared: number };

    expect(result.lcdRowsDeleted).toBe(0);
    expect(result.sessionMessagesCleared).toBe(1);
    expect(sessionStore.saveByFormattedKey).toHaveBeenCalledTimes(1);
  });

  it("H6: absent session case — LCD rows exist, no session in store → LCD cleared, sessionMessagesCleared:0, no throw", async () => {
    // dag conversation has LCD rows but no live session entry (e.g., session was deleted)
    const lcdStore = makeLcdStore(8);
    const sessionStore = {
      ...makeSessionStore(),
      loadByFormattedKey: vi.fn().mockReturnValue(undefined), // no session
      saveByFormattedKey: vi.fn(),
    };
    const deps = makeDeps({ lcdStore, sessionStore });
    const handlers = bindSessionArchiveHandlers(deps);

    // Must not throw when session is absent
    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as { sessionKey: string; lcdRowsDeleted: number; sessionMessagesCleared: number };

    expect(result.lcdRowsDeleted).toBe(8);
    expect(result.sessionMessagesCleared).toBe(0);
    // saveByFormattedKey must NOT have been called (no session to clear)
    expect(sessionStore.saveByFormattedKey).not.toHaveBeenCalled();
  });

  it("H7: --memory flag accepted; memoriesDeleted OMITTED (not-implemented); WARN emitted", async () => {
    const lcdStore = makeLcdStore(5);
    const deps = makeDeps({ lcdStore });
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      memory: true,
      _trustLevel: "admin",
    })) as { sessionKey: string; lcdRowsDeleted: number; sessionMessagesCleared: number; memoriesDeleted?: number };

    expect(result.lcdRowsDeleted).toBe(5);
    expect(result.memoriesDeleted).toBeUndefined();
    const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    const warnArg = warnCalls[0][0] as Record<string, unknown>;
    expect(warnArg["errorKind"]).toBe("precondition");
    expect(String(warnArg["hint"] ?? "")).toMatch(/not yet implemented|deferred/i);
  });

  it("H7b: --memory omitted; memoriesDeleted is OMITTED", async () => {
    const lcdStore = makeLcdStore(3);
    const deps = makeDeps({ lcdStore });
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as { sessionKey: string; lcdRowsDeleted: number; sessionMessagesCleared: number; memoriesDeleted?: number };

    expect(result.lcdRowsDeleted).toBe(3);
    expect(result.memoriesDeleted).toBeUndefined();
  });

  it("H8: approvalGate.clearApprovalCache called with sessionKey after both clears", async () => {
    const lcdStore = makeLcdStore(2);
    const approvalGate = { clearApprovalCache: vi.fn() };
    const deps = makeDeps({ lcdStore, approvalGate } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    });

    expect(approvalGate.clearApprovalCache).toHaveBeenCalledTimes(1);
    expect(approvalGate.clearApprovalCache).toHaveBeenCalledWith(SESSION_KEY);
  });

  it("H9: response includes both lcdRowsDeleted and sessionMessagesCleared", async () => {
    const lcdStore = makeLcdStore(7);
    const sessionStore = {
      ...makeSessionStore(),
      loadByFormattedKey: vi.fn().mockReturnValue({
        messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
        metadata: {},
        createdAt: 0,
        updatedAt: 0,
      }),
      saveByFormattedKey: vi.fn(),
    };
    const deps = makeDeps({ lcdStore, sessionStore });
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as Record<string, unknown>;

    expect(result["lcdRowsDeleted"]).toBe(7);
    expect(result["sessionMessagesCleared"]).toBe(2);
    expect(result["sessionKey"]).toBe(SESSION_KEY);
  });
});
