// SPDX-License-Identifier: Apache-2.0
//
// MCP install persistence -- integration test.
//
// Exercises the REAL persistToConfig + appendConfigAuditWithOutcome pipeline
// against a tmpdir config path. The unit tests in
// packages/daemon/src/api/mcp-handlers.test.ts mock persistToConfig and only
// assert call-args; this integration test catches what mocks cannot:
//
//   - R1: connect persists the new entry to integrations.mcp.servers via
//     real YAML round-trip
//   - R2: disconnect filters the named entry from the array via real YAML
//   - R3: bootstrap round-trip (in-process simulated restart re-reads the
//     persisted YAML and reconnect succeeds without override params)
//   - R5: literal $\{KEY\} env-ref preserved through deepMerge + YAML
//     stringify + YAML parse (no secret leakage into config.yaml)
//   - R6: deepMerge array-replacement semantics (re-connecting with the same
//     name overwrites the prior entry)
//   - R8: config-audit JSONL record emitted with
//     event=config.write, callerSource=mcp.connect/mcp.disconnect,
//     result=rename
//   - R11: this test suite IS R11 (the meta-acceptance is "the integration
//     tests cover R3/R5/R6/R8 end-to-end").
//
// NOTE: This test mocks ONLY mcpClientManager.connect /
// mcpClientManager.disconnect / mcpClientManager.getConnection because the
// subprocess spawn is not the SUT -- persistence is. Real subprocess semantics
// (env-var passing, fd inheritance) live in packages/skills.
//
// Imports from dist/ -- requires pnpm build first.
// The vitest workspace alias @comis/* maps to packages/*/dist/index.js.
//
// Module-level state isolation: persistToConfig holds two PROCESS-WIDE
// singletons (sigusr1Timer + pendingConfigMutations fence). Each test
// exercises the real writer, so _resetSigusr1Timer() and
// _resetMutationFence() MUST be called in beforeEach to prevent a prior
// test's armed SIGUSR2 timer from leaking into the next one (per the module
// docs at packages/daemon/src/api/shared/persist-to-config.ts:12-43).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

import {
  createMcpHandlers,
  _resetSigusr1Timer,
  _resetMutationFence,
} from "@comis/daemon";
import type { ConfigWriteAuditRecord } from "@comis/observability";

// ───────────────────────────────────────────────────────────────────
// Test harness — fixtures + helpers
// ───────────────────────────────────────────────────────────────────

let tempDir: string;
let configPath: string;
let auditLogPath: string;

