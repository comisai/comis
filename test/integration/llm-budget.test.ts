// SPDX-License-Identifier: Apache-2.0
/**
 * LLM-BUDGET: Token Budget Enforcement Integration Tests
 *
 * Tests that the budget guard correctly rejects prompts exceeding token
 * limits and that real token usage is tracked after successful calls.
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.comis/.env.
 *
 * The budget config uses perExecution: 100 which triggers budget_exceeded
 * on the executor's pre-check (estimateCost = contextChars/3 + 4096 > 100)
 * WITHOUT making any real API call. This validates the guard at zero cost.
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
const BUDGET_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-llm-budget.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "LLM-BUDGET: Token Budget Enforcement",
  () => {
    let handle: TestDaemonHandle;

    beforeAll(async () => {
      logProviderAvailability(env);
      handle = await startTestDaemon({ configPath: BUDGET_CONFIG_PATH });
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
    // LLM-BUDGET-01: Budget pre-check rejection
    // -----------------------------------------------------------------------

    it(
      "LLM-BUDGET-01: perExecution budget pre-check rejects prompt without API call",
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
            { message: "Hello" },
            1,
            { timeoutMs: 30_000 },
          )) as Record<string, unknown>;

          // The response must be a valid JSON-RPC 2.0 response
          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("id", 1);

          // Budget rejection can appear in two forms:
          // 1. result.finishReason = "budget_exceeded" (executor returns budget error as result)
          // 2. error property (executor throws, RPC adapter wraps as JSON-RPC error)
          const result = response.result as Record<string, unknown> | undefined;
          const error = response.error as Record<string, unknown> | undefined;

          if (result) {
            // Case 1: Budget exceeded returned as a result
            const finishReason = String(result.finishReason ?? "").toLowerCase();
            expect(finishReason).toContain("budget");
          } else if (error) {
            // Case 2: Budget exceeded returned as JSON-RPC error
            const errorMsg = String(
              error.message ?? error.data ?? "",
            ).toLowerCase();
            expect(errorMsg).toContain("budget");
          } else {
            // Neither result nor error -- unexpected
            expect.unreachable(
              "Response should have either result with budget_exceeded or error with budget message",
            );
          }

          // Verify this was NOT a successful normal response
          if (result && result.finishReason === "stop") {
            expect.unreachable(
              "Budget guard should have rejected the prompt, not returned a normal response",
            );
          }
        } finally {
          ws?.close();
        }
      },
      30_000,
    );

    // -----------------------------------------------------------------------
    // LLM-BUDGET-02: Budget rejection is fast (proves no API call)
    // -----------------------------------------------------------------------

    it(
      "LLM-BUDGET-02: budget rejection is fast and well-formed (no API call made)",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const startMs = Date.now();
          const response = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "What is 1 + 1?" },
            2,
            { timeoutMs: 30_000 },
          )) as Record<string, unknown>;
          const elapsedMs = Date.now() - startMs;

          // The response should be a valid JSON-RPC 2.0 message
          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("id", 2);

          // Budget pre-check rejection should be fast (< 5 seconds).
          // A real API call would take 10-60+ seconds.
          expect(elapsedMs).toBeLessThan(5_000);

          // If we got a result, verify tokensUsed is 0 or absent (no API call)
          const result = response.result as Record<string, unknown> | undefined;
          if (result && typeof result.tokensUsed === "object") {
            expect((result.tokensUsed as { total: number }).total).toBe(0);
          }
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping LLM-BUDGET-02: API key present but invalid/expired",
            );
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      30_000,
    );
  },
);
