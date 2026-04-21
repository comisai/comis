// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSkillsManageTool } from "./skills-manage-tool.js";
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

describe("skills_manage tool", () => {
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
    const tool = createSkillsManageTool(mockRpcCall);
    expect(tool.name).toBe("skills_manage");
    expect(tool.label).toBe("Skills Management");
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws for guest trust level", async () => {
      const tool = createSkillsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-1", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws for user trust level", async () => {
      const tool = createSkillsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-2", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Scope parameter forwarding
  // -----------------------------------------------------------------------

  describe("scope parameter forwarding", () => {
    it("import action forwards scope: 'shared' to RPC call", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ imported: true });

      const tool = createSkillsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-s1", {
          action: "import",
          url: "https://github.com/org/repo/tree/main/skills/test",
          scope: "shared",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith(
        "skills.import",
        expect.objectContaining({ scope: "shared" }),
      );
    });

    it("import action defaults scope to 'local' when not provided", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ imported: true });

      const tool = createSkillsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-s2", {
          action: "import",
          url: "https://github.com/org/repo/tree/main/skills/test",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith(
        "skills.import",
        expect.objectContaining({ scope: "local" }),
      );
    });

    it("delete action forwards scope: 'shared' to RPC call", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ deleted: true });

      const tool = createSkillsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-s3", {
          action: "delete",
          name: "test-skill",
          scope: "shared",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith(
        "skills.delete",
        expect.objectContaining({ scope: "shared" }),
      );
    });

    it("delete action defaults scope to 'local' when not provided", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ deleted: true });

      const tool = createSkillsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-s4", {
          action: "delete",
          name: "test-skill",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith(
        "skills.delete",
        expect.objectContaining({ scope: "local" }),
      );
    });

    it("list action does not forward scope", async () => {
      mockRpcCall.mockResolvedValue({ skills: [], total: 0 });

      const tool = createSkillsManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-s5", { action: "list" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("skills.list", { _trustLevel: "admin" });
      // Verify no scope in the call
      const callArgs = mockRpcCall.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty("scope");
    });
  });

  // -----------------------------------------------------------------------
  // Approval gate includes scope
  // -----------------------------------------------------------------------

  describe("approval gate includes scope", () => {
    it("import approval params include scope", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ imported: true });

      const tool = createSkillsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-a1", {
          action: "import",
          url: "https://github.com/org/repo/tree/main/skills/test",
          scope: "shared",
        } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "skills_manage",
          action: "skills.import",
          params: expect.objectContaining({ scope: "shared" }),
        }),
      );
    });

    it("delete approval params include scope", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ deleted: true });

      const tool = createSkillsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-a2", {
          action: "delete",
          name: "test-skill",
          scope: "shared",
        } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "skills_manage",
          action: "skills.delete",
          params: expect.objectContaining({ scope: "shared" }),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // invalid action
  // -----------------------------------------------------------------------

  describe("invalid action", () => {
    it("throws [invalid_value] for unknown action", async () => {
      const tool = createSkillsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-inv", { action: "bogus" } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });
});
