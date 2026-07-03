// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon Test Harness: Programmatic daemon bootstrap for integration tests.
 *
 * Starts the real Comis daemon with test configuration, provides a handle
 * for interacting with the gateway, and ensures graceful cleanup after tests.
 *
 * @module
 */

import type { Writable } from "node:stream";
import { createConnection } from "node:net";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDatabase } from "./db-cleanup.js";
import { seedModelCache } from "./model-cache.js";
import { ASYNC_SETTLE_MS, RPC_FAST_MS } from "./timeouts.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "./ws-helpers.js";
import { createFakeTimers, type FakeTimers, type FakeTimerEntry } from "./fake-timers.js";
import type { DaemonInstance } from "@comis/daemon";
import type { ChannelActivityRenderer } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for starting a test daemon instance. */
export interface TestDaemonOptions {
  /** Path to test config file. Defaults to test/config/config.test.yaml */
  configPath?: string;
  /** Additional DaemonOverrides for the daemon */
  overrides?: Record<string, unknown>;
  /** Port override for gateway (avoids conflicts between parallel test suites) */
  gatewayPort?: number;
  /** Writable stream to capture daemon log output (e.g., from createLogCapture().stream). */
  logStream?: Writable;
  /**
   * Disable Pino redaction in the test daemon's logger. ONLY for residency
   * tests (test/integration/secret-rpc-residency.test.ts). Production must
   * never set this; the architecture rule in
   * test/architecture/source-rules.test.ts enforces that
   * `disableRedaction: true` never appears in `packages/*\/src/**`.
   *
   * When true, the in-process daemon's tracing logger is constructed with
   * `LoggerOptions.disableRedaction = true` so the residency test can observe
   * raw Pino payloads and assert no plaintext appears anywhere.
   */
  disableRedaction?: boolean;
  /**
   * Replace the production `createSystemTimers()` adapter at the daemon
   * composition root with `createFakeTimers()` from
   * `test/support/fake-timers.ts`. Exposes the underlying timer record via
   * `handle.getTimerRecord()` so the integration test can assert every
   * long-running interval registered during bootstrap was either cancelled
   * or unref'd before shutdown completed.
   *
   * Default-mode tests should NOT set this — they rely on real timers so
   * `setInterval`/`setTimeout` fire as the daemon expects.
   */
  useFakeTimers?: boolean;
  /**
   * Override the per-channelType activity-renderer factory at the daemon
   * composition root (test seam). When provided, the harness forwards
   * this into the daemon override bag (under the activityRendererFactory key) so
   * the daemon's `DaemonOverrides` replaces the renderer produced by
   * `buildActivityRenderers`. Lets an integration test inject a spy/TestSink it
   * retains a reference to and assert `apply` fired on a real inbound turn.
   * Production must never set this; the override is test-only (mirrors the
   * useFakeTimers → timers-override discipline above).
   */
  activityRendererFactory?: (channelType: string) => ChannelActivityRenderer | undefined;
}

/** Handle to a running test daemon instance. */
export interface TestDaemonHandle {
  /** The running daemon instance */
  daemon: DaemonInstance;
  /** Gateway base URL (e.g., "http://127.0.0.1:4766") */
  gatewayUrl: string;
  /** Bearer token for authenticated requests */
  authToken: string;
  /** Shut down the daemon gracefully */
  cleanup: () => Promise<void>;
  /**
   * Snapshot of fake-timer entries (cancel + unref state) when the harness
   * was started with `useFakeTimers: true`. Returns `undefined` otherwise.
   * The integration test reads this AFTER shutdown to assert every
   * long-running interval was either cancelled or unref'd.
   */
  getTimerRecord(): ReadonlyArray<FakeTimerEntry> | undefined;
  /**
   * Chaos-test probe: read a `durable_runs` row straight from the
   * daemon's `memory.db` (resolved from `config.dataDir` + `memory.dbPath`). The
   * durable-resume engine is not exposed on `DaemonInstance`, so the chaos test
   * inspects the persisted state directly to assert a run resumed / was orphaned /
   * survived a restart. Returns `undefined` when the row (or the db) is absent.
   */
  getDurableRun(rootRunId: string): DurableRunProbeRow | undefined;
  /**
   * Chaos-test probe: read an `outward_send_ledger` row by its
   * `(root_run_id, step_index)` idempotency key from the daemon's `memory.db`.
   * Lets the chaos test assert the row transitioned unknown_after_send → committed
   * (ack-once) / unresolved (parked) after a crash-mid-send + restart. Returns
   * `undefined` when the row is absent.
   */
  getOutwardLedgerRow(rootRunId: string, stepIndex: number): OutwardLedgerProbeRow | undefined;
}

