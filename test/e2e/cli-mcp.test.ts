// SPDX-License-Identifier: Apache-2.0
/**
 * E2E: `comis mcp` CLI subprocess ↔ real test daemon (Phase 65 OPUX-01..07
 * + ROADMAP success criterion 5).
 *
 * Spawns the BUILT CLI (`packages/cli/dist/cli.js`) as a child process and
 * drives it against a real daemon booted via `test/support/daemon-harness`.
 * This is the primary functional proof of the operator MCP CLI surface that
 * Plan 02 could only unit-test (token resolution): a full
 * connect → list → status → reconnect → disconnect round-trip plus the
 * test-probe (non-persisting) path and the missing-token negative case.
 *
 * Criterion 5 (restart durability): after `mcp connect` persists a server to
 * the daemon's config YAML, the daemon is town down and re-started against the
 * SAME config file. The daemon auto-connects persisted MCP servers at boot
 * (setup-mcp.ts), so `mcp list` after restart shows the server reconnected —
 * proving the YAML round-trip survived a restart.
 *
 * Real MCP server: `mcp.connect` against a real daemon (production MCP SDK)
 * needs a genuine MCP server to complete the stdio handshake. The fixture
 * `test/support/mcp-test-server.mjs` is spawned via `node` as the connect
 * `--command`; it advertises two tools (echo, ping).
 *
 * Isolation: the daemon writes persistence to its `COMIS_CONFIG_PATHS`, so a
 * FRESH tmp config (unique gateway port) is used per run — never the tracked
 * `config.test.yaml`. The CLI subprocess connects over a real localhost WS;
 * `withClient` refuses real sockets under VITEST unless `COMIS_CLI_E2E=true`,
 * which every spawn sets (RESEARCH anti-pattern 990).
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** The built CLI entrypoint the subprocess runs (per CLAUDE.md: not on PATH). */
const CLI_PATH = resolve(__dirname, "../../packages/cli/dist/cli.js");
/** The real stdio MCP server fixture the daemon spawns on connect. */
const MCP_SERVER_FIXTURE = resolve(__dirname, "../support/mcp-test-server.mjs");

/** Unique gateway port for this suite (avoids colliding with the 4766 default). */
const GATEWAY_PORT = 47662;

// ---------------------------------------------------------------------------
// Tmp config — a self-contained daemon config the daemon may freely persist
// into. Mirrors the minimal shape of config.test.yaml with an empty MCP
// servers array and this suite's unique port.
// ---------------------------------------------------------------------------

