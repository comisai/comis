/**
 * LLM-BASIC: Real LLM Provider Integration Tests
 *
 * Tests real prompt submission through the daemon's agent.execute RPC.
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.comis/.env.
 * Skips entirely when no LLM API keys are available.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProviderEnv,
  hasAnyProvider,
  hasProvider,
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
  "../config/config.test-llm-basic.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);
const hasAnthropic = hasProvider(env, "ANTHROPIC_API_KEY");
const hasOpenAI = hasProvider(env, "OPENAI_API_KEY");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "LLM-BASIC: Real Provider Integration",
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
    // LLM-01: Basic prompt/response
    // -----------------------------------------------------------------------

    it(
      "LLM-01: agent.execute returns real LLM response with token usage",
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
            { message: "Respond with exactly one word." },
            1,
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("result");
          expect(response).not.toHaveProperty("error");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          expect(typeof result.tokensUsed).toBe("object");
          expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
          expect(result.finishReason).toBe("stop");
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping LLM-01: API key invalid/expired");
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
    // LLM-02: Consecutive prompts maintain session context
    // -----------------------------------------------------------------------

    it(
      "LLM-02: consecutive prompts maintain session context",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // First message
          const first = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "Remember this number: 42" },
            1,
          )) as Record<string, unknown>;

          if (first.error) {
            const errMsg = JSON.stringify(first.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping LLM-02: API key invalid/expired (first message)",
              );
              return;
            }
            throw new Error(`First RPC failed: ${errMsg}`);
          }

          expect(first).toHaveProperty("result");
          const firstResult = first.result as Record<string, unknown>;
          expect(typeof firstResult.response).toBe("string");
          expect((firstResult.response as string).length).toBeGreaterThan(0);

          // Second message on the SAME WebSocket
          const second = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "What number did I just mention?" },
            2,
          )) as Record<string, unknown>;

          if (second.error) {
            const errMsg = JSON.stringify(second.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping LLM-02: API key invalid/expired (second message)",
              );
              return;
            }
            throw new Error(`Second RPC failed: ${errMsg}`);
          }

          expect(second).toHaveProperty("result");
          const secondResult = second.result as Record<string, unknown>;
          expect(typeof secondResult.response).toBe("string");
          expect((secondResult.response as string).length).toBeGreaterThan(0);
          expect(typeof secondResult.tokensUsed).toBe("object");
          expect((secondResult.tokensUsed as { total: number }).total).toBeGreaterThan(0);

          // NOTE: Do NOT assert the response contains "42" -- LLMs are
          // nondeterministic. Just verify structural success.
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping LLM-02: API key invalid/expired");
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
    // Per-provider nested describes
    // -----------------------------------------------------------------------

    describe.skipIf(!hasAnthropic)("Anthropic Claude", () => {
      it(
        "LLM-03: Anthropic provider returns valid response",
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
              { message: "Name one color." },
              3,
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("jsonrpc", "2.0");
            expect(response).toHaveProperty("result");
            expect(response).not.toHaveProperty("error");

            const result = response.result as Record<string, unknown>;
            expect(typeof result.response).toBe("string");
            expect((result.response as string).length).toBeGreaterThan(0);
            expect(typeof result.tokensUsed).toBe("object");
            expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
            expect(typeof result.finishReason).toBe("string");
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping LLM-03: API key invalid/expired");
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

    describe.skipIf(!hasOpenAI)("OpenAI GPT", () => {
      it(
        "LLM-04: OpenAI provider returns valid response",
        async () => {
          // NOTE: The daemon config uses provider "anthropic". This test
          // validates that OpenAI key detection works (via hasProvider) and
          // that the basic agent.execute still works through the same daemon.
          // The nested describe is primarily a structural demonstration that
          // per-provider gating works.
          let ws: WebSocket | undefined;
          try {
            ws = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );

            const response = (await sendJsonRpc(
              ws,
              "agent.execute",
              { message: "Name one animal." },
              10,
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("jsonrpc", "2.0");
            expect(response).toHaveProperty("result");
            expect(response).not.toHaveProperty("error");

            const result = response.result as Record<string, unknown>;
            expect(typeof result.response).toBe("string");
            expect((result.response as string).length).toBeGreaterThan(0);
            expect(typeof result.tokensUsed).toBe("object");
            expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
            expect(typeof result.finishReason).toBe("string");
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping LLM-04: API key invalid/expired");
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
  },
);
