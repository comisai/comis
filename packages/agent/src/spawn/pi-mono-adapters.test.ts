// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for pi-mono adapter wrappers (version isolation, ephemeral sessions).
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const mockInMemory = vi.fn(() => ({ mock: "session-manager" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
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
  it("accepts inbound ledger content without creating persistence for an ephemeral session", () => {
    const adapter = createEphemeralComisSessionManager("/tmp/test");

    expect(adapter.appendInboundMessageLedger({
      tenantId: "default",
      userId: "sub-agent:test",
      channelId: "sub-agent:test",
    }, "provenance\n")).toEqual({ ok: true, value: undefined });
  });

  it("returns an object implementing ComisSessionManager interface", () => {
    const adapter = createEphemeralComisSessionManager("/tmp/test");
    expect(typeof adapter.withSession).toBe("function");
    expect(typeof adapter.destroySession).toBe("function");
    expect(typeof adapter.persistInboundMessage).toBe("function");
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

  it("reuses one in-memory session across repeated callbacks on the same adapter", async () => {
    const callsBefore = mockInMemory.mock.calls.length;
    const adapter = createEphemeralComisSessionManager("/tmp/test");
    const sessionKey = { tenantId: "t", userId: "u", channelId: "c" };
    const seen: unknown[] = [];

    await adapter.withSession(sessionKey, async (sm) => { seen.push(sm); });
    await adapter.withSession(sessionKey, async (sm) => { seen.push(sm); });

    expect(mockInMemory.mock.calls).toHaveLength(callsBefore + 1);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
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