/** A raw `durable_runs` row as the chaos-test probe reads it (subset of columns). */
export interface DurableRunProbeRow {
  rootRunId: string;
  status: string;
  spawnTree: string;
  outwardStep: number;
  orphanReason: string | undefined;
  lastHeartbeatAt: number;
}

/** A raw `outward_send_ledger` row as the chaos-test probe reads it (subset of columns). */
export interface OutwardLedgerProbeRow {
  rootRunId: string;
  stepIndex: number;
  state: string;
  channelType: string;
  channelId: string;
  platformMessageId: string | undefined;
  reconcileOutcome: string | undefined;
  contentDigest: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_CONFIG_PATH = resolve(__dirname, "../config/config.test.yaml");
const HEALTH_POLL_ATTEMPTS = 10;
const HEALTH_POLL_DELAY_MS = 500;

/**
 * Provider API-key env vars that the daemon credential guard
 * (agents.create → resolveProviderCredential) checks for non-empty values.
 * Integration tests that exercise agent CRUD do not make real LLM calls,
 * so a dummy non-empty value is sufficient.
 */
const PROVIDER_API_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

const DUMMY_API_KEY_VALUE = "test-fixture-not-a-real-key";

/**
 * Real provider API keys captured ONCE at module load — before any daemon boot
 * scrubs them from process.env.
 *
 * Live-fire fix: the daemon's bootstrap snapshots ANTHROPIC_* into its
 * SecretManager and then SCRUBS them from process.env (scrubProcessEnv). With
 * multiple daemons booting sequentially in one vitest file, the FIRST boot
 * removes the real key, so the 2nd+ daemon snapshots nothing and the post-boot
 * dummy re-seed makes its execute calls 401 ("invalid x-api-key"). That made
 * every 2nd+ Stage-C judged test (MEM-01 Stage-C, all of MEM-04) fail or
 * vacuously degrade. Capturing the real values at import time (the runner
 * injects live.env into process.env before importing any test file) lets
 * reinjectRealProviderKeys() restore them before EACH boot, so every daemon's
 * SecretManager gets the real key. A dummy/empty value is NOT captured (those
 * are the CRUD-test placeholders, not real credentials).
 */
const REAL_PROVIDER_KEYS: Record<string, string> = (() => {
  const captured: Record<string, string> = {};
  for (const name of PROVIDER_API_KEY_ENV_VARS) {
    const v = process.env[name];
    if (v && v !== DUMMY_API_KEY_VALUE) captured[name] = v;
  }
  return captured;
})();

/**
 * Re-inject the module-load-captured real provider keys into process.env when
 * they are currently absent or hold the dummy placeholder. Called just before
 * each daemon boot so the boot-time SecretManager snapshot sees the real key
 * even after a sibling daemon's scrub. No-op when no real keys were captured
 * (keyless CI) — those runs keep the dummy-placeholder behavior unchanged.
 */
function reinjectRealProviderKeys(): void {
  for (const [name, value] of Object.entries(REAL_PROVIDER_KEYS)) {
    const cur = process.env[name];
    if (cur === undefined || cur === "" || cur === DUMMY_API_KEY_VALUE) {
      process.env[name] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Double-start guard
// ---------------------------------------------------------------------------

/** Tracks the currently active test daemon handle to prevent double-start. */
let activeHandle: TestDaemonHandle | null = null;

// ---------------------------------------------------------------------------
// Per-fork data-dir isolation
// ---------------------------------------------------------------------------

/**
 * One throwaway dataDir per vitest fork (= per test file under pool:"forks").
 *
 * The daemon's D14 data-dir singleton lock (.daemon.lock) makes two daemons
 * on the same dataDir a hard boot failure. Integration test files run in
 * parallel forks, each booting its own in-process daemon — on the shared
 * default (~/.comis) they race the lock and fail with EEXIST. It also keeps
 * test daemons' lock/.env/master-key files out of the developer's real
 * ~/.comis, where they can collide with a locally running dev daemon.
 *
 * Memoized per fork so sequential daemon restarts within one test file
 * (persist-restart-e2e) keep their persisted state.
 */
let forkDataDir: string | undefined;

function getForkDataDir(): string {
  if (forkDataDir === undefined) {
    forkDataDir = mkdtempSync(join(tmpdir(), "comis-test-data-"));
    // Reuse the developer's cached local models (hard link, zero extra disk)
    // so the daemon skips the ~139 MB embedding download per fork. No-op on
    // CI / fresh machines. See test/support/model-cache.ts for the rationale.
    seedModelCache(forkDataDir);
  }
  return forkDataDir;
}

// ---------------------------------------------------------------------------
// Port availability helper
// ---------------------------------------------------------------------------

/**
 * Extract the gateway port from a YAML config file (simple regex, no YAML parser).
 */
function extractPortFromConfig(configPath: string): number | undefined {
  try {
    const content = readFileSync(configPath, "utf-8");
    // Match the gateway.port value in YAML (looks for port: <number> under gateway:)
    const gwMatch = content.match(/gateway:\s*\n(?:.*\n)*?\s+port:\s*(\d+)/);
    if (gwMatch?.[1]) return Number(gwMatch[1]);
    // Fallback: any top-level port:
    const simpleMatch = content.match(/^\s+port:\s*(\d+)/m);
    if (simpleMatch?.[1]) return Number(simpleMatch[1]);
  } catch {
    // Config unreadable — skip port check
  }
  return undefined;
}

/**
 * Wait until a TCP port is free (no process listening on it).
 *
 * Attempts a connection and expects ECONNREFUSED (port free). If the
 * connection succeeds, the port is still in use — waits and retries.
 */
async function waitForPortFree(
  port: number,
  host = "127.0.0.1",
  maxAttempts = 20,
  delayMs = 500,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const inUse = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true); // Port is in use
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false); // Port is free (ECONNREFUSED)
      });
    });

    if (!inUse) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }

  throw new Error(
    `Port ${port} still in use after ${maxAttempts} attempts (${maxAttempts * delayMs}ms). ` +
    "A zombie daemon process may be holding the port.",
  );
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Start the Comis daemon with test configuration.
 *
 * - Sets COMIS_CONFIG_PATHS to the test config
 * - Overrides process.exit to throw instead of killing the process
 * - Polls /health until the gateway is ready
 * - Returns a handle with gatewayUrl, authToken, and cleanup
 */
