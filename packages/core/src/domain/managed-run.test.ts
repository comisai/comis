// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createConversationRef } from "./conversation-scope.js";
import {
  ManagedRunRecordSchema,
  ManagedRunStatusSchema,
  parseManagedRunRecord,
} from "./managed-run.js";

const CONVERSATION_SCOPE = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  partition: {
    kind: "endpoint-conversation-principal" as const,
    endpoint: {
      channelType: "telegram",
      channelInstanceId: "channel-instance_a",
      conversationId: "conversation_a",
      threadId: "thread_a",
      conversationKind: "direct" as const,
    },
    principalId: "principal_a",
  },
};
const conversationReference = createConversationRef(CONVERSATION_SCOPE);
if (!conversationReference.ok) throw conversationReference.error;

function makeRecord(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    externalRunRefDigest: "a".repeat(64),
    activationDescriptorRef: "activation-descriptor_a",
    tenantId: "tenant_a",
    agentId: "agent_a",
    principalId: "principal_a",
    conversationRef: conversationReference.value,
    turnScope: {
      conversation: CONVERSATION_SCOPE,
      principal: { principalId: "principal_a" },
      endpoint: CONVERSATION_SCOPE.partition.endpoint,
    },
    deliveryOrigin: {
      channelType: "telegram",
      channelId: "conversation_a",
      userId: "principal_a",
      threadId: "thread_a",
      tenantId: "tenant_a",
    },
    trustLevel: "user",
    responseLocalePolicy: {
      locale: "en",
      source: "request",
      enforceLocale: true,
    },
    workspacePolicyHash: "b".repeat(64),
    rootRunId: "root-run_a",
    initiationSource: "user_request",
    capturedAgentCapabilities: ["orch:read", "orch:web"],
    capturedToolIds: ["mcp:service_a.inspect", "web_search"],
    capturedCapabilityViewHash: "c".repeat(64),
    executionAttachmentIds: [],
    terminalSessionIds: [],
    status: "preparing",
    statusReason: "awaiting_activation",
    lastAcceptedReportSequence: 0,
    lastReducedReportSequence: 0,
    pendingContinuation: false,
    openAttentionCount: 0,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    ...overrides,
  };
}

