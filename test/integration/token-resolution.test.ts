/**
 * Token Resolution Integration Tests (TEST-02)
 *
 * Validates the three-tier gateway token resolution chain:
 *   1. Config: explicit secret present and >= 32 chars -> use directly
 *   2. Env/SecretManager: GATEWAY_TOKEN_{ID} env variable -> use if found
 *   3. Auto-generate: generateStrongToken() -> 64-char base64url + WARN log
 *
 * Covers:
 *   - Daemon boots with mixed token configuration (explicit + missing secret)
 *   - Auto-generated token triggers WARN log with correct tokenId and envVar
 *   - WARN log contains hint and errorKind fields per logging rules
 *   - Config token with explicit secret does NOT trigger WARN log
 *   - Authenticated RPC succeeds with config-provided token
 *
 * Uses port 8561 (config.test-token-resolution.yaml).
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  createLogCapture,
  waitForLogEntry,
  filterLogs,
} from "../support/log-verifier.js";
import { LOG_POLL_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-token-resolution.yaml");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Token Resolution Integration Tests (TEST-02)", () => {
  let handle: TestDaemonHandle;
  let logCapture: ReturnType<typeof createLogCapture>;

  beforeAll(async () => {
    logCapture = createLogCapture();
    handle = await startTestDaemon({
      configPath: CONFIG_PATH,
      logStream: logCapture.stream,
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Boot verification
  // ---------------------------------------------------------------------------

  it("daemon boots successfully with mixed token configuration", async () => {
    // The first token has a real secret, so the daemon harness extracts it as authToken
    expect(handle.authToken).toBeTruthy();
    expect(handle.authToken).toBe("test-token-resolution-auth-key-integration-01");

    const response = await fetch(`${handle.gatewayUrl}/health`);
    expect(response.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Auto-generated token WARN log
  // ---------------------------------------------------------------------------

  it("auto-generates token and emits WARN log when no secret configured", async () => {
    const result = await waitForLogEntry(
      logCapture.getEntries,
      { level: "warn", msg: /auto-generated/ },
      { timeoutMs: LOG_POLL_MS },
    );

    expect(result.matched).toBe(true);
    expect(result.entry).toBeDefined();
    expect(result.entry!.tokenId).toBe("auto-gen-token");
    // Token ID "auto-gen-token" -> env key "GATEWAY_TOKEN_AUTO_GEN_TOKEN"
    expect(result.entry!.envVar).toBe("GATEWAY_TOKEN_AUTO_GEN_TOKEN");
  });

  // ---------------------------------------------------------------------------
  // WARN log hint and errorKind fields
  // ---------------------------------------------------------------------------

  it("WARN log contains hint for persistence", () => {
    const warnEntries = filterLogs(logCapture.getEntries(), {
      level: "warn",
      msg: /auto-generated/,
    });

    expect(warnEntries.length).toBeGreaterThanOrEqual(1);

    const entry = warnEntries[0]!;
    expect(entry.hint).toBeDefined();
    expect(typeof entry.hint).toBe("string");
    expect(entry.hint as string).toContain("GATEWAY_TOKEN_AUTO_GEN_TOKEN");
    expect(entry.errorKind).toBe("config");
  });

  // ---------------------------------------------------------------------------
  // Config token with explicit secret does NOT trigger WARN
  // ---------------------------------------------------------------------------

  it("config token with explicit secret does NOT trigger WARN log", () => {
    const warnEntries = filterLogs(logCapture.getEntries(), {
      level: "warn",
      msg: /auto-generated/,
    });

    // None of the WARN auto-generated entries should reference the auth-token
    for (const entry of warnEntries) {
      expect(entry.tokenId).not.toBe("auth-token");
    }
  });

  // ---------------------------------------------------------------------------
  // Authenticated REST API with config-provided token
  // ---------------------------------------------------------------------------

  it("authenticated REST API request succeeds with config-provided token", async () => {
    // The REST API at /api/agents requires bearer token auth with "rpc" scope.
    // The auth-token has scopes ["rpc", "ws", "admin"] so this should succeed.
    const response = await fetch(`${handle.gatewayUrl}/api/agents`, {
      headers: {
        Authorization: `Bearer ${handle.authToken}`,
        "Content-Type": "application/json",
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    // The /api/agents endpoint returns agent configuration.
    // Response contains an "agents" array with at least one entry.
    expect(body).toHaveProperty("agents");
    const agents = body.agents as unknown[];
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });
});
