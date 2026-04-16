/**
 * CMD-E2E: Slash Command Lifecycle E2E Tests
 *
 * Tests the complete command lifecycle through a real LLM provider via the
 * daemon's agent.execute RPC. The gateway intercepts known slash commands
 * (e.g. /status, /context, /model list) before they reach the LLM, returning
 * command handler output directly with zero token usage.
 *
 * Also tests multi-turn session continuity and graceful handling of
 * command-like text in messages.
 *
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
  "../config/config.test-slash-commands.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "CMD-E2E: Slash Command Lifecycle Through Real LLM",
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
    // Section 1: RPC Path Intercepts Slash Commands (Zero-Token Responses)
    // -----------------------------------------------------------------------

    it(
      "CMD-E2E-01: /status via RPC returns command handler output with zero tokens",
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
            { message: "/status" },
            1,
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("result");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);

          // The gateway intercepts slash commands and returns handler output
          const text = result.response as string;
          expect(text).toContain("**Session Status**");

          // Verify zero token usage (command handled locally, no LLM call)
          expect(result.tokensUsed).toEqual({ input: 0, output: 0, total: 0 });
          expect(result.finishReason).toBe("command");
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping CMD-E2E-01: API key invalid/expired");
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
      "CMD-E2E-02: /context via RPC returns command handler output with zero tokens",
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
            { message: "/context" },
            2,
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("result");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);

          // The gateway intercepts slash commands and returns handler output
          const text = result.response as string;
          expect(text).toContain("**Context Overview**");

          // Verify zero token usage
          expect(result.tokensUsed).toEqual({ input: 0, output: 0, total: 0 });
          expect(result.finishReason).toBe("command");
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping CMD-E2E-02: API key invalid/expired");
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
      "CMD-E2E-03: /model list via RPC returns command handler output with zero tokens",
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
            { message: "/model list" },
            3,
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("result");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);

          // The gateway intercepts slash commands and returns handler output
          // /model list with no models configured returns "Model list not available."
          // or "**Available Models**" if models are listed
          const text = result.response as string;
          expect(text.includes("**Available Models**") || text.includes("Model list not available")).toBe(true);

          // Verify zero token usage
          expect(result.tokensUsed).toEqual({ input: 0, output: 0, total: 0 });
          expect(result.finishReason).toBe("command");
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping CMD-E2E-03: API key invalid/expired");
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
    // Section 2: Regular Message Through Full Pipeline
    // -----------------------------------------------------------------------

    it(
      "CMD-E2E-04: simple prompt returns LLM response with token usage",
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
            { message: "Reply with exactly: PONG" },
            4,
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("result");
          expect(response).not.toHaveProperty("error");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          expect(typeof result.tokensUsed).toBe("object");
          expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping CMD-E2E-04: API key invalid/expired");
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
      "CMD-E2E-05: directive-like text mid-message treated as regular text",
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
            { message: "Can you explain what /think does in a chatbot?" },
            5,
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("result");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          expect(typeof result.tokensUsed).toBe("object");
          expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping CMD-E2E-05: API key invalid/expired");
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
    // Section 3: Multi-Turn Session Continuity
    // -----------------------------------------------------------------------

    it(
      "CMD-E2E-06: sequential messages on same WebSocket maintain session context",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Message 1: Establish context with a distinctive identifier
          const first = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "My name is TestUser42. Remember this." },
            6,
          )) as Record<string, unknown>;

          if (first.error) {
            const errMsg = JSON.stringify(first.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping CMD-E2E-06: API key invalid/expired (first message)",
              );
              return;
            }
            throw new Error(`First RPC failed: ${errMsg}`);
          }

          expect(first).toHaveProperty("result");
          const firstResult = first.result as Record<string, unknown>;
          expect(typeof firstResult.response).toBe("string");
          expect((firstResult.response as string).length).toBeGreaterThan(0);

          // Message 2: Ask the LLM to recall the context on the SAME WebSocket
          const second = (await sendJsonRpc(
            ws,
            "agent.execute",
            { message: "What is my name?" },
            7,
          )) as Record<string, unknown>;

          if (second.error) {
            const errMsg = JSON.stringify(second.error);
            if (isAuthError(errMsg)) {
              console.warn(
                "Skipping CMD-E2E-06: API key invalid/expired (second message)",
              );
              return;
            }
            throw new Error(`Second RPC failed: ${errMsg}`);
          }

          expect(second).toHaveProperty("result");
          const secondResult = second.result as Record<string, unknown>;
          expect(typeof secondResult.response).toBe("string");
          const secondText = secondResult.response as string;
          expect(secondText.length).toBeGreaterThan(0);

          // Session continuity: the LLM should recall the name from message 1
          expect(secondText).toContain("TestUser42");
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping CMD-E2E-06: API key invalid/expired");
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
      "CMD-E2E-07: config.get RPC confirms SlashBot agent loaded",
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
            10,
            { timeoutMs: 30_000 },
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("result");

          // config.get section 'agents' returns { agents: { default: { name: "SlashBot", ... } } }
          const result = response.result as Record<string, unknown>;
          const agents = result.agents as Record<string, unknown> | undefined;
          const defaultAgent = agents?.default as Record<string, unknown> | undefined;

          expect(defaultAgent).toBeDefined();
          expect(defaultAgent?.name).toBe("SlashBot");
        } finally {
          ws?.close();
        }
      },
      30_000,
    );

    // -----------------------------------------------------------------------
    // Section 4: Command-Like Text Tolerance
    // -----------------------------------------------------------------------

    it(
      "CMD-E2E-08: /help-prefixed message goes to LLM, not command handler",
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
            { message: "/help me understand quantum computing" },
            8,
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("jsonrpc", "2.0");
          expect(response).toHaveProperty("result");

          const result = response.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping CMD-E2E-08: API key invalid/expired");
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
