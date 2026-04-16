import type { SessionKey, HookRunner } from "@comis/core";
import type { SessionStore, SessionData } from "@comis/memory";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createSessionLifecycle } from "./session-lifecycle.js";

// ---------------------------------------------------------------------------
// In-memory fake SessionStore
// ---------------------------------------------------------------------------

interface StoredSession {
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

function createFakeSessionStore(): SessionStore & {
  _sessions: Map<string, StoredSession>;
} {
  const sessions = new Map<string, StoredSession>();

  function keyStr(key: SessionKey): string {
    return `${key.tenantId}:${key.userId}:${key.channelId}`;
  }

  return {
    _sessions: sessions,

    save(key, messages, metadata) {
      const k = keyStr(key);
      const existing = sessions.get(k);
      const now = Date.now();
      sessions.set(k, {
        messages,
        metadata: metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    },

    load(key): SessionData | undefined {
      const k = keyStr(key);
      const s = sessions.get(k);
      if (!s) return undefined;
      return {
        messages: s.messages,
        metadata: s.metadata,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    },

    list(tenantId?) {
      const entries: Array<{ sessionKey: string; updatedAt: number }> = [];
      for (const [k, v] of sessions) {
        if (tenantId === undefined || k.startsWith(tenantId + ":")) {
          entries.push({ sessionKey: k, updatedAt: v.updatedAt });
        }
      }
      return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    delete(key) {
      const k = keyStr(key);
      return sessions.delete(k);
    },

    deleteStale(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let deleted = 0;
      for (const [k, v] of sessions) {
        if (v.updatedAt < cutoff) {
          sessions.delete(k);
          deleted++;
        }
      }
      return deleted;
    },

    loadByFormattedKey(sessionKey: string): SessionData | undefined {
      const s = sessions.get(sessionKey);
      if (!s) return undefined;
      return {
        messages: s.messages,
        metadata: s.metadata,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    },

    listDetailed(tenantId?: string) {
      const entries: Array<{
        sessionKey: string;
        tenantId: string;
        userId: string;
        channelId: string;
        metadata: Record<string, unknown>;
        createdAt: number;
        updatedAt: number;
      }> = [];
      for (const [k, v] of sessions) {
        const parts = k.split(":");
        const tid = parts[0] ?? "";
        if (tenantId === undefined || tid === tenantId) {
          entries.push({
            sessionKey: k,
            tenantId: tid,
            userId: parts[1] ?? "",
            channelId: parts[2] ?? "",
            metadata: v.metadata,
            createdAt: v.createdAt,
            updatedAt: v.updatedAt,
          });
        }
      }
      return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testKey(overrides: Partial<SessionKey> = {}): SessionKey {
  return {
    tenantId: "default",
    userId: "user-1",
    channelId: "chan-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSessionLifecycle", () => {
  let store: ReturnType<typeof createFakeSessionStore>;

  beforeEach(() => {
    store = createFakeSessionStore();
  });

  // ── loadOrCreate ────────────────────────────────────────────────────

  describe("loadOrCreate", () => {
    it("returns empty array for new session (no existing data)", () => {
      const mgr = createSessionLifecycle(store);
      const messages = mgr.loadOrCreate(testKey());
      expect(messages).toEqual([]);
    });

    it("returns existing messages if session exists", () => {
      store.save(testKey(), [{ role: "user", content: "hello" }]);
      const mgr = createSessionLifecycle(store);
      const messages = mgr.loadOrCreate(testKey());
      expect(messages).toEqual([{ role: "user", content: "hello" }]);
    });
  });

  // ── save ────────────────────────────────────────────────────────────

  describe("save", () => {
    it("delegates to sessionStore.save()", () => {
      const mgr = createSessionLifecycle(store);
      const msgs = [{ role: "assistant", content: "hi" }];
      mgr.save(testKey(), msgs);
      const data = store.load(testKey());
      expect(data).toBeDefined();
      expect(data!.messages).toEqual(msgs);
    });

    it("passes metadata through to sessionStore.save()", () => {
      const mgr = createSessionLifecycle(store);
      mgr.save(testKey(), [], { agentId: "agent-1" });
      const data = store.load(testKey());
      expect(data!.metadata).toEqual({ agentId: "agent-1" });
    });
  });

  // ── isExpired ───────────────────────────────────────────────────────

  describe("isExpired", () => {
    it("returns true if session not found", () => {
      const mgr = createSessionLifecycle(store);
      expect(mgr.isExpired(testKey())).toBe(true);
    });

    it("returns true if session updatedAt + idleTimeoutMs < now", () => {
      // Save a session with updatedAt in the past
      store.save(testKey(), []);
      const session = store._sessions.values().next().value!;
      session.updatedAt = Date.now() - 20_000; // 20 seconds ago

      const mgr = createSessionLifecycle(store);
      expect(mgr.isExpired(testKey(), 10_000)).toBe(true); // 10s timeout
    });

    it("returns false if session is recent", () => {
      store.save(testKey(), []);
      const mgr = createSessionLifecycle(store);
      expect(mgr.isExpired(testKey(), 60_000)).toBe(false); // 60s timeout
    });

    it("uses defaultIdleTimeoutMs when no timeout argument provided", () => {
      store.save(testKey(), []);
      // Default is 4 hours = 14_400_000ms. Just-saved session should not be expired.
      const mgr = createSessionLifecycle(store);
      expect(mgr.isExpired(testKey())).toBe(false);
    });

    it("uses custom defaultIdleTimeoutMs from options", () => {
      store.save(testKey(), []);
      const session = store._sessions.values().next().value!;
      session.updatedAt = Date.now() - 5_000; // 5 seconds ago

      const mgr = createSessionLifecycle(store, { defaultIdleTimeoutMs: 3_000 });
      expect(mgr.isExpired(testKey())).toBe(true); // 3s default timeout, 5s old
    });
  });

  // ── expire ──────────────────────────────────────────────────────────

  describe("expire", () => {
    it("deletes the session via sessionStore.delete()", () => {
      store.save(testKey(), [{ role: "user", content: "delete me" }]);
      const mgr = createSessionLifecycle(store);
      const result = mgr.expire(testKey());
      expect(result).toBe(true);
      expect(store.load(testKey())).toBeUndefined();
    });

    it("returns false if session was not found", () => {
      const mgr = createSessionLifecycle(store);
      expect(mgr.expire(testKey())).toBe(false);
    });
  });

  // ── cleanStale ──────────────────────────────────────────────────────

  describe("cleanStale", () => {
    it("delegates to sessionStore.deleteStale()", () => {
      // Create two sessions: one fresh, one stale
      store.save(testKey({ userId: "old" }), []);
      const oldSession = store._sessions.values().next().value!;
      oldSession.updatedAt = Date.now() - 100_000;

      store.save(testKey({ userId: "new" }), []);

      const mgr = createSessionLifecycle(store);
      const deleted = mgr.cleanStale(50_000);
      expect(deleted).toBe(1);
    });

    it("uses defaultIdleTimeoutMs when no maxAgeMs argument provided", () => {
      store.save(testKey(), []);
      const mgr = createSessionLifecycle(store, { defaultIdleTimeoutMs: 14_400_000 });
      // Session is fresh, so nothing should be deleted
      const deleted = mgr.cleanStale();
      expect(deleted).toBe(0);
    });
  });

  // ── Session hook error capture ─────────────────────────────

  describe("session hook error capture", () => {
    function makeHookRunner(overrides?: Partial<HookRunner>): HookRunner {
      return {
        runSessionStart: vi.fn(async () => {}),
        runSessionEnd: vi.fn(async () => {}),
        runBeforeAgentStart: vi.fn(async () => ({})),
        runBeforeToolCall: vi.fn(async () => ({})),
        runAfterToolCall: vi.fn(async () => {}),
        runToolResultPersist: vi.fn(() => ({ result: undefined })),
        runAgentEnd: vi.fn(async () => {}),
        ...overrides,
      } as HookRunner;
    }

    it("logs hook error via logger.debug when session start hook rejects", async () => {
      const hookError = new Error("Hook blew up");
      const hookRunner = makeHookRunner({
        runSessionStart: vi.fn(async () => { throw hookError; }),
      });
      const logger = createMockLogger();
      const mgr = createSessionLifecycle(store, { hookRunner, logger });

      // loadOrCreate for a new session triggers runSessionStart
      mgr.loadOrCreate(testKey());

      // Allow the async .catch() to resolve
      await new Promise((r) => setTimeout(r, 10));

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ err: hookError }),
        "Session start hook error suppressed",
      );
    });

    it("logs hook error via logger.debug when session end hook rejects", async () => {
      const hookError = new Error("End hook failed");
      const hookRunner = makeHookRunner({
        runSessionEnd: vi.fn(async () => { throw hookError; }),
      });
      const logger = createMockLogger();
      store.save(testKey(), [{ role: "user", content: "hi" }]);
      const mgr = createSessionLifecycle(store, { hookRunner, logger });

      // expire triggers runSessionEnd
      mgr.expire(testKey());

      // Allow the async .catch() to resolve
      await new Promise((r) => setTimeout(r, 10));

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ err: hookError }),
        "Session end hook error suppressed",
      );
    });

    it("silently suppresses hook errors when no logger is provided", async () => {
      const hookRunner = makeHookRunner({
        runSessionStart: vi.fn(async () => { throw new Error("Hook blew up"); }),
      });
      // No logger -- backward compatibility: should not crash
      const mgr = createSessionLifecycle(store, { hookRunner });

      // Should not throw
      mgr.loadOrCreate(testKey());

      // Allow the async .catch() to resolve
      await new Promise((r) => setTimeout(r, 10));

      // No assertion needed -- the test passes if no error is thrown
    });
  });
});
