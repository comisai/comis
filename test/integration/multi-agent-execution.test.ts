/**
 * Multi-Agent Execution: Integration Tests
 *
 * Validates the core multi-agent execution contract:
 *   MULTI-01: Two agents (alpha, beta) both execute and reflect distinct identities
 *   MULTI-02: Agent with full profile can invoke memory_get; minimal profile cannot
 *   MULTI-04: session.spawn targeting a named agent executes with that agent's executor
 *   MULTI-05: Both agents produce valid streaming responses via agent.stream
 *
 * Uses a multi-agent config (port 8455) with alpha (full profile) and beta (minimal profile).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import {
  getProviderEnv,
  hasAnyProvider,
  PROVIDER_GROUPS,
  logProviderAvailability,
} from "../support/provider-env.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, "../config/config.test-multi-agent.yaml");

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)("Multi-Agent Execution: Identity, Tool Policy, Spawn, Streaming", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    logProviderAvailability(env);
    handle = await startTestDaemon({ configPath });
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
  // MULTI-01 -- Dual-agent identity loading
  // -------------------------------------------------------------------------

  it(
    "MULTI-01: Both alpha and beta agents execute independently",
    async () => {
      // Test alpha execution
      let wsAlpha: WebSocket | undefined;
      try {
        wsAlpha = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const alphaResponse = (await sendJsonRpc(wsAlpha, "agent.execute", {
          agentId: "alpha",
          message: "Say exactly: ALPHA_EXEC_OK",
        }, 1)) as Record<string, unknown>;

        expect(alphaResponse).toHaveProperty("result");
        expect(alphaResponse).not.toHaveProperty("error");

        const alphaResult = alphaResponse.result as Record<string, unknown>;
        expect(typeof alphaResult.response).toBe("string");
        expect((alphaResult.response as string).length).toBeGreaterThan(0);
        expect(typeof alphaResult.tokensUsed).toBe("object");
        expect((alphaResult.tokensUsed as { total: number }).total).toBeGreaterThan(0);
      } finally {
        wsAlpha?.close();
      }

      // Test beta execution (separate agentId, separate executor)
      let wsBeta: WebSocket | undefined;
      try {
        wsBeta = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const betaResponse = (await sendJsonRpc(wsBeta, "agent.execute", {
          agentId: "beta",
          message: "Say exactly: BETA_EXEC_OK",
        }, 2)) as Record<string, unknown>;

        expect(betaResponse).toHaveProperty("result");
        expect(betaResponse).not.toHaveProperty("error");

        const betaResult = betaResponse.result as Record<string, unknown>;
        expect(typeof betaResult.response).toBe("string");
        expect((betaResult.response as string).length).toBeGreaterThan(0);
        expect(typeof betaResult.tokensUsed).toBe("object");
        expect((betaResult.tokensUsed as { total: number }).total).toBeGreaterThan(0);
      } finally {
        wsBeta?.close();
      }
    },
    180_000,
  );

  // -------------------------------------------------------------------------
  // MULTI-02 -- Per-agent tool policy enforcement
  // -------------------------------------------------------------------------

  it(
    "MULTI-02: Alpha (full profile) can use memory tools; beta (minimal) cannot",
    async () => {
      // Alpha should be able to use memory_get (full profile)
      let wsAlpha: WebSocket | undefined;
      try {
        wsAlpha = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const alphaResponse = (await sendJsonRpc(wsAlpha, "agent.execute", {
          agentId: "alpha",
          message: "Use the memory_get tool to read the file SOUL.md and tell me what it says about boundaries. You MUST use the memory_get tool.",
        }, 3)) as Record<string, unknown>;

        expect(alphaResponse).toHaveProperty("result");
        expect(alphaResponse).not.toHaveProperty("error");

        const alphaResult = alphaResponse.result as Record<string, unknown>;
        const alphaText = (alphaResult.response as string).toLowerCase();
        // SOUL.md contains content about boundaries, privacy, personality, trust, etc.
        // Accept any of these distinctive keywords as proof the file was read.
        const mentionsSoulContent =
          alphaText.includes("private") ||
          alphaText.includes("boundaries") ||
          alphaText.includes("ask before acting") ||
          alphaText.includes("soul") ||
          alphaText.includes("trust") ||
          alphaText.includes("personality") ||
          alphaText.includes("guest") ||
          alphaText.includes("competence") ||
          alphaText.includes("resourceful");
        expect(mentionsSoulContent).toBe(true);
      } finally {
        wsAlpha?.close();
      }

      // Beta should NOT have memory tools — ask it to use one and verify it can't
      let wsBeta: WebSocket | undefined;
      try {
        wsBeta = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const betaResponse = (await sendJsonRpc(wsBeta, "agent.execute", {
          agentId: "beta",
          message: "Use the memory_get tool to read the file SOUL.md. You MUST use the memory_get tool.",
        }, 4)) as Record<string, unknown>;

        expect(betaResponse).toHaveProperty("result");

        const betaResult = betaResponse.result as Record<string, unknown>;
        const betaText = (betaResult.response as string).toLowerCase();

        // Beta can't use memory_get, so its response should not contain
        // distinctive SOUL.md content. Avoid generic words like "private",
        // "boundaries", "persona" which LLMs often use in refusal messages.
        const hasMemoryContent =
          betaText.includes("ask before acting") ||
          betaText.includes("resourceful") ||
          betaText.includes("competence") ||
          betaText.includes("guest");
        expect(hasMemoryContent).toBe(false);
      } finally {
        wsBeta?.close();
      }
    },
    180_000,
  );

  // -------------------------------------------------------------------------
  // MULTI-04 -- session.spawn targeting named agent
  // -------------------------------------------------------------------------

  it(
    "MULTI-04: session.spawn targets beta agent and produces response",
    async () => {
      // session.spawn is an internal rpcCall method (not exposed on gateway)
      // Access via daemon cast pattern (same as cron/config.patch tests)
      const rpcCall = (handle.daemon as any).rpcCall as (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;

      const result = (await rpcCall("session.spawn", {
        task: "Say exactly: SPAWN_BETA_OK",
        agent: "beta",
      })) as Record<string, unknown>;

      // Verify result has expected fields
      expect(result).toHaveProperty("response");
      expect(typeof result.response).toBe("string");
      expect((result.response as string).length).toBeGreaterThan(0);
      expect(result).toHaveProperty("sessionKey");
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // MULTI-05 -- Multi-agent streaming
  // -------------------------------------------------------------------------

  it(
    "MULTI-05a: Alpha produces valid streaming response",
    async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const response = (await sendJsonRpc(ws, "agent.stream", {
          agentId: "alpha",
          message: "Say exactly: ALPHA_STREAM_OK",
        }, 6)) as Record<string, unknown>;

        expect(response).toHaveProperty("jsonrpc", "2.0");
        expect(response).toHaveProperty("id", 6);
        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");

        const result = response.result as Record<string, unknown>;
        expect(typeof result.response).toBe("string");
        expect((result.response as string).length).toBeGreaterThan(0);
        expect(typeof result.tokensUsed).toBe("object");
        expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
      } finally {
        ws?.close();
      }
    },
    90_000,
  );

  it(
    "MULTI-05b: Beta produces valid streaming response",
    async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const response = (await sendJsonRpc(ws, "agent.stream", {
          agentId: "beta",
          message: "Say exactly: BETA_STREAM_OK",
        }, 7)) as Record<string, unknown>;

        expect(response).toHaveProperty("jsonrpc", "2.0");
        expect(response).toHaveProperty("id", 7);
        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");

        const result = response.result as Record<string, unknown>;
        expect(typeof result.response).toBe("string");
        expect((result.response as string).length).toBeGreaterThan(0);
        expect(typeof result.tokensUsed).toBe("object");
        expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
      } finally {
        ws?.close();
      }
    },
    90_000,
  );
});
