import { describe, it, expect, vi } from "vitest";
import { createMemoryHandlers } from "./memory-handlers.js";
import type { MemoryHandlerDeps } from "./memory-handlers.js";

// ---------------------------------------------------------------------------
// Helper: create isolated deps per test to avoid shared state
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<MemoryHandlerDeps>): MemoryHandlerDeps {
  return {
    defaultAgentId: "default",
    defaultWorkspaceDir: "/tmp/test-workspace",
    workspaceDirs: new Map(),
    memoryApi: {
      inspect: vi.fn(() => [
        {
          id: "mem-1",
          content: "Test memory content that is longer than needed for browse truncation tests",
          memoryType: "episodic",
          trustLevel: "learned",
          tags: ["test"],
          agentId: "default",
          userId: "user1",
          source: {},
          createdAt: Date.now(),
        },
      ]),
      search: vi.fn(async () => []),
      clear: vi.fn(() => 3),
      stats: vi.fn(() => ({
        totalEntries: 42,
        byType: { episodic: 20, semantic: 22 },
        byTrustLevel: { learned: 30, external: 12 },
        byAgent: { default: 42 },
        totalSessions: 5,
        embeddedEntries: 38,
        dbSizeBytes: 1048576,
      })),
      enforceGuardrails: vi.fn(() => null),
    } as never,
    memoryAdapter: {
      store: vi.fn(async () => ({ ok: true, value: true })),
      delete: vi.fn(async () => ({ ok: true, value: true })),
    } as never,
    tenantId: "default",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests for the 5 new memory management handlers
// ---------------------------------------------------------------------------

describe("createMemoryHandlers - memory management", () => {
  // -------------------------------------------------------------------------
  // memory.stats (agent-level access -- no admin required)
  // -------------------------------------------------------------------------

  describe("memory.stats", () => {
    it("returns MemoryStats object with all expected fields", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.stats"]!({})) as {
        totalEntries: number;
        byType: Record<string, number>;
        dbSizeBytes: number;
      };

      expect(result.totalEntries).toBe(42);
      expect(result.byType).toEqual({ episodic: 20, semantic: 22 });
      expect(result.dbSizeBytes).toBe(1048576);
    });

    it("passes tenant_id and agent_id to memoryApi.stats", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await handlers["memory.stats"]!({
        tenant_id: "custom-tenant",
        agent_id: "custom-agent",
      });

      expect(deps.memoryApi.stats).toHaveBeenCalledWith(
        "custom-tenant",
        "custom-agent",
      );
    });

    it("uses deps.tenantId as fallback when no tenant_id param", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await handlers["memory.stats"]!({});

      expect(deps.memoryApi.stats).toHaveBeenCalledWith("default", undefined);
    });

    it("works without _trustLevel (agent-level operation)", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.stats"]!({})) as {
        totalEntries: number;
      };

      expect(result.totalEntries).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  // memory.browse (agent-level access -- no admin required)
  // -------------------------------------------------------------------------

  describe("memory.browse", () => {
    it("returns paginated entries with truncated content", async () => {
      const longContent = "A".repeat(600);
      const deps = makeDeps({
        memoryApi: {
          inspect: vi.fn(() => [
            {
              id: "mem-long",
              content: longContent,
              trustLevel: "learned",
              tags: ["test"],
              agentId: "default",
              userId: "user1",
              source: {},
              createdAt: Date.now(),
            },
          ]),
          search: vi.fn(async () => []),
          clear: vi.fn(() => 0),
          stats: vi.fn(() => ({})),
          enforceGuardrails: vi.fn(() => null),
        } as never,
      });
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.browse"]!({})) as {
        entries: Array<{ id: string; content: string }>;
      };

      expect(result.entries[0]!.content.length).toBeLessThanOrEqual(500);
    });

    it("applies default offset/limit when not specified", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await handlers["memory.browse"]!({});

      expect(deps.memoryApi.inspect).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 0, limit: 20 }),
      );
    });

    it("passes filter params through to inspect", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await handlers["memory.browse"]!({
        memory_type: "episodic",
        trust_level: "learned",
        tags: ["important"],
        tenant_id: "my-tenant",
        agent_id: "my-agent",
      });

      expect(deps.memoryApi.inspect).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryType: "episodic",
          trustLevel: "learned",
          tags: ["important"],
          tenantId: "my-tenant",
          agentId: "my-agent",
        }),
      );
    });

    it("returns hasMore=true when entries.length equals limit", async () => {
      // Create mock data where entry count matches the limit
      const entries = Array.from({ length: 5 }, (_, i) => ({
        id: `mem-${i}`,
        content: `Content ${i}`,
        trustLevel: "learned",
        tags: [],
        agentId: "default",
        userId: "user1",
        source: {},
        createdAt: Date.now(),
      }));
      const deps = makeDeps({
        memoryApi: {
          inspect: vi.fn(() => entries),
          search: vi.fn(async () => []),
          clear: vi.fn(() => 0),
          stats: vi.fn(() => ({})),
          enforceGuardrails: vi.fn(() => null),
        } as never,
      });
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.browse"]!({ limit: 5 })) as {
        hasMore: boolean;
        total: number;
      };

      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(5);
    });

    it("works without _trustLevel (agent-level operation)", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.browse"]!({})) as {
        entries: unknown[];
      };

      expect(result.entries.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // memory.delete (admin required)
  // -------------------------------------------------------------------------

  describe("memory.delete", () => {
    it("rejects memory.delete without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await expect(
        handlers["memory.delete"]!({ ids: ["mem-1"], _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects memory.delete without any trust level", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await expect(
        handlers["memory.delete"]!({ ids: ["mem-1"] }),
      ).rejects.toThrow("Admin access required");
    });

    it("deletes entries by ID array and returns success count", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.delete"]!({
        ids: ["mem-1", "mem-2"],
        _trustLevel: "admin",
      })) as { deleted: number; failed: number; total: number };

      expect(result.deleted).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.total).toBe(2);
    });

    it("throws on empty ids array", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await expect(
        handlers["memory.delete"]!({ ids: [], _trustLevel: "admin" }),
      ).rejects.toThrow("Missing or empty required parameter: ids");
    });

    it("throws on missing ids parameter", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await expect(
        handlers["memory.delete"]!({ _trustLevel: "admin" }),
      ).rejects.toThrow("Missing or empty required parameter: ids");
    });

    it("handles partial failures (some IDs not found)", async () => {
      let callCount = 0;
      const deps = makeDeps({
        memoryAdapter: {
          delete: vi.fn(async () => {
            callCount++;
            // Second call fails
            if (callCount === 2) return { ok: false, error: new Error("not found") };
            return { ok: true, value: true };
          }),
        } as never,
      });
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.delete"]!({
        ids: ["mem-1", "mem-2", "mem-3"],
        _trustLevel: "admin",
      })) as { deleted: number; failed: number; total: number };

      expect(result.deleted).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.total).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // memory.flush (admin required)
  // -------------------------------------------------------------------------

  describe("memory.flush", () => {
    it("rejects memory.flush without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await expect(
        handlers["memory.flush"]!({ _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects memory.flush without any trust level", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await expect(
        handlers["memory.flush"]!({}),
      ).rejects.toThrow("Admin access required");
    });

    it("flushes entries for tenant scope and returns entriesRemoved", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.flush"]!({
        _trustLevel: "admin",
      })) as {
        flushed: boolean;
        entriesRemoved: number;
        scope: { tenantId: string; agentId: string | null };
      };

      expect(result.flushed).toBe(true);
      expect(result.entriesRemoved).toBe(3);
      expect(result.scope.tenantId).toBe("default");
      expect(result.scope.agentId).toBeNull();
    });

    it("passes agentId when provided", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.flush"]!({
        agent_id: "custom-agent",
        _trustLevel: "admin",
      })) as { scope: { agentId: string | null } };

      expect(deps.memoryApi.clear).toHaveBeenCalledWith({
        tenantId: "default",
        agentId: "custom-agent",
      });
      expect(result.scope.agentId).toBe("custom-agent");
    });

    it("uses deps.tenantId as default scope", async () => {
      const deps = makeDeps({ tenantId: "my-tenant" });
      const handlers = createMemoryHandlers(deps);

      await handlers["memory.flush"]!({ _trustLevel: "admin" });

      expect(deps.memoryApi.clear).toHaveBeenCalledWith({
        tenantId: "my-tenant",
        agentId: undefined,
      });
    });
  });

  // -------------------------------------------------------------------------
  // memory.export (agent-level access -- no admin required)
  // -------------------------------------------------------------------------

  describe("memory.export", () => {
    it("returns full entries without content truncation", async () => {
      const fullContent = "B".repeat(600);
      const deps = makeDeps({
        memoryApi: {
          inspect: vi.fn(() => [
            {
              id: "mem-full",
              content: fullContent,
              trustLevel: "learned",
              tags: ["export"],
              agentId: "default",
              userId: "user1",
              source: { who: "test" },
              createdAt: Date.now(),
            },
          ]),
          search: vi.fn(async () => []),
          clear: vi.fn(() => 0),
          stats: vi.fn(() => ({})),
          enforceGuardrails: vi.fn(() => null),
        } as never,
      });
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.export"]!({})) as {
        entries: Array<{ id: string; content: string }>;
      };

      expect(result.entries[0]!.content.length).toBe(600);
    });

    it("applies offset/limit pagination", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await handlers["memory.export"]!({ offset: 10, limit: 50 });

      expect(deps.memoryApi.inspect).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 10, limit: 50 }),
      );
    });

    it("passes tenant_id and agent_id filters", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      await handlers["memory.export"]!({
        tenant_id: "custom-tenant",
        agent_id: "custom-agent",
      });

      expect(deps.memoryApi.inspect).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "custom-tenant",
          agentId: "custom-agent",
        }),
      );
    });

    it("returns total, offset, and limit in response", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.export"]!({})) as {
        total: number;
        offset: number;
        limit: number;
      };

      expect(result.total).toBe(1);
      expect(result.offset).toBe(0);
      expect(result.limit).toBe(1000);
    });

    it("works without _trustLevel (agent-level operation)", async () => {
      const deps = makeDeps();
      const handlers = createMemoryHandlers(deps);

      const result = (await handlers["memory.export"]!({})) as {
        entries: unknown[];
      };

      expect(result.entries.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests for memory.store - write validation
// ---------------------------------------------------------------------------

describe("memory.store - write validation", () => {
  it("stores normally without validator (backwards compat)", async () => {
    const deps = makeDeps();
    const handlers = createMemoryHandlers(deps);

    const result = (await handlers["memory.store"]!({
      content: "safe content",
    })) as { stored: boolean; id: string };

    expect(result.stored).toBe(true);
    expect(deps.memoryAdapter.store).toHaveBeenCalledWith(
      expect.objectContaining({
        trustLevel: "learned",
        content: "safe content",
      }),
    );
  });

  it("stores with trustLevel learned when validator returns clean", async () => {
    const deps = makeDeps({
      memoryWriteValidator: vi.fn(() => ({
        severity: "clean" as const,
        patterns: [],
        criticalPatterns: [],
      })),
    });
    const handlers = createMemoryHandlers(deps);

    await handlers["memory.store"]!({ content: "clean content" });

    expect(deps.memoryAdapter.store).toHaveBeenCalledWith(
      expect.objectContaining({
        trustLevel: "learned",
      }),
    );
    // Should NOT include security-tainted tag
    const storeCall = (deps.memoryAdapter.store as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { tags: string[] };
    expect(storeCall.tags).not.toContain("security-tainted");
  });

  it("downgrades trust to external and adds security-tainted tag on warn", async () => {
    const deps = makeDeps({
      memoryWriteValidator: vi.fn(() => ({
        severity: "warn" as const,
        patterns: ["some-pattern"],
        criticalPatterns: [],
      })),
      eventBus: { emit: vi.fn() },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const handlers = createMemoryHandlers(deps);

    await handlers["memory.store"]!({ content: "suspicious content" });

    expect(deps.memoryAdapter.store).toHaveBeenCalledWith(
      expect.objectContaining({
        trustLevel: "external",
      }),
    );
    const storeCall = (deps.memoryAdapter.store as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { tags: string[] };
    expect(storeCall.tags).toContain("security-tainted");
  });

  it("blocks storage and throws on critical severity", async () => {
    const deps = makeDeps({
      memoryWriteValidator: vi.fn(() => ({
        severity: "critical" as const,
        patterns: ["critical-pattern"],
        criticalPatterns: ["critical-pattern"],
      })),
      eventBus: { emit: vi.fn() },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const handlers = createMemoryHandlers(deps);

    await expect(
      handlers["memory.store"]!({ content: "dangerous content" }),
    ).rejects.toThrow("Memory store blocked: content contains critical security patterns");

    // memoryAdapter.store should NOT have been called
    expect(deps.memoryAdapter.store).not.toHaveBeenCalled();
  });

  it("emits security:memory_tainted event on warn with blocked: false", async () => {
    const mockEmit = vi.fn();
    const deps = makeDeps({
      memoryWriteValidator: vi.fn(() => ({
        severity: "warn" as const,
        patterns: ["warn-pattern"],
        criticalPatterns: [],
      })),
      eventBus: { emit: mockEmit },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const handlers = createMemoryHandlers(deps);

    await handlers["memory.store"]!({ content: "warn content" });

    expect(mockEmit).toHaveBeenCalledWith(
      "security:memory_tainted",
      expect.objectContaining({
        originalTrustLevel: "learned",
        adjustedTrustLevel: "external",
        patterns: ["warn-pattern"],
        blocked: false,
      }),
    );
  });

  it("emits security:memory_tainted event on critical with blocked: true", async () => {
    const mockEmit = vi.fn();
    const deps = makeDeps({
      memoryWriteValidator: vi.fn(() => ({
        severity: "critical" as const,
        patterns: ["critical-pattern"],
        criticalPatterns: ["critical-pattern"],
      })),
      eventBus: { emit: mockEmit },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const handlers = createMemoryHandlers(deps);

    await expect(
      handlers["memory.store"]!({ content: "critical content" }),
    ).rejects.toThrow();

    expect(mockEmit).toHaveBeenCalledWith(
      "security:memory_tainted",
      expect.objectContaining({
        adjustedTrustLevel: "blocked",
        patterns: ["critical-pattern"],
        blocked: true,
      }),
    );
  });

  it("calls logger.warn on warn severity, logger.info on critical block", async () => {
    const mockWarn = vi.fn();
    const mockInfo = vi.fn();

    // Test WARN path
    const warnDeps = makeDeps({
      memoryWriteValidator: vi.fn(() => ({
        severity: "warn" as const,
        patterns: ["warn-pattern"],
        criticalPatterns: [],
      })),
      eventBus: { emit: vi.fn() },
      logger: { warn: mockWarn, info: mockInfo },
    });
    const warnHandlers = createMemoryHandlers(warnDeps);
    await warnHandlers["memory.store"]!({ content: "warn content" });

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Memory content tainted: trust downgraded from learned to external",
        errorKind: "validation",
      }),
      "Memory write tainted: suspicious patterns detected",
    );

    // Test CRITICAL path
    const criticalWarn = vi.fn();
    const criticalInfo = vi.fn();
    const critDeps = makeDeps({
      memoryWriteValidator: vi.fn(() => ({
        severity: "critical" as const,
        patterns: ["crit-pattern"],
        criticalPatterns: ["crit-pattern"],
      })),
      eventBus: { emit: vi.fn() },
      logger: { warn: criticalWarn, info: criticalInfo },
    });
    const critHandlers = createMemoryHandlers(critDeps);
    await expect(
      critHandlers["memory.store"]!({ content: "critical content" }),
    ).rejects.toThrow();

    expect(criticalInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        patterns: ["crit-pattern"],
      }),
      "Memory store blocked: critical security patterns detected",
    );
  });

  it("works without _trustLevel (agent-level operation)", async () => {
    const deps = makeDeps();
    const handlers = createMemoryHandlers(deps);

    const result = (await handlers["memory.store"]!({
      content: "agent store content",
    })) as { stored: boolean };

    expect(result.stored).toBe(true);
  });
});
