// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversationRef,
  MANAGED_RUN_GROUP_MAX_MEMBERS,
  type ManagedRunOwnerScope,
  type ManagedRunRecord,
  type ManagedRunServiceScope,
} from "@comis/core";
import { ensureManagedRunTables } from "./schema-managed-runs.js";
import { createSqliteManagedRunGroupStore } from "./managed-run-group-store.js";
import { createSqliteManagedRunStore } from "./managed-run-store.js";

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

const OWNER_SCOPE: ManagedRunOwnerScope = {
  kind: "owner",
  tenantId: "tenant_a",
  agentId: "agent_a",
  principalId: "principal_a",
  conversationRef: conversationReference.value,
};
const SERVICE_SCOPE: ManagedRunServiceScope = {
  kind: "service",
  serviceInstanceId: "service-instance_a",
};
const OTHER_SERVICE_SCOPE: ManagedRunServiceScope = {
  kind: "service",
  serviceInstanceId: "service-instance_b",
};

function makeMember(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    schemaVersion: 1,
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    externalRunRefDigest: "a".repeat(64),
    activationDescriptorDigest: "d".repeat(64),
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
  };
}

function prepareInput(members: readonly ManagedRunRecord[]) {
  return {
    operationId: "operation_a",
    managedRunGroupId: "managed-run-group_a",
    serviceInstanceId: "service-instance_a",
    rootRunId: "root-run_a",
    createdAtMs: 1_800_000_000_000,
    members,
  };
}

const TWO_MEMBERS = [
  makeMember({ managedRunId: "managed-run_a" }),
  makeMember({ managedRunId: "managed-run_b", externalRunRefDigest: "e".repeat(64) }),
];

function runRowCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM managed_runs").get() as { total: number };
  return row.total;
}
function groupRowCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM managed_run_groups").get() as { total: number };
  return row.total;
}

