import { describe, it, expect, vi, beforeEach } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createAgentsManageTool } from "./agents-manage-tool.js";
import { runWithContext } from "@comis/core";
import type { RequestContext, ApprovalGate } from "@comis/core";

// Mock @comis/core: preserve real implementations, override safePath
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    safePath: (base: string, ...segments: string[]) => base + "/" + segments.join("/"),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function makeContext(trustLevel: "admin" | "user" | "guest"): RequestContext {
  return {
    tenantId: "default",
    userId: "test-user",
    sessionKey: "test-session",
    traceId: crypto.randomUUID(),
    startedAt: Date.now(),
    trustLevel,
    channelType: "telegram",
  };
}

function createMockApprovalGate(): ApprovalGate {
  return {
    requestApproval: vi.fn(),
    resolveApproval: vi.fn(),
    pending: vi.fn(() => []),
    getRequest: vi.fn(),
    dispose: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agents_manage tool", () => {
  let mockRpcCall: ReturnType<typeof vi.fn<RpcCall>>;
  let mockApprovalGate: ApprovalGate;

  beforeEach(() => {
    mockRpcCall = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
      stub: true,
    }));
    mockApprovalGate = createMockApprovalGate();
  });

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  it("has correct name and label", () => {
    const tool = createAgentsManageTool(mockRpcCall);
    expect(tool.name).toBe("agents_manage");
    expect(tool.label).toBe("Agent Management");
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws when trust level is below admin (guest)", async () => {
      const tool = createAgentsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-1", { action: "get", agent_id: "bot-1" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws when trust level is below admin (user)", async () => {
      const tool = createAgentsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-2", { action: "get", agent_id: "bot-1" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows execution when trust level is admin", async () => {
      const tool = createAgentsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-3", { action: "get", agent_id: "bot-1" } as never),
      );

      expect(result.details).not.toHaveProperty("error");
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // create action
  // -----------------------------------------------------------------------

  describe("create action", () => {
    it("calls rpcCall('agents.create') after approval gate approves", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ agentId: "new-bot", created: true });

      const tool = createAgentsManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-c1", { action: "create", agent_id: "new-bot", config: { name: "New" } } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "agents_manage",
          action: "agents.create",
          channelType: "telegram",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("agents.create", {
        agentId: "new-bot",
        config: { name: "New" },
        _trustLevel: "admin",
      });
      expect(result.details).toEqual(
        expect.objectContaining({ agentId: "new-bot", created: true }),
      );
    });

    it("throws denial error when approval gate denies", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "test denied",
      });

      const tool = createAgentsManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-c2", { action: "create", agent_id: "new-bot" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("calls rpcCall without approval gate when approvalGate is undefined", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "new-bot", created: true });

      const tool = createAgentsManageTool(mockRpcCall); // no approval gate

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-c3", { action: "create", agent_id: "new-bot" } as never),
      );

      expect(result.details).toEqual(
        expect.objectContaining({ agentId: "new-bot", created: true }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("agents.create", {
        agentId: "new-bot",
        config: undefined,
        _trustLevel: "admin",
      });
    });
  });

  // -----------------------------------------------------------------------
  // get action
  // -----------------------------------------------------------------------

  describe("get action", () => {
    it("calls rpcCall('agents.get', { agentId }) and returns result", async () => {
      mockRpcCall.mockResolvedValue({
        agentId: "bot-1",
        config: { name: "Bot 1" },
        suspended: false,
      });

      const tool = createAgentsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-g1", { action: "get", agent_id: "bot-1" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("agents.get", { agentId: "bot-1", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ agentId: "bot-1", suspended: false }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // update action
  // -----------------------------------------------------------------------

  describe("update action", () => {
    it("calls rpcCall('agents.update', { agentId, config }) and returns result", async () => {
      mockRpcCall.mockResolvedValue({
        agentId: "bot-1",
        config: { name: "Updated" },
        updated: true,
      });

      const tool = createAgentsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-u1", {
          action: "update",
          agent_id: "bot-1",
          config: { name: "Updated" },
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("agents.update", {
        agentId: "bot-1",
        config: { name: "Updated" },
        _trustLevel: "admin",
      });
      expect(result.details).toEqual(
        expect.objectContaining({ agentId: "bot-1", updated: true }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // delete action
  // -----------------------------------------------------------------------

  describe("delete action", () => {
    it("calls rpcCall('agents.delete') after approval gate approves", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ agentId: "temp-bot", deleted: true });

      const tool = createAgentsManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-d1", { action: "delete", agent_id: "temp-bot" } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "agents_manage",
          action: "agents.delete",
          channelType: "telegram",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("agents.delete", { agentId: "temp-bot", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ agentId: "temp-bot", deleted: true }),
      );
    });

    it("throws denial error when approval gate denies", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "not authorized",
      });

      const tool = createAgentsManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-d2", { action: "delete", agent_id: "temp-bot" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // suspend action
  // -----------------------------------------------------------------------

  describe("suspend action", () => {
    it("calls rpcCall('agents.suspend', { agentId }) and returns result", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "bot-1", suspended: true });

      const tool = createAgentsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-s1", { action: "suspend", agent_id: "bot-1" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("agents.suspend", { agentId: "bot-1", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ agentId: "bot-1", suspended: true }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // resume action
  // -----------------------------------------------------------------------

  describe("resume action", () => {
    it("calls rpcCall('agents.resume', { agentId }) and returns result", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "bot-1", resumed: true });

      const tool = createAgentsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-r1", { action: "resume", agent_id: "bot-1" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("agents.resume", { agentId: "bot-1", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ agentId: "bot-1", resumed: true }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("re-throws when rpcCall throws Error", async () => {
      mockRpcCall.mockRejectedValue(new Error("Agent service unavailable"));

      const tool = createAgentsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e1", { action: "get", agent_id: "bot-1" } as never),
        ),
      ).rejects.toThrow("Agent service unavailable");
    });

    it("wraps non-Error throws in Error", async () => {
      mockRpcCall.mockRejectedValue("string error");

      const tool = createAgentsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e2", { action: "get", agent_id: "bot-1" } as never),
        ),
      ).rejects.toThrow("string error");
    });
  });

  // -----------------------------------------------------------------------
  // config JSON string coercion
  // -----------------------------------------------------------------------

  describe("config JSON string coercion", () => {
    it("coerces JSON string config to object in create action", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ agentId: "str-bot", created: true });

      const tool = createAgentsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-cs1", {
          action: "create",
          agent_id: "str-bot",
          config: '{"name":"FromString"}',
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("agents.create", {
        agentId: "str-bot",
        config: { name: "FromString" },
        _trustLevel: "admin",
      });
    });

    it("coerces JSON string config to object in update action", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "str-bot", updated: true });

      const tool = createAgentsManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-cs2", {
          action: "update",
          agent_id: "str-bot",
          config: '{"name":"UpdatedFromString"}',
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("agents.update", {
        agentId: "str-bot",
        config: { name: "UpdatedFromString" },
        _trustLevel: "admin",
      });
    });

    it("passes object config through unchanged in create action", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ agentId: "obj-bot", created: true });

      const tool = createAgentsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-cs3", {
          action: "create",
          agent_id: "obj-bot",
          config: { name: "Already Object" },
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("agents.create", {
        agentId: "obj-bot",
        config: { name: "Already Object" },
        _trustLevel: "admin",
      });
    });

    it("rejects invalid JSON string config (fails at mapWorkspaceProfile)", async () => {
      const tool = createAgentsManageTool(mockRpcCall);

      // Invalid JSON string falls through coerceConfig as raw string,
      // then mapWorkspaceProfile throws because 'in' operator requires object
      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-cs4", {
            action: "update",
            agent_id: "bad-bot",
            config: "not json",
          } as never),
        ),
      ).rejects.toThrow(TypeError);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // invalid action
  // -----------------------------------------------------------------------

  describe("invalid action", () => {
    it("throws [invalid_value] for unknown action", async () => {
      const tool = createAgentsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-inv", { action: "bogus", agent_id: "bot-1" } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);
    });
  });

  // Regression: the `config` parameter schema accepts EITHER an object OR
  // a JSON string. This stops the TypeBox validator from rejecting the
  // stringified form the Anthropic LLM sometimes emits for nested free-form
  // objects, before coerceConfig() in execute() gets a chance to parse it.
  describe("schema accepts both object and string config", () => {
    it("parameters TypeBox validates for object config", () => {
      const tool = createAgentsManageTool(mockRpcCall);
      const ok = Value.Check(tool.parameters, {
        action: "create",
        agent_id: "bot-obj",
        config: { name: "Object Agent", provider: "anthropic", model: "claude-opus-4-6" },
      });
      expect(ok).toBe(true);
    });

    it("parameters TypeBox validates for stringified config (LLM fallback path)", () => {
      const tool = createAgentsManageTool(mockRpcCall);
      const ok = Value.Check(tool.parameters, {
        action: "create",
        agent_id: "bot-str",
        config: '{"name":"Stringified Agent","provider":"anthropic","model":"claude-opus-4-6"}',
      });
      expect(ok).toBe(true);
    });
  });
});
