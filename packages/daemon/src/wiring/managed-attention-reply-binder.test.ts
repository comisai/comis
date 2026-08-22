// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createConversationRef,
  type ManagedRunAttentionRecord,
  type ManagedRunContentPort,
  type ManagedRunOwnerScope,
  type ManagedRunRecord,
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

function attention(
  attentionId: string,
  managedRunId = "managed-run-a",
  serviceInstanceId = "service-a",
): ManagedRunAttentionRecord {
  return {
    schemaVersion: 1,
    attentionId,
    managedRunId,
    serviceInstanceId,
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

function managedRun(managedRunId: string, externalRunRef: string): ManagedRunRecord {
  return {
    managedRunId,
    externalRunRefDigest: createHash("sha256").update(externalRunRef, "utf8").digest("hex"),
  } as unknown as ManagedRunRecord;
}

function makeBinder(
  candidates: ManagedRunAttentionRecord[],
  runs: ManagedRunRecord[] = [managedRun("managed-run-a", "external-run-a")],
  configuredServiceInstanceIds: ReadonlySet<string> = new Set(["service-a"]),
) {
  const claimAttentionResponse = vi.fn(async (_scope, input) => ok({
    kind: "updated" as const,
    record: {
      ...candidates.find((item) => item.attentionId === input.attentionId)!,
      status: "response_pending" as const,
      responseRef: input.responseRef,
      updatedAtMs: input.respondedAtMs,
    },
  }));
  const getAttentionResponseByOperation = vi.fn(async () => ok(undefined));
  const getAttentionBody = vi.fn(async () => ok<Uint8Array | undefined>(undefined));
  const store = {
    getAttentionResponseByOperation,
    listOpenAttention: vi.fn(async () => ok(candidates)),
    getAttention: vi.fn(async (_scope, attentionId) => ok(
      candidates.find((item) => item.attentionId === attentionId),
    )),
    listScoped: vi.fn(async () => ok(runs)),
    claimAttentionResponse,
  } as unknown as ManagedRunStorePort;
  const contentStore = {
    putAttentionBody: vi.fn(async (_scope, responseRef, input) => ok({
      contentRef: responseRef,
      contentHash: "a".repeat(64),
      byteLength: input.body.byteLength,
    })),
    getAttentionBody,
    deleteAttentionBody: vi.fn(async () => ok(true)),
  } as unknown as ManagedRunContentPort;
  const binder = createManagedAttentionReplyBinder({
    store,
    contentStore,
    configuredServiceInstanceIds,
  });
  return {
    binder,
    store,
    contentStore,
    claimAttentionResponse,
    getAttentionResponseByOperation,
    getAttentionBody,
  };
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

  it("ignores open attention retained from an unconfigured service instance", async () => {
    const setup = makeBinder([
      attention("attention-retired", "managed-run-retired", "service-retired"),
      attention("attention-current", "managed-run-current", "service-current"),
    ], [
      managedRun("managed-run-retired", "external-run-retired"),
      managedRun("managed-run-current", "external-run-current"),
    ], new Set(["service-current"]));

    const bare = await setup.binder.bind(SCOPE, {
      operationId: "reply-current-service",
      text: "Proceed with the active request",
      respondedAtMs: 100,
    });
    const retired = await setup.binder.bind(SCOPE, {
      operationId: "reply-retired-service",
      attentionId: "attention-retired",
      text: "This must remain ordinary chat",
      respondedAtMs: 101,
    });

    expect(bare).toMatchObject({
      ok: true,
      value: { kind: "bound", attention: { attentionId: "attention-current" } },
    });
    expect(retired).toEqual(ok({
      kind: "clarification_required",
      reason: "handle_not_found",
      candidateAttentionIds: ["attention-current"],
    }));
    expect(setup.claimAttentionResponse).toHaveBeenCalledOnce();
    expect(setup.claimAttentionResponse).toHaveBeenCalledWith(SCOPE, expect.objectContaining({
      attentionId: "attention-current",
    }));
  });

  it("routes handle-qualified replies only to attention owned by that managed run", async () => {
    const runs = [
      managedRun("managed-run-a", "task-backend"),
      managedRun("managed-run-b", "task-frontend"),
    ];
    const disambiguated = makeBinder([
      attention("attention-backend", "managed-run-a"),
      attention("attention-frontend", "managed-run-b"),
    ], runs);
    const unrelated = makeBinder([attention("attention-backend", "managed-run-a")], runs);

    expect(await disambiguated.binder.bind(SCOPE, {
      operationId: "reply-qualified-backend",
      text: "task-backend use monotonic issue-N values",
      respondedAtMs: 100,
    })).toMatchObject({
      ok: true,
      value: { kind: "bound", attention: { attentionId: "attention-backend" } },
    });
    expect(await unrelated.binder.bind(SCOPE, {
      operationId: "reply-qualified-frontend",
      text: "For task-frontend, validate the committed developer edit",
      respondedAtMs: 100,
    })).toEqual(ok({ kind: "not_applicable" }));
    expect(unrelated.contentStore.putAttentionBody).not.toHaveBeenCalled();
    expect(unrelated.claimAttentionResponse).not.toHaveBeenCalled();
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

  it("replays an exact attention reply after the attention is no longer open", async () => {
    const replayResponseRef = `attention-response-${createHash("sha256")
      .update("attention-replay\0reply-operation-replay", "utf8")
      .digest("hex")
      .slice(0, 48)}`;
    const replayed = {
      ...attention("attention-replay"),
      status: "response_pending" as const,
      responseRef: replayResponseRef,
      updatedAtMs: 100,
    };
    const setup = makeBinder([replayed]);
    setup.getAttentionResponseByOperation.mockResolvedValue(ok(replayed));
    setup.getAttentionBody.mockResolvedValue(ok(new TextEncoder().encode("Proceed")));
    setup.claimAttentionResponse.mockResolvedValue(ok({
      kind: "identical_replay",
      record: replayed,
    }));

    const result = await setup.binder.bind(SCOPE, {
      operationId: "reply-operation-replay",
      text: "Proceed",
      respondedAtMs: 200,
    });

    expect(result).toEqual(ok({ kind: "bound", attention: replayed }));
    expect(setup.store.listOpenAttention).not.toHaveBeenCalled();
    expect(setup.contentStore.putAttentionBody).not.toHaveBeenCalled();
    expect(setup.contentStore.deleteAttentionBody).not.toHaveBeenCalled();
    expect(setup.claimAttentionResponse).toHaveBeenCalledWith(SCOPE, {
      attentionId: "attention-replay",
      operationId: "reply-operation-replay",
      responseRef: replayResponseRef,
      respondedAtMs: 100,
    });
  });

  it("rejects altered replay text without deleting the persisted response", async () => {
    const replayed = {
      ...attention("attention-replay-altered"),
      status: "response_pending" as const,
      responseRef: "attention-response-original",
      updatedAtMs: 100,
    };
    const setup = makeBinder([replayed]);
    setup.getAttentionResponseByOperation.mockResolvedValue(ok(replayed));
    setup.getAttentionBody.mockResolvedValue(ok(new TextEncoder().encode("Proceed")));

    const result = await setup.binder.bind(SCOPE, {
      operationId: "reply-operation-altered",
      text: "Stop",
      respondedAtMs: 200,
    });

    expect(result).toEqual(err(new Error("managed-run attention response replay conflicted")));
    expect(setup.claimAttentionResponse).not.toHaveBeenCalled();
    expect(setup.contentStore.putAttentionBody).not.toHaveBeenCalled();
    expect(setup.contentStore.deleteAttentionBody).not.toHaveBeenCalled();
  });

  it("deletes only the losing private body after a concurrent replay conflict", async () => {
    const setup = makeBinder([attention("attention-concurrent")]);
    const successfulRef = `attention-response-${createHash("sha256")
      .update("attention-concurrent\0reply-operation-concurrent", "utf8")
      .digest("hex")
      .slice(0, 48)}`;
    setup.claimAttentionResponse.mockResolvedValue(ok({ kind: "replay_conflict" }));

    const result = await setup.binder.bind(SCOPE, {
      operationId: "reply-operation-concurrent",
      attentionId: "attention-concurrent",
      text: "Proceed",
      respondedAtMs: 100,
    });

    expect(result).toEqual(err(new Error("managed-run attention response replay conflicted")));
    const publishedRef = setup.contentStore.putAttentionBody.mock.calls[0]?.[1];
    expect(publishedRef).toEqual(expect.stringMatching(/^attention-response-[a-f0-9]{48}$/));
    expect(publishedRef).not.toBe(successfulRef);
    expect(setup.contentStore.deleteAttentionBody).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      agentId: "agent-a",
      managedRunId: "managed-run-a",
    }, publishedRef);
  });
});
