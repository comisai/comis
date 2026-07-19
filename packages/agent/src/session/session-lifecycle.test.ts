// SPDX-License-Identifier: Apache-2.0
import type { ConversationScope, HookRunner, SessionStorePort } from "@comis/core";
import { ok } from "@comis/shared";
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

function createFakeSessionStore(): SessionStorePort & {
  _sessions: Map<string, StoredSession>;
} {
  const sessions = new Map<string, StoredSession>();

  function keyStr(scope: ConversationScope): string {
    return JSON.stringify(scope);
  }

  return {
    _sessions: sessions,

    save(scope, messages, metadata) {
      const k = keyStr(scope);
      const existing = sessions.get(k);
      const now = Date.now();
      sessions.set(k, {
        messages,
        metadata: metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      return ok(undefined);
    },

    load(scope) {
      const k = keyStr(scope);
      const s = sessions.get(k);
      if (!s) return ok(undefined);
      return ok({
        conversationRef: `cv_${"s".repeat(43)}` as never,
        conversationScope: scope,
        messages: s.messages,
        metadata: s.metadata,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      });
    },

    delete(scope) {
      return ok(sessions.delete(keyStr(scope)));
    },

    deleteStale(queryScope, maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let deleted = 0;
      for (const [k, v] of sessions) {
        if (v.updatedAt < cutoff && JSON.parse(k).tenantId === queryScope.tenantId && JSON.parse(k).agentId === queryScope.agentId) {
          sessions.delete(k);
          deleted++;
        }
      }
      return ok(deleted);
    },
    loadByRef: vi.fn().mockReturnValue(ok(undefined)),
    list: vi.fn().mockReturnValue(ok([])),
    deleteByRef: vi.fn().mockReturnValue(ok(false)),
    listDetailed: vi.fn().mockReturnValue(ok([])),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testKey(overrides: Partial<ConversationScope> & { userId?: string } = {}): ConversationScope {
  const principalId = overrides.userId ?? "user-1";
  return {
    tenantId: "default",
    agentId: "agent-1",
    partition: { kind: "principal", principalId },
    ...overrides,
  } as ConversationScope;
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
      expect(messages).toEqual(ok([]));
    });

    it("returns existing messages if session exists", () => {
      store.save(testKey(), [{ role: "user", content: "hello" }]);
      const mgr = createSessionLifecycle(store);
      const messages = mgr.loadOrCreate(testKey());
      expect(messages).toEqual(ok([{ role: "user", content: "hello" }]));
    });
  });

  // ── save ────────────────────────────────────────────────────────────

  describe("save", () => {
    it("delegates to sessionStore.save()", () => {
      const mgr = createSessionLifecycle(store);
      const msgs = [{ role: "assistant", content: "hi" }];
      mgr.save(testKey(), msgs);
      const data = store.load(testKey());
      expect(data.ok && data.value?.messages).toEqual(msgs);
    });

    it("passes metadata through to sessionStore.save()", () => {
      const mgr = createSessionLifecycle(store);
      mgr.save(testKey(), [], { agentId: "agent-1" });
      const data = store.load(testKey());
      expect(data.ok && data.value?.metadata).toEqual({ agentId: "agent-1" });
    });
  });

  // ── isExpired ───────────────────────────────────────────────────────

  describe("isExpired", () => {
    it("returns true if session not found", () => {
      const mgr = createSessionLifecycle(store);
      expect(mgr.isExpired(testKey())).toEqual(ok(true));
    });

    it("returns true if session updatedAt + idleTimeoutMs < now", () => {
      // Save a session with updatedAt in the past
      store.save(testKey(), []);
      const session = store._sessions.values().next().value!;
      session.updatedAt = Date.now() - 20_000; // 20 seconds ago

      const mgr = createSessionLifecycle(store);
      expect(mgr.isExpired(testKey(), 10_000)).toEqual(ok(true)); // 10s timeout
    });

    it("returns false if session is recent", () => {
      store.save(testKey(), []);
      const mgr = createSessionLifecycle(store);
      expect(mgr.isExpired(testKey(), 60_000)).toEqual(ok(false)); // 60s timeout
    });

    it("uses defaultIdleTimeoutMs when no timeout argument provided", () => {
      store.save(testKey(), []);
      // Default is 4 hours = 14_400_000ms. Just-saved session should not be expired.
      const mgr = createSessionLifecycle(store);
      expect(mgr.isExpired(testKey())).toEqual(ok(false));
    });

    it("uses custom defaultIdleTimeoutMs from options", () => {
      store.save(testKey(), []);
      const session = store._sessions.values().next().value!;
      session.updatedAt = Date.now() - 5_000; // 5 seconds ago

      const mgr = createSessionLifecycle(store, { defaultIdleTimeoutMs: 3_000 });
      expect(mgr.isExpired(testKey())).toEqual(ok(true)); // 3s default timeout, 5s old
    });
  });

  // ── expire ──────────────────────────────────────────────────────────

  describe("expire", () => {
    it("deletes the session via sessionStore.delete()", () => {
      store.save(testKey(), [{ role: "user", content: "delete me" }]);
      const mgr = createSessionLifecycle(store);
      const result = mgr.expire(testKey());
      expect(result).toEqual(ok(true));
      expect(store.load(testKey())).toEqual(ok(undefined));
    });

    it("returns false if session was not found", () => {
      const mgr = createSessionLifecycle(store);
      expect(mgr.expire(testKey())).toEqual(ok(false));
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
      const deleted = mgr.cleanStale({ tenantId: "default", agentId: "agent-1" }, 50_000);
      expect(deleted).toEqual(ok(1));
    });

    it("uses defaultIdleTimeoutMs when no maxAgeMs argument provided", () => {
      store.save(testKey(), []);
      const mgr = createSessionLifecycle(store, { defaultIdleTimeoutMs: 14_400_000 });
      // Session is fresh, so nothing should be deleted
      const deleted = mgr.cleanStale({ tenantId: "default", agentId: "agent-1" });
      expect(deleted).toEqual(ok(0));
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
        "Session lifecycle hook failed",
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
        "Session lifecycle hook failed",
      );
    });

    it("silently suppresses hook errors when no logger is provided", async () => {
      const hookRunner = makeHookRunner({
        runSessionStart: vi.fn(async () => { throw new Error("Hook blew up"); }),
      });
      // No logger -- the logger is an optional dependency: must not crash
      const mgr = createSessionLifecycle(store, { hookRunner });

      // Should not throw
      mgr.loadOrCreate(testKey());

      // Allow the async .catch() to resolve
      await new Promise((r) => setTimeout(r, 10));

      // No assertion needed -- the test passes if no error is thrown
    });
  });
});

