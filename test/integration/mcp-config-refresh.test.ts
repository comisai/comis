// SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for the in-memory config refresh +
 * trailing-edge config:mutated debounce.
 *
 * Exercises the @comis/daemon barrel (via dist/) end-to-end:
 *   - In-memory swap: container.config.integrations.mcp.servers reflects
 *     connect params (including schema fields keepaliveIntervalMs +
 *     circuitBreakerThreshold + circuitBreakerCooldownMs that flow through
 *     the structuredClone swap at mcp-handlers.ts:persistMcpServers)
 *   - Debounce coalesce: 3 rapid mcp.connect calls within the 500ms debounce
 *     window collapse into ONE config:mutated event with the merged
 *     { added: [a, b, c], removed: [] } diff
 *
 * Mirrors the harness shape from test/integration/mcp-persistence.test.ts:
 * tmpdir per test, real createMcpHandlers, mocked McpClientManager + audit
 * log. The new test seam `_resetConfigMutatedCoalescer` runs in beforeEach
 * alongside `_resetSigusr1Timer` + `_resetMutationFence` so the process-wide
 * coalescer state (pendingAdded / pendingRemoved Maps + armed timer) does
 * NOT leak across tests.
 *
 * Per CLAUDE.md: integration tests import from `dist/`; requires `pnpm build`.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

import {
  createMcpHandlers,
  _resetSigusr1Timer,
  _resetMutationFence,
  _resetConfigMutatedCoalescer,
} from "@comis/daemon";

// ---------------------------------------------------------------------------
// Test harness — fixtures + helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let configPath: string;
let auditLogPath: string;

/** Minimal McpClientManager double — the spawn is NOT the SUT. */
function makeMockManager() {
  const connections = new Map<string, { name: string; config: unknown; tools: { name: string }[] }>();
  return {
    connect: vi.fn(async (cfg: { name: string }) => {
      connections.set(cfg.name, { name: cfg.name, config: cfg, tools: [] });
      return {
        ok: true as const,
        value: {
          name: cfg.name,
          status: "connected" as const,
          tools: [],
          client: null,
          lastHealthCheck: 1700000000000,
          reconnectAttempt: 0,
          maxReconnectAttempts: 5,
          generation: 0,
        },
      };
    }),
    disconnect: vi.fn(async (name: string) => {
      connections.delete(name);
    }),
    disconnectAll: vi.fn(async () => {
      connections.clear();
    }),
    getConnection: vi.fn((name: string) => {
      const c = connections.get(name);
      if (!c) return undefined;
      return {
        name: c.name,
        status: "connected" as const,
        tools: c.tools,
        client: null,
        lastHealthCheck: 1700000000000,
        reconnectAttempt: 0,
        maxReconnectAttempts: 5,
        generation: 0,
      };
    }),
    getAllConnections: vi.fn(() => Array.from(connections.values())),
    getTools: vi.fn(() => []),
    callTool: vi.fn(),
    reconnect: vi.fn(),
  };
}

function makeLogger() {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    level: "debug",
    isLevelEnabled: vi.fn(() => true),
  };
  logger.child = vi.fn(() => logger);
  return logger;
}

