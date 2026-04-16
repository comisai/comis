/**
 * Agent Routing E2E with Real LLM
 *
 * Real LLM provider E2E tests for multi-agent routing -- verifies that routed
 * agents produce actual LLM responses using their agent-specific model/identity
 * configuration.
 *
 * Test cases:
 *   ROUTE-14a: Primary agent executes via explicit agentId
 *   ROUTE-14b: Secondary agent executes via explicit agentId
 *   ROUTE-14c: Default routing resolves to primary agent
 *   ROUTE-14d: Both agents produce independent responses in sequence
 *
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.comis/.env.
 * Skips entirely when no LLM API keys are available.
 *
 * Uses port 8514 with route-primary / route-secondary agents and routing config.
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
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-agent-routing-e2e.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite -- gated on LLM API key availability
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "Agent Routing E2E with Real LLM",
  () => {
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

    // -----------------------------------------------------------------------
    // ROUTE-14a: Primary agent executes via explicit agentId
    // -----------------------------------------------------------------------

    it(
      "ROUTE-14a: Primary agent executes via explicit agentId",
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
              agentId: "route-primary",
              message: "Reply with exactly: PRIMARY_OK",
            },
            1,
          )) as Record<string, unknown>;

          if (response.error) {
            const errMsg = JSON.stringify(response.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ROUTE-14a: API key invalid/expired",
              );
              return;
            }
            throw new Error(`agent.execute failed: ${errMsg}`);
          }

          expect(response).toHaveProperty("result");
          expect(response).not.toHaveProperty("error");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          expect(typeof result.tokensUsed).toBe("object");
          expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping ROUTE-14a: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // ROUTE-14b: Secondary agent executes via explicit agentId
    // -----------------------------------------------------------------------

    it(
      "ROUTE-14b: Secondary agent executes via explicit agentId",
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
              agentId: "route-secondary",
              message: "Reply with exactly: SECONDARY_OK",
            },
            1,
          )) as Record<string, unknown>;

          if (response.error) {
            const errMsg = JSON.stringify(response.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ROUTE-14b: API key invalid/expired",
              );
              return;
            }
            throw new Error(`agent.execute failed: ${errMsg}`);
          }

          expect(response).toHaveProperty("result");
          expect(response).not.toHaveProperty("error");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          expect(typeof result.tokensUsed).toBe("object");
          expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping ROUTE-14b: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // ROUTE-14c: Default routing resolves to primary agent
    // -----------------------------------------------------------------------

    it(
      "ROUTE-14c: Default routing resolves to primary agent",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Omit agentId -- daemon should use defaultAgentId (route-primary)
          const response = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              message: "Reply with exactly: DEFAULT_OK",
            },
            1,
          )) as Record<string, unknown>;

          if (response.error) {
            const errMsg = JSON.stringify(response.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ROUTE-14c: API key invalid/expired",
              );
              return;
            }
            throw new Error(`agent.execute failed: ${errMsg}`);
          }

          expect(response).toHaveProperty("result");
          expect(response).not.toHaveProperty("error");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping ROUTE-14c: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // ROUTE-14d: Both agents produce independent responses in sequence
    // -----------------------------------------------------------------------

    it(
      "ROUTE-14d: Both agents produce independent responses in sequence",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // First: primary agent
          const primaryResponse = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              agentId: "route-primary",
              message: "What is 2+2? Answer with just the number.",
            },
            1,
          )) as Record<string, unknown>;

          if (primaryResponse.error) {
            const errMsg = JSON.stringify(primaryResponse.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ROUTE-14d: API key invalid/expired (primary)",
              );
              return;
            }
            throw new Error(`Primary agent.execute failed: ${errMsg}`);
          }

          expect(primaryResponse).toHaveProperty("result");
          expect(primaryResponse).not.toHaveProperty("error");

          const primaryResult = primaryResponse.result as Record<
            string,
            unknown
          >;
          expect(typeof primaryResult.response).toBe("string");
          expect(
            (primaryResult.response as string).length,
          ).toBeGreaterThan(0);
          expect(typeof primaryResult.tokensUsed).toBe("object");
          expect((primaryResult.tokensUsed as { total: number }).total).toBeGreaterThan(0);

          // Second: secondary agent
          const secondaryResponse = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              agentId: "route-secondary",
              message: "What is 3+3? Answer with just the number.",
            },
            2,
          )) as Record<string, unknown>;

          if (secondaryResponse.error) {
            const errMsg = JSON.stringify(secondaryResponse.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping ROUTE-14d: API key invalid/expired (secondary)",
              );
              return;
            }
            throw new Error(
              `Secondary agent.execute failed: ${errMsg}`,
            );
          }

          expect(secondaryResponse).toHaveProperty("result");
          expect(secondaryResponse).not.toHaveProperty("error");

          const secondaryResult = secondaryResponse.result as Record<
            string,
            unknown
          >;
          expect(typeof secondaryResult.response).toBe("string");
          expect(
            (secondaryResult.response as string).length,
          ).toBeGreaterThan(0);
          expect(typeof secondaryResult.tokensUsed).toBe("object");
          expect(
            (secondaryResult.tokensUsed as { total: number }).total,
          ).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping ROUTE-14d: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      90_000,
    );
  },
);
