// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 26 — tooling-fill CLI daemon-bound integration test (SPEC AC-3 +
 * AC-5 + AC-7 + AC-11 + AC-13). The acceptance gate at the daemon-boundary
 * level. Mirrors Phase 25 Plan 04's `cli-sync-tooling.test.ts` architecture.
 *
 * End-to-end coverage:
 *
 *  - Test 1 (TOOLFILL-2 / SPEC AC-3 negative): `comis config tooling-fill
 *    yfinance --yes --restart-cmd 'echo skipped'` with NO daemon running
 *    exits with code 1 and stderr contains the TOOLFILL-2 SPEC string
 *    (anchored as the runtime constant TOOLFILL_2_SPEC_STRING below — single
 *    source of truth, anti-regression grep `== 1`). The fixture's mtime is
 *    unchanged and no `~/.comis/config.pre-tooling-fill-*.yaml` backup is
 *    written. Anchors Plan 26-04's daemon-up gate (orchestrator step 4) at
 *    the integration boundary — if Plan 02's drift fix regresses (back to
 *    `health.ping`), this test fails because isDaemonRunning() returns true
 *    against a real daemon answering `system.ping`.
 *
 *  - Test 2 (SPEC AC-3 happy boundary): with a real daemon up, run
 *    `tooling-fill yfinance --yes --restart-cmd 'echo skipped'` (no test
 *    fault injector). The daemon's executor will fail on the dummy
 *    ANTHROPIC_API_KEY seeded by daemon-harness. That's fine — the boundary
 *    check is whether the CLI's POST hits /api/chat. The daemon's hono-
 *    server.ts middleware logs every non-/health request as
 *    `Request completed` with `path: "/api/chat"`. Assert that log entry
 *    exists at info level. Exit code is acceptable as either 0 or non-zero
 *    (the LLM-provider downstream may emit a `dependency` error that
 *    surfaces in summary; the contract is the /api/chat round-trip).
 *
 *  - Test 3 (SPEC AC-5 + AC-7): with a real daemon up AND
 *    COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE set to a canned 2-line response,
 *    run `tooling-fill yfinance --yes --restart-cmd 'echo skipped' --config
 *    <fixture-copy>`. The orchestrator skips the /api/chat call (the env
 *    var is the test-only fault injector landed in 26-05's first commit),
 *    runs the full state machine: stop daemon (no-op via 'echo skipped') →
 *    write backup → setHintFields → atomicWriteFile → validateConfig →
 *    start daemon (no-op). Assert: exit 0; the post-fill YAML contains the
 *    new description and `- yfinance` package; backup file lives under
 *    ~/.comis/ matching the `config.pre-tooling-fill-*.yaml` regex; backup
 *    contents are byte-equal to the pre-overwrite file.
 *
 *  - Test 4 (SPEC AC-11): after Test 3's post-fill state, run `comis config
 *    sync-tooling --format json --config <filled-fixture>` against the
 *    mutated fixture. Assert exit 0; the JSON has empty add.mcps,
 *    add.skills, remove.mcps, remove.skills arrays — Phase 25's append-only
 *    invariant (D-22) holds: tooling-fill did NOT add or remove any hint,
 *    only filled the two stub-valued fields in place.
 *
 * Pre-req: `pnpm build` (or `npx tsc -b packages/cli && npx tsc -b
 * packages/daemon` — Plan 25-04 deviation #4: full pnpm build may fail on
 * `packages/web`) MUST have run before this test. Otherwise
 * `packages/cli/dist/cli.js` is stale and the test silently uses old code
 * (RESEARCH Pitfall 8). The `beforeEach` enforces this with an `existsSync`
 * check that throws a clear error message.
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
  mkdirSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  createLogCapture,
  filterLogs,
  waitForLogEntry,
} from "../support/log-verifier.js";
import { DAEMON_STARTUP_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");
const CLI_BINARY = resolve(REPO_ROOT, "packages/cli/dist/cli.js");
const FIXTURE_SOURCE = resolve(
  REPO_ROOT,
  "test/config/config.test-tooling-fill.yaml",
);

/** D-10/Phase-26 backup filename regex (millisecond ISO + 6-char hex). */
const BACKUP_REGEX =
  /^config\.pre-tooling-fill-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}-[0-9a-f]{6}\.yaml$/;

/** Glob-equivalent prefix for backup files written under ~/.comis/. */
const BACKUP_FILENAME_PREFIX = "config.pre-tooling-fill-";

/** ${COMIS_REPO_ROOT} placeholder in the source fixture. */
const REPO_ROOT_PLACEHOLDER = "${COMIS_REPO_ROOT}";

/**
 * Literal TOOLFILL-2 SPEC string (single source of truth: orchestrator.ts
 * + agent-call.ts). Anti-regression assertion in Test 1 — if either source
 * file drifts away from this exact wording, the test fails.
 */
const TOOLFILL_2_SPEC_STRING =
  "Cannot reach Comis daemon — gateway unreachable. Start the daemon and retry.";

/**
 * Canned 2-line agent response per the parser's strict contract
 * (response-parser.ts: `DESCRIPTION: <one-line>` then
 * `REPLACES_PACKAGES: <json-array>`). Used by Tests 3 + 4 via the test-only
 * `COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE` fault injector.
 */
const CANNED_AGENT_RESPONSE =
  'DESCRIPTION: Yahoo Finance market data and history\n' +
  'REPLACES_PACKAGES: ["yfinance", "pandas-datareader"]';

const execFileAsync = promisify(execFile);

/**
 * Async wrapper around `execFile` that always resolves with
 * `{ exitCode, stdout, stderr }` regardless of the child's exit code.
 *
 * CRITICAL: this MUST be async (not `execFileSync`/`spawnSync`). The Phase
 * 25 + 26 integration tests boot the daemon IN THE SAME PROCESS as the test
 * runner (daemon-harness imports `@comis/daemon` and calls `main()`). A
 * synchronous child_process call would block the test process's event loop,
 * which is the SAME event loop serving the in-process daemon's HTTP+WS
 * gateway. The CLI's `withClient` probe + the /api/chat POST would then
 * time out on connection accept (Plan 25-04 deviation #1).
 */
async function runCli(
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const r = await execFileAsync("node", [CLI_BINARY, ...args], {
      env: { ...process.env, ...(opts.env ?? {}) },
      timeout: opts.timeoutMs ?? 15_000,
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
 * path then re-raises that thrown error. Phase 24/25 tests use the same
 * wrapper.
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
 * Read all `<.comis>/config.pre-tooling-fill-*.yaml` files currently on
 * disk under the supplied directory. Used in afterEach to clean up backups
 * produced by the test. With the per-test fake HOME, backups land under
 * the fake `.comis` (NOT the dev's real `~/.comis/`); we still maintain
 * a snapshot-diff so concurrent test runs are unaffected.
 */
function listBackupFiles(comisDir: string): string[] {
  if (!existsSync(comisDir)) return [];
  try {
    return readdirSync(comisDir)
      .filter(
        (e) => e.startsWith(BACKUP_FILENAME_PREFIX) && e.endsWith(".yaml"),
      )
      .map((e) => join(comisDir, e));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Phase 26 — comis config tooling-fill integration (AC-3 + AC-5 + AC-7 + AC-11 + AC-13)", () => {
  let workDir: string;
  let workConfigPath: string;
  /**
   * Per-test fake-HOME directory exposed to the CLI subprocess via `HOME`.
   * The CLI's `os.homedir()` resolves through HOME on POSIX, so backups
   * (under `<HOME>/.comis/`) and sync-tooling's daemon-default skill paths
   * (`<HOME>/.comis/skills`, `<HOME>/.comis/workspace/skills`) both resolve
   * here. This isolates the test from the developer's real `~/.comis/skills/`
   * which on a contributor machine may contain skills (e.g. `skill-creator`)
   * that would otherwise show up as `add` entries in Test 4's sync-tooling
   * round-trip diff.
   */
  let fakeHomeDir: string;
  let fakeComisDir: string;
  let handle: TestDaemonHandle | undefined;
  let backupSnapshotBefore: Set<string>;

  beforeEach(() => {
    // RESEARCH Pitfall 8: refuse to run if the CLI binary is missing.
    // Without this guard a stale dist/ would silently mask src/ edits.
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
    // CLI mutates this file via tooling-fill, and we want each test in
    // isolation. Plan 25-04 established this convention.
    workDir = mkdtempSync(join(tmpdir(), "comis-tooling-fill-it-"));
    workConfigPath = join(workDir, "config.yaml");

    // Fake HOME under workDir — `mkdir -p <workDir>/home/.comis` so the CLI's
    // os.homedir() (HOME on POSIX) resolves to a clean tree. Required so
    // sync-tooling's daemon-default skill-discovery paths
    // (`~/.comis/skills`, `~/.comis/workspace/skills`) do NOT pick up the
    // developer's real skills (which would surface as `add` entries in
    // Test 4's round-trip diff).
    fakeHomeDir = join(workDir, "home");
    fakeComisDir = join(fakeHomeDir, ".comis");
    mkdirSync(fakeComisDir, { recursive: true });

    // Substitute ${COMIS_REPO_ROOT} at copy-time. The CLI's loadConfigFile
    // does NOT expand ${VAR} when called without a getSecret callback (see
    // packages/core/src/config/loader.ts:101-116). The daemon's bootstrap
    // path DOES substitute, but we want both readers to agree on the literal
    // path, so we expand once here. Also keeps the fixture portable across
    // worktrees and CI runners (Phase 24 BLOCKER lesson; Plan 25-04
    // pattern).
    const fixtureContent = readFileSync(FIXTURE_SOURCE, "utf-8").replaceAll(
      REPO_ROOT_PLACEHOLDER,
      REPO_ROOT,
    );
    writeFileSync(workConfigPath, fixtureContent, { mode: 0o600 });

    // Snapshot existing backup files under the FAKE comis dir so we can
    // detect the new ones the test produces. With per-test fake HOME the
    // snapshot is always empty; this is a defense-in-depth check.
    backupSnapshotBefore = new Set(listBackupFiles(fakeComisDir));
  });

  afterEach(async () => {
    if (handle !== undefined) {
      await cleanupDaemon(handle);
      handle = undefined;
    }

    // Clean up backup files produced by this test under the fake .comis.
    const backupsAfter = listBackupFiles(fakeComisDir);
    for (const path of backupsAfter) {
      if (!backupSnapshotBefore.has(path)) {
        try {
          unlinkSync(path);
        } catch {
          // best-effort
        }
      }
    }

    // Remove the per-test work dir (which contains the fake home tree).
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it(
    "Test 1 (TOOLFILL-2): daemon-down → exit 1 + literal SPEC string + no file mutation",
    async () => {
      // No daemon started for this test.
      const mtimeBefore = statSync(workConfigPath).mtimeMs;
      const preContent = readFileSync(workConfigPath, "utf-8");

      const { exitCode, stderr } = await runCli(
        [
          "config",
          "tooling-fill",
          "yfinance",
          "--yes",
          "--restart",
          "--restart-cmd",
          "echo skipped",
          "--config",
          workConfigPath,
        ],
        {
          env: {
            // Per-test fake HOME isolates ~/.comis/ from the dev's tree.
            HOME: fakeHomeDir,
            // Direct the CLI's withClient() probe at an obviously-down port
            // so isDaemonRunning() returns false fast (1s race ceiling).
            COMIS_GATEWAY_URL: "ws://127.0.0.1:1/ws",
            COMIS_GATEWAY_TOKEN: "no-daemon-here",
          },
          timeoutMs: 10_000,
        },
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain(TOOLFILL_2_SPEC_STRING);

      // SPEC AC-5: file untouched when guard fires.
      const mtimeAfter = statSync(workConfigPath).mtimeMs;
      expect(mtimeAfter).toBe(mtimeBefore);
      expect(readFileSync(workConfigPath, "utf-8")).toBe(preContent);

      // No backup written — the orchestrator's daemon-up check fires
      // BEFORE writeBackup (state-machine step 4 vs step 9b).
      const backupsAfter = listBackupFiles(fakeComisDir);
      const newBackups = backupsAfter.filter(
        (p) => !backupSnapshotBefore.has(p),
      );
      expect(newBackups).toEqual([]);
    },
    30_000,
  );

  it(
    "Test 2 (AC-3): real /api/chat call lands on the daemon (boundary check)",
    async () => {
      const logCapture = createLogCapture();
      handle = await startTestDaemon({
        configPath: workConfigPath,
        logStream: logCapture.stream,
      });

      // No fault injector — the orchestrator will issue a real POST to
      // /api/chat. The daemon's executor will fail downstream on the dummy
      // ANTHROPIC_API_KEY (seeded by daemon-harness via
      // seedDummyProviderApiKeys), but the boundary check is whether the
      // /api/chat HTTP request actually reached the daemon's hono router.
      const { exitCode, stderr } = await runCli(
        [
          "config",
          "tooling-fill",
          "yfinance",
          "--yes",
          "--restart",
          "--restart-cmd",
          "echo skipped",
          "--config",
          workConfigPath,
        ],
        {
          env: {
            HOME: fakeHomeDir,
            COMIS_GATEWAY_URL: `ws://127.0.0.1:${new URL(handle.gatewayUrl).port}/ws`,
            COMIS_GATEWAY_TOKEN: handle.authToken,
          },
          timeoutMs: 60_000, // up to 30s for the /api/chat round-trip + 30s slack
        },
      );

      // Wait for the daemon's hono "Request completed" middleware to log
      // the /api/chat POST. The middleware fires on every non-/health
      // request (server/hono-server.ts:134-157); pattern: msg "Request
      // completed", path "/api/chat".
      const logResult = await waitForLogEntry(
        logCapture.getEntries,
        { msg: /Request completed/, path: "/api/chat" },
        { timeoutMs: 5_000 },
      );
      expect(logResult.matched).toBe(true);

      // SPEC AC-3 boundary check: at least one /api/chat request reached
      // the daemon. Multiple is fine (the orchestrator may retry on
      // transient errors).
      const entries = logCapture.getEntries();
      const chatRequests = filterLogs(entries, {
        msg: /Request completed/,
        path: "/api/chat",
      });
      expect(chatRequests.length).toBeGreaterThanOrEqual(1);

      // Exit code is acceptable as either 0 (if a real key is in the dev's
      // env) or non-zero (dummy key → executor failure → CLI surfaces
      // dependency/internal error). Either way, the boundary was crossed.
      // We DO assert that the failure mode (if any) is NOT the gateway-
      // unreachable string — the daemon WAS up.
      expect(stderr).not.toContain(TOOLFILL_2_SPEC_STRING);
      // Exit code must be a valid integer the harness produced (not the
      // sentinel -1 we emit on `signal` kills).
      expect(exitCode).toBeGreaterThanOrEqual(0);
    },
    DAEMON_STARTUP_MS + 90_000,
  );

  it(
    "Test 3 (AC-5 + AC-7): tooling-fill writes config + backup atomically (fault-injected agent response)",
    async () => {
      const logCapture = createLogCapture();
      handle = await startTestDaemon({
        configPath: workConfigPath,
        logStream: logCapture.stream,
      });

      const preMtime = statSync(workConfigPath).mtimeMs;
      const preContent = readFileSync(workConfigPath, "utf-8");

      const { exitCode, stdout, stderr } = await runCli(
        [
          "config",
          "tooling-fill",
          "yfinance",
          "--yes",
          "--restart",
          "--restart-cmd",
          "echo skipped",
          "--config",
          workConfigPath,
        ],
        {
          env: {
            HOME: fakeHomeDir,
            COMIS_GATEWAY_URL: `ws://127.0.0.1:${new URL(handle.gatewayUrl).port}/ws`,
            COMIS_GATEWAY_TOKEN: handle.authToken,
            // Test-only fault injector — orchestrator skips /api/chat and
            // uses this as the literal agent response. AGENTS.md §2.2
            // exception list explicitly allows test fault injectors.
            COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE: CANNED_AGENT_RESPONSE,
          },
          timeoutMs: 30_000,
        },
      );

      // The toMatchObject check prints a diff on failure that includes the
      // full {exitCode, stdout, stderr} shape, giving operators / CI logs
      // the diagnostic context they need without polluting passing runs.
      expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });

      // SPEC AC-5: file mutated.
      const postContent = readFileSync(workConfigPath, "utf-8");
      const postMtime = statSync(workConfigPath).mtimeMs;
      expect(postContent).not.toBe(preContent);
      expect(postMtime).toBeGreaterThanOrEqual(preMtime);

      // The new description and replacesPackages from the canned agent
      // response are now in the file. yaml@2.8.4's setIn renders the
      // sequence in block style under the existing key.
      expect(postContent).toContain(
        "description: Yahoo Finance market data and history",
      );
      expect(postContent).toContain("- yfinance");
      expect(postContent).toContain("- pandas-datareader");

      // Comments + key-order preserved (REQ-7 / D-22 append-only).
      expect(postContent).toContain("tooling:");
      expect(postContent).toContain("capabilityIndex:");
      expect(postContent).toContain("installDetours:");

      // SPEC AC-5: backup file lands under <fake-home>/.comis/ (the per-test
      // fake HOME directs `os.homedir()` in the CLI subprocess to fakeHomeDir,
      // so writeBackup's safePath(homeDir, ".comis", ...) lands here).
      const backupsAfter = listBackupFiles(fakeComisDir);
      const newBackups = backupsAfter.filter(
        (p) => !backupSnapshotBefore.has(p),
      );
      expect(newBackups.length).toBe(1);
      const backupPath = newBackups[0]!;

      // Phase 26 backup naming regex: config.pre-tooling-fill-<ISO_TS>-<6-hex>.yaml
      const backupBasename = backupPath.split("/").pop() ?? "";
      expect(backupBasename).toMatch(BACKUP_REGEX);

      // SPEC AC-7: backup is byte-equal to the pre-overwrite content.
      const backupContent = readFileSync(backupPath, "utf-8");
      expect(backupContent).toBe(preContent);

      // Success-line on stdout includes the backup path so operators can
      // see where the rollback artifact lives.
      expect(stdout).toContain(backupPath);
    },
    DAEMON_STARTUP_MS + 30_000,
  );

  it(
    "Test 4 (AC-11): sync-tooling reports no drift after tooling-fill (Phase 25 round-trip / append-only invariant)",
    async () => {
      // Reuse the Test 3 setup pattern: boot daemon, run tooling-fill via
      // the fault injector to mutate the fixture, then run sync-tooling
      // against the post-fill state and assert no drift.
      const logCapture = createLogCapture();
      handle = await startTestDaemon({
        configPath: workConfigPath,
        logStream: logCapture.stream,
      });

      const fillResult = await runCli(
        [
          "config",
          "tooling-fill",
          "yfinance",
          "--yes",
          "--restart",
          "--restart-cmd",
          "echo skipped",
          "--config",
          workConfigPath,
        ],
        {
          env: {
            HOME: fakeHomeDir,
            COMIS_GATEWAY_URL: `ws://127.0.0.1:${new URL(handle.gatewayUrl).port}/ws`,
            COMIS_GATEWAY_TOKEN: handle.authToken,
            COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE: CANNED_AGENT_RESPONSE,
          },
          timeoutMs: 30_000,
        },
      );
      expect(fillResult.exitCode).toBe(0);

      // Now run sync-tooling in inspect mode (NO --write) so the daemon-up
      // guard is skipped (D-13/D-14: write paths only). --format json gives
      // a machine-checkable diff payload (diff.ts:130+).
      const syncResult = await runCli(
        [
          "config",
          "sync-tooling",
          "--format",
          "json",
          "--config",
          workConfigPath,
        ],
        {
          env: {
            HOME: fakeHomeDir,
            // sync-tooling's inspect mode does NOT call withClient, but
            // point at the live daemon anyway in case any defense-in-depth
            // probe is added later.
            COMIS_GATEWAY_URL: `ws://127.0.0.1:${new URL(handle.gatewayUrl).port}/ws`,
            COMIS_GATEWAY_TOKEN: handle.authToken,
          },
          timeoutMs: 15_000,
        },
      );

      // Diagnostic context if the assertion below fails.
      expect({
        exitCode: syncResult.exitCode,
        stderr: syncResult.stderr,
      }).toMatchObject({ exitCode: 0 });

      // Parse the JSON payload from stdout. diff.ts:130+ renders the four
      // canonical top-level keys: discovered, existing, diff, wouldWrite.
      // The diff key has shape: {add:{mcps,skills}, remove:{mcps,skills}}.
      type SyncJsonPayload = {
        diff: {
          add: { mcps: string[]; skills: string[] };
          remove: { mcps: string[]; skills: string[] };
        };
      };
      const payload = JSON.parse(syncResult.stdout) as SyncJsonPayload;

      // Phase 25 D-22 append-only invariant: tooling-fill must NEVER add
      // or remove any hint — only fill the description + replacesPackages
      // fields in place. After tooling-fill runs, sync-tooling's diff
      // against the same discovered artifacts MUST be empty in both
      // directions.
      expect(payload.diff.add.mcps).toEqual([]);
      expect(payload.diff.add.skills).toEqual([]);
      expect(payload.diff.remove.mcps).toEqual([]);
      expect(payload.diff.remove.skills).toEqual([]);
    },
    DAEMON_STARTUP_MS + 60_000,
  );
});
