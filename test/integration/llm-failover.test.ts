// SPDX-License-Identifier: Apache-2.0
/**
 * LLM-FAILOVER: Model Failover Integration Tests
 *
 * Tests that PiExecutor's internal model resolution fallback handles
 * invalid model IDs gracefully. When getModel() fails for the configured
 * model, the executor catches the error and falls back to
 * claude-sonnet-4-5-20250929.
 *
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.comis/.env.
 *
 * The failover config uses model: "nonexistent-model-xyz-12345" which causes
 * getModel() to throw. The catch block in pi-executor.ts model fallback
 * falls back to getModel("anthropic", "claude-sonnet-4-5-20250929"), making
 * the failover transparent to the caller.
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
  "../config/config.test-llm-failover.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "LLM-FAILOVER: Model Resolution Fallback",
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
          if (!msg.includes("Daemon exit with code")) throw err;
        }
      }
    }, 30_000);

    // -----------------------------------------------------------------------
    // LLM-FAILOVER-01: Invalid primary model falls back successfully
    // -----------------------------------------------------------------------

    it(
      "LLM-FAILOVER-01: invalid primary model falls back to claude-sonnet and returns valid response",
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
            { message: "Respond with one word." },
            1,
          )) as Record<string, unknown>;

          // Valid JSON-RPC 2.0 response with result, no error
          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("id", 1);
          expect(response).toHaveProperty("result");
          expect(response).not.toHaveProperty("error");

          const result = response.result as Record<string, unknown>;

          // The fallback model executed successfully
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          expect(typeof result.tokensUsed).toBe("object");
          expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
          expect(result.finishReason).toBe("stop");
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping LLM-FAILOVER-01: API key present but invalid/expired",
            );
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
    // LLM-FAILOVER-02: Failover response is structurally identical to normal
    // -----------------------------------------------------------------------

    it(
      "LLM-FAILOVER-02: failover response is structurally identical to normal response",
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
            { message: "What is 2 + 2?" },
            2,
          )) as Record<string, unknown>;

          // Valid JSON-RPC structure
          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("id", 2);

          const result = response.result as Record<string, unknown>;

          // Structural properties identical to a normal (non-failover) response:
          // The caller cannot tell that failover occurred (by design)
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          expect(typeof result.tokensUsed).toBe("object");
          expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
          expect(typeof result.finishReason).toBe("string");
          expect(result.finishReason).toBe("stop");
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping LLM-FAILOVER-02: API key present but invalid/expired",
            );
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
    // LLM-FAILOVER-03: Multiple consecutive requests all succeed via failover
    // -----------------------------------------------------------------------

    it(
      "LLM-FAILOVER-03: multiple consecutive requests with failover all succeed",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const messages = [
            { message: "Say hello.", id: 3 },
            { message: "Say goodbye.", id: 4 },
            { message: "Say yes.", id: 5 },
          ];

          for (const { message, id } of messages) {
            const response = (await sendJsonRpc(
              ws,
              "agent.execute",
              { message },
              id,
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("jsonrpc", "2.0");
            expect(response).toHaveProperty("id", id);

            // Check for auth errors in the response body (RPC-level)
            if (response.error) {
              const errorMsg = String(
                (response.error as Record<string, unknown>).message ?? "",
              );
              if (isAuthError(errorMsg)) {
                console.warn(
                  `Skipping LLM-FAILOVER-03 (id=${id}): API key invalid/expired`,
                );
                return;
              }
            }

            expect(response).toHaveProperty("result");
            expect(response).not.toHaveProperty("error");

            const result = response.result as Record<string, unknown>;
            expect(typeof result.response).toBe("string");
            expect((result.response as string).length).toBeGreaterThan(0);
            expect(typeof result.tokensUsed).toBe("object");
            expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
          }
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping LLM-FAILOVER-03: API key present but invalid/expired",
            );
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      120_000,
    );
  },
);
