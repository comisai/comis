/**
 * System Gateway Validation Integration Tests
 *
 * Covers the following phases from the comprehensive system test plan:
 *
 *   Phase 1 — Auth edge cases (malformed headers, invalid tokens, CORS)
 *   Phase 2 — REST API data endpoint gaps (channels, activity limits, chat/history)
 *   Phase 3 — Chat endpoint validation (content-type, body shape, empty/non-string message)
 *   Phase 6 — OpenAI-compatible API edge cases (empty messages, missing auth)
 *   Phase 12 — Error handling (JSON 404, large request body, concurrent requests)
 *
 * None of these tests require an LLM API key — they validate gateway-level
 * HTTP contract enforcement without triggering real agent execution.
 *
 * @module
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-system-gateway.yaml");

describe("System Gateway Validation", () => {
  let handle: TestDaemonHandle;
  let gatewayUrl: string;
  let authToken: string;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    gatewayUrl = handle.gatewayUrl;
    authToken = handle.authToken;
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

  // ===========================================================================
  // Phase 1: Auth Edge Cases
  // ===========================================================================

  describe("Phase 1: Auth Edge Cases", () => {
    it("AUTH-EDGE-01: malformed auth header (no Bearer prefix) returns 401", async () => {
      const response = await fetch(`${gatewayUrl}/api/agents`, {
        headers: { Authorization: authToken },
      });
      expect(response.status).toBe(401);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("error", "Unauthorized");
    });

    it("AUTH-EDGE-02: empty authorization header returns 401", async () => {
      const response = await fetch(`${gatewayUrl}/api/agents`, {
        headers: { Authorization: "" },
      });
      expect(response.status).toBe(401);
    });

    it("AUTH-EDGE-03: invalid token returns 401 (not a stack trace)", async () => {
      const response = await fetch(`${gatewayUrl}/api/agents`, {
        headers: { Authorization: "Bearer INVALID_TOKEN_123" },
      });
      expect(response.status).toBe(401);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("error", "Unauthorized");
      // Should NOT contain stack trace or internal error details
      expect(JSON.stringify(body)).not.toContain("stack");
      expect(JSON.stringify(body)).not.toContain("Error:");
    });

    it("AUTH-EDGE-04: authentication required for POST /api/chat", async () => {
      const response = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(response.status).toBe(401);
    });
  });

  // ===========================================================================
  // Phase 1.6: CORS Headers
  // ===========================================================================

  describe("Phase 1.6: CORS Headers", () => {
    it("CORS-01: OPTIONS preflight returns CORS headers", async () => {
      const response = await fetch(`${gatewayUrl}/api/agents`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "GET",
        },
      });

      // Preflight should succeed
      expect(response.status).toBeLessThan(400);

      // Check CORS headers
      const allowOrigin = response.headers.get("access-control-allow-origin");
      expect(allowOrigin).toBe("*");

      const allowMethods = response.headers.get("access-control-allow-methods");
      expect(allowMethods).toBeDefined();
      expect(allowMethods).toContain("GET");
      expect(allowMethods).toContain("POST");
    });

    it("CORS-02: GET response includes Access-Control-Allow-Origin", async () => {
      const response = await fetch(`${gatewayUrl}/api/agents`, {
        headers: {
          ...makeAuthHeaders(authToken),
          Origin: "http://localhost:3000",
        },
      });
      expect(response.status).toBe(200);

      const allowOrigin = response.headers.get("access-control-allow-origin");
      expect(allowOrigin).toBe("*");
    });
  });

  // ===========================================================================
  // Phase 2: REST API Data Endpoint Gaps
  // ===========================================================================

  describe("Phase 2: REST API Data Endpoints", () => {
    it("REST-DATA-01: GET /api/channels returns channels array", async () => {
      const response = await fetch(`${gatewayUrl}/api/channels`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("channels");
      expect(Array.isArray(body.channels)).toBe(true);
    });

    it("REST-DATA-02: GET /api/activity with limit=0 clamps to 1", async () => {
      const response = await fetch(`${gatewayUrl}/api/activity?limit=0`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as { entries: unknown[]; count: number };
      // limit=0 is clamped to Math.max(1, 0) = 1
      // count may be 0 if no events yet, but should not exceed 1
      expect(body.count).toBeLessThanOrEqual(1);
    });

    it("REST-DATA-03: GET /api/activity with limit=999 clamps to 100", async () => {
      const response = await fetch(`${gatewayUrl}/api/activity?limit=999`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as { entries: unknown[]; count: number };
      // limit=999 is clamped to Math.min(999, 100) = 100
      expect(body.count).toBeLessThanOrEqual(100);
    });

    it("REST-DATA-04: GET /api/activity with non-numeric limit defaults to 50", async () => {
      const response = await fetch(`${gatewayUrl}/api/activity?limit=abc`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as { entries: unknown[]; count: number };
      // parseInt("abc") = NaN, NaN || 50 = 50
      expect(body.count).toBeLessThanOrEqual(50);
    });

    it("REST-DATA-05: GET /api/activity returns entries with correct shape", async () => {
      const response = await fetch(`${gatewayUrl}/api/activity`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as { entries: unknown[]; count: number };
      expect(body).toHaveProperty("entries");
      expect(body).toHaveProperty("count");
      expect(Array.isArray(body.entries)).toBe(true);
      expect(typeof body.count).toBe("number");

      // If there are entries, verify shape
      if (body.entries.length > 0) {
        const entry = body.entries[0] as Record<string, unknown>;
        expect(entry).toHaveProperty("id");
        expect(entry).toHaveProperty("event");
        expect(entry).toHaveProperty("payload");
        expect(entry).toHaveProperty("timestamp");
      }
    });

    it("REST-DATA-06: GET /api/chat/history returns history", async () => {
      const response = await fetch(`${gatewayUrl}/api/chat/history`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toBeDefined();
    });

    it("REST-DATA-07: GET /api/chat/history with channelId param", async () => {
      const response = await fetch(
        `${gatewayUrl}/api/chat/history?channelId=web-dashboard`,
        { headers: makeAuthHeaders(authToken) },
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toBeDefined();
    });

    it("REST-DATA-08: GET /api/agents returns agents with required fields", async () => {
      const response = await fetch(`${gatewayUrl}/api/agents`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        agents: Array<Record<string, unknown>>;
      };
      expect(body.agents.length).toBeGreaterThanOrEqual(1);

      // Each agent should have id, name, provider, model, status
      for (const agent of body.agents) {
        expect(agent).toHaveProperty("id");
        expect(agent).toHaveProperty("name");
        expect(agent).toHaveProperty("provider");
        expect(agent).toHaveProperty("model");
        expect(agent).toHaveProperty("status");
        expect(typeof agent.id).toBe("string");
        expect(typeof agent.name).toBe("string");
      }
    });
  });

  // ===========================================================================
  // Phase 3: Chat Endpoint Validation
  // ===========================================================================

  describe("Phase 3: Chat Endpoint Validation", () => {
    it("CHAT-VAL-01: POST /api/chat with text/plain Content-Type returns 415", async () => {
      const response = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "text/plain",
        },
        body: JSON.stringify({ message: "Hello" }),
      });
      expect(response.status).toBe(415);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("error", "Content-Type must be application/json");
    });

    it("CHAT-VAL-02: POST /api/chat with invalid JSON body returns 400", async () => {
      const response = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: "not valid json{{{",
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("error", "Invalid JSON body");
    });

    it("CHAT-VAL-03: POST /api/chat with missing message field returns 400", async () => {
      const response = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: makeAuthHeaders(authToken),
        body: JSON.stringify({ text: "Hello" }),
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("error", "Missing required field: message (string)");
    });

    it("CHAT-VAL-04: POST /api/chat with empty message returns 400", async () => {
      const response = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: makeAuthHeaders(authToken),
        body: JSON.stringify({ message: "" }),
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("error", "Missing required field: message (string)");
    });

    it("CHAT-VAL-05: POST /api/chat with non-string message returns 400", async () => {
      const response = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: makeAuthHeaders(authToken),
        body: JSON.stringify({ message: 123 }),
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("error", "Missing required field: message (string)");
    });

    it("CHAT-VAL-06: POST /api/chat with missing Content-Type returns 415", async () => {
      const response = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ message: "Hello" }),
      });
      expect(response.status).toBe(415);
    });
  });

  // ===========================================================================
  // Phase 6: OpenAI-Compatible API Edge Cases
  // ===========================================================================

  describe("Phase 6: OpenAI-Compatible API Edge Cases", () => {
    it("OPENAI-EDGE-01: POST /v1/chat/completions with empty messages returns 400", async () => {
      const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: makeAuthHeaders(authToken),
        body: JSON.stringify({
          model: "comis",
          messages: [],
        }),
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error: { message: string } };
      expect(body.error).toBeDefined();
    });

    it("OPENAI-EDGE-02: POST /v1/chat/completions without model returns 400", async () => {
      const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: makeAuthHeaders(authToken),
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error: { message: string } };
      expect(body.error).toBeDefined();
    });

    it("OPENAI-EDGE-03: POST /v1/chat/completions without auth returns 401", async () => {
      const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "test" }],
        }),
      });
      expect(response.status).toBe(401);

      const body = (await response.json()) as { error: { type: string } };
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe("authentication_error");
    });

    it("OPENAI-EDGE-04: GET /v1/models without auth returns 401", async () => {
      const response = await fetch(`${gatewayUrl}/v1/models`);
      expect(response.status).toBe(401);
    });

    it("OPENAI-EDGE-05: GET /v1/models with valid auth returns model list", async () => {
      const response = await fetch(`${gatewayUrl}/v1/models`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        object: string;
        data: Array<{ id: string; object: string }>;
      };
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0].object).toBe("model");
    });

    it("OPENAI-EDGE-06: POST /v1/responses without auth returns 401", async () => {
      const response = await fetch(`${gatewayUrl}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test", input: "test" }),
      });
      expect(response.status).toBe(401);

      const body = (await response.json()) as { error: { type: string } };
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe("authentication_error");
    });

    it("OPENAI-EDGE-07: POST /v1/responses without model returns 400", async () => {
      const response = await fetch(`${gatewayUrl}/v1/responses`, {
        method: "POST",
        headers: makeAuthHeaders(authToken),
        body: JSON.stringify({ input: "test" }),
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error: { message: string } };
      expect(body.error).toBeDefined();
    });
  });

  // ===========================================================================
  // Phase 12: Error Handling & Edge Cases
  // ===========================================================================

  describe("Phase 12: Error Handling & Edge Cases", () => {
    it("ERR-01: GET /nonexistent returns 404", async () => {
      const response = await fetch(`${gatewayUrl}/nonexistent/route`);
      expect(response.status).toBe(404);
    });

    it("ERR-02: GET /api/nonexistent with auth returns 404", async () => {
      const response = await fetch(`${gatewayUrl}/api/nonexistent`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(response.status).toBe(404);
    });

    it("ERR-03: large request body (64KB) does not crash daemon", async () => {
      // Send a large but not absurdly large JSON body
      const largeMessage = "A".repeat(65536);
      const response = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: makeAuthHeaders(authToken),
        body: JSON.stringify({ message: largeMessage }),
      });

      // Should return a response (success or error) but NOT crash
      expect(response.status).toBeDefined();
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(600);

      // Verify daemon is still healthy after large body
      const healthResponse = await fetch(`${gatewayUrl}/health`);
      expect(healthResponse.status).toBe(200);
    });

    it("ERR-04: concurrent requests all succeed without misrouting", async () => {
      const N = 10;
      const requests = Array.from({ length: N }, () =>
        fetch(`${gatewayUrl}/api/agents`, {
          headers: makeAuthHeaders(authToken),
        }),
      );

      const responses = await Promise.all(requests);

      for (const res of responses) {
        expect(res.status).toBe(200);
        const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
        expect(body.agents).toBeDefined();
        expect(body.agents[0].name).toBe("TestAgent");
      }
    });

    it("ERR-05: health endpoint available after all tests", async () => {
      const response = await fetch(`${gatewayUrl}/health`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { status: string; timestamp: string };
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
      expect(new Date(body.timestamp).getTime()).not.toBeNaN();
    });
  });

  // ===========================================================================
  // Phase 5: WebSocket JSON-RPC (additional edge cases)
  // ===========================================================================

  describe("Phase 5: WebSocket Edge Cases", () => {
    it("WS-EDGE-01: unauthenticated WebSocket connection is rejected with 4001", async () => {
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
          // Error events may fire before or alongside close
        });
      });

      expect(result.code).toBe(4001);
      expect(result.reason).toContain("Unauthorized");
    });

    it("WS-EDGE-02: WebSocket with invalid token is rejected with 4001", async () => {
      const port = handle.daemon.container.config.gateway.port;
      const wsUrl = `ws://127.0.0.1:${port}/ws?token=INVALID_TOKEN_123`;

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
          // Expected
        });
      });

      expect(result.code).toBe(4001);
      expect(result.reason).toContain("Unauthorized");
    });
  });
});
