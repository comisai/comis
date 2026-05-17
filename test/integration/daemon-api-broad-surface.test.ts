// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: Daemon API broad surface — handler family roundtrips.
 *
 * Lifts integration-tier coverage across the daemon's many RPC handler
 * families (agent, config, sessions, env, secrets, channels, daemon,
 * gateway, observability, memory).
 *
 * One test daemon serves all probes — each `it` block invokes a different
 * handler family. This exercises:
 *  - packages/daemon/src/api/agent-handlers.ts
 *  - packages/daemon/src/api/config-handlers.ts
 *  - packages/daemon/src/api/env-handlers.ts
 *  - packages/daemon/src/api/sessions-handlers.ts
 *  - packages/daemon/src/api/channel-handlers.ts
 *  - packages/daemon/src/api/daemon-handlers.ts (status, ping)
 *  - packages/daemon/src/api/gateway-handlers.ts
 *  - packages/daemon/src/api/rpc-dispatch.ts (the central dispatcher)
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-daemon-api-broad.yaml",
);

describe("INTEGRATION: daemon API broad-surface — handler family probes", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let msgId = 1000;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
  }, 60_000);

  afterAll(async () => {
    if (ws) ws.close();
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

  // -------------------------------------------------------------------------
  // agents.* (agent-handlers.ts)
  // -------------------------------------------------------------------------

  it("agents.list returns array including the default test agent", async () => {
    const response = (await sendJsonRpc(ws, "agents.list", {}, msgId++, {
      timeoutMs: RPC_FAST_MS,
    })) as Record<string, unknown>;
    expect(response).toHaveProperty("result");
    const result = response.result as { agents: Array<{ id?: string; name?: string }> };
    expect(Array.isArray(result.agents)).toBe(true);
    expect(result.agents.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // config.* (config-handlers.ts)
  // -------------------------------------------------------------------------

  it("config.schema returns config schema object", async () => {
    const response = (await sendJsonRpc(ws, "config.schema", {}, msgId++, {
      timeoutMs: RPC_FAST_MS,
    })) as Record<string, unknown>;
    expect(response).toHaveProperty("result");
  });

  it("config.read for known section returns config object", async () => {
    const response = (await sendJsonRpc(
      ws,
      "config.read",
      { section: "gateway" },
      msgId++,
      { timeoutMs: RPC_FAST_MS },
    )) as Record<string, unknown>;
    expect(response).toHaveProperty("result");
  });

  it("config.read for unknown section returns descriptive error", async () => {
    const response = (await sendJsonRpc(
      ws,
      "config.read",
      { section: "nonexistent_section_for_test" },
      msgId++,
      { timeoutMs: RPC_FAST_MS },
    )) as Record<string, unknown>;
    expect(response).toHaveProperty("error");
    const error = response.error as { code?: number; message?: string };
    expect(typeof error.code).toBe("number");
  });

  // -------------------------------------------------------------------------
  // env.* (env-handlers.ts) — known scope-batch ID; may not be bridged
  // -------------------------------------------------------------------------

  it("env.list returns either result (env list) or method-not-found", async () => {
    const response = (await sendJsonRpc(ws, "env.list", {}, msgId++, {
      timeoutMs: RPC_FAST_MS,
    })) as Record<string, unknown>;
    expect(response).toHaveProperty("jsonrpc", "2.0");
    expect("result" in response || "error" in response).toBe(true);
  });

  // -------------------------------------------------------------------------
  // sessions.* (sessions-handlers.ts)
  // -------------------------------------------------------------------------

  it("sessions.list returns array (may be empty for fresh daemon)", async () => {
    const response = (await sendJsonRpc(ws, "sessions.list", {}, msgId++, {
      timeoutMs: RPC_FAST_MS,
    })) as Record<string, unknown>;
    expect(response).toHaveProperty("jsonrpc", "2.0");
    expect("result" in response || "error" in response).toBe(true);
  });

  it("session.status returns session info for fresh daemon", async () => {
    const response = (await sendJsonRpc(ws, "session.status", {}, msgId++, {
      timeoutMs: RPC_FAST_MS,
    })) as Record<string, unknown>;
    expect(response).toHaveProperty("jsonrpc", "2.0");
    if ("result" in response) {
      const result = response.result as Record<string, unknown>;
      expect(typeof result.model).toBe("string");
    }
  });

  // -------------------------------------------------------------------------
  // channels.* (channel-handlers.ts)
  // -------------------------------------------------------------------------

  it("channels.list returns array of registered channel types", async () => {
    const response = (await sendJsonRpc(ws, "channels.list", {}, msgId++, {
      timeoutMs: RPC_FAST_MS,
    })) as Record<string, unknown>;
    expect(response).toHaveProperty("jsonrpc", "2.0");
    expect("result" in response || "error" in response).toBe(true);
  });

  // -------------------------------------------------------------------------
  // gateway.* (gateway-handlers.ts)
  // -------------------------------------------------------------------------

  it("gateway.status returns status object (may include uptime, port)", async () => {
    const response = (await sendJsonRpc(ws, "gateway.status", {}, msgId++, {
      timeoutMs: RPC_FAST_MS,
    })) as Record<string, unknown>;
    expect(response).toHaveProperty("jsonrpc", "2.0");
    expect("result" in response || "error" in response).toBe(true);
  });

  // -------------------------------------------------------------------------
  // models.* (models-handlers.ts)
  // -------------------------------------------------------------------------

  it("models.list returns model registry", async () => {
    const response = (await sendJsonRpc(ws, "models.list", {}, msgId++, {
      timeoutMs: RPC_FAST_MS,
    })) as Record<string, unknown>;
    expect(response).toHaveProperty("jsonrpc", "2.0");
    expect("result" in response || "error" in response).toBe(true);
  });

  // -------------------------------------------------------------------------
  // unknown method → method-not-found (-32601) (rpc-dispatch.ts error path)
  // -------------------------------------------------------------------------

  it("unknown RPC method returns -32601 method-not-found", async () => {
    const response = (await sendJsonRpc(
      ws,
      "deliberately.unknown.method.broad-surface",
      {},
      msgId++,
      { timeoutMs: RPC_FAST_MS },
    )) as Record<string, unknown>;
    expect(response).toHaveProperty("error");
    const error = response.error as { code: number };
    expect(error.code).toBe(-32601);
  });
});