export async function startTestDaemon(options?: TestDaemonOptions): Promise<TestDaemonHandle> {
  if (activeHandle) {
    throw new Error(
      "Test daemon already running. Call cleanup() before starting another instance.",
    );
  }

  const configPath = options?.configPath ?? DEFAULT_CONFIG_PATH;

  // Set config path env var (the daemon reads this)
  process.env["COMIS_CONFIG_PATHS"] = configPath;

  // Seed dummy provider API keys so the credential guard at agents.create
  // (packages/daemon/src/api/agent-handlers.ts) does not reject test agents
  // that never make real LLM calls. Real env values (set by the parent shell)
  // are preserved untouched.
  const restoreProviderEnv = seedDummyProviderApiKeys();

  // Build overrides: prevent process.exit, optionally redirect logs
  const overrides: Record<string, unknown> = {
    ...options?.overrides,
    exit: (code: number) => {
      throw new Error(`Daemon exit with code ${code}`);
    },
  };

  // Opt-in fake-timer wiring. When `useFakeTimers` is set, install a
  // `createFakeTimers()` instance at the composition root via `overrides.timers`
  // (the daemon honors this on the `timers` line in daemon.ts). The harness
  // records the instance on the closure so the returned handle can expose the
  // unrefRecord() snapshot via `getTimerRecord()` (used by the shutdown
  // integration test). Default-mode tests leave `fakeTimers` undefined and the
  // daemon falls back to `createSystemTimers()`.
  const fakeTimers: FakeTimers | undefined = options?.useFakeTimers
    ? createFakeTimers()
    : undefined;
  if (fakeTimers) {
    overrides["timers"] = fakeTimers;
  }

  // Test-only renderer-injection seam. Mirrors the useFakeTimers →
  // overrides["timers"] wiring: thread the typed option into the daemon's
  // DaemonOverrides.activityRendererFactory so the composition root injects the
  // spy renderer the activation test retains a reference to. Never set in
  // production (the typed field keeps the contract honest in the harness type).
  if (options?.activityRendererFactory) {
    overrides["activityRendererFactory"] = options.activityRendererFactory;
  }

  // Compose tracing-logger override based on logStream + disableRedaction.
  //
  // Routing rules (single call site — the harness must produce <= 1 invocation
  // of the tracing-logger factory so the daemon's production code paths emit
  // to the SAME logger instance the test observes):
  //
  //   * Neither set         -> no override; daemon uses production factory.
  //   * disableRedaction    -> override with `{ disableRedaction: true }` so
  //                            the @comis/infra LoggerOptions field threads to
  //                            the SAME logger the daemon's secrets-handlers /
  //                            auth-handlers / etc. emit to.
  //   * logStream           -> tee log lines to a vitest-side Writable using
  //                            pino.multistream. This branch already emits raw
  //                            payloads (no `redact:` field set on the pino
  //                            options object), so `disableRedaction` is
  //                            implicit-true here.
  //   * Both                -> tee AND raw payloads (residency test that also
  //                            needs to capture log lines for cross-read
  //                            isolation).
  if (options?.logStream || options?.disableRedaction) {
    overrides["createTracingLogger"] = buildTracingLoggerOverride({
      logStream: options.logStream,
      disableRedaction: options.disableRedaction === true,
    });
  }

  // Ensure the gateway port is free before starting (prevents EADDRINUSE from zombie processes)
  const configPort = options?.gatewayPort ?? extractPortFromConfig(configPath);
  if (configPort) {
    await waitForPortFree(configPort);
  }

  // Import daemon dynamically to avoid import-time side effects
  const { main } = await import("@comis/daemon");

  // Start the daemon with a per-fork COMIS_DATA_DIR (see getForkDataDir) so
  // parallel test files don't race the D14 .daemon.lock on a shared ~/.comis.
  // Set just-in-time and restored right after boot: the daemon reads the env
  // var exactly once at boot, and leaving it set would leak into CLI
  // subprocesses tests spawn with `...process.env` + a HOME override
  // (oauth-login et al. expect the child to resolve <tmpHome>/.comis).
  // Tests that pre-set COMIS_DATA_DIR themselves (credential-storage-modes,
  // daemon-lifecycle, …) keep their value — we only fill the default.
  const hadDataDirEnv = process.env["COMIS_DATA_DIR"] !== undefined;
  if (!hadDataDirEnv) {
    process.env["COMIS_DATA_DIR"] = getForkDataDir();
  }

  // Restore real provider keys (captured at module load) before boot so this
  // daemon's SecretManager snapshot sees them even if a sibling daemon already
  // scrubbed process.env (fixes 401s on the 2nd+ daemon in a file).
  reinjectRealProviderKeys();

  // Start the daemon
  let daemon: DaemonInstance;
  try {
    daemon = await main(overrides as unknown as Parameters<typeof main>[0]);
  } finally {
    if (!hadDataDirEnv) {
      delete process.env["COMIS_DATA_DIR"];
    }
  }

  // Re-seed dummy provider keys AFTER boot. The daemon's bootstrap snapshots
  // sensitive env vars into the SecretManager and then scrubs them from
  // process.env (scrubProcessEnv in daemon.ts — ANTHROPIC_* et al. match
  // SENSITIVE_PREFIXES). That deletes the keys seeded above, so the runtime
  // credential resolver (credential-resolver.ts Source B → getEnvApiKey reads
  // process.env LIVE at agents.create time) can no longer see them and rejects
  // agent-CRUD with "no API key found". Re-seeding post-boot restores the
  // guard-satisfying placeholder for CRUD tests that never make real LLM calls.
  const restoreProviderEnvPostBoot = seedDummyProviderApiKeys();

  // Verify critical subsystems are present (main() awaits all initialization)
  if (!daemon.container) {
    throw new Error("Daemon bootstrap failed: container missing");
  }
  if (!daemon.container.config?.gateway) {
    throw new Error("Daemon bootstrap failed: gateway config missing");
  }

  // Extract gateway port and auth token
  const port = options?.gatewayPort ?? daemon.container.config.gateway.port;
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const authToken = daemon.container.config.gateway.tokens[0]?.secret ?? "";

  // Wait for gateway to be ready
  await waitForHealth(gatewayUrl);

  // Build cleanup function
  const cleanup = async (): Promise<void> => {
    try {
      await daemon.shutdownHandle.trigger("test-cleanup");
      // Brief delay for graceful shutdown to complete
      await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS));

      // WAL cleanup: checkpoint and delete auxiliary SQLite files
      try {
        const dbPath = daemon.container.config.memory.dbPath;
        if (dbPath) {
          const dataDir = daemon.container.config.dataDir;
          const resolvedDbPath = dataDir
            ? resolve(dataDir, dbPath)
            : resolve(
                process.env["HOME"] ?? "",
                ".comis",
                dbPath,
              );
          cleanupDatabase(resolvedDbPath);
        }
      } catch {
        // WAL cleanup is best-effort; config shape may vary
      }
    } finally {
      delete process.env["COMIS_CONFIG_PATHS"];
      restoreProviderEnv();
      restoreProviderEnvPostBoot();
      // Dispose signal handlers to prevent leaks between test suites
      daemon.shutdownHandle.dispose();
      // Reset double-start guard
      activeHandle = null;
    }
  };

  // Resolve the daemon's memory.db path ONCE (same resolution the WAL-cleanup
  // branch uses): config.dataDir + config.memory.dbPath. The chaos-test probes
  // open it read-only per call so the chaos test can inspect the durable_runs /
  // outward_send_ledger rows the daemon persisted (those tables are not exposed
  // on DaemonInstance). Captured here because `daemon` is in scope.
  const resolveMemoryDbPath = (): string | undefined => {
    const dbPath = daemon.container.config.memory.dbPath;
    if (!dbPath) return undefined;
    const dataDir = daemon.container.config.dataDir;
    return dataDir
      ? resolve(dataDir, dbPath)
      : resolve(process.env["HOME"] ?? "", ".comis", dbPath);
  };

  const handle: TestDaemonHandle = {
    daemon,
    gatewayUrl,
    authToken,
    cleanup,
    // Expose the fake-timer record only when fake timers are in play.
    // When `useFakeTimers` is false the daemon ran on `createSystemTimers()`
    // (no record to expose); returning `undefined` is the correct signal that
    // the integration assertion is not applicable.
    getTimerRecord: () => fakeTimers?.unrefRecord(),
    getDurableRun: (rootRunId: string) => readDurableRun(resolveMemoryDbPath(), rootRunId),
    getOutwardLedgerRow: (rootRunId: string, stepIndex: number) =>
      readOutwardLedgerRow(resolveMemoryDbPath(), rootRunId, stepIndex),
  };

  // Set double-start guard
  activeHandle = handle;

  return handle;
}