describe("createSqliteManagedRunGroupStore grouped preparation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureManagedRunTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it("persists the group and every member in one commit", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    const created = await store.prepareGroup(prepareInput(TWO_MEMBERS));
    expect(created.ok && created.value.kind).toBe("created");
    expect(groupRowCount(db)).toBe(1);
    expect(runRowCount(db)).toBe(2);
  });

  it("shares atomic service capacity with single-run admission", async () => {
    const runStore = createSqliteManagedRunStore(db);
    const groupStore = createSqliteManagedRunGroupStore(db);
    const single = makeMember({
      managedRunId: "managed-run_single",
      managedRunGroupId: undefined,
    });
    const groupMember = makeMember({
      managedRunId: "managed-run_group-member",
      externalRunRefDigest: "e".repeat(64),
    });
    expect((await groupStore.prepareGroup(
      prepareInput([groupMember]),
      { maxActiveRuns: 0 },
    )).ok).toBe(false);

    const outcomes = await Promise.all([
      runStore.create(single, { maxActiveRuns: 1 }),
      groupStore.prepareGroup(prepareInput([groupMember]), { maxActiveRuns: 1 }),
    ]);

    expect(outcomes.map((outcome) => outcome.ok && outcome.value.kind).sort()).toEqual([
      "capacity_exceeded",
      "created",
    ]);
    expect(runRowCount(db)).toBe(1);
  });

  it("persists nothing when any member is unacceptable", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    // The second member belongs to a different service instance. The first is
    // perfectly valid, so a per-member loop would leave it committed — which is
    // exactly the half-written preparation the all-or-none rule forbids.
    const mixed = [
      makeMember({ managedRunId: "managed-run_a" }),
      makeMember({ managedRunId: "managed-run_b", serviceInstanceId: "service-instance_b" }),
    ];
    const created = await store.prepareGroup(prepareInput(mixed));
    expect(created.ok && created.value.kind).toBe("scope_mismatch");
    expect(groupRowCount(db)).toBe(0);
    expect(runRowCount(db)).toBe(0);
  });

  it("refuses a membership beyond the ratified ceiling, writing nothing", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    const tooMany = Array.from({ length: MANAGED_RUN_GROUP_MAX_MEMBERS + 1 }, (_, index) =>
      makeMember({ managedRunId: `managed-run_${String(index).padStart(3, "0")}` }));
    const created = await store.prepareGroup(prepareInput(tooMany));
    expect(created.ok && created.value.kind).toBe("membership_exceeds_ceiling");
    expect(groupRowCount(db)).toBe(0);
    expect(runRowCount(db)).toBe(0);
  });

  it("treats an identical retry under one operation id as the same preparation", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    expect((await store.prepareGroup(prepareInput(TWO_MEMBERS))).ok).toBe(true);
    const replay = await store.prepareGroup(prepareInput(TWO_MEMBERS));
    expect(replay.ok && replay.value.kind).toBe("identical_replay");
    expect(groupRowCount(db)).toBe(1);
    expect(runRowCount(db)).toBe(2);
  });

  it("refuses a differing retry that reuses one operation id", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    expect((await store.prepareGroup(prepareInput(TWO_MEMBERS))).ok).toBe(true);
    const conflicting = await store.prepareGroup(
      prepareInput([makeMember({ managedRunId: "managed-run_c" })]),
    );
    expect(conflicting.ok && conflicting.value.kind).toBe("replay_conflict");
    expect(runRowCount(db)).toBe(2);
  });

  it("derives the roll-up from member facts for the owning service", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    expect((await store.prepareGroup(prepareInput(TWO_MEMBERS))).ok).toBe(true);
    const rollup = await store.getGroup(SERVICE_SCOPE, "managed-run-group_a");
    expect(rollup.ok).toBe(true);
    if (!rollup.ok || rollup.value === undefined) throw new Error("expected a group");
    expect(rollup.value.stateCounts).toEqual({ preparing: 2 });
    expect(rollup.value.memberManagedRunIds).toEqual(["managed-run_a", "managed-run_b"]);
    expect(rollup.value.attentionCount).toBe(0);
  });

  it("resolves the same roll-up for the owning human scope", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    expect((await store.prepareGroup(prepareInput(TWO_MEMBERS))).ok).toBe(true);
    const rollup = await store.getGroup(OWNER_SCOPE, "managed-run-group_a");
    expect(rollup.ok && rollup.value?.managedRunGroupId).toBe("managed-run-group_a");
  });

  it("hides a group from a service instance that does not own it", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    expect((await store.prepareGroup(prepareInput(TWO_MEMBERS))).ok).toBe(true);
    const rollup = await store.getGroup(OTHER_SERVICE_SCOPE, "managed-run-group_a");
    expect(rollup.ok && rollup.value).toBeUndefined();
  });

  it("hides a group from a principal that does not own it", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    expect((await store.prepareGroup(prepareInput(TWO_MEMBERS))).ok).toBe(true);
    const rollup = await store.getGroup(
      { ...OWNER_SCOPE, principalId: "principal_b" },
      "managed-run-group_a",
    );
    expect(rollup.ok && rollup.value).toBeUndefined();
  });

  it("refuses a second preparation that reuses one group id", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    expect((await store.prepareGroup(prepareInput(TWO_MEMBERS))).ok).toBe(true);
    // A different operation reaching for the same group id would silently merge
    // two preparations into one membership.
    const reused = await store.prepareGroup({
      ...prepareInput([makeMember({ managedRunId: "managed-run_c" })]),
      operationId: "operation_b",
    });
    expect(reused.ok && reused.value.kind).toBe("replay_conflict");
    expect(runRowCount(db)).toBe(2);
  });

  it("refuses a member that is already a run, naming it", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    expect((await store.prepareGroup(prepareInput(TWO_MEMBERS))).ok).toBe(true);
    const overlapping = await store.prepareGroup({
      ...prepareInput([makeMember({
        managedRunId: "managed-run_a",
        managedRunGroupId: "managed-run-group_b",
      })]),
      operationId: "operation_b",
      managedRunGroupId: "managed-run-group_b",
    });
    expect(overlapping.ok && overlapping.value).toEqual({
      kind: "member_conflict",
      managedRunId: "managed-run_a",
    });
    expect(groupRowCount(db)).toBe(1);
  });

  it("refuses a member whose own record does not validate", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    // The tenant disagrees with the canonical turn scope, which the managed-run
    // record itself forbids. It is refused before any database read.
    const broken = makeMember({ managedRunId: "managed-run_a", tenantId: "tenant_b" });
    const created = await store.prepareGroup(prepareInput([broken]));
    expect(created.ok && created.value).toEqual({
      kind: "scope_mismatch",
      managedRunId: "managed-run_a",
    });
    expect(runRowCount(db)).toBe(0);
  });

  it("reports an unreadable group row rather than an empty group", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    expect((await store.prepareGroup(prepareInput(TWO_MEMBERS))).ok).toBe(true);
    db.prepare("UPDATE managed_run_groups SET created_at_ms = ? WHERE managed_run_group_id = ?")
      .run("not-a-timestamp", "managed-run-group_a");
    const rollup = await store.getGroup(SERVICE_SCOPE, "managed-run-group_a");
    // Returning `undefined` here would read as "no such group" and let a caller
    // act on a group that is actually corrupt.
    expect(rollup.ok).toBe(false);
  });

  it("reports an unreadable member row rather than a smaller group", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    expect((await store.prepareGroup(prepareInput(TWO_MEMBERS))).ok).toBe(true);
    db.prepare("UPDATE managed_runs SET turn_scope = ? WHERE managed_run_id = ?")
      .run("{not json", "managed-run_b");
    const rollup = await store.getGroup(SERVICE_SCOPE, "managed-run-group_a");
    expect(rollup.ok).toBe(false);
  });

  it("surfaces a failing database as an error, not a refusal", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    db.exec("DROP TABLE managed_run_group_operations");
    const created = await store.prepareGroup(prepareInput(TWO_MEMBERS));
    expect(created.ok).toBe(false);
  });

  it("refuses a replay whose group record has gone missing", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    expect((await store.prepareGroup(prepareInput(TWO_MEMBERS))).ok).toBe(true);
    // The operation says this preparation happened, but its group is gone. That
    // is a torn record, not a fresh preparation — replaying it as one would
    // rebuild a group the host already considers written.
    db.prepare("DELETE FROM managed_run_groups WHERE managed_run_group_id = ?")
      .run("managed-run-group_a");
    const replay = await store.prepareGroup(prepareInput(TWO_MEMBERS));
    expect(replay.ok).toBe(false);
  });

  it("returns nothing for a group that was never prepared", async () => {
    const store = createSqliteManagedRunGroupStore(db);
    const rollup = await store.getGroup(SERVICE_SCOPE, "managed-run-group_missing");
    expect(rollup.ok && rollup.value).toBeUndefined();
  });
});
