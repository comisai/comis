// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the session-archive RPC handlers:
 *   - session.delete (admin-gated, transcript archive)
 *   - session.reset (message clear, metadata preserved)
 *   - session.export (admin-gated, full payload dump)
 *   - context.reset_lcd (admin-gated, LCD history clear — RR4 / Phase 164-03)
 *
 * Tests for context.reset_lcd cover:
 *   H1: non-admin caller is rejected (T-164-reset-authz defense-in-depth)
 *   H2: missing session_key is rejected
 *   H3: absent deps.lcdStore fails-closed with explicit error (T-164-09)
 *   H4: happy path — mock lcdStore returns 5, handler returns { sessionKey, lcdRowsDeleted: 5 }
 *   H5: --memory flag accepted; memoriesDeleted OMITTED (not-implemented); WARN logged (Phase 164-05 honest-defer)
 *   H5b: --memory omitted; memoriesDeleted is also OMITTED (only returned when RAG clear succeeds)
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
// context.reset_lcd tests (Phase 164-03, RR4)
// ---------------------------------------------------------------------------

describe("context.reset_lcd handler", () => {
  it("H1: non-admin caller is rejected with an 'Admin' error (T-164-reset-authz)", async () => {
    const deps = makeDeps({ lcdStore: makeLcdStore() });
    const handlers = bindSessionArchiveHandlers(deps);

    await expect(
      handlers["context.reset_lcd"]!({
        session_key: SESSION_KEY,
        _trustLevel: "rpc",
      }),
    ).rejects.toThrow(/Admin/i);
  });

  it("H1b: caller with no _trustLevel is also rejected", async () => {
    const deps = makeDeps({ lcdStore: makeLcdStore() });
    const handlers = bindSessionArchiveHandlers(deps);

    await expect(
      handlers["context.reset_lcd"]!({ session_key: SESSION_KEY }),
    ).rejects.toThrow(/Admin/i);
  });

  it("H2: missing session_key throws 'Missing required parameter: session_key'", async () => {
    const deps = makeDeps({ lcdStore: makeLcdStore() });
    const handlers = bindSessionArchiveHandlers(deps);

    await expect(
      handlers["context.reset_lcd"]!({ _trustLevel: "admin" }),
    ).rejects.toThrow("Missing required parameter: session_key");
  });

  it("H3: absent deps.lcdStore fails-closed with explicit error (T-164-09)", async () => {
    const deps = makeDeps({ lcdStore: undefined });
    const handlers = bindSessionArchiveHandlers(deps);

    await expect(
      handlers["context.reset_lcd"]!({
        session_key: SESSION_KEY,
        _trustLevel: "admin",
      }),
    ).rejects.toThrow(/LCD store not available/i);
  });

  it("H4: happy path — returns { sessionKey, lcdRowsDeleted: 5 }", async () => {
    const lcdStore = makeLcdStore(5);
    const deps = makeDeps({ lcdStore });
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["context.reset_lcd"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as { sessionKey: string; lcdRowsDeleted: number };

    expect(result.sessionKey).toBe(SESSION_KEY);
    expect(result.lcdRowsDeleted).toBe(5);
    expect(lcdStore.deleteConversationLcd).toHaveBeenCalledTimes(1);
  });

  it("H4b: deleteConversationLcd is called inside runOnConversation (scope threaded correctly)", async () => {
    const lcdStore = makeLcdStore(5);
    const deps = makeDeps({ lcdStore });
    const handlers = bindSessionArchiveHandlers(deps);

    await handlers["context.reset_lcd"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    });

    // runOnConversation MUST have been called (single-flight guard)
    expect(lcdStore.runOnConversation).toHaveBeenCalledTimes(1);
    // The scope passed to deleteConversationLcd must contain all three columns
    // (T-164-reset-scope: cross-tenant/cross-agent isolation)
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

  it("H5: --memory flag accepted; memoriesDeleted OMITTED (not-implemented) and WARN emitted (Phase 164-05 honest-defer)", async () => {
    const lcdStore = makeLcdStore(5);
    const deps = makeDeps({ lcdStore });
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["context.reset_lcd"]!({
      session_key: SESSION_KEY,
      memory: true,
      _trustLevel: "admin",
    })) as { sessionKey: string; lcdRowsDeleted: number; memoriesDeleted?: number };

    // LCD rows still cleared
    expect(result.lcdRowsDeleted).toBe(5);
    // memoriesDeleted must be OMITTED (undefined), not a misleading 0
    expect(result.memoriesDeleted).toBeUndefined();
    // logger.warn must have been called with errorKind:"precondition" and a hint about deferral
    const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    const warnArg = warnCalls[0][0] as Record<string, unknown>;
    expect(warnArg["errorKind"]).toBe("precondition");
    expect(String(warnArg["hint"] ?? "")).toMatch(/not yet implemented|deferred/i);
  });

  it("H5b: --memory omitted; memoriesDeleted is OMITTED (only set when RAG clear actually runs)", async () => {
    const lcdStore = makeLcdStore(3);
    const deps = makeDeps({ lcdStore });
    const handlers = bindSessionArchiveHandlers(deps);

    const result = (await handlers["context.reset_lcd"]!({
      session_key: SESSION_KEY,
      _trustLevel: "admin",
    })) as { sessionKey: string; lcdRowsDeleted: number; memoriesDeleted?: number };

    expect(result.lcdRowsDeleted).toBe(3);
    // memoriesDeleted should be omitted when --memory is not passed
    expect(result.memoriesDeleted).toBeUndefined();
  });
});
