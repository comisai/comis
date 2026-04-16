/**
 * Agent Communication E2E Tests
 *
 * Section 1: Agent-to-Agent Messaging (requires LLM API keys, skips without)
 *   COMMS-01: session.send fire-and-forget injects message and returns sent:true
 *   COMMS-02: session.send wait mode returns target agent response
 *   COMMS-03: session.spawn creates sub-agent run and returns completed result
 *
 * Section 2: ACP Protocol Handshake (no LLM keys needed)
 *   ACP-01: Full initialize -> newSession -> prompt -> multi-turn lifecycle via ndJson
 *
 * Uses port 8489 with alpha/beta agents and agentToAgent enabled.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProviderEnv,
  hasAnyProvider,
  PROVIDER_GROUPS,
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
import { RPC_LLM_MS } from "../support/timeouts.js";
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type Agent,
} from "@agentclientprotocol/sdk";
import {
  createAcpAgent,
  type AcpServerDeps,
} from "@comis/gateway";

// ---------------------------------------------------------------------------
// Path resolution and provider detection
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-agent-comms.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Section 1: Agent-to-Agent Messaging (LLM-dependent)
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "Agent-to-Agent Messaging E2E",
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
    // COMMS-01: session.send fire-and-forget
    // -----------------------------------------------------------------------

    it(
      "COMMS-01: session.send fire-and-forget injects message and returns sent:true",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Prime the alpha agent session so a session exists
          const primeResult = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              agentId: "alpha",
              message: "Remember: you are Alpha. Respond with OK.",
            },
            1,
            { timeoutMs: RPC_LLM_MS },
          )) as Record<string, unknown>;
          expect(primeResult).toHaveProperty("result");

          // Send fire-and-forget to the alpha session
          // Daemon RPC sessions use key: test:rpc-client:gateway (default userId:channelId when no sessionKey param)
          const sendResult = (await sendJsonRpc(
            ws,
            "session.send",
            {
              session_key: "test:rpc-client:gateway",
              text: "Hello from cross-session",
              mode: "fire-and-forget",
            },
            2,
            { timeoutMs: RPC_LLM_MS },
          )) as Record<string, unknown>;

          // Fire-and-forget returns { sent: true } immediately
          const result = sendResult.result as Record<string, unknown>;
          expect(result.sent).toBe(true);
          // No response field in fire-and-forget mode
          expect(result.response).toBeUndefined();
        } finally {
          ws?.close();
        }
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // COMMS-02: session.send wait mode
    // -----------------------------------------------------------------------

    it(
      "COMMS-02: session.send wait mode returns target agent response",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Prime the alpha agent session
          const primeResult = (await sendJsonRpc(
            ws,
            "agent.execute",
            {
              agentId: "alpha",
              message: "Remember: you are Alpha. Respond with OK.",
            },
            1,
            { timeoutMs: RPC_LLM_MS },
          )) as Record<string, unknown>;
          expect(primeResult).toHaveProperty("result");

          // Send in wait mode -- executes target agent and returns response
          // Daemon RPC sessions use key: test:rpc-client:gateway (default userId:channelId when no sessionKey param)
          // agent_id is required for wait mode so cross-session-sender knows which executor to use
          const sendResult = (await sendJsonRpc(
            ws,
            "session.send",
            {
              session_key: "test:rpc-client:gateway",
              text: "What is your name?",
              mode: "wait",
              agent_id: "alpha",
            },
            2,
            { timeoutMs: RPC_LLM_MS },
          )) as Record<string, unknown>;

          const result = sendResult.result as Record<string, unknown>;
          expect(result.sent).toBe(true);
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);

          // Wait mode includes stats
          const stats = result.stats as Record<string, unknown>;
          expect(stats).toBeDefined();
          expect(stats.runtimeMs).toBeGreaterThan(0);
        } finally {
          ws?.close();
        }
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // COMMS-03: session.spawn
    // -----------------------------------------------------------------------

    it(
      "COMMS-03: session.spawn creates sub-agent run and returns completed result",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Spawn beta agent -- synchronous mode (no async param)
          // Daemon polls internally until completion (up to waitTimeoutMs)
          const spawnResult = (await sendJsonRpc(
            ws,
            "session.spawn",
            {
              task: "Say exactly one word.",
              agent: "beta",
            },
            1,
            { timeoutMs: RPC_LLM_MS },
          )) as Record<string, unknown>;

          const result = spawnResult.result as Record<string, unknown>;

          // Synchronous spawn returns completed result with response
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
          expect(typeof result.sessionKey).toBe("string");
          expect(result.taskDescription).toBe("Say exactly one word.");
        } finally {
          ws?.close();
        }
      },
      90_000,
    );
  },
);

// ---------------------------------------------------------------------------
// Paired byte stream helper for ACP protocol tests
// ---------------------------------------------------------------------------

/**
 * Create two paired byte stream sides for in-process ACP communication.
 *
 * Side A's writable feeds into Side B's readable, and vice versa.
 * This simulates a bidirectional pipe (like stdin/stdout between processes).
 */
