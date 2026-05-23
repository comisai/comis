// SPDX-License-Identifier: Apache-2.0
/**
 * sync-tooling CLI integration test.
 *
 * The only daemon-bound test in this suite. Boots a real daemon via
 * `daemon-harness`, runs the BUILT CLI binary against a fixture config,
 * restarts the daemon against the now-mutated config, and asserts the
 * daemon's `Dynamic preamble assembled` Pino debug log fires with
 * `clusterCount >= 2`.
 *
 * End-to-end coverage:
 *  - Test 1: `comis config sync-tooling --write` exits with code 1 and stderr
 *    "daemon is running" while a daemon is up. This is the live-daemon canary
 *    for `daemon-guard.ts`'s `system.ping` probe — if it regresses to
 *    `health.ping`, this test fails.
 *  - Test 2: inspect mode (no `--write`) does NOT trigger the daemon guard;
 *    stdout contains the literal `tooling:`; mtime unchanged.
 *  - Test 3: `--write` (daemon down) materializes a `tooling:` block including
 *    `installDetours.mode: advise` and `capabilityIndex.enabled: true`;
 *    backup file matches the timestamp regex; the backup contents are
 *    byte-equal to the pre-overwrite file.
 *  - Test 4: boot daemon against the synthesized config, trigger preamble
 *    assembly via `agent.execute`, observe the Pino debug log with
 *    `clusterCount >= 2`.
 *
 * Pre-req: `pnpm build` MUST have run before this test — otherwise
 * `packages/cli/dist/cli.js` is stale and the test silently uses old code.
 * The `beforeEach` enforces this with an `existsSync` check that throws a
 * clear error message.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  statSync,
  readFileSync,
  existsSync,
  unlinkSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";
import {
  createLogCapture,
  filterLogs,
  waitForLogEntry,
  type LogEntry,
} from "../support/log-verifier.js";
import {
  DAEMON_STARTUP_MS,
  RPC_LLM_MS,
} from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");
const CLI_BINARY = resolve(REPO_ROOT, "packages/cli/dist/cli.js");
const FIXTURE_SOURCE = resolve(
  REPO_ROOT,
  "test/config/config.test-sync-tooling.yaml",
);

/** Backup filename regex (millisecond ISO + 6-char hex). */
const BACKUP_REGEX =
  /^config\.pre-sync-tooling-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}-[0-9a-f]{6}\.yaml$/;

/** Glob-equivalent prefix for backup files written under ~/.comis/. */
const BACKUP_FILENAME_PREFIX = "config.pre-sync-tooling-";

/** ${COMIS_REPO_ROOT} placeholder in the source fixture. */
const REPO_ROOT_PLACEHOLDER = "${COMIS_REPO_ROOT}";

const execFileAsync = promisify(execFile);

/**
 * Async wrapper around `execFile` that always resolves with
 * `{ exitCode, stdout, stderr }` regardless of the child's exit code.
 *
 * CRITICAL: this MUST be async (not `execFileSync`/`spawnSync`). The
 * integration test boots the daemon IN THE SAME PROCESS as the test runner
 * (daemon-harness imports `@comis/daemon` and calls `main()`). A synchronous
 * child_process call would block the test process's event loop, which is the
 * SAME event loop serving the in-process daemon's WebSocket gateway. The
 * CLI's `withClient` probe would then time out on connection accept and the
 * daemon-active guard would silently fail open.
 */
