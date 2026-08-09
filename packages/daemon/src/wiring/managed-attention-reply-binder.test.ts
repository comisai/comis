// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  createConversationRef,
  type ManagedRunAttentionRecord,
  type ManagedRunContentPort,
  type ManagedRunOwnerScope,
  type ManagedRunStorePort,
} from "@comis/core";
import { err, ok } from "@comis/shared";
import { createManagedAttentionReplyBinder } from "./managed-attention-reply-binder.js";

const conversation = {
  tenantId: "tenant-a",
  agentId: "agent-a",
  partition: {
    kind: "endpoint-conversation-principal" as const,
    endpoint: {
      channelType: "echo",
      channelInstanceId: "echo-main",
      conversationId: "conversation-a",
      conversationKind: "direct" as const,
    },
    principalId: "user-a",
  },
};
const conversationRef = createConversationRef(conversation);
if (!conversationRef.ok) throw conversationRef.error;
const SCOPE: ManagedRunOwnerScope = {
  kind: "owner",
  tenantId: "tenant-a",
  agentId: "agent-a",
  principalId: "user-a",
  conversationRef: conversationRef.value,
};

function attention(attentionId: string): ManagedRunAttentionRecord {
  return {
    schemaVersion: 1,
    attentionId,
    managedRunId: "managed-run-a",
    serviceInstanceId: "service-a",
    tenantId: "tenant-a",
    agentId: "agent-a",
    principalId: "user-a",
    conversationRef: conversationRef.value,
    reportSequence: 1,
    attentionRef: `report-${attentionId}`,
    status: "open",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function makeBinder(candidates: ManagedRunAttentionRecord[]) {
  const claimAttentionResponse = vi.fn(async (_scope, input) => ok({
    kind: "updated" as const,
    record: {
      ...candidates.find((item) => item.attentionId === input.attentionId)!,
      status: "response_pending" as const,
      responseRef: input.responseRef,
      updatedAtMs: input.respondedAtMs,
    },
  }));
  const store = {
    listOpenAttention: vi.fn(async () => ok(candidates)),
    getAttention: vi.fn(async (_scope, attentionId) => ok(
      candidates.find((item) => item.attentionId === attentionId),
    )),
    claimAttentionResponse,
  } as unknown as ManagedRunStorePort;
  const contentStore = {
    putAttentionBody: vi.fn(async (_scope, responseRef, input) => ok({
      contentRef: responseRef,
      contentHash: "a".repeat(64),
      byteLength: input.body.byteLength,
    })),
    deleteAttentionBody: vi.fn(async () => ok(true)),
  } as unknown as ManagedRunContentPort;
  const binder = createManagedAttentionReplyBinder({ store, contentStore });
  return { binder, store, contentStore, claimAttentionResponse };
}

describe("managed attention reply binding", () => {
  it("binds an explicit handle exactly even when multiple open candidates exist", async () => {
    const setup = makeBinder([attention("attention-a"), attention("attention-b")]);

    const result = await setup.binder.bind(SCOPE, {
      operationId: "reply-operation-a",
      attentionId: "attention-b",
      text: "Approve the request",
      respondedAtMs: 100,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { kind: "bound", attention: { attentionId: "attention-b", status: "response_pending" } },
    });
    expect(setup.contentStore.putAttentionBody).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      agentId: "agent-a",
      managedRunId: "managed-run-a",
    }, expect.stringMatching(/^attention-response-[a-f0-9]{48}$/), {
      body: new TextEncoder().encode("Approve the request"),
    });
    expect(setup.claimAttentionResponse).toHaveBeenCalledWith(SCOPE, expect.objectContaining({
      attentionId: "attention-b",
      operationId: "reply-operation-a",
    }));
  });

  it("binds a bare reply only when exactly one open candidate exists", async () => {
    const single = makeBinder([attention("attention-a")]);
    const ambiguous = makeBinder([attention("attention-a"), attention("attention-b")]);
    const absent = makeBinder([]);

    expect(await single.binder.bind(SCOPE, {
      operationId: "reply-single",
      text: "Proceed",
      respondedAtMs: 100,
    })).toMatchObject({ ok: true, value: { kind: "bound", attention: { attentionId: "attention-a" } } });
    expect(await ambiguous.binder.bind(SCOPE, {
      operationId: "reply-ambiguous",
      text: "Proceed",
      respondedAtMs: 100,
    })).toEqual(ok({
      kind: "clarification_required",
      reason: "ambiguous",
      candidateAttentionIds: ["attention-a", "attention-b"],
    }));
    expect(await absent.binder.bind(SCOPE, {
      operationId: "reply-absent",
      text: "Proceed",
      respondedAtMs: 100,
    })).toEqual(ok({
      kind: "clarification_required",
      reason: "none_open",
      candidateAttentionIds: [],
    }));
    expect(ambiguous.contentStore.putAttentionBody).not.toHaveBeenCalled();
    expect(absent.claimAttentionResponse).not.toHaveBeenCalled();
  });

  it("never substitutes a missing explicit handle and removes orphaned private content", async () => {
    const missing = makeBinder([attention("attention-a")]);
    expect(await missing.binder.bind(SCOPE, {
      operationId: "reply-missing",
      attentionId: "attention-missing",
      text: "Proceed",
      respondedAtMs: 100,
    })).toEqual(ok({
      kind: "clarification_required",
      reason: "handle_not_found",
      candidateAttentionIds: ["attention-a"],
    }));
    expect(missing.claimAttentionResponse).not.toHaveBeenCalled();

    const failed = makeBinder([attention("attention-a")]);
    failed.claimAttentionResponse.mockResolvedValueOnce(err(new Error("store unavailable")));
    const result = await failed.binder.bind(SCOPE, {
      operationId: "reply-failed",
      attentionId: "attention-a",
      text: "Proceed",
      respondedAtMs: 100,
    });
    expect(result).toEqual(err(new Error("store unavailable")));
    expect(failed.contentStore.deleteAttentionBody).toHaveBeenCalledOnce();
  });
});
