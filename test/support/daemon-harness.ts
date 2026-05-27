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
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDatabase } from "./db-cleanup.js";
import { ASYNC_SETTLE_MS } from "./timeouts.js";
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
   * composition root (WIRE-06 test seam). When provided, the harness forwards
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

// ---------------------------------------------------------------------------
// Double-start guard
// ---------------------------------------------------------------------------

/** Tracks the currently active test daemon handle to prevent double-start. */
let activeHandle: TestDaemonHandle | null = null;

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

  // WIRE-06 test-only renderer-injection seam. Mirrors the useFakeTimers →
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

  // Start the daemon
  const daemon = await main(overrides as unknown as Parameters<typeof main>[0]);

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
 * Send a JSON-RPC 2.0 request to the gateway.
 *
 * @param gatewayUrl - Base URL of the gateway (e.g., "http://127.0.0.1:4766")
 * @param method - JSON-RPC method name
 * @param params - Method parameters
 * @param token - Bearer token for authentication
 * @returns The result field from the JSON-RPC response
 * @throws If the response contains an error field
 */
export async function rpcRequest(
  gatewayUrl: string,
  method: string,
  params: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const response = await fetch(`${gatewayUrl}/rpc`, {
    method: "POST",
    headers: makeAuthHeaders(token),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  const json = (await response.json()) as {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };

  if (json.error) {
    throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  }

  return json.result;
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
