// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the session-archive RPC handlers:
 *   - session.delete (admin-gated, transcript archive)
 *   - session.reset (message clear, metadata preserved)
 *   - session.export (admin-gated, full payload dump)
 *   - session.reset_conversation (admin-gated, COMPLETE cross-mode forget —
 *     clears the LCD store AND the daemon sessionStore, not just the LCD)
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
 *   H7: --memory with memoryPort absent; memoriesDeleted OMITTED; WARN logged
 *   H7b: --memory omitted; memoriesDeleted is OMITTED
 *   H8: approvalGate.clearApprovalCache called with sessionKey after both clears
 *   H9: response includes both lcdRowsDeleted and sessionMessagesCleared
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@comis/shared";
import { bindSessionArchiveHandlers } from "./session-archive.js";
import type { SessionHandlerDeps } from "./session-helpers.js";
import type { ContextStorePort, MemoryPort, MemoryConsolidationStore } from "@comis/core";

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
    searchLcd: vi.fn().mockReturnValue({ hits: [], cjkZeroHit: false, lane: "word", matchErrored: false }),
    runOnConversation: vi.fn().mockImplementation(
      (_conversationId: string, fn: () => unknown) => Promise.resolve(fn()),
    ),
    getIngestCursor: vi.fn().mockReturnValue(null),
    upsertIngestCursor: vi.fn(),
    deleteConversationLcd: vi.fn().mockReturnValue(deleteCount),
  } as unknown as ContextStorePort;
}

/** Minimal MemoryPort stub for the --memory reset. deleteBySessionKey
 *  returns ok(deletedCount); listMemoryIdsBySessionKey returns the given ids
 *  (captured BEFORE the delete so the purge is session-scoped). */
function makeMemoryPort(deletedCount = 2, sessionIds: string[] = ["mem-this-1", "mem-this-2"]): MemoryPort {
  return {
    store: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
    listMemoryIdsBySessionKey: vi.fn().mockResolvedValue(ok(sessionIds)),
    deleteBySessionKey: vi.fn().mockResolvedValue(ok(deletedCount)),
  } as unknown as MemoryPort;
}

/** Minimal MemoryConsolidationStore stub for the unlink/purge steps (only the
 *  live surface — the dead consolidation-cron writer methods were removed). */
function makeConsolidationStore(): MemoryConsolidationStore {
  return {
    listObservations: vi.fn(),
    unlinkDeletedSources: vi.fn().mockResolvedValue(ok(0)),
    purgeConsolidatedDerivedFrom: vi.fn().mockResolvedValue(ok(0)),
  } as unknown as MemoryConsolidationStore;
}

