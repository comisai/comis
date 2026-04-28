// SPDX-License-Identifier: Apache-2.0
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

    // ---------------------------------------------------------------------
    // onAgentCreated callback (seed-tracker registration hook)
    // ---------------------------------------------------------------------

    it("fires onAgentCreated with agentId + workspaceDir after successful create", async () => {
      mockRpcCall.mockResolvedValue({
        agentId: "new-bot",
        created: true,
        workspaceDir: "/tmp/workspace-new-bot",
      });
      const onAgentCreated = vi.fn(async () => {});

      const tool = createAgentsManageTool(mockRpcCall, undefined, { onAgentCreated });

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-c4", { action: "create", agent_id: "new-bot" } as never),
      );

      expect(onAgentCreated).toHaveBeenCalledTimes(1);
      expect(onAgentCreated).toHaveBeenCalledWith({
        agentId: "new-bot",
        workspaceDir: "/tmp/workspace-new-bot",
      });
    });

    it("fires onAgentCreated without workspaceDir when RPC result omits it", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "new-bot", created: true });
      const onAgentCreated = vi.fn(async () => {});

      const tool = createAgentsManageTool(mockRpcCall, undefined, { onAgentCreated });

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-c5", { action: "create", agent_id: "new-bot" } as never),
      );

      expect(onAgentCreated).toHaveBeenCalledTimes(1);
      expect(onAgentCreated).toHaveBeenCalledWith({ agentId: "new-bot" });
    });

    it("does NOT fire onAgentCreated when agents.create rejects", async () => {
      mockRpcCall.mockRejectedValue(new Error("rpc failure"));
      const onAgentCreated = vi.fn(async () => {});

      const tool = createAgentsManageTool(mockRpcCall, undefined, { onAgentCreated });

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-c6", { action: "create", agent_id: "new-bot" } as never),
        ),
      ).rejects.toThrow(/rpc failure/);

      expect(onAgentCreated).not.toHaveBeenCalled();
    });

    it("swallows callback errors without failing the tool call", async () => {
      mockRpcCall.mockResolvedValue({
        agentId: "new-bot",
        created: true,
        workspaceDir: "/tmp/workspace-new-bot",
      });
      const onAgentCreated = vi.fn(async () => {
        throw new Error("tracker blew up");
      });

      const tool = createAgentsManageTool(mockRpcCall, undefined, { onAgentCreated });

      // Must NOT throw -- callback failure is a non-fatal optimization.
      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-c7", { action: "create", agent_id: "new-bot" } as never),
      );

      expect(result.details).toEqual(
        expect.objectContaining({ agentId: "new-bot", created: true }),
      );
      expect(onAgentCreated).toHaveBeenCalledTimes(1);
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

  // ---------------------------------------------------------------------------
  // 260428-oyc Task 2: agents_manage.create accepts both flat workspace_profile
  // and nested workspace.profile + round-trips MANAGED_SECTIONS.exampleArgs.
  //
  // Production repro: trading-fleet creation request hit 10 tool failures
  // with a ZodError on `workspace.profile`. The TypeBox tool schema declared
  // only the flat workspace_profile field; mapWorkspaceProfile converts it to
  // nested workspace.profile; the downstream Zod (PerAgentConfigSchema) is
  // strictObject. When the LLM emitted nested workspace={profile:"specialist"}
  // directly, TypeBox's structured-config branch rejected it because no
  // nested `workspace` field was declared, then the Type.Union string fallback
  // also failed (it's an object, not a string). Result: parameter validation
  // failed before mapWorkspaceProfile ever ran.
  // ---------------------------------------------------------------------------
  describe("workspace.profile (260428-oyc)", () => {
    it("E1: round-trips MANAGED_SECTIONS.exampleArgs.agents through TypeBox", async () => {
      const { MANAGED_SECTIONS } = await import("@comis/core");
      const agentsEntry = MANAGED_SECTIONS.find((s) => s.pathPrefix === "agents");
      expect(agentsEntry, "agents entry missing from MANAGED_SECTIONS").toBeDefined();
      // Substitute placeholder strings for real values.
      const args = JSON.parse(JSON.stringify(agentsEntry!.exampleArgs)) as Record<string, unknown>;
      args.agent_id = "trading-alpha";
      const cfg = args.config as Record<string, unknown>;
      cfg.name = "Trading Alpha";
      cfg.model = "claude-sonnet-4-5";
      cfg.provider = "anthropic";

      const tool = createAgentsManageTool(mockRpcCall);
      const ok = Value.Check(tool.parameters, args);
      expect(ok, `MANAGED_SECTIONS.exampleArgs.agents round-trip failed: ${JSON.stringify(args)}`).toBe(true);
    });

    it("E2: flat workspace_profile -> mapWorkspaceProfile produces nested workspace.profile (TypeBox passes flat)", async () => {
      const tool = createAgentsManageTool(mockRpcCall);
      // Flat shape: TypeBox accepts it (workspace_profile is a declared field).
      const args = {
        action: "create" as const,
        agent_id: "spec-flat",
        config: {
          name: "Spec Flat",
          model: "claude-sonnet-4-5",
          provider: "anthropic",
          maxSteps: 50,
          workspace_profile: "specialist" as const,
        },
      };
      expect(Value.Check(tool.parameters, args)).toBe(true);

      // Run the create action and assert the RPC sees nested workspace.profile.
      mockRpcCall.mockResolvedValue({ agentId: "spec-flat", created: true });
      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-e2", args as never),
      );
      const rpcCallArgs = mockRpcCall.mock.calls[0]![1] as { config: Record<string, unknown> };
      expect(rpcCallArgs.config).toEqual({
        name: "Spec Flat",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        maxSteps: 50,
        workspace: { profile: "specialist" },
      });
      // workspace_profile must have been deleted (downstream Zod is strictObject)
      expect(rpcCallArgs.config).not.toHaveProperty("workspace_profile");

      // Downstream Zod must accept the resulting shape.
      const { PerAgentConfigSchema } = await import("@comis/core");
      const parsed = PerAgentConfigSchema.safeParse(rpcCallArgs.config);
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
      if (parsed.success) {
        expect(parsed.data.workspace.profile).toBe("specialist");
      }
    });

    it("E3: nested workspace.profile = 'specialist' is accepted by both TypeBox and downstream Zod (the bug)", async () => {
      const tool = createAgentsManageTool(mockRpcCall);
      const args = {
        action: "create" as const,
        agent_id: "spec-nested",
        config: {
          name: "Spec Nested",
          model: "claude-sonnet-4-5",
          provider: "anthropic",
          maxSteps: 50,
          workspace: { profile: "specialist" as const },
        },
      };
      // Pre-fix this fails: structured-config branch rejects unknown `workspace`,
      // string fallback also fails (it's an object).
      expect(Value.Check(tool.parameters, args)).toBe(true);

      mockRpcCall.mockResolvedValue({ agentId: "spec-nested", created: true });
      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-e3", args as never),
      );
      const rpcCallArgs = mockRpcCall.mock.calls[0]![1] as { config: Record<string, unknown> };
      expect(rpcCallArgs.config).toEqual({
        name: "Spec Nested",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        maxSteps: 50,
        workspace: { profile: "specialist" },
      });

      // Downstream Zod accepts -- NO ZodError on workspace.profile.
      const { PerAgentConfigSchema } = await import("@comis/core");
      const parsed = PerAgentConfigSchema.safeParse(rpcCallArgs.config);
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
      if (parsed.success) {
        expect(parsed.data.workspace.profile).toBe("specialist");
      }
    });

    it("E4: nested workspace.profile = 'full' is accepted", async () => {
      const tool = createAgentsManageTool(mockRpcCall);
      const args = {
        action: "create" as const,
        agent_id: "full-nested",
        config: {
          name: "Full Nested",
          model: "claude-sonnet-4-5",
          provider: "anthropic",
          maxSteps: 50,
          workspace: { profile: "full" as const },
        },
      };
      expect(Value.Check(tool.parameters, args)).toBe(true);

      mockRpcCall.mockResolvedValue({ agentId: "full-nested", created: true });
      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-e4", args as never),
      );
      const rpcCallArgs = mockRpcCall.mock.calls[0]![1] as { config: Record<string, unknown> };
      const { PerAgentConfigSchema } = await import("@comis/core");
      const parsed = PerAgentConfigSchema.safeParse(rpcCallArgs.config);
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
      if (parsed.success) {
        expect(parsed.data.workspace.profile).toBe("full");
      }
    });

    it("E5: invalid workspace.profile value still rejected (enum validation preserved)", async () => {
      const tool = createAgentsManageTool(mockRpcCall);
      const args = {
        action: "create" as const,
        agent_id: "bad-profile",
        config: {
          name: "Bad",
          model: "m",
          provider: "p",
          workspace: { profile: "unknown-mode" as unknown as "full" },
        },
      };
      // After the fix: TypeBox declares the nested `workspace` shape and the
      // profile enum (full|specialist), so invalid values are rejected at the
      // tool-validation layer -- before they reach the downstream Zod parse.
      // (Pre-fix: TypeBox passed unknown values through because the structured
      // config object had no `workspace` field; downstream Zod was the only
      // gate. The fix tightens validation so the LLM gets faster feedback.)
      expect(Value.Check(tool.parameters, args)).toBe(false);
    });

    it("E6: JSON-string config carrying nested workspace still works", async () => {
      const tool = createAgentsManageTool(mockRpcCall);
      const args = {
        action: "create" as const,
        agent_id: "spec-json",
        config: JSON.stringify({
          name: "Spec JSON",
          model: "claude-sonnet-4-5",
          provider: "anthropic",
          workspace: { profile: "specialist" },
        }),
      };
      // String fallback of the Type.Union accepts any JSON string.
      expect(Value.Check(tool.parameters, args)).toBe(true);

      mockRpcCall.mockResolvedValue({ agentId: "spec-json", created: true });
      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-e6", args as never),
      );
      const rpcCallArgs = mockRpcCall.mock.calls[0]![1] as { config: Record<string, unknown> };
      expect(rpcCallArgs.config).toEqual({
        name: "Spec JSON",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        workspace: { profile: "specialist" },
      });
    });

    it("E7: mapWorkspaceProfile is idempotent and a no-op on already-nested config", () => {
      // Direct invariant test on the side-effect of running create twice.
      // Running the tool twice with the same flat-shape input must produce
      // identical config payloads to the RPC layer (no double-nesting).
      const tool = createAgentsManageTool(mockRpcCall);
      const args = {
        action: "create" as const,
        agent_id: "idempotent",
        config: {
          name: "Idem",
          model: "m",
          provider: "p",
          workspace_profile: "specialist" as const,
        },
      };
      expect(Value.Check(tool.parameters, args)).toBe(true);

      // Two runs share the same args object reference. After the first run,
      // mapWorkspaceProfile mutates it (deletes workspace_profile, adds nested
      // workspace). Calling Value.Check again on the now-nested shape must
      // also pass (covers the "already-nested config flows through unchanged"
      // contract).
      mockRpcCall.mockResolvedValue({ agentId: "idempotent", created: true });
      // Snapshot the config to two separate objects so we can rerun cleanly.
      const args2 = JSON.parse(JSON.stringify(args));
      args2.agent_id = "idempotent-2";
      // After a fresh run starts with already-nested config:
      args2.config = { name: "Idem2", model: "m", provider: "p", workspace: { profile: "specialist" } };
      expect(Value.Check(tool.parameters, args2)).toBe(true);
    });

    it("E8: precedence -- flat workspace_profile wins when both flat and nested are present", async () => {
      const tool = createAgentsManageTool(mockRpcCall);
      // Both shapes provided: flat="full", nested.profile="specialist".
      // Pinned behavior: flat workspace_profile WINS (the spread in
      // mapWorkspaceProfile is `{...existing, profile}`, which overwrites
      // the existing nested profile with the flat value).
      const args = {
        action: "create" as const,
        agent_id: "both-shapes",
        config: {
          name: "Both",
          model: "m",
          provider: "p",
          workspace_profile: "full" as const,
          workspace: { profile: "specialist" as const },
        },
      };
      expect(Value.Check(tool.parameters, args)).toBe(true);

      mockRpcCall.mockResolvedValue({ agentId: "both-shapes", created: true });
      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-e8", args as never),
      );
      const rpcCallArgs = mockRpcCall.mock.calls[0]![1] as { config: Record<string, unknown> };
      expect((rpcCallArgs.config.workspace as Record<string, unknown>).profile).toBe("full");
      // workspace_profile flat field is gone after mapping.
      expect(rpcCallArgs.config).not.toHaveProperty("workspace_profile");
    });
  });

  // ---------------------------------------------------------------------------
  // 260428-rrr Bug B: workspace_profile and nested workspace.profile
  // descriptions must spell out the enum is "full" | "specialist" ONLY.
  //
  // Production trace f099bac9 saw the LLM probing values like "minimal" and
  // "none" for workspace.profile because the description string only listed
  // valid values without explicitly closing the door on others. The runtime
  // enum (TypeBox Type.Union(Type.Literal("full"), Type.Literal("specialist")))
  // already enforces this; we are just making the description match the
  // enforcement so the LLM stops trying invalid values up front.
  //
  // Source-level structural assertion (read the file as text, scope to the
  // relevant declaration block) is the simpler and more robust approach --
  // it avoids fighting TypeBox's Symbol-keyed metadata layout.
  // ---------------------------------------------------------------------------
  describe("AgentsManageToolParams description guardrails (260428-rrr)", () => {
    /**
     * Find the substring scoped to a `<field>: Type.Optional(...)` declaration
     * in the source file, using paren-balanced extraction so nested
     * `Type.Union(...)` / `Type.Object(...)` bodies are included. Returns the
     * slice from the first character of `<field>:` up to and including the
     * matching close-paren of the outer Type.Optional.
     */
    function extractOptionalBlock(src: string, fieldDecl: string): string {
      const start = src.indexOf(fieldDecl);
      expect(start, `field declaration not found: ${fieldDecl}`).toBeGreaterThan(-1);
      const openParen = src.indexOf("(", start);
      let depth = 1;
      let i = openParen + 1;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            i++; // include the closing ')'
            break;
          }
        }
      }
      expect(depth, `unbalanced parens for ${fieldDecl}`).toBe(0);
      return src.slice(start, i);
    }

    it("workspace_profile description spells out the enum is ONLY full|specialist", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      const here = path.dirname(url.fileURLToPath(import.meta.url));
      const src = fs.readFileSync(
        path.resolve(here, "agents-manage-tool.ts"),
        "utf-8",
      );
      const wpBlock = extractOptionalBlock(src, "workspace_profile: Type.Optional");
      expect(wpBlock).toContain("ONLY");
    });

    it("nested workspace.profile description spells out the enum is ONLY full|specialist", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      const here = path.dirname(url.fileURLToPath(import.meta.url));
      const src = fs.readFileSync(
        path.resolve(here, "agents-manage-tool.ts"),
        "utf-8",
      );
      const wsBlock = extractOptionalBlock(src, "workspace: Type.Optional");
      expect(wsBlock).toContain("ONLY");
    });
  });
});
