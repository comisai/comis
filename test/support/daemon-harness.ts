// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon Test Harness: Programmatic daemon bootstrap for integration tests.
 *
 * Starts the real Comis daemon with test configuration, provides a handle
 * for interacting with the gateway, and ensures graceful cleanup after tests.
 *
 * Used by integration test suites across phases 27-36.
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
import type { DaemonInstance } from "@comis/daemon";

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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_CONFIG_PATH = resolve(__dirname, "../config/config.test.yaml");
const HEALTH_POLL_ATTEMPTS = 10;
const HEALTH_POLL_DELAY_MS = 500;

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

  // Build overrides: prevent process.exit, optionally redirect logs
  const overrides: Record<string, unknown> = {
    ...options?.overrides,
    exit: (code: number) => {
      throw new Error(`Daemon exit with code ${code}`);
    },
  };

  // If logStream provided, override createTracingLogger to tee output
  if (options?.logStream) {
    const logStream = options.logStream;
    overrides.createTracingLogger = (opts: { name: string; level?: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require in test harness
      const pino = require("pino");
      const streamLevel = opts.level ?? "debug";
      const pinoMultistream = pino.multistream([
        { stream: process.stdout, level: streamLevel },
        { stream: logStream, level: streamLevel },
      ]);
      return pino(
        {
          name: opts.name,
          level: opts.level ?? "debug",
          timestamp: pino.stdTimeFunctions.isoTime,
          formatters: {
            level(label: string, number: number) {
              return { level: label, levelValue: number };
            },
          },
        },
        pinoMultistream,
      );
    };
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
