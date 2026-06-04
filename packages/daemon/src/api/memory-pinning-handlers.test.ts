// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createMemoryPinningHandlers } from "./memory-pinning-handlers.js";
import type { MemoryApiDeps as MemoryHandlerDeps } from "./types.js";
import { ok } from "@comis/shared";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<MemoryHandlerDeps>): MemoryHandlerDeps {
  return {
    defaultAgentId: "default",
    defaultWorkspaceDir: "/tmp/test-workspace",
    workspaceDirs: new Map(),
    tenantId: "default",
    memoryApi: {
      inspect: vi.fn(() => []),
      search: vi.fn(async () => []),
      clear: vi.fn(() => 0),
      stats: vi.fn(() => ({
        totalEntries: 0,
        byType: {},
        byTrustLevel: {},
        byAgent: {},
        totalSessions: 0,
        embeddedEntries: 0,
        dbSizeBytes: 0,
        oldestCreatedAt: null,
      })),
      pin: vi.fn(async () => ok(true)),
      unpin: vi.fn(async () => ok(true)),
    } as never,
    memoryAdapter: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() })),
    } as never,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMemoryPinningHandlers", () => {
  // -------------------------------------------------------------------------
  // memory.pin
  // -------------------------------------------------------------------------

  describe("memory.pin", () => {
    it("memory.pin handler returns {pinned: true} for a valid admin request", async () => {
      const deps = makeDeps();
      const handlers = createMemoryPinningHandlers(deps);

      const result = await handlers["memory.pin"]!({
        id: "mem-123",
        _trustLevel: "admin",
      });

      expect(result).toEqual({ pinned: true, id: "mem-123" });
    });

    it("memory.pin handler throws on non-admin trust level request", async () => {
      const deps = makeDeps();
      const handlers = createMemoryPinningHandlers(deps);

      await expect(
        handlers["memory.pin"]!({ id: "mem-123", _trustLevel: "user" }),
      ).rejects.toThrow("Admin access required for memory pin");
    });
  });

  // -------------------------------------------------------------------------
  // memory.unpin
  // -------------------------------------------------------------------------

  describe("memory.unpin", () => {
    it("memory.unpin handler returns {unpinned: true} for a valid admin request", async () => {
      const deps = makeDeps();
      const handlers = createMemoryPinningHandlers(deps);

      const result = await handlers["memory.unpin"]!({
        id: "mem-456",
        _trustLevel: "admin",
      });

      expect(result).toEqual({ unpinned: true, id: "mem-456" });
    });

    it("memory.unpin handler throws on non-admin trust level request", async () => {
      const deps = makeDeps();
      const handlers = createMemoryPinningHandlers(deps);

      await expect(
        handlers["memory.unpin"]!({ id: "mem-456", _trustLevel: "user" }),
      ).rejects.toThrow("Admin access required for memory unpin");
    });
  });
});
