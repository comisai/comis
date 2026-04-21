// SPDX-License-Identifier: Apache-2.0
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDaemon, makeAuthHeaders, type TestDaemonHandle } from "../support/daemon-harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-gateway-auth.yaml");

describe("Gateway Auth: Health, Rejection & REST API", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
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

  // ---------------------------------------------------------------------------
  // GATE-01 — Health endpoint (no auth required)
  // ---------------------------------------------------------------------------

  it("GET /health returns 200 without authentication", async () => {
    const response = await fetch(`${handle.gatewayUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("status", "ok");
    expect(body).toHaveProperty("timestamp");
    expect(typeof body.timestamp).toBe("string");
  });

  it("GET /health includes a valid ISO timestamp", async () => {
    const response = await fetch(`${handle.gatewayUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const timestamp = body.timestamp as string;
    // Verify it parses as a valid date and is a reasonable ISO string
    const parsed = new Date(timestamp);
    expect(parsed.getTime()).not.toBeNaN();
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ---------------------------------------------------------------------------
  // GATE-02 — Unauthenticated rejection
  // ---------------------------------------------------------------------------

  it("unauthenticated GET /api/agents returns 401", async () => {
    const response = await fetch(`${handle.gatewayUrl}/api/agents`);
    expect(response.status).toBe(401);
  });

  it("unauthenticated GET /api/memory/search returns 401", async () => {
    const response = await fetch(`${handle.gatewayUrl}/api/memory/search?q=test`);
    expect(response.status).toBe(401);
  });

  it("unauthenticated GET /api/memory/stats returns 401", async () => {
    const response = await fetch(`${handle.gatewayUrl}/api/memory/stats`);
    expect(response.status).toBe(401);
  });

  it("unauthenticated POST /api/chat returns 401", async () => {
    const response = await fetch(`${handle.gatewayUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(response.status).toBe(401);
  });

  it("unauthenticated WebSocket /ws is rejected with code 4001", async () => {
    const port = handle.daemon.container.config.gateway.port;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const result = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WebSocket close event not received within 5 seconds"));
      }, 5_000);

      const ws = new WebSocket(wsUrl);

      ws.addEventListener("close", (event) => {
        clearTimeout(timeout);
        resolve({ code: event.code, reason: event.reason });
      });

      ws.addEventListener("error", () => {
        // Error events may fire before or alongside close — we only care about close
      });
    });

    expect(result.code).toBe(4001);
    expect(result.reason).toContain("Unauthorized");
  });

  // ---------------------------------------------------------------------------
  // GATE-04 — Authenticated REST API
  // ---------------------------------------------------------------------------

  it("authenticated GET /api/agents returns agent list", async () => {
    const response = await fetch(`${handle.gatewayUrl}/api/agents`, {
      headers: makeAuthHeaders(handle.authToken),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("agents");
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBeGreaterThanOrEqual(1);
    expect(body.agents[0]).toHaveProperty("name", "TestAgent");
  });

  it("authenticated GET /api/memory/stats returns stats", async () => {
    const response = await fetch(`${handle.gatewayUrl}/api/memory/stats`, {
      headers: makeAuthHeaders(handle.authToken),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeDefined();
  });

  it("authenticated GET /api/memory/search returns results", async () => {
    const response = await fetch(`${handle.gatewayUrl}/api/memory/search?q=test`, {
      headers: makeAuthHeaders(handle.authToken),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("results");
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("authenticated GET /api/activity returns entries", async () => {
    const response = await fetch(`${handle.gatewayUrl}/api/activity`, {
      headers: makeAuthHeaders(handle.authToken),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("entries");
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body).toHaveProperty("count");
    expect(typeof body.count).toBe("number");
  });
});
