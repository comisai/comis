import { describe, it, expect, vi } from "vitest";
import { createAcpAgent, type AcpServerDeps } from "./acp-server.js";
import type {
  InitializeRequest,
  NewSessionRequest,
  PromptRequest,
  AuthenticateRequest,
  CancelNotification,
} from "@agentclientprotocol/sdk";

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
});