function writeTmpConfig(dir: string, port: number): string {
  const configPath = join(dir, "config.yaml");
  const yaml = [
    'tenantId: "test"',
    'logLevel: "debug"',
    'dataDir: ""',
    "agents:",
    "  default:",
    '    name: "TestAgent"',
    "    model: default",
    "    provider: default",
    "    maxSteps: 10",
    "    rag:",
    "      enabled: false",
    "gateway:",
    "  enabled: true",
    '  host: "127.0.0.1"',
    `  port: ${port}`,
    "  tokens:",
    '    - id: "test-token"',
    '      secret: "test-secret-key-for-cli-mcp-e2e-suite-32plus"',
    '      scopes: ["rpc", "ws", "admin"]',
    "  rateLimit:",
    "    windowMs: 60000",
    "    maxRequests: 10000",
    "memory:",
    '  dbPath: "test-cli-mcp-e2e.db"',
    "integrations:",
    "  mcp:",
    "    servers: []",
    "monitoring:",
    "  disk:",
    "    enabled: false",
    "  resources:",
    "    enabled: false",
    "  systemd:",
    "    enabled: false",
    "  securityUpdates:",
    "    enabled: false",
    "  git:",
    "    enabled: false",
    "models:",
    "  defaultProvider: anthropic",
    "",
  ].join("\n");
  writeFileSync(configPath, yaml, { mode: 0o600 });
  return configPath;
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

describe("E2E: comis mcp CLI ↔ real daemon", () => {
  let handle: TestDaemonHandle;
  let tmpDir: string;
  let configPath: string;
  /** A token-less HOME so ensureGatewayToken cannot read a real ~/.comis/.env. */
  let emptyHome: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-mcp-e2e-"));
    configPath = writeTmpConfig(tmpDir, GATEWAY_PORT);
    emptyHome = join(tmpDir, "empty-home");
    mkdirSync(emptyHome, { recursive: true });
    handle = await startTestDaemon({ configPath, gatewayPort: GATEWAY_PORT });
  }, 60_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);

  /**
   * Spawn the built CLI as a child process. The subprocess inherits the parent
   * env PLUS the gateway URL/token + COMIS_CLI_E2E (so withClient opens a real
   * socket under VITEST). Resolves on close with the captured stdout/stderr and
   * exit code.
   */
  function runCli(args: string[]): Promise<CliResult> {
    return new Promise((resolveProc, rejectProc) => {
      const child = spawn(process.execPath, [CLI_PATH, ...args], {
        env: {
          ...process.env,
          COMIS_GATEWAY_URL: `ws://127.0.0.1:${handle.daemon.container.config.gateway.port}/ws`,
          COMIS_GATEWAY_TOKEN: handle.authToken,
          COMIS_CLI_E2E: "true",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("close", (code) => resolveProc({ stdout, stderr, code: code ?? 0 }));
      child.on("error", rejectProc);
    });
  }

  /**
   * OPUX-07 negative path: spawn the CLI with NO gateway token AND a HOME that
   * has no ~/.comis/.env, so ensureGatewayToken cannot resolve a token from any
   * source and must surface the named-env-var error.
   */
  function runCliNoToken(args: string[]): Promise<CliResult> {
    return new Promise((resolveProc, rejectProc) => {
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      delete env["COMIS_GATEWAY_TOKEN"];
      env["HOME"] = emptyHome;
      env["COMIS_GATEWAY_URL"] = `ws://127.0.0.1:${handle.daemon.container.config.gateway.port}/ws`;
      env["COMIS_CLI_E2E"] = "true";
      const child = spawn(process.execPath, [CLI_PATH, ...args], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("close", (code) => resolveProc({ stdout, stderr, code: code ?? 0 }));
      child.on("error", rejectProc);
    });
  }

  /** Connect args for the real test MCP server fixture (stdio via node). */
  const connectArgs = (name: string, extra: string[] = []) => [
    "mcp",
    "connect",
    name,
    "--transport",
    "stdio",
    "--command",
    process.execPath,
    "--args",
    MCP_SERVER_FIXTURE,
    "--format",
    "json",
    ...extra,
  ];

  // -------------------------------------------------------------------------
  // OPUX-01 — list against an empty config
  // -------------------------------------------------------------------------

  it("OPUX-01: mcp list --format json on an empty config → code 0, servers:[] total:0", async () => {
    const result = await runCli(["mcp", "list", "--format", "json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { servers: unknown[]; total: number };
    expect(parsed.servers).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // OPUX-07 — missing token surfaces a named error (negative, no token)
  // -------------------------------------------------------------------------

  it("OPUX-07: mcp list with no token → non-zero exit + 'Missing COMIS_GATEWAY_TOKEN' on stderr", async () => {
    const result = await runCliNoToken(["mcp", "list", "--format", "json"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Missing COMIS_GATEWAY_TOKEN");
    // The error must not be a generic 401 / unauthorized.
    expect(result.stderr.toLowerCase()).not.toContain("401");
  });

  // -------------------------------------------------------------------------
  // OPUX-03/04/05/02 — connect → list → status → reconnect → disconnect
  // -------------------------------------------------------------------------

  it("OPUX-03: mcp connect persists a server and reports a non-zero tool count", async () => {
    const result = await runCli(connectArgs("test-server"));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      name: string;
      status: string;
      toolCount: number;
      tools: string[];
      persistence?: string;
    };
    expect(parsed.name).toBe("test-server");
    expect(parsed.status).toBe("connected");
    expect(parsed.toolCount).toBe(2);
    expect(parsed.tools).toEqual(expect.arrayContaining(["echo", "ping"]));
    // Persisted to the config YAML (the durability precondition for restart).
    expect(parsed.persistence).toBe("persisted");
  });

  it("OPUX-01: mcp list after connect shows test-server", async () => {
    const result = await runCli(["mcp", "list", "--format", "json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      servers: Array<{ name: string; status: string; toolCount: number }>;
      total: number;
    };
    const entry = parsed.servers.find((s) => s.name === "test-server");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("connected");
    expect(parsed.total).toBeGreaterThanOrEqual(1);
  });

  it("OPUX-02: mcp status test-server reports a detailed status with the tool list", async () => {
    const result = await runCli(["mcp", "status", "test-server", "--format", "json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      name: string;
      status: string;
      toolCount: number;
      tools: Array<{ name: string }>;
      capabilities?: Record<string, unknown>;
    };
    expect(parsed.name).toBe("test-server");
    expect(parsed.status).toBe("connected");
    expect(parsed.toolCount).toBe(2);
    expect(parsed.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["echo", "ping"]));
  });

  it("OPUX-05: mcp reconnect test-server (no override params) → code 0, reconnected", async () => {
    const result = await runCli(["mcp", "reconnect", "test-server", "--format", "json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      name: string;
      status: string;
      toolCount: number;
    };
    expect(parsed.name).toBe("test-server");
    expect(parsed.status).toBe("connected");
    expect(parsed.toolCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // OPUX-06 — test probe does NOT persist (namespaced internally)
  // -------------------------------------------------------------------------

  it("OPUX-06: mcp test probes WITHOUT persisting (scratch absent from list)", async () => {
    const probe = await runCli([
      "mcp",
      "test",
      "scratch",
      "--transport",
      "stdio",
      "--command",
      process.execPath,
      "--args",
      MCP_SERVER_FIXTURE,
      "--format",
      "json",
    ]);
    expect(probe.code).toBe(0);
    const parsed = JSON.parse(probe.stdout) as {
      success: boolean;
      toolCount?: number;
      tools?: string[];
    };
    expect(parsed.success).toBe(true);
    expect(parsed.toolCount).toBe(2);

    // The probe must NOT have registered "scratch" as a persistent server.
    const list = await runCli(["mcp", "list", "--format", "json"]);
    const parsedList = JSON.parse(list.stdout) as { servers: Array<{ name: string }> };
    expect(parsedList.servers.find((s) => s.name === "scratch")).toBeUndefined();
    // The internal __test__ namespace is never surfaced either.
    expect(parsedList.servers.find((s) => s.name.includes("scratch"))).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Criterion 5 — restart durability: persisted YAML survives a daemon restart
  // and the server auto-reconnects on the fresh daemon.
  // -------------------------------------------------------------------------

  it("Criterion 5: connected server is persisted to config YAML (durability precondition)", () => {
    // mcp.connect persisted the entry earlier; assert the on-disk YAML carries
    // it (the round-trip durability proof, independent of runtime state).
    const persisted = parseYaml(readFileSync(configPath, "utf-8")) as {
      integrations?: { mcp?: { servers?: Array<{ name: string; transport: string; command: string }> } };
    };
    const servers = persisted.integrations?.mcp?.servers ?? [];
    const entry = servers.find((s) => s.name === "test-server");
    expect(entry).toBeDefined();
    expect(entry!.transport).toBe("stdio");
    expect(entry!.command).toBe(process.execPath);
  });

  it("Criterion 5: after a daemon restart, the persisted server auto-reconnects (mcp list shows it)", async () => {
    // Tear down the running daemon (releases the double-start guard + port).
    await handle.cleanup();

    // Re-boot against the SAME config file. setup-mcp.ts auto-connects every
    // enabled entry in integrations.mcp.servers at boot, so the persisted
    // test-server reconnects without any CLI action.
    handle = await startTestDaemon({ configPath, gatewayPort: GATEWAY_PORT });

    const result = await runCli(["mcp", "list", "--format", "json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      servers: Array<{ name: string; status: string; toolCount: number }>;
    };
    const entry = parsed.servers.find((s) => s.name === "test-server");
    expect(entry).toBeDefined();
    // Auto-reconnected on boot from the persisted YAML.
    expect(entry!.status).toBe("connected");
    expect(entry!.toolCount).toBe(2);
  }, 60_000);

  // -------------------------------------------------------------------------
  // OPUX-04 — disconnect removes the server (after the restart assertions)
  // -------------------------------------------------------------------------

  it("OPUX-04: mcp disconnect test-server → code 0, removed from list", async () => {
    const result = await runCli(["mcp", "disconnect", "test-server", "--format", "json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { status: string; persistence?: string };
    expect(parsed.status).toBe("disconnected");

    const list = await runCli(["mcp", "list", "--format", "json"]);
    const parsedList = JSON.parse(list.stdout) as { servers: Array<{ name: string }> };
    expect(parsedList.servers.find((s) => s.name === "test-server")).toBeUndefined();
  });
});
