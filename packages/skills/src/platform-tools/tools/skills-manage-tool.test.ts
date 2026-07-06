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
  // Import source schema
  // -----------------------------------------------------------------------

  describe("import source schema", () => {
    it("exposes source:'clawhub' in the import acquisition-channel union", () => {
      const tool = createSkillsManageTool(mockRpcCall);
      // The source union is the acquisition-channel enum; clawhub joins
      // github/archive/wellknown as a fourth channel (@owner/slug from ClawHub).
      const sourceSchema = JSON.stringify(
        (tool.parameters as { properties: { source: unknown } }).properties.source,
      );
      expect(sourceSchema).toContain("clawhub");
    });

    it("confirm description enumerates both warnable classes and never a flat refusal", () => {
      const tool = createSkillsManageTool(mockRpcCall);
      const confirm = (tool.parameters as { properties: { confirm: { description?: string } } }).properties
        .confirm;
      const desc = (confirm.description ?? "").toLowerCase();
      // Both warnable classes the wire contract documents must be named: the
      // pin/hash divergence AND the non-official publisher.
      expect(desc).toMatch(/hash|pin/);
      expect(desc).toContain("official");
      // Still makes clear confirm never overrides a flat collision refusal.
      expect(desc).toContain("collision");
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

    it("import action threads source + archiveUrl + confirm to skills.import and passes NO force", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ ok: true });

      const tool = createSkillsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-arch", {
          action: "import",
          source: "archive",
          archiveUrl: "https://example.com/skill.zip",
          scope: "shared",
          confirm: true,
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith(
        "skills.import",
        expect.objectContaining({
          source: "archive",
          archiveUrl: "https://example.com/skill.zip",
          scope: "shared",
          confirm: true,
        }),
      );
      // The legacy force bypass is gone from the RPC — the tool must not thread it.
      const params = mockRpcCall.mock.calls.find((c) => c[0] === "skills.import")?.[1] as Record<string, unknown>;
      expect(params).not.toHaveProperty("force");
    });

    it("import action forwards source: 'wellknown' + registry + name to skills.import", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ ok: true });

      const tool = createSkillsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-wk", {
          action: "import",
          source: "wellknown",
          registry: "https://reg.example",
          name: "my-skill",
          scope: "shared",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith(
        "skills.import",
        expect.objectContaining({
          source: "wellknown",
          registry: "https://reg.example",
          name: "my-skill",
          scope: "shared",
        }),
      );
    });

    it("import action forwards source: 'clawhub' + name (@owner/slug) to skills.import and passes NO force", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ ok: true });

      const tool = createSkillsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-ch", {
          action: "import",
          source: "clawhub",
          name: "@acme/pdf-extractor",
          scope: "shared",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith(
        "skills.import",
        expect.objectContaining({
          source: "clawhub",
          name: "@acme/pdf-extractor",
          scope: "shared",
        }),
      );
      // The daemon infers registry:"clawhub" from the source; the tool forwards
      // no registry and — like every other channel — no force. The triple gate
      // and the pre-download verdict block live behind the RPC, inherited unchanged.
      const params = mockRpcCall.mock.calls.find((c) => c[0] === "skills.import")?.[1] as Record<string, unknown>;
      expect(params).not.toHaveProperty("force");
    });

    it("import remains an approval-gated action under admin trust with the new params", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ ok: true });

      const tool = createSkillsManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-gate", {
          action: "import",
          source: "archive",
          archiveUrl: "https://example.com/skill.zip",
        } as never),
      );

      // The approval gate still fires for import (the new params do not weaken it).
      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "skills_manage", action: "skills.import" }),
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
