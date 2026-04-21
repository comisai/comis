// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the modules whose clearSession* functions we delegate to.
// The mocks must be hoisted before the import of the module under test.
const mockClearSessionToolNameSnapshot = vi.hoisted(() => vi.fn());
const mockClearSessionBootstrapFileSnapshot = vi.hoisted(() => vi.fn());
const mockClearSessionDeliveredGuides = vi.hoisted(() => vi.fn());
const mockClearSessionToolSchemaSnapshot = vi.hoisted(() => vi.fn());
const mockClearSessionBreakpointIndex = vi.hoisted(() => vi.fn());
const mockClearSessionCacheWarm = vi.hoisted(() => vi.fn());
const mockClearSessionToolSchemaSnapshotHash = vi.hoisted(() => vi.fn());
const mockClearSessionTracker = vi.hoisted(() => vi.fn());
const mockClearDiscoveryTracker = vi.hoisted(() => vi.fn());
const mockClearCacheBreakDetectorSession = vi.hoisted(() => vi.fn());
const mockClearSessionLastResponseTs = vi.hoisted(() => vi.fn());
const mockClearCacheSafeParams = vi.hoisted(() => vi.fn());
const mockClearSessionRenderedToolCache = vi.hoisted(() => vi.fn());
const mockClearSessionPerToolCache = vi.hoisted(() => vi.fn());
const mockClearSessionBetaHeaderLatches = vi.hoisted(() => vi.fn());
const mockClearSessionLatches = vi.hoisted(() => vi.fn());
const mockClearSessionEvictionCooldown = vi.hoisted(() => vi.fn());
const mockClearSessionCacheSavings = vi.hoisted(() => vi.fn());

vi.mock("./prompt-assembly.js", () => ({
  clearSessionToolNameSnapshot: mockClearSessionToolNameSnapshot,
  clearSessionBootstrapFileSnapshot: mockClearSessionBootstrapFileSnapshot,
  clearCacheSafeParams: mockClearCacheSafeParams,
}));

vi.mock("./executor-session-state.js", () => ({
  clearSessionDeliveredGuides: mockClearSessionDeliveredGuides,
  clearSessionToolSchemaSnapshot: mockClearSessionToolSchemaSnapshot,
  clearSessionToolSchemaSnapshotHash: mockClearSessionToolSchemaSnapshotHash,
  clearSessionBreakpointIndex: mockClearSessionBreakpointIndex,
  clearSessionCacheWarm: mockClearSessionCacheWarm,
  clearSessionLatches: mockClearSessionLatches,
  clearSessionEvictionCooldown: mockClearSessionEvictionCooldown,
  clearSessionCacheSavings: mockClearSessionCacheSavings,
}));

vi.mock("./tool-lifecycle.js", () => ({
  clearSessionTracker: mockClearSessionTracker,
}));

vi.mock("./discovery-tracker.js", () => ({
  clearDiscoveryTracker: mockClearDiscoveryTracker,
}));

vi.mock("./cache-break-detection.js", () => ({
  clearCacheBreakDetectorSession: mockClearCacheBreakDetectorSession,
}));

vi.mock("./ttl-guard.js", () => ({
  clearSessionLastResponseTs: mockClearSessionLastResponseTs,
}));

vi.mock("./stream-wrappers/request-body-injector.js", () => ({
  clearSessionBetaHeaderLatches: mockClearSessionBetaHeaderLatches,
}));

vi.mock("./stream-wrappers/tool-schema-cache.js", () => ({
  clearSessionRenderedToolCache: mockClearSessionRenderedToolCache,
  clearSessionPerToolCache: mockClearSessionPerToolCache,
}));

// formatSessionKey is real -- import from @comis/core
// We need the actual implementation to verify the key formatting.
// (The default vitest config does not auto-mock @comis/core.)

import { clearSessionState, wireSessionStateCleanup } from "./session-snapshot-cleanup.js";

