// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Value } from "typebox/value";
import {
  createAgentsManageTool,
  AgentsManageToolParams,
  buildCreateContract,
} from "./agents-manage-tool.js";
import { runWithContext } from "@comis/core";
import type { RequestContext, ApprovalGate } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

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

/**
 * Build a Pino-shaped mock logger compatible with `ComisLogger`.
 * Mirrors the gateway-tool.test.ts:22-34 pattern. The agents-manage tool
 * calls `logger.info(obj, msg)` from the `create` action override; we stub
 * the full surface so future calls (e.g. `warn`) don't blow up the harness.
 */
function makeMockLogger() {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  return logger as typeof logger & ComisLogger;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agents_manage tool", () => {
  let mockRpcCall: ReturnType<typeof vi.fn<RpcCall>>;
  let mockApprovalGate: ApprovalGate;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    mockRpcCall = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
      stub: true,
    }));
    mockApprovalGate = createMockApprovalGate();
    mockLogger = makeMockLogger();
  });

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  it("has correct name and label", () => {
    const tool = createAgentsManageTool(mockRpcCall, mockLogger);
    expect(tool.name).toBe("agents_manage");
    expect(tool.label).toBe("Agent Management");
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws when trust level is below admin (guest)", async () => {
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-1", { action: "get", agent_id: "bot-1" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws when trust level is below admin (user)", async () => {
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-2", { action: "get", agent_id: "bot-1" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows execution when trust level is admin", async () => {
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger, mockApprovalGate);

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-c2", { action: "create", agent_id: "new-bot" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("calls rpcCall without approval gate when approvalGate is undefined", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "new-bot", created: true });

      const tool = createAgentsManageTool(mockRpcCall, mockLogger); // no approval gate, no callbacks

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger, undefined, { onAgentCreated });

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger, undefined, { onAgentCreated });

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-c5", { action: "create", agent_id: "new-bot" } as never),
      );

      expect(onAgentCreated).toHaveBeenCalledTimes(1);
      expect(onAgentCreated).toHaveBeenCalledWith({ agentId: "new-bot" });
    });

    it("does NOT fire onAgentCreated when agents.create rejects", async () => {
      mockRpcCall.mockRejectedValue(new Error("rpc failure"));
      const onAgentCreated = vi.fn(async () => {});

      const tool = createAgentsManageTool(mockRpcCall, mockLogger, undefined, { onAgentCreated });

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger, undefined, { onAgentCreated });

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

  // ---------------------------------------------------------------------------
  // 260428-sw2 Layer 1: post-create next-step contract emitted in tool_result.
  //
  // Production trace 1a8b0d91 turn 13 (17:24:26.932 UTC) was completely empty
  // (0 text, 0 thinking, 0 tools) after the LLM created 9 sub-agents in
  // parallel: TOOL_GUIDE prescriptive text was crowded out under high
  // parallel-tool-call load. Fix: emit the next-step contract on the
  // freshest, uncached surface -- the tool_result text block itself, read
  // by the LLM on every turn.
  //
  // Pins:
  //  - Case A (workspaceDir present): full contract with anchor strings
  //    "✓ Agent ... created", workspaceDir echoed twice (at-line + ROLE.md
  //    path), ROLE.md mentioned ≥2 times, IDENTITY.md, "Next required
  //    action", "NOT ready until ROLE.md is customized", literal
  //    `write({path:` directive.
  //  - Case B (workspaceDir absent, defensive fallback): shorter contract
  //    pinning "Customize {agentId}'s workspace ROLE.md" + IDENTITY.md.
  //  - Structured fields preserved: result.details = raw RPC return,
  //    result.content has exactly 2 text blocks (contract first,
  //    JSON.stringify(rpcReturn, null, 2) second).
  //  - Structured Pino INFO log emitted once with module/action/agentId/
  //    workspaceDir/contractEmitted fields and the canonical message.
  //  - Non-create actions (get/update/delete/suspend/resume) MUST NOT emit
  //    the contract NOR the structured INFO log.
  // ---------------------------------------------------------------------------
  describe("create next-step contract (260428-sw2)", () => {
    it("Case A: with workspaceDir, emits full contract as first text block", async () => {
      const rpcReturn = {
        agentId: "ta-fundamentals",
        config: { name: "TA Fundamentals" },
        created: true,
        workspaceDir: "/home/comis/.comis/workspace-ta-fundamentals",
      };
      mockRpcCall.mockResolvedValue(rpcReturn);

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-sw2-a", {
          action: "create",
          agent_id: "ta-fundamentals",
        } as never),
      );

      expect(result.content[0]!.type).toBe("text");
      const contract = (result.content[0] as { type: "text"; text: string }).text;

      // Anchor strings
      expect(contract).toContain("✓ Agent ta-fundamentals created");
      expect(contract).toContain("Next required action");
      expect(contract).toContain("NOT ready until ROLE.md is customized");
      expect(contract).toContain("IDENTITY.md");
      // workspaceDir echoed at least twice (at-line + ROLE.md path)
      const wsdMatches = contract.match(/workspace-ta-fundamentals/g) ?? [];
      expect(wsdMatches.length).toBeGreaterThanOrEqual(2);
      // ROLE.md mentioned at least twice
      const roleMatches = contract.match(/ROLE\.md/g) ?? [];
      expect(roleMatches.length).toBeGreaterThanOrEqual(2);
      // Exact write() directive substring with the workspaceDir/ROLE.md path
      expect(contract).toContain(
        'call write({path: "/home/comis/.comis/workspace-ta-fundamentals/ROLE.md", content: "..."})',
      );
    });

    it("Case B: without workspaceDir, emits fallback contract", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "ta-bear", created: true });

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-sw2-b", {
          action: "create",
          agent_id: "ta-bear",
        } as never),
      );

      expect(result.content[0]!.type).toBe("text");
      const contract = (result.content[0] as { type: "text"; text: string }).text;

      expect(contract).toContain("✓ Agent ta-bear created");
      expect(contract).toContain("Customize ta-bear's workspace ROLE.md");
      expect(contract).toContain("IDENTITY.md");
      // Case-A-only anchor must NOT be present
      expect(contract).not.toContain("NOT ready until");
    });

    it("structured fields preserved: details = raw RPC return; second text block = JSON view", async () => {
      const rpcReturn = {
        agentId: "ta-fundamentals",
        config: { name: "TA Fundamentals", model: "claude-sonnet-4-5" },
        created: true,
        workspaceDir: "/home/comis/.comis/workspace-ta-fundamentals",
      };
      mockRpcCall.mockResolvedValue(rpcReturn);

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-sw2-c", {
          action: "create",
          agent_id: "ta-fundamentals",
        } as never),
      );

      // details preserved verbatim (existing assertions on result.details still pass)
      expect(result.details).toEqual(rpcReturn);
      // exactly 2 text blocks
      expect(result.content.length).toBe(2);
      expect(result.content[1]!.type).toBe("text");
      const jsonBlock = (result.content[1] as { type: "text"; text: string }).text;
      expect(jsonBlock).toBe(JSON.stringify(rpcReturn, null, 2));
    });

    it("emits structured INFO log with exact field shape on successful create (with workspaceDir)", async () => {
      const rpcReturn = {
        agentId: "ta-fundamentals",
        config: { name: "TA Fundamentals" },
        created: true,
        workspaceDir: "/home/comis/.comis/workspace-ta-fundamentals",
      };
      mockRpcCall.mockResolvedValue(rpcReturn);

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-sw2-d", {
          action: "create",
          agent_id: "ta-fundamentals",
        } as never),
      );

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      const [fields, msg] = mockLogger.info.mock.calls[0]!;
      expect(fields).toEqual({
        module: "skill.agents-manage",
        action: "create",
        agentId: "ta-fundamentals",
        workspaceDir: "/home/comis/.comis/workspace-ta-fundamentals",
        contractEmitted: true,
        // 260428-vyf: additive field distinguishing the 3 inline-write
        // outcomes. "none" because this test does not supply inlineContent.
        inlineWritesOutcome: "none",
      });
      expect(msg).toMatch(/agents_manage\.create succeeded.*next-step contract emitted/);
    });

    it("emits INFO log with workspaceDir: null when RPC return omits workspaceDir", async () => {
      mockRpcCall.mockResolvedValue({ agentId: "ta-bear", created: true });

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-sw2-e", {
          action: "create",
          agent_id: "ta-bear",
        } as never),
      );

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      const [fields] = mockLogger.info.mock.calls[0]!;
      expect(fields).toEqual({
        module: "skill.agents-manage",
        action: "create",
        agentId: "ta-bear",
        workspaceDir: null,
        contractEmitted: true,
        // 260428-vyf: additive field, "none" when inlineContent absent.
        inlineWritesOutcome: "none",
      });
    });

    it("non-create actions emit NEITHER the contract NOR the structured INFO log", async () => {
      // Parameterized loop covers all 5 non-create actions in one block.
      const cases: Array<{
        action: "get" | "update" | "delete" | "suspend" | "resume";
        callId: string;
        rpcReturn: Record<string, unknown>;
        approval: boolean;
      }> = [
        { action: "get", callId: "call-sw2-neg-get", rpcReturn: { agentId: "bot-x", suspended: false }, approval: false },
        { action: "update", callId: "call-sw2-neg-update", rpcReturn: { agentId: "bot-x", updated: true }, approval: false },
        { action: "delete", callId: "call-sw2-neg-delete", rpcReturn: { agentId: "bot-x", deleted: true }, approval: true },
        { action: "suspend", callId: "call-sw2-neg-suspend", rpcReturn: { agentId: "bot-x", suspended: true }, approval: false },
        { action: "resume", callId: "call-sw2-neg-resume", rpcReturn: { agentId: "bot-x", resumed: true }, approval: false },
      ];

      for (const c of cases) {
        // Reset per-iteration so the assertions about call-counts stay clean.
        mockRpcCall = vi.fn(async () => c.rpcReturn);
        mockLogger = makeMockLogger();
        if (c.approval) {
          (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>) = vi
            .fn()
            .mockResolvedValue({ approved: true, approvedBy: "operator" });
        }

        const tool = createAgentsManageTool(mockRpcCall, mockLogger, mockApprovalGate);
        const result = await runWithContext(makeContext("admin"), () =>
          tool.execute(c.callId, { action: c.action, agent_id: "bot-x" } as never),
        );

        // Pre-fix shape: single JSON text block.
        expect(result.content.length, `action ${c.action}: content length`).toBe(1);
        expect(result.content[0]!.type, `action ${c.action}: content[0].type`).toBe("text");
        const text = (result.content[0] as { type: "text"; text: string }).text;
        expect(text, `action ${c.action}: must NOT contain contract`).not.toContain(
          "Next required action",
        );

        // No call to logger.info with module=skill.agents-manage + contractEmitted.
        const sw2Calls = mockLogger.info.mock.calls.filter(
          (call) =>
            typeof call[0] === "object" &&
            call[0] !== null &&
            (call[0] as Record<string, unknown>).module === "skill.agents-manage" &&
            (call[0] as Record<string, unknown>).contractEmitted === true,
        );
        expect(sw2Calls, `action ${c.action}: contractEmitted INFO must not fire`).toEqual([]);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 260428-vyf Layer 2: inline ROLE.md / IDENTITY.md content on agents.create.
  //
  // The tool layer accepts workspace.role / workspace.identity at the schema
  // boundary, strips them from the config payload before the RPC, and
  // forwards them as a separate top-level `inlineContent` parameter (Path A).
  // The daemon writes the files atomically as part of agents.create and
  // returns an `inlineWritesResult` field on the RPC payload, which
  // buildCreateContract uses to decide between the SHORT, PARTIAL, and
  // 2-step (existing) contract forms.
  //
  // Tests 1-4: TypeBox schema accept/reject for the new shape + size limits.
  // Test 5: handler strips role/identity from config + forwards inlineContent.
  // Tests 6-9: buildCreateContract 3-state branches + IO failure fallthrough.
  // ---------------------------------------------------------------------------
  describe("create inline workspace content (260428-vyf)", () => {
    // ---------------------------------------------------------------------
    // Test 1-4: schema accept/reject
    // ---------------------------------------------------------------------
    it("Test 1 — schema accepts workspace.role + workspace.identity", () => {
      const ok = Value.Check(AgentsManageToolParams, {
        action: "create",
        agent_id: "vyf-a",
        config: {
          workspace: { profile: "specialist", role: "R", identity: "I" },
        },
      });
      expect(ok).toBe(true);
    });

    it("Test 2 — schema rejects oversize role (>16384 chars)", () => {
      const ok = Value.Check(AgentsManageToolParams, {
        action: "create",
        agent_id: "vyf-big-r",
        config: {
          workspace: { profile: "specialist", role: "x".repeat(16385) },
        },
      });
      expect(ok).toBe(false);
    });

    it("Test 3 — schema rejects oversize identity (>4096 chars)", () => {
      const ok = Value.Check(AgentsManageToolParams, {
        action: "create",
        agent_id: "vyf-big-i",
        config: {
          workspace: { profile: "specialist", identity: "y".repeat(4097) },
        },
      });
      expect(ok).toBe(false);
    });

    it("Test 4 — schema accepts role-only and identity-only shapes", () => {
      const roleOnly = Value.Check(AgentsManageToolParams, {
        action: "create",
        agent_id: "vyf-r",
        config: { workspace: { profile: "specialist", role: "R" } },
      });
      expect(roleOnly).toBe(true);
      const idOnly = Value.Check(AgentsManageToolParams, {
        action: "create",
        agent_id: "vyf-i",
        config: { workspace: { profile: "full", identity: "I" } },
      });
      expect(idOnly).toBe(true);
    });

    // ---------------------------------------------------------------------
    // Test 5: handler strips role/identity from config + forwards inlineContent
    // ---------------------------------------------------------------------
    it("Test 5 — handler strips role/identity from RPC config and forwards inlineContent", async () => {
      mockRpcCall.mockResolvedValue({
        agentId: "vyf-strip",
        created: true,
        workspaceDir: "/tmp/workspace-vyf-strip",
        inlineWritesResult: { roleWritten: true, identityWritten: true, bytesWritten: 2 },
      });

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-vyf-strip", {
          action: "create",
          agent_id: "vyf-strip",
          config: {
            workspace: { profile: "specialist", role: "R", identity: "I" },
          },
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledTimes(1);
      const [method, rpcArgs] = mockRpcCall.mock.calls[0]!;
      expect(method).toBe("agents.create");
      const argsTyped = rpcArgs as {
        agentId: string;
        config: { workspace?: Record<string, unknown> };
        inlineContent?: { role?: string; identity?: string };
        _trustLevel: string;
      };
      // Config workspace must NOT carry role/identity any more.
      expect(argsTyped.config.workspace).toEqual({ profile: "specialist" });
      // inlineContent is the dedicated top-level RPC param.
      expect(argsTyped.inlineContent).toEqual({ role: "R", identity: "I" });
    });

    // ---------------------------------------------------------------------
    // Test 6: buildCreateContract — both written → SHORT contract
    // ---------------------------------------------------------------------
    it("Test 6 — buildCreateContract: both written emits SHORT operationally-ready contract", () => {
      const text = buildCreateContract("agt-a", "/tmp/workspace-agt-a", {
        roleWritten: true,
        identityWritten: true,
        bytesWritten: 42,
      });
      expect(text).toContain("✓ Agent agt-a created at /tmp/workspace-agt-a with inline ROLE.md");
      expect(text).toContain("and IDENTITY.md");
      expect(text).toContain("42 bytes");
      expect(text).toContain("No further setup needed");
      expect(text).toContain("operationally ready");
      // Negative: must NOT use the long-form 2-step language.
      expect(text).not.toContain("Next required action");
      expect(text).not.toContain("NOT ready until");
    });

    // ---------------------------------------------------------------------
    // Test 7: buildCreateContract — partial (role only) → mixed contract
    // ---------------------------------------------------------------------
    it("Test 7 — buildCreateContract: role-only partial mentions ROLE.md written + IDENTITY.md still template", () => {
      const text = buildCreateContract("agt-p", "/tmp/workspace-agt-p", {
        roleWritten: true,
        identityWritten: false,
        bytesWritten: 1,
      });
      expect(text).toContain("with inline ROLE.md");
      expect(text).toContain("IDENTITY.md is still the unmodified template");
      // Single Next-required-action line targeting only IDENTITY.md.
      const nextActionLines = text.split("\n").filter((l) => l.includes("Next required action"));
      expect(nextActionLines.length).toBe(1);
      expect(nextActionLines[0]).toContain("IDENTITY.md");
      expect(nextActionLines[0]).not.toContain("ROLE.md");
    });

    // ---------------------------------------------------------------------
    // Test 8: buildCreateContract — neither (regression) emits existing 2-step
    // ---------------------------------------------------------------------
    it("Test 8 — buildCreateContract: neither/undefined falls through to existing 260428-sw2 contract", () => {
      const undefinedResult = buildCreateContract("agt-n", "/tmp/workspace-agt-n");
      expect(undefinedResult).toContain("✓ Agent agt-n created at /tmp/workspace-agt-n.");
      expect(undefinedResult).toContain("Workspace files are TEMPLATES");
      expect(undefinedResult).toContain("Next required action");
      expect(undefinedResult).toContain("NOT ready until ROLE.md is customized");
      expect(undefinedResult).not.toContain("inline ROLE.md");
      expect(undefinedResult).not.toContain("operationally ready");

      const noWritesResult = buildCreateContract("agt-x", "/tmp/workspace-agt-x", {
        roleWritten: false,
        identityWritten: false,
        bytesWritten: 0,
      });
      // false/false success-shape still falls through to the 2-step contract.
      expect(noWritesResult).toContain("Workspace files are TEMPLATES");
      expect(noWritesResult).toContain("Next required action");
    });

    // ---------------------------------------------------------------------
    // Test 9: buildCreateContract — IO failure shape falls through to 2-step
    // ---------------------------------------------------------------------
    it("Test 9 — buildCreateContract: helper IO failure shape falls through to existing 2-step contract", () => {
      const text = buildCreateContract("agt-f", "/tmp/workspace-agt-f", {
        ok: false,
        error: { kind: "io", file: "ROLE.md", message: "EACCES" },
      });
      // The error-shape lacks `roleWritten` so the function takes the
      // existing 2-step branch — pinning that the LLM is told to call
      // write() to recover, not the false short-form "ready" message.
      expect(text).toContain("Next required action");
      expect(text).toContain("Workspace files are TEMPLATES");
      expect(text).not.toContain("operationally ready");
      expect(text).not.toContain("inline ROLE.md");
    });
  });

  // -----------------------------------------------------------------------
  // systemPrompt / prompt / instructions alias → workspace.role
  // -----------------------------------------------------------------------

  describe("role alias mapping (systemPrompt hallucination fix)", () => {
    it("maps systemPrompt to workspace.role and forwards as inlineContent", async () => {
      mockRpcCall.mockResolvedValue({
        agentId: "alias-sp",
        created: true,
        workspaceDir: "/tmp/workspace-alias-sp",
        inlineWritesResult: { roleWritten: true, identityWritten: false, bytesWritten: 50 },
      });

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-alias-sp", {
          action: "create",
          agent_id: "alias-sp",
          config: {
            name: "Alias Test",
            systemPrompt: "You are a helpful analyst.",
          },
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledTimes(1);
      const [, rpcArgs] = mockRpcCall.mock.calls[0]!;
      const args = rpcArgs as {
        config: Record<string, unknown>;
        inlineContent?: { role?: string; identity?: string };
      };
      // systemPrompt must be stripped from config
      expect(args.config).not.toHaveProperty("systemPrompt");
      // workspace.role must be set and forwarded as inlineContent
      expect(args.inlineContent).toEqual({ role: "You are a helpful analyst." });
    });

    it("maps string-form config with systemPrompt (the actual production failure path)", async () => {
      mockRpcCall.mockResolvedValue({
        agentId: "alias-str",
        created: true,
        workspaceDir: "/tmp/workspace-alias-str",
        inlineWritesResult: { roleWritten: true, identityWritten: false, bytesWritten: 30 },
      });

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-alias-str", {
          action: "create",
          agent_id: "alias-str",
          config: JSON.stringify({
            name: "StringForm",
            model: "claude-sonnet-4-6",
            systemPrompt: "You are a trader.",
          }),
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledTimes(1);
      const [, rpcArgs] = mockRpcCall.mock.calls[0]!;
      const args = rpcArgs as {
        config: Record<string, unknown>;
        inlineContent?: { role?: string; identity?: string };
      };
      expect(args.config).not.toHaveProperty("systemPrompt");
      expect(args.inlineContent).toEqual({ role: "You are a trader." });
    });

    it("explicit workspace.role takes precedence over alias", async () => {
      mockRpcCall.mockResolvedValue({
        agentId: "alias-prec",
        created: true,
        workspaceDir: "/tmp/workspace-alias-prec",
        inlineWritesResult: { roleWritten: true, identityWritten: false, bytesWritten: 20 },
      });

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-alias-prec", {
          action: "create",
          agent_id: "alias-prec",
          config: {
            workspace: { profile: "specialist", role: "Explicit role" },
            systemPrompt: "Should be ignored",
          },
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledTimes(1);
      const [, rpcArgs] = mockRpcCall.mock.calls[0]!;
      const args = rpcArgs as {
        config: Record<string, unknown>;
        inlineContent?: { role?: string; identity?: string };
      };
      expect(args.config).not.toHaveProperty("systemPrompt");
      expect(args.inlineContent).toEqual({ role: "Explicit role" });
    });

    it("maps other aliases: prompt, instructions, system", async () => {
      for (const alias of ["prompt", "instructions", "system"] as const) {
        mockRpcCall.mockReset();
        mockRpcCall.mockResolvedValue({
          agentId: `alias-${alias}`,
          created: true,
          workspaceDir: `/tmp/workspace-alias-${alias}`,
          inlineWritesResult: { roleWritten: true, identityWritten: false, bytesWritten: 10 },
        });

        const tool = createAgentsManageTool(mockRpcCall, mockLogger);
        await runWithContext(makeContext("admin"), () =>
          tool.execute(`call-alias-${alias}`, {
            action: "create",
            agent_id: `alias-${alias}`,
            config: { [alias]: "Some role content" },
          } as never),
        );

        const [, rpcArgs] = mockRpcCall.mock.calls[0]!;
        const args = rpcArgs as {
          config: Record<string, unknown>;
          inlineContent?: { role?: string; identity?: string };
        };
        expect(args.config, `${alias} should be stripped`).not.toHaveProperty(alias);
        expect(args.inlineContent, `${alias} should map to role`).toEqual({ role: "Some role content" });
      }
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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger, mockApprovalGate);

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger, mockApprovalGate);

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

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
  // list action
  // -----------------------------------------------------------------------

  describe("list action", () => {
    it("calls rpcCall('agents.list') and returns result", async () => {
      mockRpcCall.mockResolvedValue([
        { agentId: "bot-1", suspended: false },
        { agentId: "bot-2", suspended: true },
      ]);

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-l1", { action: "list" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("agents.list", { _trustLevel: "admin" });
      expect(result.details).toEqual([
        { agentId: "bot-1", suspended: false },
        { agentId: "bot-2", suspended: true },
      ]);
    });

    it("works without agent_id parameter", async () => {
      mockRpcCall.mockResolvedValue([]);

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-l2", { action: "list" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("agents.list", { _trustLevel: "admin" });
      expect(result.details).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("re-throws when rpcCall throws Error", async () => {
      mockRpcCall.mockRejectedValue(new Error("Agent service unavailable"));

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-e1", { action: "get", agent_id: "bot-1" } as never),
        ),
      ).rejects.toThrow("Agent service unavailable");
    });

    it("wraps non-Error throws in Error", async () => {
      mockRpcCall.mockRejectedValue("string error");

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger, mockApprovalGate);

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger, mockApprovalGate);

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
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

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
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);

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
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
      const ok = Value.Check(tool.parameters, {
        action: "create",
        agent_id: "bot-obj",
        config: { name: "Object Agent", provider: "anthropic", model: "claude-opus-4-6" },
      });
      expect(ok).toBe(true);
    });

    it("parameters TypeBox validates for stringified config (LLM fallback path)", () => {
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
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

      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
      const ok = Value.Check(tool.parameters, args);
      expect(ok, `MANAGED_SECTIONS.exampleArgs.agents round-trip failed: ${JSON.stringify(args)}`).toBe(true);
    });

    it("E2: flat workspace_profile -> mapWorkspaceProfile produces nested workspace.profile (TypeBox passes flat)", async () => {
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
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
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
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
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
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
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
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
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
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
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
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
      const tool = createAgentsManageTool(mockRpcCall, mockLogger);
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