function makeContainer(initialConfig: unknown) {
  return {
    config: initialConfig,
    eventBus: {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    tenantId: "test-tenant",
  };
}

function makePersistDeps(container: ReturnType<typeof makeContainer>) {
  return {
    container,
    configPaths: [configPath],
    defaultConfigPaths: [configPath],
    configGitManager: undefined,
    logger: makeLogger(),
  } as never;
}

beforeEach(() => {
  // Process-wide state seams MUST reset every test (mirrors the coalescer
  // module + the persist-to-config.ts:72/99 precedent).
  _resetSigusr1Timer();
  _resetMutationFence();
  _resetConfigMutatedCoalescer();
  tempDir = mkdtempSync(join(tmpdir(), "mcp-config-refresh-int-"));
  configPath = join(tempDir, "config.yaml");
  auditLogPath = join(tempDir, "config-audit.jsonl");
  // Seed with a non-MCP field so AppConfigSchema.safeParse is happy.
  writeFileSync(configPath, "logLevel: info\n", { mode: 0o600 });
  process.env.COMIS_CONFIG_AUDIT_LOG = auditLogPath;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.COMIS_CONFIG_AUDIT_LOG;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests — schema-additions wiring
// ---------------------------------------------------------------------------

describe("in-memory config swap carries new schema fields", () => {
  it("container.config.integrations.mcp.servers[*].keepaliveIntervalMs reflects connect param", async () => {
    const initialConfig = parseYaml("logLevel: info\n");
    const container = makeContainer(initialConfig);
    const manager = makeMockManager();
    const handlers = createMcpHandlers({
      mcpClientManager: manager as never,
      logger: makeLogger(),
      container: container as never,
      persistDeps: makePersistDeps(container),
      // Top-level eventBus is what persistMcpServers checks before scheduling
      // through the trailing-edge coalescer. (container.eventBus is for the
      // audit:event path; deps.eventBus is the slice that mcp-handlers reads
      // at the swap site.)
      eventBus: container.eventBus,
    } as never);

    await handlers["mcp.connect"]!({
      server_name: "test-server",
      transport: "stdio",
      command: "/usr/bin/test",
      keepaliveIntervalMs: 60_000,
    } as never);

    const servers = (container.config as {
      integrations: { mcp: { servers: Array<{ name: string; keepaliveIntervalMs?: number }> } };
    }).integrations.mcp.servers;
    const entry = servers.find((s) => s.name === "test-server");
    expect(entry).toBeDefined();
    expect(entry!.keepaliveIntervalMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Tests — trailing-edge 500ms debounce coalesce
// ---------------------------------------------------------------------------

describe("config:mutated 500ms debounce coalesce", () => {
  it("debounces 3 connects within 100ms into one config:mutated event", async () => {
    vi.useFakeTimers();

    const initialConfig = parseYaml("logLevel: info\n");
    const container = makeContainer(initialConfig);
    const manager = makeMockManager();
    const handlers = createMcpHandlers({
      mcpClientManager: manager as never,
      logger: makeLogger(),
      container: container as never,
      persistDeps: makePersistDeps(container),
      // Top-level eventBus is what persistMcpServers checks before scheduling
      // through the trailing-edge coalescer. (container.eventBus is for the
      // audit:event path; deps.eventBus is the slice that mcp-handlers reads
      // at the swap site.)
      eventBus: container.eventBus,
    } as never);

    // 3 rapid connects — fired one after the other (all within the 500ms
    // debounce window). The structuredClone swap fires synchronously per
    // call; the coalescer.schedule reset its timer each call so only ONE
    // emit fires at the trailing edge.
    await handlers["mcp.connect"]!({
      server_name: "a", transport: "stdio", command: "/usr/bin/test",
    } as never);
    await handlers["mcp.connect"]!({
      server_name: "b", transport: "stdio", command: "/usr/bin/test",
    } as never);
    await handlers["mcp.connect"]!({
      server_name: "c", transport: "stdio", command: "/usr/bin/test",
    } as never);

    // Inside the 500ms window -- no emit yet.
    const emit = container.eventBus.emit as ReturnType<typeof vi.fn>;
    const callsBefore = emit.mock.calls.filter((c) => c[0] === "config:mutated");
    expect(callsBefore).toHaveLength(0);

    // Advance past the trailing-edge window.
    await vi.advanceTimersByTimeAsync(500);
    // Flush microtasks scheduled by the timer body.
    await Promise.resolve();

    const callsAfter = emit.mock.calls.filter((c) => c[0] === "config:mutated");
    expect(callsAfter).toHaveLength(1);
    expect(callsAfter[0]![1]).toMatchObject({
      path: "integrations.mcp.servers",
      added: expect.arrayContaining([
        expect.objectContaining({ name: "a" }),
        expect.objectContaining({ name: "b" }),
        expect.objectContaining({ name: "c" }),
      ]),
      removed: [],
    });
  });
});
