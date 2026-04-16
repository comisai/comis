/**
 * v13.0 Session Greeting and Agent Execution (LLM-Gated)
 *
 * Validates that v13.0 session greeting generation (SESS-01) works end-to-end
 * through the daemon, and that agent execution succeeds with all v13.0 prompt
 * enrichments (CTXT-01, CTXT-02, AGNT-05, COMM-04).
 *
 * Tests are gated by provider-env.ts and skip gracefully without API keys.
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.comis/.env.
 *
 * Uses port 8551 with config.test-v13-greeting.yaml.
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
import { RPC_LLM_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-v13-greeting.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("v13.0 Session Greeting and Agent Execution (LLM-Gated)", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    logProviderAvailability(env);
    if (!hasLlmKey) return; // Skip daemon startup when no LLM keys
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
  // SESS-01 and Agent Execution (LLM-gated)
  // -------------------------------------------------------------------------

  describe.skipIf(!hasLlmKey)("SESS-01 and Agent Execution", () => {
    it(
      "SESS-01: /new command produces LLM-generated greeting via REST",
      async () => {
        try {
          const response = await fetch(`${handle.gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({ message: "/new" }),
          });

          expect(response.ok).toBe(true);

          const body = (await response.json()) as Record<string, unknown>;
          expect(typeof body.response).toBe("string");
          expect((body.response as string).length).toBeGreaterThan(5);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping SESS-01 /new: API key invalid/expired",
            );
            return;
          }
          throw err;
        }
      },
      90_000,
    );

    it(
      "SESS-01: /reset command also produces greeting",
      async () => {
        try {
          const response = await fetch(`${handle.gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({ message: "/reset" }),
          });

          expect(response.ok).toBe(true);

          const body = (await response.json()) as Record<string, unknown>;
          expect(typeof body.response).toBe("string");
          expect((body.response as string).length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping SESS-01 /reset: API key invalid/expired",
            );
            return;
          }
          throw err;
        }
      },
      90_000,
    );

    it(
      "agent.execute succeeds with v13.0 enriched system prompt",
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
            { message: "Say exactly: V13_PROMPT_OK" },
            1,
            { timeoutMs: RPC_LLM_MS },
          )) as Record<string, unknown>;

          if (response.error) {
            const errMsg = JSON.stringify(response.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping agent.execute v13.0: API key invalid/expired",
              );
              return;
            }
            throw new Error(`RPC failed: ${errMsg}`);
          }

          expect(response).toHaveProperty("result");
          expect(response).not.toHaveProperty("error");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          expect(typeof result.tokensUsed).toBe("object");
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping agent.execute v13.0: API key invalid/expired",
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
  });
});
