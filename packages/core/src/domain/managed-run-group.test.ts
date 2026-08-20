// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createConversationRef } from "./conversation-scope.js";
import {
  MANAGED_RUN_GROUP_MAX_MEMBERS,
  deriveManagedRunGroupRollup,
  parseManagedRunGroupOperationResult,
  parseManagedRunGroupRecord,
} from "./managed-run-group.js";
import { parseManagedRunRecord, type ManagedRunRecord } from "./managed-run.js";

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
const CONVERSATION_REF = conversationReference.value;

function makeGroup(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    managedRunGroupId: "managed-run-group_a",
    serviceInstanceId: "service-instance_a",
    tenantId: "tenant_a",
    agentId: "agent_a",
    principalId: "principal_a",
    conversationRef: CONVERSATION_REF,
    rootRunId: "root-run_a",
    memberManagedRunIds: ["managed-run_a", "managed-run_b"],
    stateCounts: { preparing: 2 },
    attentionCount: 0,
    activeCustodyCount: 0,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    ...overrides,
  };
}

function makeMember(overrides: Readonly<Record<string, unknown>> = {}): ManagedRunRecord {
  const parsed = parseManagedRunRecord({
    schemaVersion: 1,
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    externalRunRefDigest: "a".repeat(64),
    activationDescriptorDigest: "d".repeat(64),
    activationDescriptorRef: "activation-descriptor_a",
    tenantId: "tenant_a",
    agentId: "agent_a",
    principalId: "principal_a",
    conversationRef: CONVERSATION_REF,
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
    traceId: "10000000-0000-4000-8000-000000000001",
    trustLevel: "user",
    responseLocalePolicy: { locale: "en", source: "request", enforceLocale: true },
    workspacePolicyHash: "b".repeat(64),
    rootRunId: "root-run_a",
    initiationSource: "user_request",
    managedRunGroupId: "managed-run-group_a",
    capturedAgentCapabilities: ["orch:read"],
    capturedToolIds: ["web_search"],
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
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

describe("ManagedRunGroupRecord host authority validation", () => {
  it("accepts a content-free same-scope group roll-up", () => {
    const result = parseManagedRunGroupRecord(makeGroup());
    expect(result.ok).toBe(true);
  });

  it("carries no domain workflow vocabulary", () => {
    // The group is an operator roll-up, not a workflow graph. Comis stores no
    // component names, dependency edges, integration order or acceptance rules.
    for (const field of ["dependsOn", "edges", "componentName", "integrationOrder", "milestone"]) {
      expect(parseManagedRunGroupRecord(makeGroup({ [field]: "x" })).ok, field).toBe(false);
    }
  });

  it("requires the member state counts to account for exactly the members", () => {
    expect(parseManagedRunGroupRecord(makeGroup({ stateCounts: { preparing: 1 } })).ok).toBe(false);
    expect(parseManagedRunGroupRecord(makeGroup({ stateCounts: { preparing: 3 } })).ok).toBe(false);
    expect(parseManagedRunGroupRecord(makeGroup({
      stateCounts: { preparing: 1, active: 1 },
    })).ok).toBe(true);
  });

  it("keeps derived counts within the membership", () => {
    expect(parseManagedRunGroupRecord(makeGroup({ attentionCount: 3 })).ok).toBe(false);
    expect(parseManagedRunGroupRecord(makeGroup({ activeCustodyCount: 3 })).ok).toBe(false);
  });

  it("requires explicit, unique, bounded membership", () => {
    expect(parseManagedRunGroupRecord(makeGroup({
      memberManagedRunIds: [], stateCounts: {},
    })).ok).toBe(false);
    expect(parseManagedRunGroupRecord(makeGroup({
      memberManagedRunIds: ["managed-run_b", "managed-run_a"],
    })).ok, "members must be sorted").toBe(false);
    expect(parseManagedRunGroupRecord(makeGroup({
      memberManagedRunIds: ["managed-run_a", "managed-run_a"],
    })).ok, "members must be unique").toBe(false);
    const tooMany = Array.from(
      { length: MANAGED_RUN_GROUP_MAX_MEMBERS + 1 },
      (_, index) => `managed-run_${String(index).padStart(3, "0")}`,
    );
    expect(parseManagedRunGroupRecord(makeGroup({
      memberManagedRunIds: tooMany,
      stateCounts: { preparing: tooMany.length },
    })).ok).toBe(false);
  });

  it("rejects an update that precedes creation", () => {
    expect(parseManagedRunGroupRecord(makeGroup({ updatedAtMs: 1_799_999_999_999 })).ok).toBe(false);
  });
});

describe("managed-run group roll-up derivation", () => {
  it("derives counts from member run facts alone", () => {
    const members = [
      makeMember({ managedRunId: "managed-run_a", status: "active", statusReason: "report_activity", activationDescriptorRef: undefined }),
      makeMember({ managedRunId: "managed-run_b", status: "waiting", statusReason: "attention_pending", activationDescriptorRef: undefined, openAttentionCount: 2 }),
    ];
    const rollup = deriveManagedRunGroupRollup({
      managedRunGroupId: "managed-run-group_a",
      serviceInstanceId: "service-instance_a",
      rootRunId: "root-run_a",
      createdAtMs: 1_800_000_000_000,
      updatedAtMs: 1_800_000_000_001,
      members,
    });
    expect(rollup.ok).toBe(true);
    if (!rollup.ok) return;
    expect(rollup.value.stateCounts).toEqual({ active: 1, waiting: 1 });
    // One member holds attention, not two — the count is members needing
    // attention, never a sum of their open requests.
    expect(rollup.value.attentionCount).toBe(1);
    expect(rollup.value.memberManagedRunIds).toEqual(["managed-run_a", "managed-run_b"]);
  });

  it("refuses members that do not share one scope", () => {
    const foreign = makeMember({ managedRunId: "managed-run_b", serviceInstanceId: "service-instance_b" });
    const rollup = deriveManagedRunGroupRollup({
      managedRunGroupId: "managed-run-group_a",
      serviceInstanceId: "service-instance_a",
      rootRunId: "root-run_a",
      createdAtMs: 1_800_000_000_000,
      updatedAtMs: 1_800_000_000_000,
      members: [makeMember(), foreign],
    });
    expect(rollup.ok).toBe(false);
  });

  it("refuses a member that claims a different group", () => {
    const stray = makeMember({ managedRunId: "managed-run_b", managedRunGroupId: "managed-run-group_b" });
    const rollup = deriveManagedRunGroupRollup({
      managedRunGroupId: "managed-run-group_a",
      serviceInstanceId: "service-instance_a",
      rootRunId: "root-run_a",
      createdAtMs: 1_800_000_000_000,
      updatedAtMs: 1_800_000_000_000,
      members: [makeMember(), stray],
    });
    expect(rollup.ok).toBe(false);
  });

  it("refuses an unbounded membership", () => {
    const members = Array.from({ length: MANAGED_RUN_GROUP_MAX_MEMBERS + 1 }, (_, index) =>
      makeMember({ managedRunId: `managed-run_${String(index).padStart(3, "0")}` }));
    const rollup = deriveManagedRunGroupRollup({
      managedRunGroupId: "managed-run-group_a",
      serviceInstanceId: "service-instance_a",
      rootRunId: "root-run_a",
      createdAtMs: 1_800_000_000_000,
      updatedAtMs: 1_800_000_000_000,
      members,
    });
    expect(rollup.ok).toBe(false);
  });
});

describe("managed-run group operation results are never falsely atomic", () => {
  const base = {
    operationId: "operation_a",
    managedRunGroupId: "managed-run-group_a",
    members: [
      { managedRunId: "managed-run_a", outcome: "completed" },
      { managedRunId: "managed-run_b", outcome: "not_attempted" },
    ],
  };

  it("reports one outcome per member, including partial activation", () => {
    const result = parseManagedRunGroupOperationResult(base);
    expect(result.ok).toBe(true);
  });

  it("admits every outcome the host can honestly report", () => {
    for (const outcome of ["completed", "rejected", "unknown", "not_attempted"]) {
      expect(parseManagedRunGroupOperationResult({
        ...base,
        members: [{ managedRunId: "managed-run_a", outcome }],
      }).ok, outcome).toBe(true);
    }
    expect(parseManagedRunGroupOperationResult({
      ...base,
      members: [{ managedRunId: "managed-run_a", outcome: "succeeded" }],
    }).ok, "no outcome outside the closed set").toBe(false);
  });

  it("refuses duplicate or unsorted member outcomes", () => {
    expect(parseManagedRunGroupOperationResult({
      ...base,
      members: [
        { managedRunId: "managed-run_b", outcome: "completed" },
        { managedRunId: "managed-run_a", outcome: "completed" },
      ],
    }).ok).toBe(false);
    expect(parseManagedRunGroupOperationResult({
      ...base,
      members: [
        { managedRunId: "managed-run_a", outcome: "completed" },
        { managedRunId: "managed-run_a", outcome: "rejected" },
      ],
    }).ok).toBe(false);
  });
});
