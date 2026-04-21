// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for wireGeminiCacheCleanup.
 *
 * Verifies that session:expired events trigger fire-and-forget Gemini
 * cache disposal via suppressError.
 *
 * Session expiry triggers Gemini cache disposal.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { wireGeminiCacheCleanup } from "./gemini-cache-lifecycle.js";
import type { GeminiCacheManager } from "./gemini-cache-manager.js";
import type { SessionKey } from "@comis/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEventBus() {
  const handlers: Map<string, Array<(payload: unknown) => void>> = new Map();
  return {
    on(event: string, handler: (payload: unknown) => void): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event: string, payload: unknown): void {
      const list = handlers.get(event) ?? [];
      for (const handler of list) handler(payload);
    },
    getHandlerCount(event: string): number {
      return (handlers.get(event) ?? []).length;
    },
  };
}

function createMockCacheManager(): GeminiCacheManager & { dispose: ReturnType<typeof vi.fn> } {
  return {
    getOrCreate: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    disposeAll: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
    getActiveCount: vi.fn().mockReturnValue(0),
    cleanupOrphaned: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wireGeminiCacheCleanup", () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let cacheManager: ReturnType<typeof createMockCacheManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = createMockEventBus();
    cacheManager = createMockCacheManager();
  });

  it("subscribes to session:expired on the eventBus", () => {
    wireGeminiCacheCleanup(eventBus, cacheManager);
    expect(eventBus.getHandlerCount("session:expired")).toBe(1);
  });

  it("calls cacheManager.dispose with formatted session key on session:expired", () => {
    wireGeminiCacheCleanup(eventBus, cacheManager);

    const sessionKey: SessionKey = {
      agentId: "agent-1",
      tenantId: "default",
      channelId: "chan-1",
      userId: "user-1",
    };

    eventBus.emit("session:expired", { sessionKey, reason: "idle" });

    // formatSessionKey produces "agent:{agentId}:{tenantId}:{userId}:{channelId}"
    expect(cacheManager.dispose).toHaveBeenCalledWith("agent:agent-1:default:user-1:chan-1");
  });

  it("does not throw if dispose rejects (fire-and-forget via suppressError)", () => {
    cacheManager.dispose.mockRejectedValue(new Error("disposal failed"));

    wireGeminiCacheCleanup(eventBus, cacheManager);

    const sessionKey: SessionKey = {
      agentId: "agent-1",
      tenantId: "default",
      channelId: "chan-1",
      userId: "user-1",
    };

    // Should not throw -- suppressError swallows the rejection
    expect(() => {
      eventBus.emit("session:expired", { sessionKey, reason: "daily-reset" });
    }).not.toThrow();
  });
});