function createPairedByteStreams(): [
  {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  },
  {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  },
] {
  // Channel A -> B
  let controllerAB: ReadableStreamDefaultController<Uint8Array>;
  const readableAB = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controllerAB = ctrl;
    },
  });
  const writableAB = new WritableStream<Uint8Array>({
    write(chunk) {
      controllerAB.enqueue(chunk);
    },
    close() {
      controllerAB.close();
    },
  });

  // Channel B -> A
  let controllerBA: ReadableStreamDefaultController<Uint8Array>;
  const readableBA = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controllerBA = ctrl;
    },
  });
  const writableBA = new WritableStream<Uint8Array>({
    write(chunk) {
      controllerBA.enqueue(chunk);
    },
    close() {
      controllerBA.close();
    },
  });

  return [
    { readable: readableAB, writable: writableBA }, // Side A: reads from AB, writes to BA
    { readable: readableBA, writable: writableAB }, // Side B: reads from BA, writes to AB
  ];
}

// ---------------------------------------------------------------------------
// Mock ACP deps factory
// ---------------------------------------------------------------------------

function createTestAcpDeps(
  overrides?: Partial<AcpServerDeps>,
): AcpServerDeps {
  return {
    executeAgent: vi
      .fn<AcpServerDeps["executeAgent"]>()
      .mockResolvedValue({
        response: "Hello from test agent",
        tokensUsed: { input: 10, output: 20, total: 30 },
        finishReason: "stop",
      }),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    version: "1.0.0-test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Section 2: ACP Protocol Handshake (no LLM keys needed)
// ---------------------------------------------------------------------------

describe("ACP Protocol Handshake E2E", () => {
  // -------------------------------------------------------------------------
  // ACP-01: Full lifecycle through ndJson transport
  // -------------------------------------------------------------------------

  it(
    "ACP-01: Full initialize -> newSession -> prompt -> multi-turn lifecycle through ndJson transport",
    async () => {
      const [sideA, sideB] = createPairedByteStreams();
      const deps = createTestAcpDeps();

      // Agent side: reads from sideB, writes to sideB
      const agentStream = ndJsonStream(sideB.writable, sideB.readable);
      new AgentSideConnection(
        (_conn) => createAcpAgent(deps).agent,
        agentStream,
      );

      // Client side: reads from sideA, writes to sideA
      const clientStream = ndJsonStream(sideA.writable, sideA.readable);

      const mockClient: Client = {
        requestPermission: async () =>
          ({ outcome: { outcome: "cancelled" } }) as any,
        sessionUpdate: async () => {},
      };

      const clientConn = new ClientSideConnection(
        (_agent) => mockClient,
        clientStream,
      );

      try {
        // 1. Initialize
        const initResult = await clientConn.initialize({
          protocolVersion: 1,
          clientCapabilities: {},
        });
        expect(initResult.protocolVersion).toBe(1);
        expect(initResult.agentInfo?.name).toBe("comis");
        expect(initResult.agentInfo?.title).toBe("Comis");
        expect(initResult.agentInfo?.version).toBe("1.0.0-test");

        // 2. New session
        const sessionResult = await clientConn.newSession({
          cwd: "/tmp/test-project",
          mcpServers: [],
        });
        expect(sessionResult.sessionId).toBeTruthy();
        expect(typeof sessionResult.sessionId).toBe("string");

        // 3. First prompt
        const promptResult = await clientConn.prompt({
          sessionId: sessionResult.sessionId,
          prompt: [{ type: "text", text: "Hello from ACP client" }],
        });
        expect(promptResult.stopReason).toBe("end_turn");

        // 4. Verify executeAgent was called with correct session key
        expect(deps.executeAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Hello from ACP client",
            sessionKey: expect.objectContaining({
              channelId: "acp",
              userId: "ide-user",
              peerId: sessionResult.sessionId,
            }),
          }),
        );

        // 5. Second prompt (verify session still active -- multi-turn)
        const prompt2Result = await clientConn.prompt({
          sessionId: sessionResult.sessionId,
          prompt: [{ type: "text", text: "Follow-up message" }],
        });
        expect(prompt2Result.stopReason).toBe("end_turn");
        expect(deps.executeAgent).toHaveBeenCalledTimes(2);
      } finally {
        // Close both writable streams to signal end of connection
        const writerA = sideA.writable.getWriter();
        const writerB = sideB.writable.getWriter();
        await writerA.close().catch(() => {});
        await writerB.close().catch(() => {});
      }
    },
    30_000,
  );
});
