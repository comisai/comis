// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionsManageTool } from "./sessions-manage-tool.js";
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

describe("sessions_manage tool", () => {
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
    const tool = createSessionsManageTool(mockRpcCall);
    expect(tool.name).toBe("sessions_manage");
    expect(tool.label).toBe("Session Management");
  });

  // -----------------------------------------------------------------------
  // Trust guard
  // -----------------------------------------------------------------------

  describe("trust guard", () => {
    it("throws when trust level is below admin (guest)", async () => {
      const tool = createSessionsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("guest"), () =>
          tool.execute("call-1", { action: "export", session_key: "s1" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("throws when trust level is below admin (user)", async () => {
      const tool = createSessionsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("user"), () =>
          tool.execute("call-2", { action: "export", session_key: "s1" } as never),
        ),
      ).rejects.toThrow(/Insufficient trust level/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("allows execution when trust level is admin", async () => {
      const tool = createSessionsManageTool(mockRpcCall);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-3", { action: "export", session_key: "s1" } as never),
      );

      expect(result.details).not.toHaveProperty("error");
      expect(mockRpcCall).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // delete action
  // -----------------------------------------------------------------------

  describe("delete action", () => {
    it("calls rpcCall('session.delete') after approval gate approves", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ sessionKey: "s1", deleted: true });

      const tool = createSessionsManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-d1", { action: "delete", session_key: "s1" } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "sessions_manage",
          action: "session.delete",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("session.delete", { session_key: "s1", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ sessionKey: "s1", deleted: true }),
      );
    });

    it("throws denial error when approval gate denies", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "denied by operator",
      });

      const tool = createSessionsManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-d2", { action: "delete", session_key: "s1" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("calls rpcCall without approval gate when approvalGate is undefined", async () => {
      mockRpcCall.mockResolvedValue({ sessionKey: "s1", deleted: true });

      const tool = createSessionsManageTool(mockRpcCall); // no approval gate

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-d3", { action: "delete", session_key: "s1" } as never),
      );

      expect(result.details).toEqual(
        expect.objectContaining({ sessionKey: "s1", deleted: true }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("session.delete", { session_key: "s1", _trustLevel: "admin" });
    });
  });

  // -----------------------------------------------------------------------
  // reset action
  // -----------------------------------------------------------------------

  describe("reset action", () => {
    it("calls rpcCall('session.reset') after approval gate approves", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: true,
        approvedBy: "operator",
      });
      mockRpcCall.mockResolvedValue({ sessionKey: "s1", reset: true, previousMessageCount: 5 });

      const tool = createSessionsManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-r1", { action: "reset", session_key: "s1" } as never),
      );

      expect(mockApprovalGate.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "sessions_manage",
          action: "session.reset",
        }),
      );
      expect(mockRpcCall).toHaveBeenCalledWith("session.reset", { session_key: "s1", _trustLevel: "admin" });
      expect(result.details).toEqual(
        expect.objectContaining({ sessionKey: "s1", reset: true }),
      );
    });

    it("throws denial error when approval gate denies", async () => {
      (mockApprovalGate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        approved: false,
        reason: "policy violation",
      });

      const tool = createSessionsManageTool(mockRpcCall, mockApprovalGate);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-r2", { action: "reset", session_key: "s1" } as never),
        ),
      ).rejects.toThrow(/not approved/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // export action
  // -----------------------------------------------------------------------

  describe("export action", () => {
    it("calls rpcCall('session.export') with session_key (no approval)", async () => {
      mockRpcCall.mockResolvedValue({
        sessionKey: "s1",
        messages: [],
        messageCount: 0,
      });

      const tool = createSessionsManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-e1", { action: "export", session_key: "s1" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("session.export", { session_key: "s1", _trustLevel: "admin" });
      expect(mockApprovalGate.requestApproval).not.toHaveBeenCalled();
      expect(result.details).toEqual(
        expect.objectContaining({ sessionKey: "s1" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // compact action
  // -----------------------------------------------------------------------

  describe("compact action", () => {
    it("calls rpcCall('session.compact') with session_key (no approval)", async () => {
      mockRpcCall.mockResolvedValue({
        sessionKey: "s1",
        compactionTriggered: true,
        instructions: null,
      });

      const tool = createSessionsManageTool(mockRpcCall, mockApprovalGate);

      const result = await runWithContext(makeContext("admin"), () =>
        tool.execute("call-cp1", { action: "compact", session_key: "s1" } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("session.compact", {
        session_key: "s1",
        instructions: undefined,
        _trustLevel: "admin",
      });
      expect(mockApprovalGate.requestApproval).not.toHaveBeenCalled();
      expect(result.details).toEqual(
        expect.objectContaining({ compactionTriggered: true }),
      );
    });

    it("passes instructions parameter when provided", async () => {
      mockRpcCall.mockResolvedValue({
        sessionKey: "s1",
        compactionTriggered: true,
        instructions: "Keep only summaries",
      });

      const tool = createSessionsManageTool(mockRpcCall);

      await runWithContext(makeContext("admin"), () =>
        tool.execute("call-cp2", {
          action: "compact",
          session_key: "s1",
          instructions: "Keep only summaries",
        } as never),
      );

      expect(mockRpcCall).toHaveBeenCalledWith("session.compact", {
        session_key: "s1",
        instructions: "Keep only summaries",
        _trustLevel: "admin",
      });
    });
  });

  // -----------------------------------------------------------------------
  // unknown action
  // -----------------------------------------------------------------------

  describe("invalid action", () => {
    it("throws [invalid_value] for unknown action", async () => {
      const tool = createSessionsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-u1", { action: "unknown_action", session_key: "s1" } as never),
        ),
      ).rejects.toThrow(/\[invalid_value\]/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("re-throws when rpcCall throws Error", async () => {
      mockRpcCall.mockRejectedValue(new Error("Session service unavailable"));

      const tool = createSessionsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-err1", { action: "export", session_key: "s1" } as never),
        ),
      ).rejects.toThrow("Session service unavailable");
    });

    it("wraps non-Error throws in Error", async () => {
      mockRpcCall.mockRejectedValue("string error");

      const tool = createSessionsManageTool(mockRpcCall);

      await expect(
        runWithContext(makeContext("admin"), () =>
          tool.execute("call-err2", { action: "export", session_key: "s1" } as never),
        ),
      ).rejects.toThrow("string error");
    });
  });
});
