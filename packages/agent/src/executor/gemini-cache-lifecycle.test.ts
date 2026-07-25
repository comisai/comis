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
import { conversationScopeToSessionKey, formatSessionKey, type ConversationScope } from "@comis/core";

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

function makeConversationScope(): ConversationScope {
  return {
    tenantId: "default",
    agentId: "agent-1",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: {
        channelType: "test",
        channelInstanceId: "test-instance",
        conversationId: "chan-1",
        conversationKind: "direct",
      },
      principalId: "user-1",
    },
  };
}

function displayKey(scope: ConversationScope): string {
  const projected = conversationScopeToSessionKey(scope);
  if (!projected.ok) throw projected.error;
  return formatSessionKey(projected.value);
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

    const conversationScope = makeConversationScope();

    eventBus.emit("session:expired", { conversationScope, reason: "idle" });

    // `formatSessionKey` does not serialize `agentId`; the formatted key is
    // `{tenantId}:{userId}:{channelId}` for keys without optional segments.
    expect(cacheManager.dispose).toHaveBeenCalledWith(displayKey(conversationScope));
  });

  it("does not throw if dispose rejects (fire-and-forget via suppressError)", () => {
    cacheManager.dispose.mockRejectedValue(new Error("disposal failed"));

    wireGeminiCacheCleanup(eventBus, cacheManager);

    const conversationScope = makeConversationScope();

    // Should not throw -- suppressError swallows the rejection
    expect(() => {
      eventBus.emit("session:expired", { conversationScope, reason: "daily-reset" });
    }).not.toThrow();
  });
});
