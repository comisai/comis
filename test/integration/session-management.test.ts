/**
 * SESS: Session Management Integration Tests
 *
 * Validates session operations through observable gateway endpoints:
 *   SESS-01: Agent config (model, name, maxSteps) via RPC config.get; tokensUsed via agent.execute
 *   SESS-02: Sessions persist after agent execution, confirmed via /api/chat/history
 *   SESS-03: Session history returns messages with role, content, and timestamp
 *   SESS-04: Follow-up messages accumulate in session history
 *   SESS-05: Custom sessionKey in agent.execute produces isolated session
 *
 * Uses a dedicated config (port 8450, separate memory DB) to avoid conflicts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  makeAuthHeaders,
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

const SESSIONS_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-sessions.yaml",
);

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)("Session Management: Gateway RPC & REST Integration", () => {
  let handle: TestDaemonHandle;
  let gatewayUrl: string;
  let authToken: string;

  beforeAll(async () => {
    logProviderAvailability(env);
    handle = await startTestDaemon({ configPath: SESSIONS_CONFIG_PATH });
    gatewayUrl = handle.gatewayUrl;
    authToken = handle.authToken;
  }, 120_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // SESS-01 -- Agent config returns model, name, maxSteps; agent execution
  //            returns tokensUsed
  // -------------------------------------------------------------------------

  it(
    "SESS-01: agent config returns model, name, and maxSteps; agent execution returns tokensUsed",
    async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(gatewayUrl, authToken);

        // 1. Verify agent config via RPC config.get
        const configResponse = (await sendJsonRpc(
          ws,
          "config.get",
          { section: "agents" },
          1,
        )) as Record<string, unknown>;

        expect(configResponse).toHaveProperty("result");
        expect(configResponse).not.toHaveProperty("error");

        const configResult = configResponse.result as Record<string, unknown>;
        expect(configResult).toHaveProperty("agents");

        const agents = configResult.agents as Record<
          string,
          Record<string, unknown>
        >;
        expect(agents).toHaveProperty("default");

        const defaultAgent = agents.default;
        expect(typeof defaultAgent.model).toBe("string");
        expect(defaultAgent.model).toBe("claude-opus-4-6");
        expect(typeof defaultAgent.name).toBe("string");
        expect(defaultAgent.name).toBe("TestAgent");
        expect(typeof defaultAgent.maxSteps).toBe("number");
        expect(defaultAgent.maxSteps).toBe(10);

        // 2. Verify cost tracking via agent.execute
        const execResponse = (await sendJsonRpc(
          ws,
          "agent.execute",
          { message: "Say hi" },
          2,
        )) as Record<string, unknown>;

        expect(execResponse).toHaveProperty("result");
        expect(execResponse).not.toHaveProperty("error");

        const execResult = execResponse.result as Record<string, unknown>;
        expect(typeof execResult.tokensUsed).toBe("object");
        expect((execResult.tokensUsed as { total: number }).total).toBeGreaterThan(0);
        expect(typeof execResult.finishReason).toBe("string");
      } finally {
        ws?.close();
      }
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // SESS-03 -- Session history returns messages with role, content, and
  //            timestamp after agent execution
  // -------------------------------------------------------------------------

  it(
    "SESS-03: session history returns messages with role, content, and timestamp after agent execution",
    async () => {
      // Execute an agent turn via REST POST /api/chat
      const chatResponse = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: makeAuthHeaders(authToken),
        body: JSON.stringify({
          message: "Say exactly: session-history-test-marker",
        }),
      });
      expect(chatResponse.ok).toBe(true);

      // Retrieve session history via REST GET /api/chat/history
      const historyResponse = await fetch(
        `${gatewayUrl}/api/chat/history?channelId=gateway`,
        { headers: makeAuthHeaders(authToken) },
      );
      expect(historyResponse.ok).toBe(true);

      const historyData = (await historyResponse.json()) as {
        messages: Array<{ role: string; content: string; timestamp: number }>;
      };

      expect(historyData).toHaveProperty("messages");
      expect(Array.isArray(historyData.messages)).toBe(true);
      expect(historyData.messages.length).toBeGreaterThan(0);

      // Verify message structure: role, content, timestamp
      const msg = historyData.messages[0];
      expect(typeof msg.role).toBe("string");
      expect(["user", "assistant"]).toContain(msg.role);
      expect(typeof msg.content).toBe("string");
      expect(msg.content.length).toBeGreaterThan(0);
      expect(typeof msg.timestamp).toBe("number");
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // SESS-02 -- Sessions persist after agent execution, confirmed via
  //            history endpoint
  // -------------------------------------------------------------------------

  it(
    "SESS-02: sessions persist after agent execution, confirmed via history endpoint",
    async () => {
      // After SESS-01 and SESS-03 have created sessions, verify persistence
      const historyResponse = await fetch(
        `${gatewayUrl}/api/chat/history?channelId=gateway`,
        { headers: makeAuthHeaders(authToken) },
      );
      expect(historyResponse.ok).toBe(true);

      const historyData = (await historyResponse.json()) as {
        messages: Array<{ role: string; content: string; timestamp: number }>;
      };

      expect(historyData).toHaveProperty("messages");
      expect(Array.isArray(historyData.messages)).toBe(true);
      expect(historyData.messages.length).toBeGreaterThan(0);
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // SESS-04 -- Follow-up message to existing session produces accumulated
  //            history
  // -------------------------------------------------------------------------

  it(
    "SESS-04: follow-up message to existing session produces accumulated history",
    async () => {
      // Get current message count
      const beforeResponse = await fetch(
        `${gatewayUrl}/api/chat/history?channelId=gateway`,
        { headers: makeAuthHeaders(authToken) },
      );
      expect(beforeResponse.ok).toBe(true);
      const beforeData = (await beforeResponse.json()) as {
        messages: Array<{ role: string; content: string; timestamp: number }>;
      };
      const countBefore = beforeData.messages.length;

      // Send first follow-up message
      const chat1Response = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: makeAuthHeaders(authToken),
        body: JSON.stringify({
          message: "First message for accumulation test",
        }),
      });
      expect(chat1Response.ok).toBe(true);

      // Send second follow-up message
      const chat2Response = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: makeAuthHeaders(authToken),
        body: JSON.stringify({
          message: "Second message for accumulation test",
        }),
      });
      expect(chat2Response.ok).toBe(true);

      // Check history grew
      const afterResponse = await fetch(
        `${gatewayUrl}/api/chat/history?channelId=gateway`,
        { headers: makeAuthHeaders(authToken) },
      );
      expect(afterResponse.ok).toBe(true);
      const afterData = (await afterResponse.json()) as {
        messages: Array<{ role: string; content: string; timestamp: number }>;
      };

      // Should have more messages than before (at least 2 user + 2 assistant = 4 new)
      expect(afterData.messages.length).toBeGreaterThan(countBefore);
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // SESS-05 -- Agent execution with different session key produces isolated
  //            session
  // -------------------------------------------------------------------------

  it(
    "SESS-05: agent execution with different session key produces isolated session",
    async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(gatewayUrl, authToken);

        // Execute agent with a custom sessionKey via WebSocket RPC.
        // Use different channelId for isolation but keep userId as "rpc-client"
        // because getSessionHistory hardcodes userId to "rpc-client".
        const execResponse = (await sendJsonRpc(
          ws,
          "agent.execute",
          {
            message: "Isolated session test",
            sessionKey: {
              userId: "rpc-client",
              channelId: "isolated-channel",
              peerId: "test",
            },
          },
          10,
        )) as Record<string, unknown>;

        expect(execResponse).toHaveProperty("result");
        expect(execResponse).not.toHaveProperty("error");

        const execResult = execResponse.result as Record<string, unknown>;
        expect(typeof execResult.response).toBe("string");
        expect(typeof execResult.tokensUsed).toBe("object");
        expect((execResult.tokensUsed as { total: number }).total).toBeGreaterThan(0);
      } finally {
        ws?.close();
      }

      // Check isolated channel history via REST
      const isolatedResponse = await fetch(
        `${gatewayUrl}/api/chat/history?channelId=isolated-channel`,
        { headers: makeAuthHeaders(authToken) },
      );
      expect(isolatedResponse.ok).toBe(true);
      const isolatedData = (await isolatedResponse.json()) as {
        messages: Array<{ role: string; content: string; timestamp: number }>;
      };

      expect(isolatedData.messages.length).toBeGreaterThan(0);

      // Check gateway channel history (should be separate)
      const gatewayResponse = await fetch(
        `${gatewayUrl}/api/chat/history?channelId=gateway`,
        { headers: makeAuthHeaders(authToken) },
      );
      expect(gatewayResponse.ok).toBe(true);
      const gatewayData = (await gatewayResponse.json()) as {
        messages: Array<{ role: string; content: string; timestamp: number }>;
      };

      // Gateway channel should have more messages (from SESS-01 through SESS-04)
      // while isolated channel was just created with a single exchange
      expect(gatewayData.messages.length).toBeGreaterThan(
        isolatedData.messages.length,
      );
    },
    90_000,
  );
});
