// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for createImapLifecycle (imap-lifecycle.ts).
 *
 * Targets uncovered branches: connect failure path + reconnect scheduling,
 * mailbox-lock failure, exists event handler (count > prevCount branch),
 * fetch error handling, IDLE error -> polling fallback, stop() with error.
 *
 * Phase 40 / Plan 40-12 / COV-03 — channels branches gap closure.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// ImapFlow mock — captures handlers and lets tests trigger them
// ---------------------------------------------------------------------------

const mockFns = {
  connect: vi.fn(),
  getMailboxLock: vi.fn(),
  logout: vi.fn(),
  on: vi.fn(),
  fetch: vi.fn(),
  close: vi.fn(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registeredHandlers: Map<string, (data: any) => void>;

vi.mock("imapflow", () => {
  return {
    ImapFlow: class MockImapFlow {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(_args: unknown[]) {
        registeredHandlers = new Map();
      }
      connect = mockFns.connect;
      getMailboxLock = mockFns.getMailboxLock;
      logout = mockFns.logout;
      on = vi.fn(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (event: string, fn: (data: any) => void) => {
          registeredHandlers.set(event, fn);
          mockFns.on(event, fn);
        },
      );
      fetch = mockFns.fetch;
      close = mockFns.close;
    },
  };
});

const logger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as import("./imap-lifecycle.js").ImapLifecycleOpts["logger"];

function makeOpts(
  overrides: Partial<import("./imap-lifecycle.js").ImapLifecycleOpts> = {},
): import("./imap-lifecycle.js").ImapLifecycleOpts {
  return {
    host: "imap.example.com",
    port: 993,
    secure: true,
    auth: { user: "user@example.com", pass: "test-pass" },
    logger,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFns.connect.mockResolvedValue(undefined);
  mockFns.getMailboxLock.mockResolvedValue({ release: vi.fn() });
  mockFns.logout.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Connect failure path
// ---------------------------------------------------------------------------

describe("createImapLifecycle connect failure", () => {
  it("logs error and returns err when client.connect rejects", async () => {
    mockFns.connect.mockRejectedValue(new Error("connection_refused"));
    const { createImapLifecycle } = await import("./imap-lifecycle.js");

    const handle = createImapLifecycle(makeOpts());
    const result = await handle.start();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("connection_refused");
    }
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("credentials"),
        errorKind: "network",
      }),
      "IMAP connection failed",
    );
  });
});

// ---------------------------------------------------------------------------
// Mailbox lock failure
// ---------------------------------------------------------------------------

describe("createImapLifecycle mailbox lock failure", () => {
  it("returns err with INBOX-lock message when getMailboxLock rejects", async () => {
    mockFns.getMailboxLock.mockRejectedValue(new Error("INBOX_LOCKED"));
    const { createImapLifecycle } = await import("./imap-lifecycle.js");

    const handle = createImapLifecycle(makeOpts());
    const result = await handle.start();

    expect(result.ok).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("INBOX"),
        errorKind: "network",
      }),
      "Failed to get INBOX lock",
    );
  });
});

// ---------------------------------------------------------------------------
// Exists event handler — count > prevCount
// ---------------------------------------------------------------------------

