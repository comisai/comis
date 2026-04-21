// SPDX-License-Identifier: Apache-2.0
/**
 * v13.0 Structural Integration Tests (Non-LLM)
 *
 * Validates v13.0 Agent Intelligence daemon bootstrap, config propagation,
 * and log cleanliness WITHOUT requiring LLM API keys. Tests cover:
 *
 *   1. Daemon boots cleanly with v13.0 config (health + gateway.status)
 *   2. config.get returns reactionLevel for default agent (Phase 176)
 *   3. Agent config has expected v13.0 shape (name, model, provider, budgets)
 *   4. Daemon logs contain no unexpected errors or warnings
 *
 * Uses port 8550 with a dedicated memory database for isolation.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("v13.0 Structural Integration Tests (Non-LLM)", () => {
  let handle: TestDaemonHandle;
  let gatewayUrl: string;
  let authToken: string;
  let ws: WebSocket;
  let logCapture: ReturnType<typeof createLogCapture>;
  let msgId = 100;

  beforeAll(async () => {
    logCapture = createLogCapture();
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
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 1: Daemon boots cleanly with v13.0 config
  // -------------------------------------------------------------------------

  it("daemon boots cleanly with v13.0 config", async () => {
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
  // Test 2: config.get returns reactionLevel for default agent
  // -------------------------------------------------------------------------

  it("config.get returns reactionLevel for default agent", async () => {
    const response = (await sendJsonRpc(
      ws,
      "config.get",
      { section: "agents" },
      msgId++,
      { timeoutMs: RPC_FAST_MS },
    )) as Record<string, unknown>;

    expect(response).toHaveProperty("result");

    const result = response.result as Record<string, unknown>;
    const agents = result.agents as Record<
      string,
      Record<string, unknown>
    >;
    expect(agents).toBeDefined();
    expect(agents).toHaveProperty("default");
    expect(agents.default.reactionLevel).toBe("minimal");
  });

  // -------------------------------------------------------------------------
  // Test 3: Agent config has expected v13.0 shape
  // -------------------------------------------------------------------------

  it("agent config has expected v13.0 shape", async () => {
    const response = (await sendJsonRpc(
      ws,
      "config.get",
      { section: "agents" },
      msgId++,
      { timeoutMs: RPC_FAST_MS },
    )) as Record<string, unknown>;

    expect(response).toHaveProperty("result");

    const result = response.result as Record<string, unknown>;
    const agents = result.agents as Record<
      string,
      Record<string, unknown>
    >;
    const defaultAgent = agents.default;

    expect(defaultAgent.name).toBe("V13StructuralAgent");
    expect(defaultAgent.model).toBe("claude-opus-4-6");
    expect(defaultAgent.provider).toBe("anthropic");
    expect(defaultAgent.maxSteps).toBe(10);
    expect(typeof defaultAgent.budgets).toBe("object");
    expect(typeof defaultAgent.circuitBreaker).toBe("object");
  });

  // -------------------------------------------------------------------------
  // Test 4: Daemon logs contain no unexpected errors or warnings
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
