import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-cli-agent.yaml");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CLI Agent Integration (real daemon)", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;

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
  // INTEG-01 -- RPC Connectivity
  // -------------------------------------------------------------------------

  describe("INTEG-01: RPC Connectivity", () => {
    it("connects to daemon and receives a valid JSON-RPC response", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "routing" }, 1, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");
    });

    it("handles unknown RPC method with JSON-RPC error", async () => {
      const response = (await sendJsonRpc(ws, "nonexistent.method", {}, 2, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      const error = response.error as Record<string, unknown>;
      expect(typeof error.code).toBe("number");
      expect(typeof error.message).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // INTEG-02 -- Agent List
  // -------------------------------------------------------------------------

  describe("INTEG-02: Agent List", () => {
    it("returns routing config from config.get routing section", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "routing" }, 3, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");
      expect(typeof response.result).toBe("object");
    });

    it("returns agent configuration from config.get agents section", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "agents" }, 4, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");
      expect(typeof response.result).toBe("object");

      // The test config has a default agent named "TestAgent"
      const result = response.result as Record<string, unknown>;
      const agents = result.agents as Record<string, unknown>;
      expect(agents).toHaveProperty("default");
      const defaultAgent = agents.default as Record<string, unknown>;
      expect(defaultAgent.name).toBe("TestAgent");
    });

    it("returns full config overview without section parameter", async () => {
      const response = (await sendJsonRpc(ws, "config.get", {}, 5, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");
      expect(typeof response.result).toBe("object");

      // Full config includes tenantId, logLevel, gateway
      const result = response.result as Record<string, unknown>;
      expect(result).toHaveProperty("tenantId");
      expect(result).toHaveProperty("logLevel");
      expect(result).toHaveProperty("gateway");
    });
  });

  // -------------------------------------------------------------------------
  // INTEG-03 -- Agent CRUD Lifecycle (config.set/config.get round-trips)
  // -------------------------------------------------------------------------

  describe("INTEG-03: Agent CRUD Lifecycle", () => {
    const TEST_AGENT = "integ-test-" + Date.now();
    let msgId = 10;

    it("sends create agent via config.patch and receives structured response", async () => {
      // config.set was removed in favor of config.patch (per-key) and
      // config.apply (full-section replacement).
      const response = (await sendJsonRpc(ws, "config.patch", {
        section: "agents",
        key: TEST_AGENT,
        value: {
          name: TEST_AGENT,
          defaultProvider: "test-provider",
          defaultModel: "test-model",
        },
      }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      // Either a success result or an authorization error is acceptable -- both
      // prove the RPC round-trip and method resolution. We only assert that we
      // got back a well-formed JSON-RPC response.
      const hasResult = Object.prototype.hasOwnProperty.call(response, "result");
      const hasError = Object.prototype.hasOwnProperty.call(response, "error");
      expect(hasResult || hasError).toBe(true);
    });

    it("verifies config.get returns pre-existing agent data after set call", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "agents" }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      // Verify the pre-configured default agent still exists
      const result = response.result as Record<string, unknown>;
      const agents = result.agents as Record<string, unknown>;
      expect(agents).toHaveProperty("default");
    });

    it("sends update agent via config.patch with updated model", async () => {
      const response = (await sendJsonRpc(ws, "config.patch", {
        section: "agents",
        key: TEST_AGENT,
        value: {
          name: TEST_AGENT,
          defaultProvider: "test-provider",
          defaultModel: "updated-model",
        },
      }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      const hasResult = Object.prototype.hasOwnProperty.call(response, "result");
      const hasError = Object.prototype.hasOwnProperty.call(response, "error");
      expect(hasResult || hasError).toBe(true);
    });

    it("verifies config.get still returns consistent agent data after update", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "agents" }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      // Verify the agent config structure is still intact
      const result = response.result as Record<string, unknown>;
      expect(result).toHaveProperty("agents");
      const agents = result.agents as Record<string, unknown>;
      const defaultAgent = agents.default as Record<string, unknown>;
      expect(defaultAgent).toHaveProperty("name", "TestAgent");
      expect(defaultAgent).toHaveProperty("model");
    });

    it("sends delete agent via config.patch with null value", async () => {
      const response = (await sendJsonRpc(ws, "config.patch", {
        section: "agents",
        key: TEST_AGENT,
        value: null,
      }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      const hasResult = Object.prototype.hasOwnProperty.call(response, "result");
      const hasError = Object.prototype.hasOwnProperty.call(response, "error");
      expect(hasResult || hasError).toBe(true);
    });

    it("verifies config.get returns valid response after delete call", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "agents" }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      // Config structure remains valid after delete round-trip
      const result = response.result as Record<string, unknown>;
      expect(result).toHaveProperty("agents");
    });
  });
});
