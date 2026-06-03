// SPDX-License-Identifier: Apache-2.0
/**
 * Structural Integration Tests (Non-LLM)
 *
 * Validates Agent Intelligence daemon bootstrap, config propagation,
 * and log cleanliness WITHOUT requiring LLM API keys. Tests cover:
 *
 *   - Daemon boots cleanly with the structural config (health + gateway.status)
 *   - config.get returns reactionLevel for default agent
 *   - Agent config has the expected shape (name, model, provider, budgets)
 *   - Daemon logs contain no unexpected errors or warnings
 *
 * Uses port 8550 with a dedicated memory database for isolation.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";
import { createLogCapture } from "../support/log-verifier.js";
import { validateLogs, formatReport } from "../support/log-validator.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-v13-structural.yaml",
);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Structural Integration Tests (Non-LLM)", () => {
  let handle: TestDaemonHandle;
  let gatewayUrl: string;
  let authToken: string;
  let ws: WebSocket;
  let logCapture: ReturnType<typeof createLogCapture>;
  let msgId = 100;
  let tempDataDir: string;
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    logCapture = createLogCapture();
    // Isolate the data dir so the boot mismatch-warn does not fire on
    // stranded file-side credentials left in the shared ~/.comis by dev usage or other
    // tests — this suite asserts the daemon logs contain no unexpected warnings.
    originalDataDir = process.env["COMIS_DATA_DIR"];
    tempDataDir = mkdtempSync(resolve(tmpdir(), "comis-v13-structural-"));
    process.env["COMIS_DATA_DIR"] = tempDataDir;
    handle = await startTestDaemon({
      configPath: CONFIG_PATH,
      logStream: logCapture.stream,
    });
    gatewayUrl = handle.gatewayUrl;
    authToken = handle.authToken;
    ws = await openAuthenticatedWebSocket(gatewayUrl, authToken);
  }, 60_000);

  afterAll(async () => {
    if (ws) ws.close();
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
    if (originalDataDir === undefined) {
      delete process.env["COMIS_DATA_DIR"];
    } else {
      process.env["COMIS_DATA_DIR"] = originalDataDir;
    }
    try {
      rmSync(tempDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Daemon boots cleanly with the structural config
  // -------------------------------------------------------------------------

  it("daemon boots cleanly with the expected config", async () => {
    // REST health check
    const healthResponse = await fetch(`${gatewayUrl}/health`, {
      headers: makeAuthHeaders(authToken),
    });
    expect(healthResponse.status).toBe(200);

    const healthBody = (await healthResponse.json()) as Record<
      string,
      unknown
    >;
    expect(healthBody.status).toBe("ok");

    // RPC gateway.status
    const rpcResponse = (await sendJsonRpc(
      ws,
      "gateway.status",
      {},
      msgId++,
      { timeoutMs: RPC_FAST_MS },
    )) as Record<string, unknown>;

    expect(rpcResponse).toHaveProperty("result");
    const result = rpcResponse.result as Record<string, unknown>;
    expect(typeof result.pid).toBe("number");
    expect(typeof result.uptime).toBe("number");
  });

  // -------------------------------------------------------------------------
  // config.get returns reactionLevel for default agent
  // -------------------------------------------------------------------------

  it("agents.get returns reactionLevel for default agent", async () => {
    // Agent config is read via agents.get rather than
    // config.get({section:"agents"}), which no longer egresses agent configs.
    const response = (await sendJsonRpc(
      ws,
      "agents.get",
      { agentId: "default" },
      msgId++,
      { timeoutMs: RPC_FAST_MS },
    )) as Record<string, unknown>;

    expect(response).toHaveProperty("result");

    const result = response.result as Record<string, unknown>;
    expect(result.agentId).toBe("default");
    const config = result.config as Record<string, unknown>;
    expect(config).toBeDefined();
    expect(config.reactionLevel).toBe("minimal");
  });

  // -------------------------------------------------------------------------
  // Agent config has the expected shape
  // -------------------------------------------------------------------------

  it("agent config has the expected shape", async () => {
    // Agent config is read via agents.get rather than
    // config.get({section:"agents"}), which no longer egresses agent configs.
    const response = (await sendJsonRpc(
      ws,
      "agents.get",
      { agentId: "default" },
      msgId++,
      { timeoutMs: RPC_FAST_MS },
    )) as Record<string, unknown>;

    expect(response).toHaveProperty("result");

    const result = response.result as Record<string, unknown>;
    const defaultAgent = result.config as Record<string, unknown>;

    expect(defaultAgent.name).toBe("V13StructuralAgent");
    expect(defaultAgent.model).toBe("claude-opus-4-6");
    expect(defaultAgent.provider).toBe("anthropic");
    expect(defaultAgent.maxSteps).toBe(10);
    expect(typeof defaultAgent.budgets).toBe("object");
    expect(typeof defaultAgent.circuitBreaker).toBe("object");
  });

  // -------------------------------------------------------------------------
  // Daemon logs contain no unexpected errors or warnings
  // -------------------------------------------------------------------------

  it("daemon logs contain no unexpected errors or warnings", async () => {
    const entries = logCapture.getEntries();
    const report = validateLogs(entries);

    if (!report.clean) {
      console.log(formatReport(report));
    }

    expect(report.clean).toBe(true);
  });
});