describe("ManagedRunRecord domain authority validation", () => {
  it("accepts an exact content-free host authority record", () => {
    const result = parseManagedRunRecord(makeRecord());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.managedRunId).toBe("managed-run_a");
    expect(result.value.turnScope.endpoint.channelInstanceId).toBe("channel-instance_a");
    expect(result.value.capturedAgentCapabilities).toEqual(["orch:read", "orch:web"]);
  });

  it("rejects unknown fields and malformed opaque identifiers or hashes", () => {
    expect(parseManagedRunRecord(makeRecord({ unexpected: true })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ managedRunId: "contains spaces" })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ workspacePolicyHash: "short" })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ externalRunRefDigest: "z".repeat(64) })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ capturedCapabilityViewHash: "A".repeat(64) })).ok).toBe(false);
  });

  it("rejects tenant agent principal and conversation disagreement with the turn scope", () => {
    expect(parseManagedRunRecord(makeRecord({ tenantId: "tenant_b" })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ agentId: "agent_b" })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ principalId: "principal_b" })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ conversationRef: `cv_${"x".repeat(43)}` })).ok).toBe(false);
  });

  it("rejects delivery origins that disagree with the exact endpoint or principal", () => {
    const baseOrigin = makeRecord().deliveryOrigin as Record<string, unknown>;
    for (const deliveryOrigin of [
      { ...baseOrigin, tenantId: "tenant_b" },
      { ...baseOrigin, userId: "principal_b" },
      { ...baseOrigin, channelType: "slack" },
      { ...baseOrigin, channelId: "conversation_b" },
      { ...baseOrigin, threadId: "thread_b" },
    ]) {
      expect(parseManagedRunRecord(makeRecord({ deliveryOrigin })).ok).toBe(false);
    }
  });

  it("requires service-event provenance and forbids it on other initiation sources", () => {
    expect(parseManagedRunRecord(makeRecord({ initiationSource: "service_event" })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ ingressProfileId: "profile_a" })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ ingressEventDigest: "d".repeat(64) })).ok).toBe(false);

    expect(parseManagedRunRecord(makeRecord({
      initiationSource: "service_event",
      ingressProfileId: "profile_a",
      ingressEventDigest: "d".repeat(64),
    })).ok).toBe(true);
  });

  it("requires deterministic unique capability and tool ceilings", () => {
    expect(parseManagedRunRecord(makeRecord({
      capturedAgentCapabilities: ["orch:web", "orch:read"],
    })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({
      capturedAgentCapabilities: ["orch:read", "orch:read"],
    })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ capturedAgentCapabilities: ["admin"] })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ capturedToolIds: ["web_search", "web_search"] })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ capturedToolIds: ["web_search", "alpha_tool"] })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ capturedToolIds: ["contains spaces"] })).ok).toBe(false);
  });

  it("accepts only closed status and reason combinations", () => {
    expect(ManagedRunStatusSchema.options).toEqual([
      "preparing",
      "active",
      "waiting",
      "paused",
      "candidate_complete",
      "succeeded",
      "failed",
      "cancelled",
      "unknown",
    ]);
    expect(parseManagedRunRecord(makeRecord({ status: "running" })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ status: "active", statusReason: "awaiting_activation" })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({
      status: "active",
      statusReason: "activation_acknowledged",
      activationDescriptorRef: undefined,
    })).ok).toBe(true);
  });

  it("requires a private activation pointer only while preparing", () => {
    expect(parseManagedRunRecord(makeRecord({ activationDescriptorRef: undefined })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({
      status: "unknown",
      statusReason: "recovery_join_missing",
    })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({
      status: "unknown",
      statusReason: "recovery_join_missing",
      activationDescriptorRef: undefined,
    })).ok).toBe(true);
  });

  it("binds terminal outcomes to matching terminal states", () => {
    expect(parseManagedRunRecord(makeRecord({
      status: "succeeded",
      statusReason: "outcome_verified",
      activationDescriptorRef: undefined,
    })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({
      status: "succeeded",
      statusReason: "outcome_verified",
      activationDescriptorRef: undefined,
      terminalOutcome: { kind: "succeeded", recordedAtMs: 1_800_000_000_100 },
      updatedAtMs: 1_800_000_000_100,
    })).ok).toBe(true);
    expect(parseManagedRunRecord(makeRecord({
      status: "failed",
      statusReason: "failure_verified",
      activationDescriptorRef: undefined,
      terminalOutcome: { kind: "succeeded", recordedAtMs: 1_800_000_000_100 },
      updatedAtMs: 1_800_000_000_100,
    })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({
      terminalOutcome: { kind: "cancelled", recordedAtMs: 1_800_000_000_000 },
    })).ok).toBe(false);
  });

  it("rejects decreasing cursors impossible counters and reversed timestamps", () => {
    expect(parseManagedRunRecord(makeRecord({
      lastAcceptedReportSequence: 2,
      lastReducedReportSequence: 3,
    })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ lastAcceptedReportSequence: -1 })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ openAttentionCount: -1 })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ updatedAtMs: 1_799_999_999_999 })).ok).toBe(false);
    expect(parseManagedRunRecord(makeRecord({ lastHeartbeatAtMs: 1_800_000_000_001 })).ok).toBe(false);
  });

  it("returns a Result error instead of throwing on corrupt input", () => {
    const parsed = ManagedRunRecordSchema.safeParse(makeRecord({ status: "corrupt" }));
    const result = parseManagedRunRecord(makeRecord({ status: "corrupt" }));

    expect(parsed.success).toBe(false);
    expect(result.ok).toBe(false);
  });
});