describe("session-snapshot-cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // clearSessionState
  // ---------------------------------------------------------------------------

  describe("clearSessionState", () => {
    it("delegates to all 18 clearSession* functions with the same key", () => {
      const key = "agent:bot1:t:u:c";

      clearSessionState(key);

      expect(mockClearSessionToolNameSnapshot).toHaveBeenCalledWith(key);
      expect(mockClearSessionBootstrapFileSnapshot).toHaveBeenCalledWith(key);
      expect(mockClearCacheSafeParams).toHaveBeenCalledWith(key);
      expect(mockClearSessionDeliveredGuides).toHaveBeenCalledWith(key);
      expect(mockClearSessionToolSchemaSnapshot).toHaveBeenCalledWith(key);
      expect(mockClearSessionToolSchemaSnapshotHash).toHaveBeenCalledWith(key);
      expect(mockClearSessionBreakpointIndex).toHaveBeenCalledWith(key);
      expect(mockClearSessionCacheWarm).toHaveBeenCalledWith(key);
      expect(mockClearSessionTracker).toHaveBeenCalledWith(key);
      expect(mockClearDiscoveryTracker).toHaveBeenCalledWith(key);
      expect(mockClearCacheBreakDetectorSession).toHaveBeenCalledWith(key);
      expect(mockClearSessionLastResponseTs).toHaveBeenCalledWith(key);
      expect(mockClearSessionRenderedToolCache).toHaveBeenCalledWith(key);
      expect(mockClearSessionPerToolCache).toHaveBeenCalledWith(key);
      expect(mockClearSessionBetaHeaderLatches).toHaveBeenCalledWith(key);
      expect(mockClearSessionLatches).toHaveBeenCalledWith(key);
      expect(mockClearSessionEvictionCooldown).toHaveBeenCalledWith(key);
      expect(mockClearSessionCacheSavings).toHaveBeenCalledWith(key);
    });

    it("calls each function exactly once", () => {
      clearSessionState("any-key");

      expect(mockClearSessionToolNameSnapshot).toHaveBeenCalledTimes(1);
      expect(mockClearSessionBootstrapFileSnapshot).toHaveBeenCalledTimes(1);
      expect(mockClearCacheSafeParams).toHaveBeenCalledTimes(1);
      expect(mockClearSessionDeliveredGuides).toHaveBeenCalledTimes(1);
      expect(mockClearSessionToolSchemaSnapshot).toHaveBeenCalledTimes(1);
      expect(mockClearSessionToolSchemaSnapshotHash).toHaveBeenCalledTimes(1);
      expect(mockClearSessionBreakpointIndex).toHaveBeenCalledTimes(1);
      expect(mockClearSessionCacheWarm).toHaveBeenCalledTimes(1);
      expect(mockClearSessionTracker).toHaveBeenCalledTimes(1);
      expect(mockClearDiscoveryTracker).toHaveBeenCalledTimes(1);
      expect(mockClearCacheBreakDetectorSession).toHaveBeenCalledTimes(1);
      expect(mockClearSessionLastResponseTs).toHaveBeenCalledTimes(1);
      expect(mockClearSessionRenderedToolCache).toHaveBeenCalledTimes(1);
      expect(mockClearSessionPerToolCache).toHaveBeenCalledTimes(1);
      expect(mockClearSessionBetaHeaderLatches).toHaveBeenCalledTimes(1);
      expect(mockClearSessionLatches).toHaveBeenCalledTimes(1);
      expect(mockClearSessionEvictionCooldown).toHaveBeenCalledTimes(1);
      expect(mockClearSessionCacheSavings).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // wireSessionStateCleanup
  // ---------------------------------------------------------------------------

  describe("wireSessionStateCleanup", () => {
    it("subscribes to session:expired and calls clearSessionState on event", () => {
      // Minimal event bus stub
      let capturedHandler: ((payload: { sessionKey: { tenantId: string; userId: string; channelId: string }; reason: string }) => void) | undefined;
      const eventBus = {
        on: vi.fn((_event: string, handler: typeof capturedHandler) => {
          capturedHandler = handler;
        }),
      };

      wireSessionStateCleanup(eventBus as never);

      // Verify subscription
      expect(eventBus.on).toHaveBeenCalledWith("session:expired", expect.any(Function));

      // Simulate event emission
      expect(capturedHandler).toBeDefined();
      capturedHandler!({
        sessionKey: { tenantId: "t1", userId: "u1", channelId: "c1" },
        reason: "idle-timeout",
      });

      // formatSessionKey should produce "t1:u1:c1" for this input
      const expectedKey = "t1:u1:c1";

      expect(mockClearSessionToolNameSnapshot).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionBootstrapFileSnapshot).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionDeliveredGuides).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionToolSchemaSnapshot).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionToolSchemaSnapshotHash).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionBreakpointIndex).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionCacheWarm).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionTracker).toHaveBeenCalledWith(expectedKey);
      expect(mockClearDiscoveryTracker).toHaveBeenCalledWith(expectedKey);
      expect(mockClearCacheBreakDetectorSession).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionLastResponseTs).toHaveBeenCalledWith(expectedKey);
    });

    it("formats session key with agentId prefix when present", () => {
      let capturedHandler: ((payload: { sessionKey: { agentId: string; tenantId: string; userId: string; channelId: string }; reason: string }) => void) | undefined;
      const eventBus = {
        on: vi.fn((_event: string, handler: typeof capturedHandler) => {
          capturedHandler = handler;
        }),
      };

      wireSessionStateCleanup(eventBus as never);

      capturedHandler!({
        sessionKey: { agentId: "bot1", tenantId: "t1", userId: "u1", channelId: "c1" },
        reason: "manual-reset",
      });

      const expectedKey = "agent:bot1:t1:u1:c1";

      expect(mockClearSessionDeliveredGuides).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionToolSchemaSnapshotHash).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionCacheWarm).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionTracker).toHaveBeenCalledWith(expectedKey);
      expect(mockClearDiscoveryTracker).toHaveBeenCalledWith(expectedKey);
      expect(mockClearCacheBreakDetectorSession).toHaveBeenCalledWith(expectedKey);
      expect(mockClearSessionLastResponseTs).toHaveBeenCalledWith(expectedKey);
    });
  });
});