describe("createImapLifecycle exists event handler", () => {
  it("calls fetch when exists event reports count > prevCount", async () => {
    // Provide async iterable for fetch
    async function* emptyIter() {}
    mockFns.fetch.mockReturnValue(emptyIter());

    const { createImapLifecycle } = await import("./imap-lifecycle.js");
    const handle = createImapLifecycle(makeOpts());
    handle.onNewMessage(() => undefined);
    await handle.start();

    // Trigger exists event
    const existsHandler = registeredHandlers.get("exists");
    expect(existsHandler).toBeDefined();
    existsHandler!({ path: "INBOX", count: 5, prevCount: 3 });
    await new Promise((r) => setTimeout(r, 5));

    expect(mockFns.fetch).toHaveBeenCalled();
  });

  it("does not call fetch when exists count equals prevCount", async () => {
    const { createImapLifecycle } = await import("./imap-lifecycle.js");
    const handle = createImapLifecycle(makeOpts());
    await handle.start();

    const existsHandler = registeredHandlers.get("exists");
    existsHandler!({ path: "INBOX", count: 3, prevCount: 3 });

    expect(mockFns.fetch).not.toHaveBeenCalled();
  });

  it("dispatches fetched messages to onNewMessage handlers", async () => {
    async function* msgIter() {
      yield {
        source: Buffer.from("email-body"),
        uid: 42,
        envelope: { subject: "Hello" },
      };
    }
    mockFns.fetch.mockReturnValue(msgIter());

    const { createImapLifecycle } = await import("./imap-lifecycle.js");
    const handle = createImapLifecycle(makeOpts());
    const handler = vi.fn();
    handle.onNewMessage(handler);
    await handle.start();

    const existsHandler = registeredHandlers.get("exists");
    existsHandler!({ path: "INBOX", count: 1, prevCount: 0 });
    // Allow async fetch
    await new Promise((r) => setTimeout(r, 20));

    expect(handler).toHaveBeenCalledWith(
      Buffer.from("email-body"),
      42,
      { subject: "Hello" },
    );
  });

  it("logs warning when fetch throws and does not break the loop", async () => {
    async function* throwingIter() {
      throw new Error("fetch-failed");
      yield undefined;
    }
    mockFns.fetch.mockReturnValue(throwingIter());

    const { createImapLifecycle } = await import("./imap-lifecycle.js");
    const handle = createImapLifecycle(makeOpts());
    await handle.start();

    const existsHandler = registeredHandlers.get("exists");
    existsHandler!({ path: "INBOX", count: 1, prevCount: 0 });
    await new Promise((r) => setTimeout(r, 20));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("Fetch failed"),
        errorKind: "network",
      }),
      "Failed to fetch new messages",
    );
  });
});

// ---------------------------------------------------------------------------
// IDLE error → polling fallback
// ---------------------------------------------------------------------------

describe("createImapLifecycle IDLE error fallback", () => {
  it("logs polling fallback warning when error event has IDLE in the message", async () => {
    const { createImapLifecycle } = await import("./imap-lifecycle.js");
    const handle = createImapLifecycle(makeOpts());
    await handle.start();

    const errorHandler = registeredHandlers.get("error");
    expect(errorHandler).toBeDefined();
    errorHandler!(new Error("IDLE not supported"));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("polling"),
        errorKind: "platform",
      }),
      "IDLE not supported, switching to polling fallback",
    );
  });

  it("ignores non-IDLE errors on the error event listener", async () => {
    const { createImapLifecycle } = await import("./imap-lifecycle.js");
    const handle = createImapLifecycle(makeOpts());
    await handle.start();

    const errorHandler = registeredHandlers.get("error");
    errorHandler!(new Error("connection reset"));

    // No IDLE-related warn was logged for this error
    const calls = (logger.warn as Mock).mock.calls.filter(
      ([payload, msg]: unknown[]) =>
        typeof msg === "string" && msg.includes("polling fallback"),
    );
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Close event → reconnect
// ---------------------------------------------------------------------------

describe("createImapLifecycle close event reconnect", () => {
  it("logs info and schedules reconnect when close event fires (not stopped)", async () => {
    const { createImapLifecycle } = await import("./imap-lifecycle.js");
    const handle = createImapLifecycle(makeOpts());
    await handle.start();

    const closeHandler = registeredHandlers.get("close");
    expect(closeHandler).toBeDefined();
    closeHandler!();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ submodule: "imap" }),
      "IMAP connection closed, scheduling reconnect",
    );
  });
});

// ---------------------------------------------------------------------------
// stop() with logout error
// ---------------------------------------------------------------------------

describe("createImapLifecycle stop()", () => {
  it("returns err when logout() rejects after a successful start", async () => {
    mockFns.logout.mockRejectedValue(new Error("logout_failed"));
    const { createImapLifecycle } = await import("./imap-lifecycle.js");

    const handle = createImapLifecycle(makeOpts());
    await handle.start();
    const result = await handle.stop();

    expect(result.ok).toBe(false);
  });

  it("returns ok when stop() called without a prior successful start (no client)", async () => {
    const { createImapLifecycle } = await import("./imap-lifecycle.js");

    const handle = createImapLifecycle(makeOpts());
    const result = await handle.stop();

    expect(result.ok).toBe(true);
  });
});
