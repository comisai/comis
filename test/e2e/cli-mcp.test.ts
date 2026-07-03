// SPDX-License-Identifier: Apache-2.0
/**
 * E2E: `comis mcp` CLI subprocess ↔ real test daemon.
 *
 * Spawns the BUILT CLI (`packages/cli/dist/cli.js`) as a child process and
 * drives it against a real daemon booted via `test/support/daemon-harness`.
 * This is the primary functional proof of the operator MCP CLI surface: a full
 * connect → list → status → reconnect → disconnect round-trip plus the
 * test-probe (non-persisting) path and the missing-token negative case.
 *
 * Restart durability: after `mcp connect` persists a server to
 * the daemon's config YAML, the daemon is torn down and re-started against the
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
 * which every spawn sets.
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
/** The real stdio MCP server fixture the daemon spawns on connect. Lives under
 *  test/support/__fixtures__/ — the eslint-ignored fixtures home — so the
 *  Node globals (`process`) the fixture uses do not trip the security lint. */
const MCP_SERVER_FIXTURE = resolve(__dirname, "../support/__fixtures__/mcp-test-server.mjs");

/** Unique gateway port for this suite (avoids colliding with the 4766 default). */
const GATEWAY_PORT = 47662;

/**
 * Value the daemon resolves `${COMIS_GATEWAY_TOKEN}` to at config load. Set on
 * process.env in beforeAll so the gateway token in the tmp config resolves to a
 * real secret (and `handle.authToken` carries it), while the on-disk YAML keeps
 * the env-ref literal that the persist guard exempts. ≥32 chars to satisfy the
 * gateway-token schema floor.
 */
const GATEWAY_TOKEN_SECRET = "test-secret-key-for-cli-mcp-e2e-suite-32plus";

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
    // Env-ref (NOT inline plaintext) for the gateway token secret. This suite
    // exercises the persist path (`mcp connect` → persistToConfig), which since
    // the security-hardening guard (persist-to-config.ts) refuses to write a
    // config.yaml containing ANY plaintext secret. An inline literal here would
    // abort every persist with `[plaintext_secret_blocked]` → "runtime_only".
    // The `${COMIS_GATEWAY_TOKEN}` ref mirrors the production setup wizard
    // (wizard/steps/10-write-config.ts) and is masked back to its env-ref by the
    // guard's maskRefsFromOnDisk, so the scan exempts it. The env var is set in
    // beforeAll (and survives the daemon env-scrub — COMIS_* is not sensitive).
    '      secret: "${COMIS_GATEWAY_TOKEN}"',
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
  /** Prior COMIS_GATEWAY_TOKEN (restored in afterAll) so the suite leaves env clean. */
  let priorGatewayToken: string | undefined;

  beforeAll(async () => {
    // Set BEFORE boot so the config's `${COMIS_GATEWAY_TOKEN}` ref resolves at
    // load. NOTE: this var does NOT survive boot — while COMIS_* is absent from the
    // stage-1 SENSITIVE_PREFIXES scrub, the daemon's STAGE-2 scrub deletes every
    // config-referenced SecretRef name (`container.platformSecretNames`) from
    // process.env after parse, and this config carries `secret: "${COMIS_GATEWAY_TOKEN}"`.
    // So the restart-durability test's in-process restart RE-SETS it before re-boot (a real process
    // restart's service manager / setup wizard re-provides the env identically).
    priorGatewayToken = process.env["COMIS_GATEWAY_TOKEN"];
    process.env["COMIS_GATEWAY_TOKEN"] = GATEWAY_TOKEN_SECRET;
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
    if (priorGatewayToken === undefined) {
      delete process.env["COMIS_GATEWAY_TOKEN"];
    } else {
      process.env["COMIS_GATEWAY_TOKEN"] = priorGatewayToken;
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
   * Missing-token negative path: spawn the CLI with NO gateway token AND a HOME
   * that has no ~/.comis/.env, so ensureGatewayToken cannot resolve a token from
   * any source and must surface the named-env-var error.
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
  // list against an empty config
  // -------------------------------------------------------------------------

  it("mcp list --format json on an empty config → code 0, servers:[] total:0", async () => {
    const result = await runCli(["mcp", "list", "--format", "json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { servers: unknown[]; total: number };
    expect(parsed.servers).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // missing token surfaces a named error (negative, no token)
  // -------------------------------------------------------------------------

  it("mcp list with no token → non-zero exit + 'Missing COMIS_GATEWAY_TOKEN' on stderr", async () => {
    const result = await runCliNoToken(["mcp", "list", "--format", "json"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Missing COMIS_GATEWAY_TOKEN");
    // The error must not be a generic 401 / unauthorized.
    expect(result.stderr.toLowerCase()).not.toContain("401");
  });

  // -------------------------------------------------------------------------
  // connect → list → status → reconnect → disconnect
  // -------------------------------------------------------------------------

  it("mcp connect persists a server and reports a non-zero tool count", async () => {
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

  it("mcp list after connect shows test-server", async () => {
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

  it("mcp status test-server reports a detailed status with the tool list", async () => {
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

  it("mcp reconnect test-server (no override params) → code 0, reconnected", async () => {
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
  // test probe does NOT persist (namespaced internally)
  // -------------------------------------------------------------------------

  it("mcp test probes WITHOUT persisting (scratch absent from list)", async () => {
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
  // Restart durability: persisted YAML survives a daemon restart
  // and the server auto-reconnects on the fresh daemon.
  // -------------------------------------------------------------------------

  it("connected server is persisted to config YAML (durability precondition for restart)", () => {
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

  it("after a daemon restart, the persisted server auto-reconnects (mcp list shows it)", async () => {
    // Tear down the running daemon (releases the double-start guard + port).
    await handle.cleanup();

    // Re-provide COMIS_GATEWAY_TOKEN: boot-1's stage-2 SecretRef scrub
    // (container.platformSecretNames) deleted it from process.env, so the
    // config's `${COMIS_GATEWAY_TOKEN}` ref would otherwise fail to resolve on
    // re-boot ("Missing env var COMIS_GATEWAY_TOKEN"). A real daemon restart is a
    // fresh process whose service manager / setup wizard supplies the env again;
    // this in-process restart mimics that.
    process.env["COMIS_GATEWAY_TOKEN"] = GATEWAY_TOKEN_SECRET;

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
  // disconnect removes the server (after the restart assertions)
  // -------------------------------------------------------------------------

  it("mcp disconnect test-server → code 0, removed from list", async () => {
    const result = await runCli(["mcp", "disconnect", "test-server", "--format", "json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { status: string; persistence?: string };
    expect(parsed.status).toBe("disconnected");

    const list = await runCli(["mcp", "list", "--format", "json"]);
    const parsedList = JSON.parse(list.stdout) as { servers: Array<{ name: string }> };
    expect(parsedList.servers.find((s) => s.name === "test-server")).toBeUndefined();
  });
});
