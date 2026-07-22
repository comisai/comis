// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import { createConversationLocator } from "@comis/core";
import { deliverGovernedGraphAnnouncement } from "./graph-announcement-delivery.js";

function params() {
  const locator = createConversationLocator({
    tenantId: "tenant",
    agentId: "agent-1",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: {
        channelType: "telegram",
        channelInstanceId: "test-instance",
        conversationId: "chat-1",
        conversationKind: "direct",
      },
      principalId: "user",
    },
  });
  if (!locator.ok) throw locator.error;
  return {
    graphId: "graph-1",
    agentId: "agent-1",
    callerSessionKey: "tenant:user:chat-1",
    callerConversation: locator.value,
    destinationEndpoint: locator.value.conversationScope.partition.kind === "endpoint-conversation-principal"
      ? locator.value.conversationScope.partition.endpoint
      : undefined,
    channelType: "telegram",
    channelId: "chat-1",
    text: "Graph complete",
  };
}

function logger() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe("governed graph announcement delivery", () => {
  it("settles only after the receipt-backed send commits", async () => {
    let commit = (): void => {};
    const commitGate = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const send = vi.fn(async () => {
      await commitGate;
      return ok({
        delivered: true as const,
        identity: { agentId: "agent-1", rootRunId: "root-1", stepIndex: 3 },
      });
    });
    let settled = false;
    const delivery = deliverGovernedGraphAnnouncement({ send, logger: logger() }, params())
      .then((result) => {
        settled = true;
        return result;
      });

    await Promise.resolve();
    expect(settled).toBe(false);
    commit();
    await expect(delivery).resolves.toEqual(ok("committed"));
    expect(settled).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it("surfaces a false adapter outcome without a second send", async () => {
    const log = logger();
    const send = vi.fn(async () => ok({
      delivered: false as const,
      failure: "transport_rejected" as const,
      identity: { agentId: "agent-1", rootRunId: "root-1", stepIndex: 3 },
    }));

    const result = await deliverGovernedGraphAnnouncement({ send, logger: log }, params());

    expect(send).toHaveBeenCalledOnce();
    expect(result).toEqual(ok("retained"));
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ failure: "transport_rejected", hint: expect.any(String) }),
      "Graph announcement was not receipt-committed",
    );
  });

  it("keeps a lost boundary response content-safe and does not retry", async () => {
    const log = logger();
    const send = vi.fn(async () => err(new Error("token=PRIVATE_GRAPH_TOKEN")));

    const result = await deliverGovernedGraphAnnouncement({ send, logger: log }, params());

    expect(send).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("PRIVATE_GRAPH_TOKEN");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency", hint: expect.any(String) }),
      "Graph governed announcement boundary failed",
    );
  });

  it("keeps the completion resumable when authenticated identity is missing", async () => {
    const send = vi.fn();
    const missingIdentity = {
      graphId: "graph-1",
      callerSessionKey: "tenant:user:chat-1",
      channelType: "telegram",
      channelId: "chat-1",
      text: "Graph complete",
    };

    const result = await deliverGovernedGraphAnnouncement(
      { send, logger: logger() },
      missingIdentity,
    );

    expect(result.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "allocation_blocked",
    "operation_validation_blocked",
    "lookup_blocked",
    "operation_mismatch",
    "begin_blocked",
  ] as const)("does not settle %s without retained operation evidence", async (failure) => {
    const send = vi.fn(async () => ok({
      delivered: false as const,
      identity: { agentId: "agent-1", rootRunId: "root-1", stepIndex: 3 },
      failure,
    }));

    const result = await deliverGovernedGraphAnnouncement(
      { send, logger: logger() },
      params(),
    );

    expect(result.ok).toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    "operation_retained",
    "uncertainty_transition_blocked",
    "transport_failed",
    "transport_rejected",
    "platform_receipt_missing",
    "commit_blocked",
  ] as const)("settles proven retained outcome %s", async (failure) => {
    const send = vi.fn(async () => ok({
      delivered: false as const,
      identity: { agentId: "agent-1", rootRunId: "root-1", stepIndex: 3 },
      failure,
    }));

    const result = await deliverGovernedGraphAnnouncement(
      { send, logger: logger() },
      params(),
    );

    expect(result).toEqual(ok("retained"));
    expect(send).toHaveBeenCalledOnce();
  });
});
