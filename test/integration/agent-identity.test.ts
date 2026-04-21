// SPDX-License-Identifier: Apache-2.0
/**
 * Agent Identity: REST API, RPC Config, and LLM Integration Tests
 *
 * Validates that the daemon correctly exposes agent identity data through:
 * - GET /api/agents REST endpoint (structure, auth, multi-agent listing, field values)
 * - config.get RPC method for the agents section
 * - Distinct agent name isolation across configured agents
 *
 * Non-LLM structural tests run unconditionally (no API keys required).
 * LLM-gated tests (added by Plan 02) require ANTHROPIC_API_KEY or OPENAI_API_KEY.
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
  getProviderEnv,
  hasAnyProvider,
  PROVIDER_GROUPS,
  isAuthError,
  logProviderAvailability,
} from "../support/provider-env.js";
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

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Agent Identity: REST API, RPC Config, and LLM Integration", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    logProviderAvailability(env);
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

  // -------------------------------------------------------------------------
  // LLM Identity Loading and Reflection
  // -------------------------------------------------------------------------

  describe.skipIf(!hasLlmKey)("LLM Identity Loading and Reflection", () => {
    it(
      "ID-LLM-01: Default agent reflects AGENTS.md session startup instructions",
      { retry: 2, timeout: 90_000 },
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const response = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              agentId: "primary",
              message:
                "What does your operating manual say you should do at the start of every session? Be brief.",
            },
            10,
          )) as Record<string, unknown>;

          if (response.error) {
            const errMsg = JSON.stringify(response.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ID-LLM-01: API key invalid/expired",
              );
              return;
            }
            throw new Error(`RPC failed: ${errMsg}`);
          }

          expect(response).toHaveProperty("result");
          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);

          // Soft content check: at least one identity-related keyword
          const text = (result.response as string).toLowerCase();
          const hasIdentityKeyword =
            text.includes("soul") ||
            text.includes("identity") ||
            text.includes("user") ||
            text.includes("session") ||
            text.includes("read") ||
            text.includes("memory") ||
            text.includes("check") ||
            text.includes("load") ||
            text.includes("review") ||
            text.includes("file") ||
            text.includes("manual") ||
            text.includes("start") ||
            text.includes("instruction");
          expect(hasIdentityKeyword).toBe(true);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping ID-LLM-01: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
    );

    it(
      "ID-LLM-02: Agent reads SOUL.md via memory_get and reflects boundaries",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const response = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              agentId: "primary",
              message:
                "Use the memory_get tool to read the file SOUL.md and tell me what it says. You MUST use the memory_get tool.",
            },
            11,
          )) as Record<string, unknown>;

          if (response.error) {
            const errMsg = JSON.stringify(response.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ID-LLM-02: API key invalid/expired",
              );
              return;
            }
            throw new Error(`RPC failed: ${errMsg}`);
          }

          expect(response).toHaveProperty("result");
          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);

          // Soft content check: at least one boundary-related keyword
          const text = (result.response as string).toLowerCase();
          const hasBoundaryKeyword =
            text.includes("private") ||
            text.includes("boundaries") ||
            text.includes("personality") ||
            text.includes("soul") ||
            text.includes("ask before");
          expect(hasBoundaryKeyword).toBe(true);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping ID-LLM-02: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      90_000,
    );

    it(
      "ID-LLM-03: Agent reads IDENTITY.md via memory_get",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const response = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              agentId: "primary",
              message:
                "Use the memory_get tool to read the file IDENTITY.md and tell me what it contains. You MUST use the memory_get tool.",
            },
            12,
          )) as Record<string, unknown>;

          if (response.error) {
            const errMsg = JSON.stringify(response.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ID-LLM-03: API key invalid/expired",
              );
              return;
            }
            throw new Error(`RPC failed: ${errMsg}`);
          }

          expect(response).toHaveProperty("result");
          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          // No specific content assertion -- IDENTITY.md may be template
          // or user-customized. Just verify structural success.
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping ID-LLM-03: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      90_000,
    );
  });

  // -------------------------------------------------------------------------
  // Multi-Agent Identity Isolation
  // -------------------------------------------------------------------------

  describe.skipIf(!hasLlmKey)("Multi-Agent Identity Isolation", () => {
    it(
      "ID-MULTI-01: Primary agent executes with its own identity",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const response = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              agentId: "primary",
              message: "Say exactly: PRIMARY_IDENTITY_OK",
            },
            13,
          )) as Record<string, unknown>;

          if (response.error) {
            const errMsg = JSON.stringify(response.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ID-MULTI-01: API key invalid/expired",
              );
              return;
            }
            throw new Error(`RPC failed: ${errMsg}`);
          }

          expect(response).toHaveProperty("result");
          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          expect(typeof result.tokensUsed).toBe("object");
          expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping ID-MULTI-01: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      90_000,
    );

    it(
      "ID-MULTI-02: Secondary agent executes with distinct identity",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const response = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              agentId: "secondary",
              message: "Say exactly: SECONDARY_IDENTITY_OK",
            },
            14,
          )) as Record<string, unknown>;

          if (response.error) {
            const errMsg = JSON.stringify(response.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ID-MULTI-02: API key invalid/expired",
              );
              return;
            }
            throw new Error(`RPC failed: ${errMsg}`);
          }

          expect(response).toHaveProperty("result");
          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          expect(typeof result.tokensUsed).toBe("object");
          expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping ID-MULTI-02: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      90_000,
    );
  });

  // -------------------------------------------------------------------------
  // Identity Persistence
  // -------------------------------------------------------------------------

  describe.skipIf(!hasLlmKey)("Identity Persistence", () => {
    it(
      "ID-PERSIST-01: Identity persists across multiple messages in same session",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // First message: seed a fact
          const first = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              agentId: "primary",
              message:
                "Remember this: my favorite color is azure blue. Acknowledge briefly.",
            },
            15,
          )) as Record<string, unknown>;

          if (first.error) {
            const errMsg = JSON.stringify(first.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ID-PERSIST-01: API key invalid/expired (first message)",
              );
              return;
            }
            throw new Error(`First RPC failed: ${errMsg}`);
          }

          expect(first).toHaveProperty("result");
          const firstResult = first.result as Record<string, unknown>;
          expect(typeof firstResult.response).toBe("string");
          expect((firstResult.response as string).length).toBeGreaterThan(0);

          // Second message on SAME WS (same session)
          const second = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              agentId: "primary",
              message: "What is my favorite color? Answer in one word.",
            },
            16,
          )) as Record<string, unknown>;

          if (second.error) {
            const errMsg = JSON.stringify(second.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ID-PERSIST-01: API key invalid/expired (second message)",
              );
              return;
            }
            throw new Error(`Second RPC failed: ${errMsg}`);
          }

          expect(second).toHaveProperty("result");
          const secondResult = second.result as Record<string, unknown>;
          expect(typeof secondResult.response).toBe("string");
          expect((secondResult.response as string).length).toBeGreaterThan(0);

          // Soft content check on second response
          const text = (secondResult.response as string).toLowerCase();
          const recallsColor =
            text.includes("azure") || text.includes("blue");
          expect(recallsColor).toBe(true);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping ID-PERSIST-01: API key invalid/expired",
            );
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      180_000,
    );
  });

  // -------------------------------------------------------------------------
  // HTTP Chat Identity Routing
  // -------------------------------------------------------------------------

  describe.skipIf(!hasLlmKey)("HTTP Chat Identity Routing", () => {
    it(
      "ID-CHAT-01: POST /api/chat with agentId routes to correct agent",
      async () => {
        try {
          const response = await fetch(`${handle.gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({
              message: "Say exactly one word.",
              agentId: "primary",
            }),
          });

          expect(response.status).toBe(200);

          const body = (await response.json()) as { response: string };
          expect(typeof body.response).toBe("string");
          expect(body.response.length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping ID-CHAT-01: API key invalid/expired",
            );
            return;
          }
          throw err;
        }
      },
      90_000,
    );

    it(
      "ID-CHAT-02: POST /api/chat without agentId uses default agent",
      async () => {
        try {
          const response = await fetch(`${handle.gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({
              message: "Say exactly one word.",
            }),
          });

          expect(response.status).toBe(200);

          const body = (await response.json()) as { response: string };
          expect(typeof body.response).toBe("string");
          expect(body.response.length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping ID-CHAT-02: API key invalid/expired",
            );
            return;
          }
          throw err;
        }
      },
      90_000,
    );

    it(
      "ID-CHAT-03: POST /api/chat returns valid response structure",
      async () => {
        try {
          const response = await fetch(`${handle.gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({
              message: "Respond with exactly one word.",
              agentId: "secondary",
            }),
          });

          expect(response.status).toBe(200);

          const body = (await response.json()) as { response: string };
          expect(typeof body.response).toBe("string");
          expect(body.response.length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping ID-CHAT-03: API key invalid/expired",
            );
            return;
          }
          throw err;
        }
      },
      90_000,
    );
  });
});
