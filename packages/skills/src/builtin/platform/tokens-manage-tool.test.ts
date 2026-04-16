import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokensManageTool } from "./tokens-manage-tool.js";
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

describe("tokens_manage tool", () => {
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
    const tool = createTokensManageTool(mockRpcCall);
    expect(tool.name).toBe("tokens_manage");
    expect(tool.label).toBe("Token Management");
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws when trust level is below admin (guest)", async () => {
      const tool = createTokensManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-1", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws when trust level is below admin (user)", async () => {
      const tool = createTokensManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-2", { action: "list" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows execution when trust level is admin", async () => {
      const tool = createTokensManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-3", { action: "list" } as never),
      );

      expect(result.details).not.toHaveProperty("error");
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // list action
  // -----------------------------------------------------------------------

  describe("list action", () => {
    it("delegates to tokens.list RPC (no approval needed)", async () => {
      mockRpcCall.mockResolvedValue({ tokens: [{ id: "tok-1", scopes: ["rpc"] }] });

      const tool = createTokensManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-l1", { action: "list" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("tokens.list", { _trustLevel: "admin" });
      expect(mockApprovalGate.requestApproval).not.toHaveBeenCalled();
      expect(result.details).toEqual(
        expect.objectContaining({ tokens: [{ id: "tok-1", scopes: ["rpc"] }] }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // create action
  // -----------------------------------------------------------------------

  describe("create action", () => {
    it("requests approval then delegates to tokens.create", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ id: "new-tok", secret: "s3cr3t", scopes: ["rpc"] });

      const tool = createTokensManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-c1", { action: "create", scopes: ["rpc"] } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "tokens_manage",
          action: "tokens.create",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("tokens.create", {
        id: undefined,
        scopes: ["rpc"],
        _trustLevel: "admin",
      });
      expect(result.details).toEqual(
        expect.objectContaining({ id: "new-tok", scopes: ["rpc"] }),
      );
    });

    it("throws denial when rejected", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "too many tokens",
      });

      const tool = createTokensManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-c2", { action: "create", scopes: ["rpc"] } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("passes token_id and scopes to RPC", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
      });
      mockRpcCall.mockResolvedValue({ id: "my-custom-id", secret: "s", scopes: ["admin", "ws"] });

      const tool = createTokensManageTool(mockRpcCall, mockApprovalGate);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-c3", {
          action: "create",
          token_id: "my-custom-id",
          scopes: ["admin", "ws"],
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("tokens.create", {
        id: "my-custom-id",
        scopes: ["admin", "ws"],
        _trustLevel: "admin",
      });
    });

    it("throws when scopes missing", async () => {
      const tool = createTokensManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-c4", { action: "create" } as never),
        ),
      ).rejects.toThrow(/\[missing_param\].*scopes/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // revoke action
  // -----------------------------------------------------------------------

  describe("revoke action", () => {
    it("requests approval then delegates to tokens.revoke", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ id: "tok-1", revoked: true });

      const tool = createTokensManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-rv1", { action: "revoke", token_id: "tok-1" } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "tokens_manage",
          action: "tokens.revoke",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("tokens.revoke", { id: "tok-1", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ id: "tok-1", revoked: true }),
      );
    });

    it("throws denial when rejected", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "critical token",
      });

      const tool = createTokensManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-rv2", { action: "revoke", token_id: "tok-1" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // rotate action
  // -----------------------------------------------------------------------

  describe("rotate action", () => {
    it("requests approval then delegates to tokens.rotate", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ oldId: "tok-1", newId: "tok-1-rotated-123", newSecret: "new-s" });

      const tool = createTokensManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-rt1", { action: "rotate", token_id: "tok-1" } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "tokens_manage",
          action: "tokens.rotate",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("tokens.rotate", { id: "tok-1", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ oldId: "tok-1", newId: "tok-1-rotated-123" }),
      );
    });

    it("throws denial when rejected", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "not during deployment",
      });

      const tool = createTokensManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-rt2", { action: "rotate", token_id: "tok-1" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // unknown action
  // -----------------------------------------------------------------------

  describe("invalid action", () => {
    it("throws [invalid_value] for unknown action", async () => {
      const tool = createTokensManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-u1", { action: "unknown_action" } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // without approval gate
  // -----------------------------------------------------------------------

  describe("without approval gate", () => {
    it("calls rpcCall directly for create when approvalGate is undefined", async () => {
      mockRpcCall.mockResolvedValue({ id: "new-tok", secret: "s", scopes: ["rpc"] });

      const tool = createTokensManageTool(mockRpcCall); // no approval gate

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-na1", { action: "create", scopes: ["rpc"] } as never),
      );

      expect(result.details).toEqual(
        expect.objectContaining({ id: "new-tok" }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("tokens.create", {
        id: undefined,
        scopes: ["rpc"],
        _trustLevel: "admin",
      });
    });
  });

  // -----------------------------------------------------------------------
  // error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("re-throws when rpcCall throws Error", async () => {
      mockRpcCall.mockRejectedValue(new Error("Token service unavailable"));

      const tool = createTokensManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-err1", { action: "list" } as never),
        ),
      ).rejects.toThrow("Token service unavailable");
    });

    it("wraps non-Error throws in Error", async () => {
      mockRpcCall.mockRejectedValue("string error");

      const tool = createTokensManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-err2", { action: "list" } as never),
        ),
      ).rejects.toThrow("string error");
    });
  });
});