/**
 * Create HTTP headers for authenticated gateway requests.
 */
export function makeAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Send a JSON-RPC 2.0 request to the gateway over WEBSOCKET (`/ws?token=`).
 *
 * AUTO-01 transport: the gateway serves the generic `handlers[method]`
 * dispatch ONLY over WebSocket — `POST /rpc` returns a plain HTTP 404 at HEAD
 * (the gateway mounts the dispatch via `createWsHandler` on `/ws`; its only HTTP
 * routes are `/health`, the static SPA, and a curated `/api/*` REST set). A live
 * drive discovered the prior `POST /rpc` form was latent-broken live —
 * it hit the 404, NOT the dispatch — and no prior test caught it (the live
 * callers are `COMIS_LIVE`-gated; `eventbus-daemon-e2e` asserts only an inline
 * `status < 500`; `chan.test.ts` injects a fake `rpc`). This helper now mirrors
 * the production `comis` CLI (`packages/cli/src/client/rpc-client.ts` is a WS
 * JSON-RPC client) by opening an authenticated WS, sending one request, and
 * unwrapping the response — so the harness drives the SAME transport the product
 * does. The CLI's `tg rpc` (test/live/bin/chan.ts) wraps this, so it too reaches
 * ANY gateway method over WS.
 *
 * The return/throw CONTRACT is unchanged from the old `/rpc` form (every caller —
 * `tg rpc`'s `invokeRpc`, the billing/health scenarios — depends on it): resolve
 * the unwrapped `result`, or throw `RPC error <code>: <message>` when the
 * response carries an `error` envelope.
 *
 * @param gatewayUrl - Base URL of the gateway (e.g., "http://127.0.0.1:4766")
 * @param method - JSON-RPC method name
 * @param params - Method parameters
 * @param token - Bearer token for authentication
 * @returns The result field from the JSON-RPC response
 * @throws If the response contains an error field, or the WS cannot connect
 */
export async function rpcRequest(
  gatewayUrl: string,
  method: string,
  params: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  // `RPC_FAST_MS` (30s): the harness's generic RPC drives no-LLM dispatch methods
  // (obs.*, config.get, health/billing snapshots), not agent.execute — the fast
  // timeout keeps a hung gateway from stalling the suite, while comfortably
  // covering a cold dispatch on a freshly-booted rig.
  const ws = await openAuthenticatedWebSocket(gatewayUrl, token, {
    timeoutMs: RPC_FAST_MS,
  });
  try {
    const envelope = (await sendJsonRpc(ws, method, params, 1, {
      timeoutMs: RPC_FAST_MS,
    })) as {
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };

    if (envelope.error) {
      throw new Error(`RPC error ${envelope.error.code}: ${envelope.error.message}`);
    }

    return envelope.result;
  } finally {
    ws.close();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the tracing-logger override the daemon's `DaemonOverrides` accepts.
 *
 * Single point of invocation for the `@comis/daemon` tracing-logger factory --
 * other branches (the tee path) bypass to raw pino so they can use
 * pino.multistream. This co-locates the residency-test wiring with the
 * existing log-tee wiring under one entry point.
 */
function buildTracingLoggerOverride(opts: {
  logStream?: Writable;
  disableRedaction: boolean;
}): (loggerOpts: {
  name: string;
  level?: string;
  transport?: import("pino").TransportMultiOptions | import("pino").TransportSingleOptions;
}) => unknown {
  const { logStream, disableRedaction } = opts;
  return (loggerOpts) => {
    if (logStream) {
      // Tee path: raw pino with multistream destination. No `redact:` field,
      // so payloads are emitted verbatim -- which is what the residency test
      // wants when `disableRedaction` is also true. Pre-existing callers
      // (e.g. secrets-lifecycle) likewise observe raw payloads here; this
      // branch's behavior has not changed.
      void disableRedaction; // Marker: tee path is implicit-disable-redact.
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require in test harness
      const pino = require("pino");
      const streamLevel = loggerOpts.level ?? "debug";
      const pinoMultistream = pino.multistream([
        { stream: process.stdout, level: streamLevel },
        { stream: logStream, level: streamLevel },
      ]);
      return pino(
        {
          name: loggerOpts.name,
          level: loggerOpts.level ?? "debug",
          timestamp: pino.stdTimeFunctions.isoTime,
          formatters: {
            level(label: string, number: number) {
              return { level: label, levelValue: number };
            },
          },
        },
        pinoMultistream,
      );
    }
    // disableRedaction-only path: defer to the real factory so the
    // AsyncLocalStorage tracing mixin is preserved (the daemon's production
    // code paths rely on it for traceId injection). The
    // LoggerOptions.disableRedaction field is the load-bearing toggle for
    // the residency test.
    //
    // Dynamic require keeps the harness's literal-symbol count down to a
    // single factory call site.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require in test harness
    const daemonModule = require("@comis/daemon") as {
      createTracingLogger: (o: {
        name: string;
        level?: string;
        disableRedaction?: boolean;
        transport?: import("pino").TransportMultiOptions | import("pino").TransportSingleOptions;
      }) => unknown;
    };
    return daemonModule.createTracingLogger({
      name: loggerOpts.name,
      level: loggerOpts.level,
      disableRedaction: true,
      ...(loggerOpts.transport ? { transport: loggerOpts.transport } : {}),
    });
  };
}

/**
 * Poll the gateway health endpoint until it responds successfully.
 */
async function waitForHealth(gatewayUrl: string): Promise<void> {
  for (let attempt = 0; attempt < HEALTH_POLL_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${gatewayUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Connection refused — gateway not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_DELAY_MS));
  }

  throw new Error(
    `Gateway health check failed after ${HEALTH_POLL_ATTEMPTS} attempts at ${gatewayUrl}/health`,
  );
}

/**
 * Inject dummy values for provider API-key env vars that are unset or empty.
 * Returns a rollback function that restores the original env state.
 *
 * Real values (set by the parent shell) are preserved untouched — the dummy
 * is written ONLY when the variable is undefined or the empty string. This
 * keeps the harness safe to use in CI alongside developer machines that
 * already export real provider keys.
 *
 * Why this exists: the daemon credential guard at
 * `packages/daemon/src/api/agent-handlers.ts` calls
 * `resolveProviderCredential(provider)` on `agents.create` and rejects the
 * RPC if no provider key is found in the env. Integration tests that
 * exercise agent CRUD do not make real LLM calls, so a non-empty placeholder
 * is sufficient to satisfy the guard.
 */
function seedDummyProviderApiKeys(): () => void {
  const restorers: Array<() => void> = [];
  for (const name of PROVIDER_API_KEY_ENV_VARS) {
    const existing = process.env[name];
    if (existing === undefined || existing === "") {
      process.env[name] = DUMMY_API_KEY_VALUE;
      // Existed-as-undefined → delete on rollback. Existed-as-"" → restore "".
      if (existing === undefined) {
        restorers.push(() => {
          delete process.env[name];
        });
      } else {
        restorers.push(() => {
          process.env[name] = "";
        });
      }
    }
    // else: real value present, preserve it (no restorer needed).
  }
  return () => {
    for (const restore of restorers) restore();
  };
}

// ---------------------------------------------------------------------------
// Echo delivery-count probe
// ---------------------------------------------------------------------------

/**
 * Count + list the messages an EchoChannelAdapter recorded — the deterministic
 * delivery-count probe the chaos test asserts on (exactly-one delivery
 * after a crash-mid-send + restart; exactly-two for the two-distinct-sends case).
 *
 * Echo's in-memory `sentMessages` store IS the platform truth in the test: the
 * chaos test registers an EchoChannelAdapter on `daemon.adapterRegistry`, so this
 * reads that adapter's `getSentMessages()`. Kept here (not just inline in the
 * test) so the delivery-count probe is a named, reusable harness seam and the
 * `sentMessages` source is documented in one place.
 *
 * Accepts the adapter structurally (anything exposing `getSentMessages()`) so the
 * harness need not statically import @comis/channels.
 */
export function getEchoDeliveries(
  echo: { getSentMessages(): Array<{ id: string; channelId: string; text: string; timestamp: number }> },
): Array<{ id: string; channelId: string; text: string; timestamp: number }> {
  return echo.getSentMessages();
}

// ---------------------------------------------------------------------------
// Durable-state probes (read memory.db directly)
// ---------------------------------------------------------------------------

/**
 * Open the daemon's memory.db READ-ONLY and return a better-sqlite3 handle, or
 * `undefined` when the path is absent or the open fails (e.g. the db has not been
 * created yet). Dynamic require keeps better-sqlite3 out of the harness's static
 * import graph (it is the same native dep the daemon already loads) and mirrors
 * the harness's existing dynamic-require seams (the pino factory).
 */
function openMemoryDbReadonly(dbPath: string | undefined): { db: unknown; close: () => void } | undefined {
  if (!dbPath) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require in test harness; better-sqlite3 is the daemon's native dep.
    const Database = require("better-sqlite3") as new (
      path: string,
      opts?: { readonly?: boolean; fileMustExist?: boolean },
    ) => { prepare: (sql: string) => { get: (...args: unknown[]) => unknown }; close: () => void };
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return { db, close: () => db.close() };
  } catch {
    // db not yet created / locked / unreadable — the probe returns undefined.
    return undefined;
  }
}

/** Read one `durable_runs` row by rootRunId; `undefined` when absent. */
function readDurableRun(dbPath: string | undefined, rootRunId: string): DurableRunProbeRow | undefined {
  const handle = openMemoryDbReadonly(dbPath);
  if (!handle) return undefined;
  try {
    const row = (
      handle.db as { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }
    )
      .prepare(
        `SELECT root_run_id, status, spawn_tree, outward_step, orphan_reason, last_heartbeat_at FROM durable_runs WHERE root_run_id = ?`,
      )
      .get(rootRunId) as
      | {
          root_run_id: string;
          status: string;
          spawn_tree: string;
          outward_step: number;
          orphan_reason: string | null;
          last_heartbeat_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      rootRunId: row.root_run_id,
      status: row.status,
      spawnTree: row.spawn_tree,
      outwardStep: row.outward_step,
      orphanReason: row.orphan_reason ?? undefined,
      lastHeartbeatAt: row.last_heartbeat_at,
    };
  } catch {
    return undefined;
  } finally {
    handle.close();
  }
}

/** Read one `outward_send_ledger` row by (rootRunId, stepIndex); `undefined` when absent. */
function readOutwardLedgerRow(
  dbPath: string | undefined,
  rootRunId: string,
  stepIndex: number,
): OutwardLedgerProbeRow | undefined {
  const handle = openMemoryDbReadonly(dbPath);
  if (!handle) return undefined;
  try {
    const row = (
      handle.db as { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }
    )
      .prepare(
        `SELECT root_run_id, step_index, state, channel_type, channel_id, platform_message_id, reconcile_outcome, content_digest FROM outward_send_ledger WHERE root_run_id = ? AND step_index = ?`,
      )
      .get(rootRunId, stepIndex) as
      | {
          root_run_id: string;
          step_index: number;
          state: string;
          channel_type: string;
          channel_id: string;
          platform_message_id: string | null;
          reconcile_outcome: string | null;
          content_digest: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      rootRunId: row.root_run_id,
      stepIndex: row.step_index,
      state: row.state,
      channelType: row.channel_type,
      channelId: row.channel_id,
      platformMessageId: row.platform_message_id ?? undefined,
      reconcileOutcome: row.reconcile_outcome ?? undefined,
      contentDigest: row.content_digest,
    };
  } catch {
    return undefined;
  } finally {
    handle.close();
  }
}