/** Build a minimal SessionHandlerDeps for session.reset_conversation tests. */
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
// session.reset_conversation tests
// Complete cross-mode forget: clears BOTH LCD store AND daemon sessionStore
// (an LCD-only reset would leave the daemon transcript to resurrect the chat).
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

  it("explicit agentId scopes the LCD delete to that agent, not the default", async () => {
    // Live finding 2026-06-13: resetting a non-default agent's conversation returned
    // lcdRowsDeleted:0 because the scope hardcoded deps.defaultAgentId — the delete
    // looked under the wrong agent. An admin-supplied agentId selects the scope.
    const lcdStore = makeLcdStore();
    const deps = makeDeps({ lcdStore });
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      agentId: "agent-b",
      _trustLevel: "admin",
    })) as { resolvedAgentId?: string };

    const call = (lcdStore.deleteConversationLcd as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      agentId: string;
    };
    expect(call.agentId).toBe("agent-b");
    expect(result.resolvedAgentId).toBe("agent-b");
  });

  it("absent agentId falls back to the default and states it in the response", async () => {
    const deps = makeDeps({ lcdStore: makeLcdStore() });
    const handlers = bindSessionArchiveHandlers(deps);
    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as { resolvedAgentId?: string };
    expect(result.resolvedAgentId).toBe("default");
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

  // Executor session-scoped state (tool-schema snapshots, the grammar
  // strip-retry once-gate, JIT-guide delivery, cache latches) would survive a
  // conversation reset if the reset handler only cleared LCD + sessionStore.
  // The reused session key then inherits the OLD gate/snapshots — a reset
  // session got ZERO strip-retries and terminal-failed its first grammar-400.
  // The handler must drop the agent-side state through the injected single
  // authoritative cleanup path.
  it("reset_conversation clears executor session-scoped state via clearAgentSessionState (strip once-gate re-arms)", async () => {
    const clearAgentSessionState = vi.fn();
    const deps = makeDeps({ lcdStore: makeLcdStore(1), clearAgentSessionState });
    const handlers = bindSessionArchiveHandlers(deps);

    await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    });

    expect(clearAgentSessionState).toHaveBeenCalledWith(SESSION_KEY);
  });

  it("session.delete (session destroy) also clears executor session-scoped state for the key", async () => {
    const clearAgentSessionState = vi.fn();
    const deps = makeDeps({ lcdStore: makeLcdStore(1), clearAgentSessionState });
    const handlers = bindSessionArchiveHandlers(deps);

    await handlers["session.delete"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    });

    expect(clearAgentSessionState).toHaveBeenCalledWith(SESSION_KEY);
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

  it("H7: --memory but memoryPort ABSENT → graceful-degrade WARN, memoriesDeleted OMITTED", async () => {
    // When memoryPort is NOT wired into deps (deployment doesn't support
    // it), --memory must NOT throw — it logs a precondition WARN and leaves
    // memoriesDeleted off the result (LCD + sessionStore are still cleared).
    const lcdStore = makeLcdStore(5);
    const deps = makeDeps({ lcdStore }); // no memoryPort
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
    // The runtime-layer (L3) not-wired WARN also fires in this deps shape —
    // find the memoryPort warn by content rather than call order.
    const memoryWarn = warnCalls
      .map((c) => c[0] as Record<string, unknown>)
      .find((a) => /memoryPort not available|--memory flag ignored/i.test(String(a["hint"] ?? "")));
    expect(memoryWarn).toBeDefined();
    expect(memoryWarn!["errorKind"]).toBe("precondition");
  });

  it("H7b: --memory omitted; memoriesDeleted is OMITTED (stub not reached)", async () => {
    const lcdStore = makeLcdStore(3);
    const deps = makeDeps({ lcdStore, memoryPort: makeMemoryPort() } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as { sessionKey: string; lcdRowsDeleted: number; sessionMessagesCleared: number; memoriesDeleted?: number };

    expect(result.lcdRowsDeleted).toBe(3);
    expect(result.memoriesDeleted).toBeUndefined();
    // --memory omitted → deleteBySessionKey NOT reached.
    expect((deps.memoryPort!.deleteBySessionKey as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// session.reset_conversation --memory HONEST reset. --memory deletes the
// RAG-memory rows by source_session_key (BOTH paired-conversation AND
// lcd-distilled episodic memories — one query covers both) and unlinks them
// from consolidated observations (orphan→delete, multi-source→keep).
// --purge-derived is a separate, opt-in nuclear escalation.
// ---------------------------------------------------------------------------

describe("session.reset_conversation --memory", () => {
  it("memory:true → deleteBySessionKey called with (sessionKey, {tenantId, agentId})", async () => {
    const memoryPort = makeMemoryPort(2);
    const deps = makeDeps({ lcdStore: makeLcdStore(5), memoryPort } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      memory: true,
      _trustLevel: "admin",
    });

    expect(memoryPort.deleteBySessionKey).toHaveBeenCalledTimes(1);
    const callArgs = (memoryPort.deleteBySessionKey as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { tenantId: string; agentId: string },
    ];
    expect(callArgs[0]).toBe(SESSION_KEY);
    expect(callArgs[1].tenantId).toBe("tenant1");
    expect(callArgs[1].agentId).toBe("default");
  });

  it("deleteBySessionKey returns 2 → result.memoriesDeleted === 2 (field present)", async () => {
    const deps = makeDeps({
      lcdStore: makeLcdStore(5),
      memoryPort: makeMemoryPort(2),
    } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      memory: true,
      _trustLevel: "admin",
    })) as { memoriesDeleted?: number };

    expect(result.memoriesDeleted).toBe(2);
  });

  it("deleteBySessionKey returns 0 → result.memoriesDeleted === 0 (no error)", async () => {
    const deps = makeDeps({
      lcdStore: makeLcdStore(5),
      memoryPort: makeMemoryPort(0),
    } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      memory: true,
      _trustLevel: "admin",
    })) as { memoriesDeleted?: number };

    expect(result.memoriesDeleted).toBe(0);
  });

  it("purge_derived:false (default) → purgeConsolidatedDerivedFrom NOT called", async () => {
    const consolidationStore = makeConsolidationStore();
    const deps = makeDeps({
      lcdStore: makeLcdStore(5),
      memoryPort: makeMemoryPort(2),
      consolidationStore,
    } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      memory: true,
      _trustLevel: "admin",
    });

    expect(consolidationStore.purgeConsolidatedDerivedFrom).not.toHaveBeenCalled();
  });

  it("purge_derived:true → purgeConsolidatedDerivedFrom called with (sessionKey, tenantId, agentId, thisSessionIds)", async () => {
    const consolidationStore = makeConsolidationStore();
    // The ids are captured BEFORE the delete: purge must receive THEM, not
    // re-derive "any dangling source id".
    const memoryPort = makeMemoryPort(2, ["mem-x", "mem-y"]);
    const deps = makeDeps({
      lcdStore: makeLcdStore(5),
      memoryPort,
      consolidationStore,
    } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      memory: true,
      purge_derived: true,
      _trustLevel: "admin",
    });

    // The ids are read BEFORE the destructive delete.
    expect(memoryPort.listMemoryIdsBySessionKey).toHaveBeenCalledTimes(1);
    const listInvokeOrder = (memoryPort.listMemoryIdsBySessionKey as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;
    const deleteInvokeOrder = (memoryPort.deleteBySessionKey as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;
    expect(listInvokeOrder).toBeLessThan(deleteInvokeOrder);

    expect(consolidationStore.purgeConsolidatedDerivedFrom).toHaveBeenCalledTimes(1);
    const callArgs = (consolidationStore.purgeConsolidatedDerivedFrom as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, string, string[]];
    expect(callArgs[0]).toBe(SESSION_KEY);
    expect(callArgs[1]).toBe("tenant1");
    expect(callArgs[2]).toBe("default"); // agentId threaded
    expect(callArgs[3]).toEqual(["mem-x", "mem-y"]); // this-session ids passed
  });

  it("deletedCount>0 → consolidationStore.unlinkDeletedSources called with (sessionKey, tenantId, agentId)", async () => {
    // The unlink step (orphan→delete, multi-source→keep) lives in the
    // consolidation store; the handler delegates to it when memories were deleted.
    const consolidationStore = makeConsolidationStore();
    const deps = makeDeps({
      lcdStore: makeLcdStore(5),
      memoryPort: makeMemoryPort(3),
      consolidationStore,
    } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      memory: true,
      _trustLevel: "admin",
    });

    expect(consolidationStore.unlinkDeletedSources).toHaveBeenCalledTimes(1);
    const callArgs = (consolidationStore.unlinkDeletedSources as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, string];
    expect(callArgs[0]).toBe(SESSION_KEY);
    expect(callArgs[1]).toBe("tenant1");
    expect(callArgs[2]).toBe("default"); // agentId threaded (matches the delete scope)
  });

  it("deletedCount===0 → unlinkDeletedSources NOT called (nothing to unlink)", async () => {
    const consolidationStore = makeConsolidationStore();
    const deps = makeDeps({
      lcdStore: makeLcdStore(5),
      memoryPort: makeMemoryPort(0),
      consolidationStore,
    } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      memory: true,
      _trustLevel: "admin",
    });

    expect(consolidationStore.unlinkDeletedSources).not.toHaveBeenCalled();
  });

  it("deleteBySessionKey err result → non-fatal WARN, LCD reset still succeeds", async () => {
    // A memory-store failure must NOT break the LCD/sessionStore reset that
    // already succeeded — the handler logs a dependency WARN and returns.
    const memoryPort = {
      store: vi.fn(),
      search: vi.fn(),
      delete: vi.fn(),
      deleteBySessionKey: vi.fn().mockResolvedValue(err(new Error("db locked"))),
    } as unknown as MemoryPort;
    const deps = makeDeps({ lcdStore: makeLcdStore(5), memoryPort } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      memory: true,
      _trustLevel: "admin",
    })) as { lcdRowsDeleted: number; memoriesDeleted?: number };

    // LCD reset still reported; memoriesDeleted is 0 (the delete failed).
    expect(result.lcdRowsDeleted).toBe(5);
    expect(result.memoriesDeleted).toBe(0);
    const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const dependencyWarn = warnCalls.find(
      (c) => (c[0] as Record<string, unknown>)["errorKind"] === "dependency",
    );
    expect(dependencyWarn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// session.reset_conversation runtime layer (L3) tests — observed live:
// without the runtime destroy, the surviving pi session JSONL re-ingested
// wholesale on the next turn (lcd-ingest epoch rebase) and the "forgotten"
// conversation resurrected into the DAG.
// ---------------------------------------------------------------------------

describe("session.reset_conversation severs the runtime transcript so the forget cannot resurrect", () => {
  it("destroys the pi runtime session and reports runtimeSessionDestroyed:true", async () => {
    const destroyRuntimeSession = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({ lcdStore: makeLcdStore(5), destroyRuntimeSession } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as { runtimeSessionDestroyed: boolean };

    expect(destroyRuntimeSession).toHaveBeenCalledWith(SESSION_KEY);
    expect(result.runtimeSessionDestroyed).toBe(true);
  });

  it("reports runtimeSessionDestroyed:false when the runtime layer is not wired, with a WARN naming the resurrection consequence", async () => {
    const deps = makeDeps({ lcdStore: makeLcdStore(5) });
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as { runtimeSessionDestroyed: boolean; lcdRowsDeleted: number };

    expect(result.runtimeSessionDestroyed).toBe(false);
    expect(result.lcdRowsDeleted).toBe(5);
    const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const resurrectWarn = warnCalls.find((c) =>
      String((c[0] as Record<string, unknown>)["hint"] ?? "").includes("resurrect"),
    );
    expect(resurrectWarn).toBeDefined();
  });

  it("a failed runtime destroy (false) still preserves the L1/L2 counts in the response", async () => {
    const destroyRuntimeSession = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({ lcdStore: makeLcdStore(9), destroyRuntimeSession } as Partial<SessionHandlerDeps>);
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["session.reset_conversation"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as { runtimeSessionDestroyed: boolean; lcdRowsDeleted: number; sessionMessagesCleared: number };

    expect(result.runtimeSessionDestroyed).toBe(false);
    expect(result.lcdRowsDeleted).toBe(9);
    expect(result.sessionMessagesCleared).toBe(1);
  });
});
