// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { TypedEventBus, formatSessionKey } from "@comis/core";
import type { ExecutionPlanPort, ReadonlyExecutionPlan } from "@comis/core";
import {
  createAcpAgent,
  startAcpServer,
  type AcpServerDeps,
} from "./acp-server.js";
import type {
  AgentSideConnection,
  InitializeRequest,
  NewSessionRequest,
  PromptRequest,
  AuthenticateRequest,
  CancelNotification,
} from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------------------
// SDK transport mock for startAcpServer (bridge-wiring tests below).
//
// startAcpServer builds a real AgentSideConnection over process.stdin/stdout
// and `await`s `connection.closed`. To inspect bridge construction WITHOUT
// blocking on a live stdio stream, replace the SDK transport with fakes:
//   - ndJsonStream → a stub (the wiring tests never read/write frames);
//   - AgentSideConnection → a fake whose `closed` is a PENDING promise the
//     test controls (so startAcpServer stays in its open window while we
//     emit on the bus) and whose `signal` is a controllable AbortSignal.
// The OTHER tests in this file build their own hand-rolled fake connection
// (makeFakeConnection) and never instantiate the SDK class, so the module
// mock does not perturb them.
// ---------------------------------------------------------------------------
const sdkConnectionState: {
  resolveClosed?: () => void;
  abortController?: AbortController;
} = {};

vi.mock("@agentclientprotocol/sdk", () => {
  class FakeAgentSideConnection {
    public sessionUpdate = vi.fn(async () => {});
    public requestPermission = vi.fn(async () => ({
      outcome: { outcome: "cancelled" as const },
    }));
    public readonly closed: Promise<void>;
    private readonly _abort = new AbortController();
    constructor(_toAgent: unknown, _stream: unknown) {
      sdkConnectionState.abortController = this._abort;
      this.closed = new Promise<void>((resolve) => {
        sdkConnectionState.resolveClosed = resolve;
      });
    }
    get signal(): AbortSignal {
      return this._abort.signal;
    }
  }
  return {
    tenantId: "default",
    agentId: "a1",
    AgentSideConnection: FakeAgentSideConnection,
    ndJsonStream: vi.fn(() => ({ readable: {}, writable: {} })),
  };
});

/**
 * Hand-built fake AgentSideConnection (AGENTS.md §2.5 — only the members the
 * SUT touches). Exposes a controllable `signal` so a test can fire the "abort"
 * event the way the SDK does on connection close (acp.d.ts:150).
 */
function makeFakeConnection(): {
  connection: AgentSideConnection;
  abortController: AbortController;
} {
  const abortController = new AbortController();
  const connection = {
    sessionUpdate: vi.fn(async () => {}),
    requestPermission: vi.fn(async () => ({
      outcome: { outcome: "selected", optionId: "approve" },
    })),
    get signal(): AbortSignal {
      return abortController.signal;
    },
  } as unknown as AgentSideConnection;
  return { connection, abortController };
}

function createMockDeps(
  overrides?: Partial<AcpServerDeps>,
): AcpServerDeps {
  return {
    executeAgent: vi.fn<AcpServerDeps["executeAgent"]>().mockResolvedValue({
      response: "Hello from Comis",
      tokensUsed: { input: 10, output: 20, total: 30 },
      finishReason: "stop",
    }),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    version: "1.2.3",
    ...overrides,
  };
}