async function runCli(args: string[], opts: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const r = await execFileAsync("node", [CLI_BINARY, ...args], {
      // VITEST=true propagates to the child; the CLI's withClient refuses
      // real WebSockets unless COMIS_CLI_E2E=true. Opt in so the
      // daemon-active guard can actually probe the test daemon.
      env: { ...process.env, COMIS_CLI_E2E: "true", ...(opts.env ?? {}) },
      timeout: opts.timeoutMs ?? 10_000,
      // Buffer up to 1 MB of output (more than the CLI ever produces).
      maxBuffer: 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  } catch (e) {
    const errObj = e as {
      code?: number | null;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    return {
      exitCode: typeof errObj.code === "number" ? errObj.code : -1,
      stdout: errObj.stdout?.toString() ?? "",
      stderr: errObj.stderr?.toString() ?? "",
    };
  }
}

/**
 * Suppress the "Daemon exit with code N" error that `cleanup()` rethrows on
 * the daemon-harness side. The harness intentionally overrides `process.exit`
 * to throw so the test process is not killed; the cleanup graceful-shutdown
 * path then re-raises that thrown error.
 */
async function cleanupDaemon(handle: TestDaemonHandle): Promise<void> {
  try {
    await handle.cleanup();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Daemon exit with code")) throw err;
  }
}

/**
 * Convert the daemon-harness gateway URL (e.g. http://127.0.0.1:8525) to the
 * WebSocket URL the CLI's `withClient` expects (ws://127.0.0.1:8525/ws).
 */
function toWsGatewayUrl(httpGatewayUrl: string): string {
  const url = new URL(httpGatewayUrl);
  return `ws://${url.hostname}:${url.port}/ws`;
}

/**
 * Read all `~/.comis/config.pre-sync-tooling-*.yaml` files currently on disk.
 * Used in afterEach to clean up backups produced by the test — backups land
 * in the dev's real ~/.comis/ because the CLI resolves homeDir via
 * os.homedir() at runtime.
 */
function listBackupFiles(): string[] {
  const dir = join(homedir(), ".comis");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(
        (e) =>
          e.startsWith(BACKUP_FILENAME_PREFIX) && e.endsWith(".yaml"),
      )
      .map((e) => join(dir, e));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("comis config sync-tooling integration", () => {
  let workDir: string;
  let workConfigPath: string;
  let handle: TestDaemonHandle | undefined;
  let backupSnapshotBefore: Set<string>;

  beforeEach(() => {
    // Refuse to run if the CLI binary is missing. Without this guard a stale
    // dist/ would silently mask src/ edits.
    if (!existsSync(CLI_BINARY)) {
      throw new Error(
        `CLI binary not found at ${CLI_BINARY} — run 'pnpm build' first ` +
          "(integration tests load from packages/*/dist/, not src/).",
      );
    }
    if (!existsSync(FIXTURE_SOURCE)) {
      throw new Error(`Fixture source not found at ${FIXTURE_SOURCE}`);
    }

    // Per-test working directory under the OS temp dir (NOT the repo) — the
    // CLI mutates this file via --write, and we want each test in isolation.
    workDir = mkdtempSync(join(tmpdir(), "comis-sync-tooling-it-"));
    workConfigPath = join(workDir, "config.yaml");

    // Substitute ${COMIS_REPO_ROOT} at copy-time. The CLI's loadConfigFile
    // does NOT expand ${VAR} when called without a getSecret callback (see
    // packages/core/src/config/loader.ts:101-116). The daemon's bootstrap path
    // DOES substitute, but we want both readers to agree on the literal path,
    // so we expand once here. Also keeps the fixture portable across worktrees
    // and CI runners.
    const fixtureContent = readFileSync(FIXTURE_SOURCE, "utf-8").replaceAll(
      REPO_ROOT_PLACEHOLDER,
      REPO_ROOT,
    );
    writeFileSync(workConfigPath, fixtureContent, { mode: 0o600 });

    // Snapshot existing backup files so we can clean up only what THIS test
    // produced. Avoids deleting backups left over from a concurrent test run
    // or from the developer's real CLI usage.
    backupSnapshotBefore = new Set(listBackupFiles());
  });

  afterEach(async () => {
    if (handle !== undefined) {
      await cleanupDaemon(handle);
      handle = undefined;
    }

    // Clean up backup files produced by this test.
    const backupsAfter = listBackupFiles();
    for (const path of backupsAfter) {
      if (!backupSnapshotBefore.has(path)) {
        try {
          unlinkSync(path);
        } catch {
          // best-effort
        }
      }
    }

    // Remove the per-test work dir.
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it(
    "daemon-active guard fires while daemon is up (system.ping)",
    async () => {
      const logCapture = createLogCapture();
      handle = await startTestDaemon({
        configPath: workConfigPath,
        logStream: logCapture.stream,
      });

      const wsGatewayUrl = toWsGatewayUrl(handle.gatewayUrl);

      const mtimeBefore = statSync(workConfigPath).mtimeMs;
      const { exitCode, stderr } = await runCli(
        ["config", "sync-tooling", "--write", "--config", workConfigPath],
        {
          env: {
            // Direct the CLI's withClient() probe at the test daemon.
            COMIS_GATEWAY_URL: wsGatewayUrl,
            COMIS_GATEWAY_TOKEN: handle.authToken,
          },
        },
      );
      const mtimeAfter = statSync(workConfigPath).mtimeMs;

      expect(exitCode).toBe(1);
      expect(stderr).toContain("daemon is running");
      // mtime unchanged when guard fires.
      expect(mtimeAfter).toBe(mtimeBefore);
    },
    DAEMON_STARTUP_MS + 30_000,
  );

  it(
    "inspect mode does NOT trigger the daemon guard",
    async () => {
      const logCapture = createLogCapture();
      handle = await startTestDaemon({
        configPath: workConfigPath,
        logStream: logCapture.stream,
      });

      const wsGatewayUrl = toWsGatewayUrl(handle.gatewayUrl);

      const mtimeBefore = statSync(workConfigPath).mtimeMs;
      const { exitCode, stdout } = await runCli(
        ["config", "sync-tooling", "--config", workConfigPath],
        {
          env: {
            // Even though inspect mode skips the probe, set the gateway env
            // vars so any unintended probe fails loudly against the right
            // host instead of silently succeeding against ~/.comis/config.yaml.
            COMIS_GATEWAY_URL: wsGatewayUrl,
            COMIS_GATEWAY_TOKEN: handle.authToken,
          },
        },
      );
      const mtimeAfter = statSync(workConfigPath).mtimeMs;

      expect(exitCode).toBe(0);
      // diff.ts:114 emits `payload.wouldWrite` which always contains the
      // literal `tooling:` key.
      expect(stdout).toContain("tooling:");
      // mtime unchanged in inspect mode.
      expect(mtimeAfter).toBe(mtimeBefore);
    },
    DAEMON_STARTUP_MS + 30_000,
  );

  it(
    "--write materializes tooling: block + writes backup",
    async () => {
      // No daemon running for this test — we want the happy --write path.
      const preWriteContent = readFileSync(workConfigPath, "utf-8");

      const { exitCode, stdout } = await runCli(
        [
          "config",
          "sync-tooling",
          "--write",
          "--config",
          workConfigPath,
        ],
        {
          env: {
            // No daemon to probe — direct withClient at an obviously-down port
            // so isDaemonRunning() returns false fast (1s race ceiling).
            COMIS_GATEWAY_URL: "ws://127.0.0.1:1/ws",
            COMIS_GATEWAY_TOKEN: "no-daemon-here",
          },
        },
      );
      expect(exitCode).toBe(0);

      const post = readFileSync(workConfigPath, "utf-8");
      expect(post).toContain("tooling:");
      expect(post).toContain("installDetours:");
      expect(post).toContain("mode: advise");
      expect(post).toContain("capabilityIndex:");
      expect(post).toContain("enabled: true");

      // Parse backup path from the success line `(backup: <path>)`.
      const backupMatch = stdout.match(/\(backup:\s*([^)]+)\)/);
      expect(backupMatch).not.toBeNull();
      const backupPath = backupMatch![1]!.trim();

      // Backup file exists.
      expect(existsSync(backupPath)).toBe(true);

      // Backup filename matches the timestamp + hex pattern.
      const backupBasename = backupPath.split("/").pop() ?? "";
      expect(backupBasename).toMatch(BACKUP_REGEX);

      // Backup is byte-equal to the pre-overwrite content.
      const backupContent = readFileSync(backupPath, "utf-8");
      expect(backupContent).toBe(preWriteContent);
    },
    30_000,
  );

  it(
    "daemon boots cleanly with synthesized tooling: block",
    async () => {
      // Step 1: write the tooling block via the CLI (daemon NOT running).
      const writeResult = await runCli(
        [
          "config",
          "sync-tooling",
          "--write",
          "--config",
          workConfigPath,
        ],
        {
          env: {
            COMIS_GATEWAY_URL: "ws://127.0.0.1:1/ws",
            COMIS_GATEWAY_TOKEN: "no-daemon-here",
          },
        },
      );
      expect(writeResult.exitCode).toBe(0);

      // Sanity: the synthesized config must contain a tooling: block.
      const mutated = readFileSync(workConfigPath, "utf-8");
      expect(mutated).toContain("tooling:");

      // Step 2: boot the daemon against the now-mutated config.
      const logCapture = createLogCapture();
      handle = await startTestDaemon({
        configPath: workConfigPath,
        logStream: logCapture.stream,
      });

      // Step 3: trigger preamble assembly. Open WS, send agent.execute. The
      // daemon-harness auto-seeds ANTHROPIC_API_KEY with a dummy value, so the
      // executor reaches preamble assembly (executor-prompt-runner.ts:208-223)
      // and emits the Pino debug log SYNCHRONOUSLY before the LLM dispatch
      // fails on the dummy key.
      const ws = await openAuthenticatedWebSocket(
        handle.gatewayUrl,
        handle.authToken,
      );
      try {
        await sendJsonRpc(
          ws,
          "agent.execute",
          { message: "List my available capabilities." },
          1,
          { timeoutMs: RPC_LLM_MS },
        );
      } catch {
        // Expected: dummy ANTHROPIC_API_KEY causes auth-error AFTER preamble
        // assembly has already fired the Pino log.
      } finally {
        ws.close();
      }

      // Step 4: poll the captured log stream for the debug-level Pino entry.
      // waitForLogEntry handles Pino's async flush without flaky setTimeouts.
      const result = await waitForLogEntry(
        logCapture.getEntries,
        { msg: /Dynamic preamble assembled/, level: "debug" },
        { timeoutMs: 10_000 },
      );
      expect(result.matched).toBe(true);

      // Inspect ALL matching entries — the daemon may emit more than one
      // assembly during multi-step preamble construction. The first one has
      // the canonical clusterCount.
      const entries = logCapture.getEntries();
      const assemblies = filterLogs(entries, {
        msg: /Dynamic preamble assembled/,
        level: "debug",
      });
      expect(assemblies.length).toBeGreaterThan(0);

      const first = assemblies[0] as LogEntry & { clusterCount?: unknown };
      expect(typeof first.clusterCount).toBe("number");
      // clusterCount >= 2. Achieved via the skill-variants fixture:
      // `comis-capability-skill` (manifest cluster: data-fetching-financial)
      // + `operator-config-skill` and `sdk-fallback-skill` (both fall through
      // to prompt-skills).
      expect(first.clusterCount as number).toBeGreaterThanOrEqual(2);
    },
    DAEMON_STARTUP_MS + 90_000,
  );
});
