import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDaemon, makeAuthHeaders, type TestDaemonHandle } from "../support/daemon-harness.js";
import { createLogCapture, assertLogContains, assertLogSequence } from "../support/log-verifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-smoke.yaml");

describe("Smoke Test: Daemon Infrastructure", () => {
  let handle: TestDaemonHandle;
  const logCapture = createLogCapture();

  beforeAll(async () => {
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
        // Expected: graceful shutdown calls the overridden exit() which throws.
        // "Daemon exit with code 0" is normal shutdown. Suppress it.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  it("daemon starts successfully", () => {
    expect(handle).toBeDefined();
    expect(handle.daemon).toBeDefined();
    expect(handle.daemon.container).toBeDefined();
    expect(handle.gatewayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("config has debug logging enabled", () => {
    expect(handle.daemon.container.config.logLevel).toBe("debug");
  });

  it("config has test agent identity", () => {
    const agents = handle.daemon.container.config.agents;
    expect(agents.default).toBeDefined();
    expect(agents.default.name).toBe("TestAgent");
  });

  it("config has relaxed rate limits", () => {
    const rateLimit = handle.daemon.container.config.gateway.rateLimit;
    expect(rateLimit.maxRequests).toBeGreaterThanOrEqual(10000);
  });

  it("GET /health returns 200", async () => {
    const response = await fetch(`${handle.gatewayUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("status", "ok");
  });

  it("unauthenticated REST API is rejected", async () => {
    // The gateway REST API requires bearer token auth for all endpoints except /health
    const response = await fetch(`${handle.gatewayUrl}/api/agents`);
    // Should be rejected (401 or error response)
    expect(response.status).toBe(401);
  });

  it("authenticated REST API succeeds", async () => {
    // The gateway exposes a REST API at /api/* (JSON-RPC is WebSocket-only at /ws)
    const response = await fetch(`${handle.gatewayUrl}/api/agents`, {
      headers: makeAuthHeaders(handle.authToken),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeDefined();
    // Should contain at least the default agent
    expect(body).toHaveProperty("agents");
  });

  it("gateway has test token configured", () => {
    const tokens = handle.daemon.container.config.gateway.tokens;
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens[0]?.scopes).toContain("admin");
  });

  it("scheduler cron is enabled", () => {
    // At least the default agent should have a cron scheduler
    expect(handle.daemon.cronSchedulers.size).toBeGreaterThanOrEqual(1);
  });

  it("daemon logs contain expected startup messages", () => {
    const entries = logCapture.getEntries();
    expect(entries.length).toBeGreaterThan(0);

    // Verify individual startup messages exist
    const daemonStarted = assertLogContains(entries, { msg: "Comis daemon started" });
    expect(daemonStarted.matched).toBe(true);

    const gatewayStarted = assertLogContains(entries, { msg: "Gateway server started" });
    expect(gatewayStarted.matched).toBe(true);
  });

  it("daemon logs have correct startup sequence", () => {
    const entries = logCapture.getEntries();

    // Verify startup messages appear in logical order:
    // Gateway starts first, then daemon reports overall startup complete
    const sequence = assertLogSequence(entries, [
      { msg: "Gateway server started" },
      { msg: "Comis daemon started" },
    ]);
    expect(sequence.matched).toBe(true);
    expect(sequence.entries).toHaveLength(2);
  });
});