describe("createAcpAgent", () => {
  describe("initialize", () => {
    it("returns correct agent info and protocol version", async () => {
      const deps = createMockDeps();
      const { agent } = createAcpAgent(deps);

      const params: InitializeRequest = {
        protocolVersion: 1,
      };

      const result = await agent.initialize(params);

      expect(result.protocolVersion).toBe(1);
      expect(result.agentInfo).toEqual({
        name: "comis",
        title: "Comis",
        version: "1.2.3",
      });
      expect(result.agentCapabilities).toEqual({});
    });

    it("uses default version when not provided", async () => {
      const deps = createMockDeps({ version: undefined });
      const { agent } = createAcpAgent(deps);

      const result = await agent.initialize({
        protocolVersion: 1,
      });

      expect(result.agentInfo!.version).toBe("0.0.1");
    });
  });

  describe("newSession", () => {
    it("returns a session ID and creates a session in the map", async () => {
      const deps = createMockDeps();
      const { agent, sessionMap } = createAcpAgent(deps);

      const params: NewSessionRequest = {
        cwd: "/tmp/project",
        mcpServers: [],
      };

      const result = await agent.newSession(params);

      expect(result.sessionId).toBeTruthy();
      expect(typeof result.sessionId).toBe("string");

      // Verify session was created in the map
      const key = sessionMap.get(result.sessionId);
      expect(key).toBeDefined();
      expect(key!.channelId).toBe("acp");
      expect(key!.userId).toBe("ide-user");
      expect(key!.peerId).toBe(result.sessionId);
    });

    it("creates unique session IDs for each call", async () => {
      const deps = createMockDeps();
      const { agent } = createAcpAgent(deps);

      const params: NewSessionRequest = {
        cwd: "/tmp/project",
        mcpServers: [],
      };

      const result1 = await agent.newSession(params);
      const result2 = await agent.newSession(params);

      expect(result1.sessionId).not.toBe(result2.sessionId);
    });
  });

  describe("prompt", () => {
    it("calls executeAgent with correct session key and returns endTurn", async () => {
      const deps = createMockDeps();
      const { agent } = createAcpAgent(deps);

      // Create a session first
      const session = await agent.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });

      const params: PromptRequest = {
        sessionId: session.sessionId,
        prompt: [
          { type: "text", text: "What is the meaning of life?" },
        ],
      };

      const result = await agent.prompt(params);

      expect(result.stopReason).toBe("end_turn");
      expect(deps.executeAgent).toHaveBeenCalledWith({
        message: "What is the meaning of life?",
        sessionKey: {
          userId: "ide-user",
          channelId: "acp",
          peerId: session.sessionId,
        },
      });
    });

    it("joins multiple text blocks with newline", async () => {
      const deps = createMockDeps();
      const { agent } = createAcpAgent(deps);

      const session = await agent.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });

      await agent.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "text", text: "First block" },
          { type: "text", text: "Second block" },
        ],
      });

      expect(deps.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "First block\nSecond block",
        }),
      );
    });

    it("throws error for unknown session", async () => {
      const deps = createMockDeps();
      const { agent } = createAcpAgent(deps);

      const params: PromptRequest = {
        sessionId: "nonexistent-session",
        prompt: [{ type: "text", text: "Hello" }],
      };

      await expect(agent.prompt(params)).rejects.toThrow(
        "Unknown ACP session: nonexistent-session",
      );
      expect(deps.logger.error).toHaveBeenCalled();
    });

    it("returns endTurn and logs error when executeAgent fails", async () => {
      const deps = createMockDeps({
        executeAgent: vi.fn<AcpServerDeps["executeAgent"]>().mockRejectedValue(
          new Error("Agent execution failed"),
        ),
      });
      const { agent } = createAcpAgent(deps);

      const session = await agent.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });

      const result = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Hello" }],
      });

      expect(result.stopReason).toBe("end_turn");
      expect(deps.logger.error).toHaveBeenCalled();
    });
  });

  describe("authenticate", () => {
    it("returns without error (no-op for local agent)", async () => {
      const deps = createMockDeps();
      const { agent } = createAcpAgent(deps);

      const params: AuthenticateRequest = {
        methodId: "local",
      };

      // Should not throw
      await expect(agent.authenticate(params)).resolves.not.toThrow();
    });
  });

  describe("cancel", () => {
    it("removes the session from the map", async () => {
      const deps = createMockDeps();
      const { agent, sessionMap } = createAcpAgent(deps);

      const session = await agent.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });

      expect(sessionMap.get(session.sessionId)).toBeDefined();

      const cancelParams: CancelNotification = {
        sessionId: session.sessionId,
      };
      await agent.cancel(cancelParams);

      expect(sessionMap.get(session.sessionId)).toBeUndefined();
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.sessionId }),
        expect.stringContaining("cancel"),
      );
    });
  });

  describe("ndJson stdio transport edge cases", () => {
    // NOTE: startAcpServer delegates entirely to @agentclientprotocol/sdk's
    // ndJsonStream and AgentSideConnection for transport-level concerns
    // (malformed JSON, partial reads, buffering). These are tested within
    // the SDK itself. Our unit tests cover the agent logic layer above
    // the transport.
    //
    // However, we can verify that createAcpAgent handles edge cases in
    // the prompt content extraction, which is the layer between transport
    // and agent execution.

    it("extracts empty string from prompt with no text blocks", async () => {
      const deps = createMockDeps();
      const { agent } = createAcpAgent(deps);

      const session = await agent.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });

      // Send prompt with only non-text blocks (simulating image/resource content)
      await agent.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "image", source: { type: "url", url: "https://example.com/img.png" } } as never,
        ],
      });

      expect(deps.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ message: "" }),
      );
    });

    it("handles prompt with mixed text and non-text blocks", async () => {
      const deps = createMockDeps();
      const { agent } = createAcpAgent(deps);

      const session = await agent.newSession({
        cwd: "/tmp",
        mcpServers: [],
      });

      await agent.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "image", source: { type: "url", url: "https://example.com/img.png" } } as never,
          { type: "text", text: "Describe this image" },
          { type: "resource", uri: "file:///tmp/test.ts" } as never,
          { type: "text", text: "and this file" },
        ],
      });

      expect(deps.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Describe this image\nand this file",
        }),
      );
    });
  });

  describe("per-session AgentSideConnection registry", () => {
    it("retains the registered connection per session id after newSession", async () => {
      const deps = createMockDeps();
      const { agent, registerConnection, getConnection } = createAcpAgent(deps);
      const { connection } = makeFakeConnection();
      registerConnection(connection);

      const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

      // The bridges (Wave 2) reach the connection through getConnection.
      expect(getConnection(session.sessionId)).toBe(connection);
    });

    it("returns undefined from getConnection for an unknown session id", () => {
      const deps = createMockDeps();
      const { getConnection } = createAcpAgent(deps);

      expect(getConnection("nonexistent-session")).toBeUndefined();
    });

    it("drops the retained connection from the registry on cancel", async () => {
      const deps = createMockDeps();
      const { agent, registerConnection, getConnection } = createAcpAgent(deps);
      const { connection } = makeFakeConnection();
      registerConnection(connection);

      const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
      expect(getConnection(session.sessionId)).toBe(connection);

      await agent.cancel({ sessionId: session.sessionId });

      expect(getConnection(session.sessionId)).toBeUndefined();
    });

    it("empties the connection registry when the connection signal aborts", async () => {
      const deps = createMockDeps();
      const { agent, registerConnection, getConnection } = createAcpAgent(deps);
      const { connection, abortController } = makeFakeConnection();
      registerConnection(connection);

      const sessionA = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
      const sessionB = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
      expect(getConnection(sessionA.sessionId)).toBe(connection);
      expect(getConnection(sessionB.sessionId)).toBe(connection);

      // The SDK aborts connection.signal on close (acp.d.ts:150) — every
      // retained connection for the aborted connection must be dropped.
      abortController.abort();

      expect(getConnection(sessionA.sessionId)).toBeUndefined();
      expect(getConnection(sessionB.sessionId)).toBeUndefined();
    });
  });
});

