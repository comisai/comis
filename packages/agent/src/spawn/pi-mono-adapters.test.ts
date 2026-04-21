// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for pi-mono adapter wrappers (version isolation, R-11: ephemeral sessions).
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const mockInMemory = vi.fn(() => ({ mock: "session-manager" }));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  SessionManager: {
    inMemory: (...args: unknown[]) => mockInMemory(...args),
  },
}));

// ---------------------------------------------------------------------------
// Import (after mock)
// ---------------------------------------------------------------------------

import { createEphemeralComisSessionManager } from "./pi-mono-adapters.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createEphemeralComisSessionManager", () => {
  it("returns an object implementing ComisSessionManager interface", () => {
    const adapter = createEphemeralComisSessionManager("/tmp/test");
    expect(typeof adapter.withSession).toBe("function");
    expect(typeof adapter.destroySession).toBe("function");
    expect(typeof adapter.getSessionStats).toBe("function");
    expect(typeof adapter.writeSessionMetadata).toBe("function");
  });

  it("is a version-isolation wrapper function", () => {
    expect(typeof createEphemeralComisSessionManager).toBe("function");
  });

  it("withSession delegates to SessionManager.inMemory and wraps result in ok()", async () => {
    const adapter = createEphemeralComisSessionManager("/tmp/test");
    const sessionKey = { tenantId: "t", userId: "u", channelId: "c" };

    const result = await adapter.withSession(sessionKey, async (sm) => {
      expect(sm).toEqual({ mock: "session-manager" });
      return "test-result";
    });

    expect(mockInMemory).toHaveBeenCalledWith("/tmp/test");
    expect(result).toEqual({ ok: true, value: "test-result" });
  });

  it("withSession returns err on callback failure", async () => {
    const adapter = createEphemeralComisSessionManager("/tmp/test");
    const sessionKey = { tenantId: "t", userId: "u", channelId: "c" };

    const result = await adapter.withSession(sessionKey, async () => {
      throw new Error("boom");
    });

    expect(result).toEqual({ ok: false, error: "error" });
  });

  it("destroySession is a no-op", async () => {
    const adapter = createEphemeralComisSessionManager("/tmp/test");
    const sessionKey = { tenantId: "t", userId: "u", channelId: "c" };
    // Should not throw
    await adapter.destroySession(sessionKey);
  });

  it("getSessionStats returns undefined", () => {
    const adapter = createEphemeralComisSessionManager("/tmp/test");
    const sessionKey = { tenantId: "t", userId: "u", channelId: "c" };
    expect(adapter.getSessionStats(sessionKey)).toBeUndefined();
  });

  it("writeSessionMetadata is a no-op", () => {
    const adapter = createEphemeralComisSessionManager("/tmp/test");
    const sessionKey = { tenantId: "t", userId: "u", channelId: "c" };
    // Should not throw
    adapter.writeSessionMetadata(sessionKey, { traceId: "test" });
  });
});
