// SPDX-License-Identifier: Apache-2.0
/**
 * Agent Communication E2E Tests
 *
 * ACP Protocol Handshake (no LLM keys needed)
 *   ACP-01: Full initialize -> newSession -> prompt -> multi-turn lifecycle via ndJson
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
} from "@agentclientprotocol/sdk";
import {
  createAcpAgent,
  type AcpServerDeps,
} from "@comis/gateway";

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
// ACP Protocol Handshake (no LLM keys needed)
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
