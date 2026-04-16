import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApprovalHandlers } from "./approval-handlers.js";
import type { ApprovalGate } from "@comis/core";
import type { ApprovalRequest } from "@comis/core";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makePendingRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: overrides.requestId ?? "req-001",
    toolName: overrides.toolName ?? "agents.restart",
    action: overrides.action ?? "agents.restart",
    params: overrides.params ?? { agentId: "bot-1" },
    agentId: overrides.agentId ?? "agent-1",
    sessionKey: overrides.sessionKey ?? "default:user1:discord",
    trustLevel: overrides.trustLevel ?? "user",
    createdAt: overrides.createdAt ?? Date.now(),
    timeoutMs: overrides.timeoutMs ?? 30_000,
  };
}

function createMockApprovalGate(pendingRequests: ApprovalRequest[] = []): ApprovalGate {
  return {
    requestApproval: vi.fn(),
    resolveApproval: vi.fn(),
    pending: vi.fn(() => [...pendingRequests]),
    getRequest: vi.fn((id: string) => pendingRequests.find((r) => r.requestId === id)),
    dispose: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createApprovalHandlers", () => {
  let mockGate: ApprovalGate;
  let handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

  // -------------------------------------------------------------------------
  // admin.approval.pending
  // -------------------------------------------------------------------------

  describe("admin.approval.pending", () => {
    it("returns { requests: [], total: 0 } when no pending requests", async () => {
      mockGate = createMockApprovalGate([]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });

      const result = await handlers["admin.approval.pending"]!({});

      expect(result).toEqual({ requests: [], total: 0 });
    });

    it("returns { requests: [request], total: 1 } when one request is pending", async () => {
      const req = makePendingRequest({ requestId: "req-abc" });
      mockGate = createMockApprovalGate([req]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });

      const result = (await handlers["admin.approval.pending"]!({})) as {
        requests: ApprovalRequest[];
        total: number;
      };

      expect(result.total).toBe(1);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]!.requestId).toBe("req-abc");
    });

    it("returns all pending requests (not just first/last)", async () => {
      const req1 = makePendingRequest({ requestId: "req-1", toolName: "tool-a" });
      const req2 = makePendingRequest({ requestId: "req-2", toolName: "tool-b" });
      const req3 = makePendingRequest({ requestId: "req-3", toolName: "tool-c" });
      mockGate = createMockApprovalGate([req1, req2, req3]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });

      const result = (await handlers["admin.approval.pending"]!({})) as {
        requests: ApprovalRequest[];
        total: number;
      };

      expect(result.total).toBe(3);
      expect(result.requests).toHaveLength(3);
      expect(result.requests.map((r) => r.requestId)).toEqual(["req-1", "req-2", "req-3"]);
    });
  });

  // -------------------------------------------------------------------------
  // admin.approval.resolve -- happy path
  // -------------------------------------------------------------------------

  describe("admin.approval.resolve -- happy path", () => {
    beforeEach(() => {
      const req = makePendingRequest({ requestId: "req-resolve" });
      mockGate = createMockApprovalGate([req]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });
    });

    it("approve returns success object with requestId and approved: true", async () => {
      const result = (await handlers["admin.approval.resolve"]!({
        requestId: "req-resolve",
        approved: true,
        approvedBy: "admin",
      })) as { requestId: string; approved: boolean; approvedBy: string; reason: string | null };

      expect(result.requestId).toBe("req-resolve");
      expect(result.approved).toBe(true);
      expect(result.approvedBy).toBe("admin");
      expect(mockGate.resolveApproval).toHaveBeenCalledWith("req-resolve", true, "admin", undefined);
    });

    it("deny returns success object with reason", async () => {
      const result = (await handlers["admin.approval.resolve"]!({
        requestId: "req-resolve",
        approved: false,
        reason: "Denied",
      })) as { requestId: string; approved: boolean; reason: string | null };

      expect(result.requestId).toBe("req-resolve");
      expect(result.approved).toBe(false);
      expect(result.reason).toBe("Denied");
    });
  });

  // -------------------------------------------------------------------------
  // admin.approval.resolve -- validation
  // -------------------------------------------------------------------------

  describe("admin.approval.resolve -- validation", () => {
    beforeEach(() => {
      mockGate = createMockApprovalGate([]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });
    });

    it("missing requestId throws Error", async () => {
      await expect(
        handlers["admin.approval.resolve"]!({ approved: true }),
      ).rejects.toThrow("Missing required parameter: requestId");
    });

    it("missing approved throws Error", async () => {
      await expect(
        handlers["admin.approval.resolve"]!({ requestId: "req-1" }),
      ).rejects.toThrow("Missing required parameter: approved");
    });

    it("non-boolean approved (string 'true') throws Error", async () => {
      await expect(
        handlers["admin.approval.resolve"]!({
          requestId: "req-1",
          approved: "true",
        }),
      ).rejects.toThrow("Missing required parameter: approved");
    });

    it("unknown requestId throws Error with 'not found' message", async () => {
      await expect(
        handlers["admin.approval.resolve"]!({
          requestId: "nonexistent-id",
          approved: true,
        }),
      ).rejects.toThrow(/not found/);
    });
  });

  // -------------------------------------------------------------------------
  // admin.approval.resolve -- default approvedBy
  // -------------------------------------------------------------------------

  describe("admin.approval.resolve -- default approvedBy", () => {
    it("defaults approvedBy to 'operator' when not provided", async () => {
      const req = makePendingRequest({ requestId: "req-default" });
      mockGate = createMockApprovalGate([req]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });

      const result = (await handlers["admin.approval.resolve"]!({
        requestId: "req-default",
        approved: true,
      })) as { approvedBy: string };

      expect(result.approvedBy).toBe("operator");
      expect(mockGate.resolveApproval).toHaveBeenCalledWith("req-default", true, "operator", undefined);
    });
  });
});
