// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApprovalHandlers } from "./approval-handlers.js";
import { ConversationRefSchema, type ApprovalGate } from "@comis/core";
import type { ApprovalRequest } from "@comis/core";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const CONVERSATION_REF = ConversationRefSchema.parse(`cv_${"a".repeat(43)}`);
const OTHER_CONVERSATION_REF = ConversationRefSchema.parse(`cv_${"b".repeat(43)}`);
const AUTH_PARAMS = {
  tenant_id: "tenant-a",
  agent_id: "agent-1",
  conversation_ref: CONVERSATION_REF,
};

function makePendingRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: overrides.requestId ?? "req-001",
    shortId: overrides.shortId ?? "abc123XYZ789",
    toolName: overrides.toolName ?? "agents.restart",
    action: overrides.action ?? "agents.restart",
    params: overrides.params ?? { agentId: "bot-1" },
    agentId: overrides.agentId ?? "agent-1",
    tenantId: overrides.tenantId ?? "tenant-a",
    conversationRef: overrides.conversationRef ?? CONVERSATION_REF,
    resolvingPrincipalId: overrides.resolvingPrincipalId ?? "principal-1",
    trustLevel: overrides.trustLevel ?? "user",
    callbackOwner: overrides.callbackOwner ?? {
      tenantId: "default",
      userId: "user1",
      channelType: "discord",
      channelKey: "discord",
    },
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

      const result = await handlers["admin.approval.pending"]!(AUTH_PARAMS);

      expect(result).toEqual({ requests: [], total: 0 });
    });

    it("returns { requests: [request], total: 1 } when one request is pending", async () => {
      const req = makePendingRequest({ requestId: "req-abc" });
      mockGate = createMockApprovalGate([req]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });

      const result = (await handlers["admin.approval.pending"]!(AUTH_PARAMS)) as {
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

      const result = (await handlers["admin.approval.pending"]!(AUTH_PARAMS)) as {
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

  describe("admin.approval.resolve — approves a pending request and unblocks the tool call", () => {
    beforeEach(() => {
      const req = makePendingRequest({ requestId: "req-resolve" });
      mockGate = createMockApprovalGate([req]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });
    });

    it("approve returns success object with requestId and approved: true", async () => {
      const result = (await handlers["admin.approval.resolve"]!({
        ...AUTH_PARAMS,
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
        ...AUTH_PARAMS,
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
          ...AUTH_PARAMS,
          requestId: "req-1",
          approved: "true",
        }),
      ).rejects.toThrow("Missing required parameter: approved");
    });

    it("unknown requestId throws Error with 'not found' message", async () => {
      await expect(
        handlers["admin.approval.resolve"]!({
          ...AUTH_PARAMS,
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
        ...AUTH_PARAMS,
        requestId: "req-default",
        approved: true,
      })) as { approvedBy: string };

      expect(result.approvedBy).toBe("operator");
      expect(mockGate.resolveApproval).toHaveBeenCalledWith("req-default", true, "operator", undefined);
    });
  });

  // -------------------------------------------------------------------------
  // admin.approval.resolveAll branch coverage
  // -------------------------------------------------------------------------

  describe("admin.approval.resolveAll", () => {
    it("rejects resolveAll when approved parameter is not a boolean value per bespoke pre-zod guard", async () => {
      mockGate = createMockApprovalGate([]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });
      await expect(
        handlers["admin.approval.resolveAll"]!({}),
      ).rejects.toThrow(/Missing required parameter: approved/i);
    });

    it("resolves every pending request within the supplied conversation authority", async () => {
      const r1 = makePendingRequest({ requestId: "ra-1" });
      const r2 = makePendingRequest({ requestId: "ra-2" });
      mockGate = createMockApprovalGate([r1, r2]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });
      const result = (await handlers["admin.approval.resolveAll"]!({
        ...AUTH_PARAMS,
        approved: true,
        approvedBy: "ops",
      })) as { resolved: number; requestIds: string[] };
      expect(result.resolved).toBe(2);
      expect(result.requestIds).toEqual(["ra-1", "ra-2"]);
      expect(mockGate.resolveApproval).toHaveBeenCalledTimes(2);
    });

    it("resolves only requests matching the provided conversation authority", async () => {
      const ra = makePendingRequest({ requestId: "match-1" });
      const rb = makePendingRequest({ requestId: "miss-1", tenantId: "tenant-b", conversationRef: OTHER_CONVERSATION_REF });
      mockGate = createMockApprovalGate([ra, rb]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });
      const result = (await handlers["admin.approval.resolveAll"]!({
        ...AUTH_PARAMS,
        approved: false,
        reason: "bulk-deny",
      })) as { resolved: number; requestIds: string[] };
      expect(result.resolved).toBe(1);
      expect(result.requestIds).toEqual(["match-1"]);
      expect(mockGate.resolveApproval).toHaveBeenCalledWith("match-1", false, "operator", "bulk-deny");
      expect(mockGate.resolveApproval).not.toHaveBeenCalledWith(expect.stringContaining("miss-"), expect.anything(), expect.anything(), expect.anything());
    });

    it("returns resolved:0 and empty array when no pending requests are present in resolveAll", async () => {
      mockGate = createMockApprovalGate([]);
      handlers = createApprovalHandlers({ approvalGate: mockGate });
      const result = (await handlers["admin.approval.resolveAll"]!({
        ...AUTH_PARAMS,
        approved: true,
      })) as { resolved: number; requestIds: string[] };
      expect(result.resolved).toBe(0);
      expect(result.requestIds).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // admin.approval.clearDenialCache branch coverage
  // -------------------------------------------------------------------------

  describe("admin.approval.clearDenialCache", () => {
    it("forwards conversation authority to ApprovalGate.clearDenialCache", async () => {
      const clearDenialCache = vi.fn();
      mockGate = { ...createMockApprovalGate([]), clearDenialCache } as ApprovalGate;
      handlers = createApprovalHandlers({ approvalGate: mockGate });
      const result = (await handlers["admin.approval.clearDenialCache"]!({
        ...AUTH_PARAMS,
      })) as { cleared: true };
      expect(result.cleared).toBe(true);
      expect(clearDenialCache).toHaveBeenCalledWith({
        tenantId: "tenant-a",
        agentId: "agent-1",
        conversationRef: CONVERSATION_REF,
      });
    });

    it("rejects clearing denial cache without explicit conversation authority", async () => {
      const clearDenialCache = vi.fn();
      mockGate = { ...createMockApprovalGate([]), clearDenialCache } as ApprovalGate;
      handlers = createApprovalHandlers({ approvalGate: mockGate });
      await expect(handlers["admin.approval.clearDenialCache"]!({})).rejects.toThrow();
      expect(clearDenialCache).not.toHaveBeenCalled();
    });
  });
});