/**
 * Bridge-wiring suite: startAcpServer must construct the three ACP bridges and
 * subscribe the plan bridge per connection when the injection seams
 * (executionPlanPort + eventBus + activityStreamPort) are present, and remain a
 * no-op for non-ACP-plan callers when they are absent.
 *
 * RED on pre-patch code: `AcpServerDeps` carries no `executionPlanPort` /
 * `eventBus`, and startAcpServer constructs no bridge — so the
 * `getCurrentPlan` read after a `sep:plan_extracted` emit never fires.
 */
describe("startAcpServer bridge wiring", () => {
  const ACP_SESSION_ID = "wire-acp-session-1";
  const SESSION_KEY = formatSessionKey({
    tenantId: "default",
    agentId: "a1",
    userId: "ide-user",
    channelId: "acp",
    peerId: ACP_SESSION_ID,
  });

  /** Mutable fake ExecutionPlanPort (mirrors acp-plan-bridge.test.ts:38-50). */
  function makePlanPort(plan: ReadonlyExecutionPlan | undefined): {
    port: ExecutionPlanPort;
    getCurrentPlan: ReturnType<typeof vi.fn>;
  } {
    const getCurrentPlan = vi.fn(() => plan);
    return { port: { getCurrentPlan }, getCurrentPlan };
  }

  function activePlan(): ReadonlyExecutionPlan {
    return {
      active: true,
      request: "do the thing",
      completedCount: 0,
      steps: [{ index: 1, description: "step one", status: "pending" }],
    };
  }

  // Each test runs startAcpServer (which never resolves until we resolve the
  // mocked connection.closed) — start it, drive the bus, then tear it down.
  async function withRunningServer(
    deps: AcpServerDeps,
    body: () => void | Promise<void>,
  ): Promise<void> {
    sdkConnectionState.resolveClosed = undefined;
    sdkConnectionState.abortController = undefined;
    const serverPromise = startAcpServer(deps);
    // Let startAcpServer reach `await connection.closed` (construct the handle,
    // the connection, register it, and build the bridges).
    await Promise.resolve();
    await Promise.resolve();
    try {
      await body();
    } finally {
      // Close the connection so startAcpServer resolves and the plan bridge
      // unsubscribes (teardown symmetry).
      sdkConnectionState.abortController?.abort();
      sdkConnectionState.resolveClosed?.();
      await serverPromise;
    }
  }

  it("startAcpServer constructs the three ACP bridges when executionPlanPort and activityStreamPort are injected", async () => {
    const bus = new TypedEventBus();
    const { port, getCurrentPlan } = makePlanPort(activePlan());
    const activityStreamPort = {
      subscribeForTurn: vi.fn(() => ({ unsubscribe: vi.fn() })),
    };
    const deps = createMockDeps({
      executionPlanPort: port,
      eventBus: bus,
      activityStreamPort: activityStreamPort as never,
    });

    await withRunningServer(deps, () => {
      // The plan bridge subscribes `sep:plan_extracted` on the injected bus and
      // reads the live plan via the injected port. Emitting proves BOTH that the
      // bridge was constructed/subscribed AND that the port it reads is the one
      // we injected on AcpServerDeps.executionPlanPort.
      bus.emit("sep:plan_extracted", {
        agentId: "a1",
        sessionKey: SESSION_KEY,
        stepCount: 1,
        timestamp: Date.now(),
      });
      expect(getCurrentPlan).toHaveBeenCalled();
    });
  });

  it("startAcpServer no-ops the plan bridge when executionPlanPort is absent (back-compat)", async () => {
    const bus = new TypedEventBus();
    const onSpy = vi.spyOn(bus, "on");
    // No executionPlanPort — existing non-ACP-plan callers are unaffected.
    const deps = createMockDeps({ eventBus: bus });

    await withRunningServer(deps, () => {
      // With no port, the plan bridge must NOT be constructed → no handler
      // registered for the plan/tool events on the injected bus.
      const planSubscribed = onSpy.mock.calls.some(
        ([eventName]) =>
          eventName === "sep:plan_extracted" || eventName === "tool:executed",
      );
      expect(planSubscribed).toBe(false);
    });
  });

  it("passes only the read-only port to createAcpPlanBridge — no raw plan source crosses (§19.6 M6 composition guard)", async () => {
    const bus = new TypedEventBus();
    const { port, getCurrentPlan } = makePlanPort(activePlan());
    const activityStreamPort = {
      subscribeForTurn: vi.fn(() => ({ unsubscribe: vi.fn() })),
    };
    const deps = createMockDeps({
      executionPlanPort: port,
      eventBus: bus,
      activityStreamPort: activityStreamPort as never,
    });

    await withRunningServer(deps, () => {
      bus.emit("sep:plan_extracted", {
        agentId: "a1",
        sessionKey: SESSION_KEY,
        stepCount: 1,
        timestamp: Date.now(),
      });
      // The composition hands the plan bridge ONLY the read-only port; the
      // bridge reads the live plan THROUGH getCurrentPlan() rather than via a
      // raw plan ref. A getCurrentPlan() read after the emit proves the
      // read-only seam is the source (the redacted-frame guarantee itself is
      // covered by acp-bridges-redaction.test.ts).
      expect(getCurrentPlan).toHaveBeenCalledTimes(1);
    });
  });
});