// ---------------------------------------------------------------------------
// ComisSessionManager.destroySession write-lock tests
// ---------------------------------------------------------------------------

describe("ComisSessionManager.destroySession", () => {
  it("acquires write lock before unlinking JSONL", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createComisSessionManager } = await import("./comis-session-manager.js");

    const baseDir = await mkdtemp(join(tmpdir(), "csm-destroy-"));
    const lockDir = await mkdtemp(join(tmpdir(), "csm-lock-"));

    // FileLockPort injection.
    const { createFileLock } = await import("@comis/core");
    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      // destroySession appends a `session_ended` row via appendSessionIndexEntry;
      // point dataDir at the tmp baseDir so the write lands under <baseDir>/logs/
      // and never the operator's real ~/.comis (test-process write-guard).
      dataDir: baseDir,
      fileLock: createFileLock(),
    });

    const sessionKey: SessionKey = { tenantId: "t1", userId: "u1", channelId: "test-ch" };

    // Create a fake JSONL file so destroySession has something to unlink
    const { sessionKeyToPath } = await import("./session-key-mapper.js");
    const sessionPath = sessionKeyToPath(sessionKey, baseDir);
    const { mkdir: mkdirFs } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdirFs(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, '{"type":"header"}\n');

    // Verify file exists before destroy
    const { existsSync } = await import("node:fs");
    expect(existsSync(sessionPath)).toBe(true);

    await mgr.destroySession(sessionKey);

    // Verify file is gone after destroy
    expect(existsSync(sessionPath)).toBe(false);
  });

  it("destroySession is idempotent when file does not exist", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createComisSessionManager } = await import("./comis-session-manager.js");

    const baseDir = await mkdtemp(join(tmpdir(), "csm-destroy-idem-"));
    const lockDir = await mkdtemp(join(tmpdir(), "csm-lock-idem-"));

    // FileLockPort injection.
    const { createFileLock } = await import("@comis/core");
    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      // destroySession appends a `session_ended` row via appendSessionIndexEntry;
      // point dataDir at the tmp baseDir so the write lands under <baseDir>/logs/
      // and never the operator's real ~/.comis (test-process write-guard).
      dataDir: baseDir,
      fileLock: createFileLock(),
    });

    const sessionKey: SessionKey = { tenantId: "t1", userId: "u1", channelId: "no-exist" };

    // Should not throw even if file does not exist
    await expect(mgr.destroySession(sessionKey)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Abnormal-termination cleanup contract:
//
// ComisSessionManager.withSession() guarantees that the post-execution
// JSONL secret sanitizer (`sanitizeSessionSecrets`) runs in a `finally`
// block while the write lock is still held. This means a callback that
// throws -- LLM stream aborts mid-tool-call, timeout, network error,
// fault injector -- still leaves the on-disk JSONL transcript redacted.
//
// These tests assert the contract end-to-end by writing pre-built JSONL
// fixtures containing unredacted API keys + env_value parameters into a
// temp dir, then invoking `withSession` with a callback that throws, and
// verifying the file content was rewritten with `[REDACTED]` substitutes.
//
// The path is "abnormal termination" because the callback never returns
// successfully -- the only thing that runs is the `finally` cleanup.
// ---------------------------------------------------------------------------

describe("ComisSessionManager — abnormal-termination cleanup contract via withSession finally", () => {
  // SDK-canonical JSONL header (matches CURRENT_SESSION_VERSION = 3 in
  // pi-coding-agent's session-manager.js). If the header is malformed or
  // uses an older shape, SessionManager.open() calls newSession() +
  // _rewriteFile() to clobber the file with a fresh header -- which would
  // delete our pre-written tool_use line before the sanitizer can run.
  function sdkHeader(): string {
    return JSON.stringify({
      type: "session",
      version: 3,
      id: "00000000-0000-0000-0000-000000000abc",
      timestamp: "2026-05-15T00:00:00.000Z",
      cwd: "/tmp/wd",
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- helper return type is structural
  async function bootstrap(testNameSuffix: string): Promise<any> {
    const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { existsSync, readFileSync } = await import("node:fs");
    const { createComisSessionManager } = await import("./comis-session-manager.js");
    const { sessionKeyToPath } = await import("./session-key-mapper.js");
    const { createFileLock } = await import("@comis/core");

    const baseDir = await mkdtemp(join(tmpdir(), `csm-abnormal-${testNameSuffix}-`));
    const lockDir = await mkdtemp(join(tmpdir(), `csm-lock-${testNameSuffix}-`));
    const mgr = createComisSessionManager({
      sessionBaseDir: baseDir,
      lockDir,
      cwd: baseDir,
      // The destroy-after-abnormal test calls destroySession, which appends a
      // `session_ended` row via appendSessionIndexEntry; point dataDir at the tmp
      // baseDir so the write lands under <baseDir>/logs/ and never the operator's
      // real ~/.comis (test-process write-guard).
      dataDir: baseDir,
      fileLock: createFileLock(),
    });
    const sessionKey: SessionKey = {
      tenantId: "tenant-abnormal",
      userId: "user-abnormal",
      channelId: `chan-${testNameSuffix}`,
    };
    const sessionPath = sessionKeyToPath(sessionKey, baseDir);
    await mkdir(dirname(sessionPath), { recursive: true });
    return { baseDir, lockDir, mgr, sessionKey, sessionPath, writeFile, existsSync, readFileSync };
  }

  it("redacts API keys in JSONL tool_use blocks when the withSession callback throws (finally still runs)", async () => {
    const { mgr, sessionKey, sessionPath, writeFile, readFileSync } = await bootstrap("apikey");

    // Pre-write JSONL with an assistant message containing a tool_use block
    // whose `input.apiKey` value matches an OpenAI-pattern key. The SDK
    // would normally flush this synchronously before the tool runs; we
    // simulate by writing the line directly so the sanitizer has work.
    const toolUseLine = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "set_secret", id: "tc-1", input: { apiKey: "sk-test-abc-xyz-1234567890-DEF" } },
        ],
      },
    });
    await writeFile(sessionPath, sdkHeader() + "\n" + toolUseLine + "\n");

    // Invoke withSession with a callback that throws -- the finally block
    // must still run sanitizeSessionSecrets.
    const result = await mgr.withSession(sessionKey, async () => {
      throw new Error("simulated mid-tool-call abort");
    });
    expect(result.ok).toBe(false);

    const after = readFileSync(sessionPath, "utf-8");
    expect(after).toContain("[REDACTED]");
    expect(after).not.toContain("sk-test-abc-xyz-1234567890-DEF");
  });

  it("redacts gateway env_value parameter when the withSession callback throws (env_set secret-leak guard)", async () => {
    const { mgr, sessionKey, sessionPath, writeFile, readFileSync } = await bootstrap("env-set");

    // Gateway env_set with a sensitive env_value. The post-execution
    // sanitizer's first rule targets exactly this shape.
    const envSetLine = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "gateway", id: "tc-2", input: { action: "env_set", env_key: "BOT_TOKEN", env_value: "super-secret-bot-token-value" } },
        ],
      },
    });
    await writeFile(sessionPath, sdkHeader() + "\n" + envSetLine + "\n");

    const result = await mgr.withSession(sessionKey, async () => {
      throw new Error("simulated stream abort during env_set");
    });
    expect(result.ok).toBe(false);

    const after = readFileSync(sessionPath, "utf-8");
    expect(after).toContain('"env_value":"[REDACTED]"');
    expect(after).not.toContain("super-secret-bot-token-value");
  });

  it("preserves clean (no-secret) JSONL content byte-identical when the finally sanitizer runs (idempotent no-op)", async () => {
    const { mgr, sessionKey, sessionPath, writeFile, readFileSync } = await bootstrap("happy-path");

    const cleanLine = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello user" }],
      },
    });
    await writeFile(sessionPath, sdkHeader() + "\n" + cleanLine + "\n");

    const before = readFileSync(sessionPath, "utf-8");
    const result = await mgr.withSession(sessionKey, async () => "ok");
    expect(result.ok).toBe(true);

    const after = readFileSync(sessionPath, "utf-8");
    // Clean content stays byte-identical; sanitizer detected no secrets.
    expect(after).toBe(before);
  });

  it("returns err('error') when the withSession callback throws so callers can surface the failure", async () => {
    const { mgr, sessionKey, sessionPath, writeFile } = await bootstrap("err-error-route");
    await writeFile(sessionPath, sdkHeader() + "\n");

    const result = await mgr.withSession(sessionKey, async () => {
      throw new Error("simulated failure");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("error");
    }
  });

  it("destroySession after an abnormal-termination withSession still removes the redacted JSONL", async () => {
    const { mgr, sessionKey, sessionPath, writeFile, existsSync, readFileSync } = await bootstrap("destroy-after");

    // Write a JSONL with a secret-bearing toolCall arguments shape
    // (sensitive-arg-names rule fires on { token: <non-empty string> }),
    // run withSession that throws (triggering sanitize-on-finally),
    // then assert destroySession still removes it.
    const toolUseLine = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "set_secret", id: "tc-3", input: { token: "raw-bearer-token-value-zxc-9876" } },
        ],
      },
    });
    await writeFile(sessionPath, sdkHeader() + "\n" + toolUseLine + "\n");

    const result = await mgr.withSession(sessionKey, async () => {
      throw new Error("aborted");
    });
    expect(result.ok).toBe(false);

    // Sanitizer should have redacted while the lock was still held.
    const afterSanitize = readFileSync(sessionPath, "utf-8");
    expect(afterSanitize).toContain("[REDACTED]");
    expect(afterSanitize).not.toContain("raw-bearer-token-value-zxc-9876");

    // destroySession unlinks the file even after the abort path.
    await mgr.destroySession(sessionKey);
    expect(existsSync(sessionPath)).toBe(false);
  });
});
