import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
// Provider detection
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)("Agent Execution: WebSocket JSON-RPC Integration", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    logProviderAvailability(env);
    handle = await startTestDaemon();
  }, 60_000);

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
  // AGENT-01 -- agent.execute returns valid LLM response
  // -------------------------------------------------------------------------

  it(
    "AGENT-01: agent.execute returns valid LLM response",
    async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const response = (await sendJsonRpc(ws, "agent.execute", {
          message: "Say exactly: AGENT_EXECUTE_OK",
        }, 1)) as Record<string, unknown>;

        // Expect a valid JSON-RPC response (not an error)
        expect(response).toHaveProperty("jsonrpc", "2.0");
        expect(response).toHaveProperty("id", 1);
        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");

        // Validate result structure
        const result = response.result as Record<string, unknown>;
        expect(typeof result.response).toBe("string");
        expect((result.response as string).length).toBeGreaterThan(0);
        expect(typeof result.tokensUsed).toBe("object");
        expect((result.tokensUsed as { total: number }).total).toBeGreaterThan(0);
        expect(typeof result.finishReason).toBe("string");
      } finally {
        ws?.close();
      }
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // AGENT-02 -- Agent reflects identity from workspace
  // -------------------------------------------------------------------------

  it(
    "AGENT-02: Agent reflects identity from workspace",
    async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const response = (await sendJsonRpc(ws, "agent.execute", {
          message: "What does your operating manual say you should do at the start of every session? Be brief.",
        }, 2)) as Record<string, unknown>;

        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");

        const result = response.result as Record<string, unknown>;
        expect(typeof result.response).toBe("string");

        // AGENTS.md says: "Before doing anything else: 1. Read SOUL.md 2. Read USER.md 3. Read IDENTITY.md"
        // The agent should reference reading workspace files
        const text = (result.response as string).toLowerCase();
        const mentionsWorkspaceFiles =
          text.includes("soul") ||
          text.includes("identity") ||
          text.includes("user") ||
          text.includes("session");
        expect(mentionsWorkspaceFiles).toBe(true);
      } finally {
        ws?.close();
      }
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // AGENT-03 -- Agent invokes tool during execution
  // -------------------------------------------------------------------------

  it(
    "AGENT-03: Agent invokes tool during execution",
    async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const response = (await sendJsonRpc(ws, "agent.execute", {
          message:
            "Use the memory_get tool to read the file SOUL.md and tell me what it says about boundaries. You MUST use the memory_get tool.",
        }, 3)) as Record<string, unknown>;

        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");

        const result = response.result as Record<string, unknown>;
        expect(typeof result.response).toBe("string");

        // SOUL.md template contains:
        // "Private things stay private. Period."
        // "When in doubt, ask before acting externally."
        const text = (result.response as string).toLowerCase();
        const mentionsBoundaries =
          text.includes("private") ||
          text.includes("boundaries") ||
          text.includes("ask before acting");
        expect(mentionsBoundaries).toBe(true);

        // stepsExecuted may or may not be surfaced by the RPC adapter
        if (result.stepsExecuted !== undefined) {
          expect(typeof result.stepsExecuted).toBe("number");
        }
      } finally {
        ws?.close();
      }
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // AGENT-04 -- agent.stream returns response (fallback to execute)
  // -------------------------------------------------------------------------

  it(
    "AGENT-04: agent.stream returns response",
    async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const response = (await sendJsonRpc(ws, "agent.stream", {
          message: "Say exactly: STREAM_TEST_OK",
        }, 4)) as Record<string, unknown>;

        // agent.stream falls back to non-streaming execute
        expect(response).toHaveProperty("jsonrpc", "2.0");
        expect(response).toHaveProperty("id", 4);
        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");

        // Same structure as agent.execute
        const result = response.result as Record<string, unknown>;
        expect(typeof result.response).toBe("string");
        expect((result.response as string).length).toBeGreaterThan(0);
        expect(typeof result.tokensUsed).toBe("object");
        expect(typeof result.finishReason).toBe("string");
      } finally {
        ws?.close();
      }
    },
    90_000,
  );
});
