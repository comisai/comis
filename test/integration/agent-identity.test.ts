// SPDX-License-Identifier: Apache-2.0
/**
 * Agent Identity: REST API and RPC Config Tests
 *
 * Validates that the daemon correctly exposes agent identity data through:
 * - GET /api/agents REST endpoint (structure, auth, multi-agent listing, field values)
 * - config.get RPC method for the agents section
 * - Distinct agent name isolation across configured agents
 *
 * Uses config.test-identity.yaml (port 8505) with two agents:
 * - primary: "PrimaryIdentityAgent" (full tool profile)
 * - secondary: "SecondaryIdentityAgent" (minimal tool profile)
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
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-identity.yaml");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Agent Identity: REST API and RPC Config", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
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

  // -------------------------------------------------------------------------
  // REST API Agent Config (Non-LLM)
  // -------------------------------------------------------------------------

  describe("REST API Agent Config (Non-LLM)", () => {
    it(
      "ID-REST-01: GET /api/agents returns configured agents with correct structure",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/api/agents`, {
          method: "GET",
          headers: makeAuthHeaders(handle.authToken),
        });

        expect(response.status).toBe(200);

        const body = (await response.json()) as {
          agents: Array<Record<string, unknown>>;
        };
        expect(Array.isArray(body.agents)).toBe(true);
        expect(body.agents.length).toBeGreaterThan(0);

        // Verify first agent has expected structure
        const agent = body.agents[0];
        expect(typeof agent.id).toBe("string");
        expect(typeof agent.name).toBe("string");
        expect(typeof agent.provider).toBe("string");
        expect(typeof agent.model).toBe("string");
        expect(agent.status).toBe("active");
      },
      RPC_FAST_MS,
    );

    it(
      "ID-REST-02: GET /api/agents requires authentication (returns 401 without token)",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/api/agents`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });

        expect(response.status).toBe(401);
      },
      RPC_FAST_MS,
    );

    it(
      "ID-REST-03: GET /api/agents lists both primary and secondary agents",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/api/agents`, {
          method: "GET",
          headers: makeAuthHeaders(handle.authToken),
        });

        expect(response.status).toBe(200);

        const body = (await response.json()) as {
          agents: Array<{ id: string; name: string }>;
        };
        expect(body.agents.length).toBe(2);

        const agentIds = body.agents.map((a) => a.id);
        expect(agentIds).toContain("primary");
        expect(agentIds).toContain("secondary");
      },
      RPC_FAST_MS,
    );

    it(
      "ID-REST-04: Each agent has correct identity fields from config",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/api/agents`, {
          method: "GET",
          headers: makeAuthHeaders(handle.authToken),
        });

        expect(response.status).toBe(200);

        const body = (await response.json()) as {
          agents: Array<{
            id: string;
            name: string;
            provider: string;
            model: string;
            status: string;
          }>;
        };

        // Find primary agent
        const primary = body.agents.find((a) => a.id === "primary");
        expect(primary).toBeDefined();
        expect(primary!.name).toBe("PrimaryIdentityAgent");
        expect(primary!.provider).toBe("anthropic");
        expect(primary!.model).toMatch(/claude-opus/);
        expect(primary!.status).toBe("active");

        // Find secondary agent
        const secondary = body.agents.find((a) => a.id === "secondary");
        expect(secondary).toBeDefined();
        expect(secondary!.name).toBe("SecondaryIdentityAgent");
        expect(secondary!.provider).toBe("anthropic");
        expect(secondary!.status).toBe("active");
      },
      RPC_FAST_MS,
    );
  });

  // -------------------------------------------------------------------------
  // RPC Agent Config (Non-LLM)
  // -------------------------------------------------------------------------

  describe("RPC Agent Config (Non-LLM)", () => {
    it(
      "ID-RPC-01: config.get with section 'agents' returns full agent configs",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const response = (await sendJsonRpc(
            ws,
            "config.get",
            { section: "agents" },
            1,
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("result");

          const result = response.result as Record<string, unknown>;
          // config.get with section 'agents' returns { agents: { ... } }
          const agents = result.agents as Record<string, Record<string, unknown>>;
          expect(agents).toBeDefined();
          expect(agents).toHaveProperty("primary");
          expect(agents).toHaveProperty("secondary");
          expect(agents.primary.name).toBe("PrimaryIdentityAgent");
          expect(agents.secondary.name).toBe("SecondaryIdentityAgent");
        } finally {
          ws?.close();
        }
      },
      RPC_FAST_MS,
    );

    it(
      "ID-MULTI-03: REST API shows distinct agent names for identity isolation",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/api/agents`, {
          method: "GET",
          headers: makeAuthHeaders(handle.authToken),
        });

        expect(response.status).toBe(200);

        const body = (await response.json()) as {
          agents: Array<{ name: string }>;
        };
        const names = body.agents.map((a) => a.name);
        expect(names).toContain("PrimaryIdentityAgent");
        expect(names).toContain("SecondaryIdentityAgent");
        expect(names[0]).not.toBe(names[1]);
      },
      RPC_FAST_MS,
    );
  });

});