/** Minimal McpClientManager double — the spawn is NOT the SUT. */
function makeMockManager() {
  // Map of name → { config, tools } simulating the manager's in-memory store.
  const connections = new Map<string, { name: string; config: unknown; tools: { name: string }[] }>();
  const manager = {
    connect: vi.fn(async (cfg: { name: string }) => {
      connections.set(cfg.name, {
        name: cfg.name,
        config: cfg,
        // R11 acceptance: toolCount === 20.
        tools: Array.from({ length: 20 }, (_, i) => ({ name: `tool${i}` })),
      });
      return {
        ok: true as const,
        value: {
          name: cfg.name,
          status: "connected" as const,
          tools: connections.get(cfg.name)!.tools,
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
    reconnect: vi.fn(async (name: string) => {
      const c = connections.get(name);
      if (!c) return { ok: false as const, error: new Error(`MCP server "${name}" has no stored config -- use connect() instead`) };
      return {
        ok: true as const,
        value: {
          name,
          status: "connected" as const,
          tools: c.tools,
          client: null,
          lastHealthCheck: 1700000000000,
          reconnectAttempt: 0,
          maxReconnectAttempts: 5,
          generation: 0,
        },
      };
    }),
  };
  return manager;
}

function makeContainer(initialConfig: unknown) {
  return {
    config: initialConfig,
    eventBus: {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    },
    // Minimal AppContainer fields. The integration test only exercises the
    // path through persistToConfig, which reads container.config (for deep
    // merge baseline) and container.eventBus (for audit:event emission).
    tenantId: "test-tenant",
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
    child: vi.fn(() => logger),
  };
  return logger;
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

/** Read all JSONL records from the audit log; returns [] if the file does not exist. */
function readAuditRecords(): ConfigWriteAuditRecord[] {
  if (!existsSync(auditLogPath)) return [];
  const raw = readFileSync(auditLogPath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ConfigWriteAuditRecord);
}

beforeEach(() => {
  // Process-wide state resets — see persist-to-config.ts:12-43.
  _resetSigusr1Timer();
  _resetMutationFence();
  // Fresh tmpdir per test for full isolation.
  tempDir = mkdtempSync(join(tmpdir(), "mcp-persist-int-"));
  configPath = join(tempDir, "config.yaml");
  auditLogPath = join(tempDir, "config-audit.jsonl");
  // Seed config with a non-MCP field so AppConfigSchema.safeParse is happy.
  writeFileSync(configPath, "logLevel: info\n", { mode: 0o600 });
  process.env.COMIS_CONFIG_AUDIT_LOG = auditLogPath;
});

afterEach(() => {
  // Always clean up — `force: true` survives partial failures.
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.COMIS_CONFIG_AUDIT_LOG;
});

// ───────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────

describe("MCP install persistence (real persistToConfig + audit JSONL)", () => {
  it("R1+R5+R8: mcp.connect persists env-ref unresolved + emits config-audit JSONL record", async () => {
    const container = makeContainer(parseYaml(readFileSync(configPath, "utf-8")));
    const manager = makeMockManager();
    const handlers = createMcpHandlers({
      mcpClientManager: manager as never,
      logger: makeLogger(),
      container: container as never,
      persistDeps: makePersistDeps(container),
    } as never);

    const result = await handlers["mcp.connect"]!({
      server_name: "yfinance",
      transport: "stdio",
      command: "npx",
      args: ["yfinance-mcp-ts"],
      env: { PROXY: "${YFINANCE_PROXY_LIST}" },
    } as never) as { persistence: string; warning?: string };

    expect(result.persistence).toBe("persisted");
    expect(result.warning).toBeUndefined();

    // R1: YAML contains exactly one new entry under integrations.mcp.servers.
    const persistedYaml = parseYaml(readFileSync(configPath, "utf-8")) as {
      integrations?: { mcp?: { servers?: unknown[] } };
    };
    expect(persistedYaml.integrations?.mcp?.servers).toHaveLength(1);
    const persistedEntry = persistedYaml.integrations!.mcp!.servers![0] as {
      name: string;
      transport: string;
      command: string;
      args: string[];
      env: { PROXY: string };
      enabled: boolean;
    };
    expect(persistedEntry.name).toBe("yfinance");
    expect(persistedEntry.transport).toBe("stdio");
    expect(persistedEntry.command).toBe("npx");
    expect(persistedEntry.args).toEqual(["yfinance-mcp-ts"]);
    expect(persistedEntry.enabled).toBe(true);

    // R5: the literal `${KEY}` reference round-trips through real YAML
    // stringify + YAML parse unchanged. Secret value never appears in YAML.
    expect(persistedEntry.env.PROXY).toBe("${YFINANCE_PROXY_LIST}");

    // R8: one JSONL record with the SPEC-locked field shape.
    const records = readAuditRecords();
    const mcpRecords = records.filter(
      (r) => (r as { callerSource?: string }).callerSource === "mcp.connect",
    );
    expect(mcpRecords).toHaveLength(1);
    expect(mcpRecords[0]).toMatchObject({
      event: "config.write",
      callerSource: "mcp.connect",
      result: "rename",
    });
    // R8 hash-diff: previousHash and nextHash both present and DIFFERENT
    // (the file content changed).
    const record = mcpRecords[0] as {
      previousHash?: string;
      nextHash?: string;
    };
    expect(typeof record.previousHash).toBe("string");
    expect(typeof record.nextHash).toBe("string");
    expect(record.previousHash).not.toBe(record.nextHash);
  });

  it("R6: re-calling connect with the same name overwrites the prior entry (deepMerge array-replacement)", async () => {
    const container = makeContainer(parseYaml(readFileSync(configPath, "utf-8")));
    const manager = makeMockManager();
    const handlers = createMcpHandlers({
      mcpClientManager: manager as never,
      logger: makeLogger(),
      container: container as never,
      persistDeps: makePersistDeps(container),
    } as never);

    // First connect — v1 args.
    await handlers["mcp.connect"]!({
      server_name: "yfinance",
      transport: "stdio",
      command: "npx",
      args: ["yfinance-mcp-ts"],
    } as never);

    // Refresh in-memory container.config from the on-disk YAML so the
    // second connect's read-current baseline reflects the just-persisted
    // state (simulates the daemon's bootstrap-then-mutation pattern).
    container.config = parseYaml(readFileSync(configPath, "utf-8"));

    // Second connect — v2 args (different from v1).
    await handlers["mcp.connect"]!({
      server_name: "yfinance",
      transport: "stdio",
      command: "npx",
      args: ["yfinance-mcp-ts", "--verbose"],
    } as never);

    const finalYaml = parseYaml(readFileSync(configPath, "utf-8")) as {
      integrations?: { mcp?: { servers?: unknown[] } };
    };
    // R6 invariant: exactly ONE entry where name === "yfinance".
    expect(finalYaml.integrations?.mcp?.servers).toHaveLength(1);
    const finalEntry = finalYaml.integrations!.mcp!.servers![0] as {
      name: string;
      args: string[];
    };
    expect(finalEntry.name).toBe("yfinance");
    // The SECOND call's args win — the deepMerge array-replacement worked.
    expect(finalEntry.args).toEqual(["yfinance-mcp-ts", "--verbose"]);

    // JSONL: TWO config.write records, each tagged callerSource: mcp.connect.
    const records = readAuditRecords();
    const mcpRecords = records.filter(
      (r) => (r as { callerSource?: string }).callerSource === "mcp.connect",
    );
    expect(mcpRecords).toHaveLength(2);
  });

  it("R2+R8: mcp.disconnect removes the entry from YAML and emits a 'mcp.disconnect' audit record", async () => {
    const container = makeContainer(parseYaml(readFileSync(configPath, "utf-8")));
    const manager = makeMockManager();
    const handlers = createMcpHandlers({
      mcpClientManager: manager as never,
      logger: makeLogger(),
      container: container as never,
      persistDeps: makePersistDeps(container),
    } as never);

    // Pre-seed: connect first so there is an entry to remove.
    await handlers["mcp.connect"]!({
      server_name: "yfinance",
      transport: "stdio",
      command: "npx",
      args: [],
    } as never);
    container.config = parseYaml(readFileSync(configPath, "utf-8"));

    // Disconnect.
    const result = await handlers["mcp.disconnect"]!({
      server_name: "yfinance",
    } as never) as { persistence: string };
    expect(result.persistence).toBe("persisted");

    // R2: the array slot remains, but with empty array (NOT undefined).
    const finalYaml = parseYaml(readFileSync(configPath, "utf-8")) as {
      integrations?: { mcp?: { servers?: unknown[] } };
    };
    expect(finalYaml.integrations?.mcp?.servers).toEqual([]);

    // R8: exactly one mcp.disconnect record (alongside the prior mcp.connect).
    const records = readAuditRecords();
    const disconnectRecords = records.filter(
      (r) => (r as { callerSource?: string }).callerSource === "mcp.disconnect",
    );
    expect(disconnectRecords).toHaveLength(1);
    expect(disconnectRecords[0]).toMatchObject({
      event: "config.write",
      callerSource: "mcp.disconnect",
      result: "rename",
    });
  });

  it("R3+R11: bootstrap round-trip — persist → fresh re-read → reconnect succeeds without override params", async () => {
    // Step 1: original setup — connect + persist.
    const container1 = makeContainer(parseYaml(readFileSync(configPath, "utf-8")));
    const manager1 = makeMockManager();
    const handlers1 = createMcpHandlers({
      mcpClientManager: manager1 as never,
      logger: makeLogger(),
      container: container1 as never,
      persistDeps: makePersistDeps(container1),
    } as never);
    await handlers1["mcp.connect"]!({
      server_name: "yfinance",
      transport: "stdio",
      command: "npx",
      args: ["yfinance-mcp-ts"],
    } as never);

    // Step 2: simulated daemon restart — fresh container, fresh manager,
    // but config is re-read from the same on-disk YAML that Step 1 wrote.
    const reloadedConfig = parseYaml(readFileSync(configPath, "utf-8")) as {
      integrations?: {
        mcp?: { servers?: Array<{ name: string; transport: string; command: string }> };
      };
    };
    // R3 precondition: the persisted entry survived the on-disk round-trip.
    expect(reloadedConfig.integrations?.mcp?.servers).toHaveLength(1);

    const container2 = makeContainer(reloadedConfig);
    const manager2 = makeMockManager();
    // Simulate bootstrap auto-connect: feed the persisted entry into the
    // fresh manager so manager.getConnection returns it for reconnect.
    const persistedEntry = reloadedConfig.integrations!.mcp!.servers![0]!;
    await manager2.connect(persistedEntry as never);

    const handlers2 = createMcpHandlers({
      mcpClientManager: manager2 as never,
      logger: makeLogger(),
      container: container2 as never,
      persistDeps: makePersistDeps(container2),
    } as never);

    // R3 acceptance: reconnect with NO override params succeeds.
    const result = await handlers2["mcp.reconnect"]!({
      server_name: "yfinance",
    } as never) as { name: string; status: string; toolCount: number };

    expect(result).toMatchObject({
      name: "yfinance",
      status: "connected",
    });
    // R11 acceptance: toolCount === 20 from the deterministic mockManager.
    expect(result.toolCount).toBe(20);
  });
});
