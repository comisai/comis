// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for IMAP lifecycle manager.
 *
 * Uses vi.mock() to mock ImapFlow — no real IMAP connections.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// ImapFlow mock — vi.mock is hoisted, so use a global-accessible store
// ---------------------------------------------------------------------------

/** Shared mock client that tests can inspect/configure. */
const mockFns = {
  connect: vi.fn(),
  getMailboxLock: vi.fn(),
  logout: vi.fn(),
  on: vi.fn(),
  fetch: vi.fn(),
  close: vi.fn(),
};

/** Track the constructor args for assertions. */
let lastConstructorArgs: unknown[] = [];

vi.mock("imapflow", () => {
  return {
    ImapFlow: class MockImapFlow {
      connect: Mock;
      getMailboxLock: Mock;
      logout: Mock;
      on: Mock;
      fetch: Mock;
      close: Mock;

      constructor(...args: unknown[]) {
        lastConstructorArgs = args;
        this.connect = mockFns.connect;
        this.getMailboxLock = mockFns.getMailboxLock;
        this.logout = mockFns.logout;
        this.on = mockFns.on;
        this.fetch = mockFns.fetch;
        this.close = mockFns.close;
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Logger stub
// ---------------------------------------------------------------------------

const logger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as import("./imap-lifecycle.js").ImapLifecycleOpts["logger"];

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

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
  lastConstructorArgs = [];
  mockFns.connect.mockResolvedValue(undefined);
  mockFns.getMailboxLock.mockResolvedValue({ release: vi.fn() });
  mockFns.logout.mockResolvedValue(undefined);
  mockFns.on.mockReturnThis();
});

describe("createImapLifecycle", () => {
  async function getModule() {
    return import("./imap-lifecycle.js");
  }

  it("creates handle with start/stop/onNewMessage methods", async () => {
    const { createImapLifecycle } = await getModule();
    const handle = createImapLifecycle(makeOpts());
    expect(handle).toBeDefined();
    expect(typeof handle.start).toBe("function");
    expect(typeof handle.stop).toBe("function");
    expect(typeof handle.onNewMessage).toBe("function");
  });

  it("start connects ImapFlow client with correct host/port/auth", async () => {
    const { createImapLifecycle } = await getModule();
    const handle = createImapLifecycle(makeOpts());
    const result = await handle.start();

    expect(result.ok).toBe(true);
    expect(lastConstructorArgs[0]).toEqual(
      expect.objectContaining({
        host: "imap.example.com",
        port: 993,
        secure: true,
        auth: { user: "user@example.com", pass: "test-pass" },
      }),
    );
    expect(mockFns.connect).toHaveBeenCalled();
    expect(mockFns.getMailboxLock).toHaveBeenCalledWith("INBOX");
  });

  it("start sets maxIdleTime for 25 min IDLE cycling per RFC 2177", async () => {
    const { createImapLifecycle } = await getModule();
    const handle = createImapLifecycle(makeOpts());
    await handle.start();

    expect(lastConstructorArgs[0]).toEqual(
      expect.objectContaining({
        maxIdleTime: 25 * 60 * 1000,
      }),
    );
  });

  it("registers 'exists' event listener on start", async () => {
    const { createImapLifecycle } = await getModule();
    const handle = createImapLifecycle(makeOpts());
    await handle.start();

    const existsCalls = mockFns.on.mock.calls.filter(
      ([event]: [string]) => event === "exists",
    );
    expect(existsCalls.length).toBeGreaterThan(0);
  });

  it("registers 'close' event listener for reconnect", async () => {
    const { createImapLifecycle } = await getModule();
    const handle = createImapLifecycle(makeOpts());
    await handle.start();

    const closeCalls = mockFns.on.mock.calls.filter(
      ([event]: [string]) => event === "close",
    );
    expect(closeCalls.length).toBeGreaterThan(0);
  });

  it("stop disconnects client and cancels timers", async () => {
    const releaseFn = vi.fn();
    mockFns.getMailboxLock.mockResolvedValue({ release: releaseFn });

    const { createImapLifecycle } = await getModule();
    const handle = createImapLifecycle(makeOpts());
    await handle.start();
    const result = await handle.stop();

    expect(result.ok).toBe(true);
    expect(releaseFn).toHaveBeenCalled();
    expect(mockFns.logout).toHaveBeenCalled();
  });

  it("OAuth2 auth passes accessToken field", async () => {
    const { createImapLifecycle } = await getModule();
    const handle = createImapLifecycle(
      makeOpts({
        auth: { user: "user@gmail.com", accessToken: "ya29.test-token" },
      }),
    );
    await handle.start();

    expect(lastConstructorArgs[0]).toEqual(
      expect.objectContaining({
        auth: { user: "user@gmail.com", accessToken: "ya29.test-token" },
      }),
    );
  });

  it("password auth passes pass field", async () => {
    const { createImapLifecycle } = await getModule();
    const handle = createImapLifecycle(
      makeOpts({
        auth: { user: "user@example.com", pass: "my-password" },
      }),
    );
    await handle.start();

    expect(lastConstructorArgs[0]).toEqual(
      expect.objectContaining({
        auth: { user: "user@example.com", pass: "my-password" },
      }),
    );
  });
});
