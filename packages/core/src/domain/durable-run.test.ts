// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  parseDurableGraphCheckpoint,
  parseDurableRunRecord,
  type DurableRunRecord,
} from "./durable-run.js";

/** A fully populated record that rejection tests mutate one field at a time. */
function makeValidRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    checkpointId: "checkpoint-abc",
    rootRunId: "root-run-abc",
    agentId: "agent-a",
    sessionKey: "tenant-a:user-a:chat-a",
    ownerTenantId: "tenant-a",
    ownerUserId: "user-a",
    deliveryOrigin: null,
    spawnTree: ["lease-1", "lease-2"],
    caps: ["orch:read", "orch:message"],
    leaseIds: ["lease-1", "lease-2"],
    budgetConsumed: 0.42,
    rootBudget: {
      startedAtMs: 1_699_999_990_000,
      tokensConsumed: 1200,
      usdConsumed: 0.42,
    },
    cronOrigin: null,
    trustLevel: "user",
    status: "running",
    lastHeartbeatAt: 1_700_000_000_000,
    scriptRef: null,
    checkpointRef: null,
    ...overrides,
  };
}

describe("parseDurableRunRecord domain validation", () => {
  it("parses a fully populated valid record and returns ok with every field", () => {
    const result = parseDurableRunRecord(makeValidRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record: DurableRunRecord = result.value;
    expect(record.checkpointId).toBe("checkpoint-abc");
    expect(record.rootRunId).toBe("root-run-abc");
    expect(record.agentId).toBe("agent-a");
    expect(record.sessionKey).toBe("tenant-a:user-a:chat-a");
    expect(record.spawnTree).toEqual(["lease-1", "lease-2"]);
    expect(record.caps).toEqual(["orch:read", "orch:message"]);
    expect(record.leaseIds).toEqual(["lease-1", "lease-2"]);
    expect(record.budgetConsumed).toBe(0.42);
    expect(record.rootBudget).toEqual({
      startedAtMs: 1_699_999_990_000,
      tokensConsumed: 1200,
      usdConsumed: 0.42,
    });
    expect(record.cronOrigin).toBeNull();
    expect(record.trustLevel).toBe("user");
    expect(record.status).toBe("running");
    expect(record.lastHeartbeatAt).toBe(1_700_000_000_000);
  });

  it("rejects an empty object because required fields are missing", () => {
    const result = parseDurableRunRecord({});
    expect(result.ok).toBe(false);
  });

  it.each(["guest", "user", "admin"] as const)(
    "accepts the closed %s trust level required for restart re-minting",
    (trustLevel) => {
      const result = parseDurableRunRecord(makeValidRecord({ trustLevel }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.trustLevel).toBe(trustLevel);
    },
  );

  it("rejects a checkpoint whose exact trust level is absent or outside the closed union", () => {
    const absent = makeValidRecord();
    delete absent.trustLevel;
    expect(parseDurableRunRecord(absent).ok).toBe(false);
    expect(parseDurableRunRecord(makeValidRecord({ trustLevel: "system" })).ok).toBe(false);
  });

  it("rejects a status value outside the closed running/orphaned/completed/revoked set", () => {
    const result = parseDurableRunRecord(makeValidRecord({ status: "paused" }));
    expect(result.ok).toBe(false);
  });

  it("accepts each member of the closed status set running orphaned completed revoked", () => {
    for (const status of ["running", "orphaned", "completed", "revoked"] as const) {
      const result = parseDurableRunRecord(makeValidRecord({ status }));
      expect(result.ok).toBe(true);
    }
  });

  it("rejects caps containing a string that is not a member of the AgentCapability union", () => {
    const result = parseDurableRunRecord(makeValidRecord({ caps: ["orch:read", "admin"] }));
    expect(result.ok).toBe(false);
  });

  it("rejects an extra unknown property because strictObject forbids column drift", () => {
    const result = parseDurableRunRecord(makeValidRecord({ unexpectedColumn: "drift" }));
    expect(result.ok).toBe(false);
  });

  it("rejects an empty execution checkpoint identity", () => {
    const result = parseDurableRunRecord(makeValidRecord({ checkpointId: "" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a non-canonical session identity or an empty tree identity", () => {
    expect(parseDurableRunRecord(makeValidRecord({ sessionKey: "tenant-a:user-a" })).ok).toBe(
      false,
    );
    expect(parseDurableRunRecord(makeValidRecord({ rootRunId: "" })).ok).toBe(false);
  });

  it("rejects checkpoint owner fields that disagree with the canonical session identity", () => {
    expect(
      parseDurableRunRecord(makeValidRecord({ ownerTenantId: "tenant-b" })).ok,
    ).toBe(false);
    expect(parseDurableRunRecord(makeValidRecord({ ownerUserId: "user-b" })).ok).toBe(false);
  });

  it("rejects a delivery origin whose tenant or user disagrees with the checkpoint owner", () => {
    const origin = {
      channelType: "telegram",
      channelId: "requester-chat",
      tenantId: "tenant-a",
      userId: "user-a",
    };
    expect(
      parseDurableRunRecord(
        makeValidRecord({ deliveryOrigin: { ...origin, tenantId: "tenant-b" } }),
      ).ok,
    ).toBe(false);
    expect(
      parseDurableRunRecord(
        makeValidRecord({ deliveryOrigin: { ...origin, userId: "user-b" } }),
      ).ok,
    ).toBe(false);
  });

  it("accepts a requester channel that differs from the internal sub-agent session channel", () => {
    const result = parseDurableRunRecord(
      makeValidRecord({
        sessionKey: "tenant-a:user-a:sub-agent:run-a",
        deliveryOrigin: {
          channelType: "telegram",
          channelId: "requester-chat",
          tenantId: "tenant-a",
          userId: "user-a",
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects negative or non-finite consumed budget values", () => {
    expect(parseDurableRunRecord(makeValidRecord({ budgetConsumed: -0.01 })).ok).toBe(false);
    expect(parseDurableRunRecord(makeValidRecord({ budgetConsumed: Number.POSITIVE_INFINITY })).ok)
      .toBe(false);
  });

  it("rejects a missing or invalid authoritative root budget checkpoint", () => {
    const missing = makeValidRecord();
    delete missing.rootBudget;
    expect(parseDurableRunRecord(missing).ok).toBe(false);
    expect(parseDurableRunRecord(makeValidRecord({
      rootBudget: { startedAtMs: 10, tokensConsumed: -1, usdConsumed: 0.42 },
    })).ok).toBe(false);
    expect(parseDurableRunRecord(makeValidRecord({
      rootBudget: { startedAtMs: 10, tokensConsumed: 1, usdConsumed: 0.5 },
    })).ok).toBe(false);
  });

  it("rejects a root budget anchor later than its checkpoint heartbeat", () => {
    const result = parseDurableRunRecord(makeValidRecord({
      rootBudget: {
        startedAtMs: 1_700_000_000_001,
        tokensConsumed: 1200,
        usdConsumed: 0.42,
      },
    }));

    expect(result.ok).toBe(false);
  });

  it("accepts sibling checkpoint identities under one tree root", () => {
    const first = parseDurableRunRecord(makeValidRecord({ checkpointId: "checkpoint-a" }));
    const second = parseDurableRunRecord(makeValidRecord({ checkpointId: "checkpoint-b" }));
    expect(first.ok && first.value.rootRunId).toBe("root-run-abc");
    expect(second.ok && second.value.rootRunId).toBe("root-run-abc");
  });

  it("accepts a flat string array spawnTree the leaseId-node shape of a flat run", () => {
    const result = parseDurableRunRecord(makeValidRecord({ spawnTree: ["lease-a", "lease-b"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.spawnTree).toEqual(["lease-a", "lease-b"]);
  });

  it("rejects a DAG spawnTree that omits its protected checkpoint artifact ref", () => {
    const spawnTree = [
      { nodeId: "a", status: "completed" },
      { nodeId: "b", status: "running", runId: "r1" },
    ];
    const result = parseDurableRunRecord(makeValidRecord({ spawnTree, checkpointRef: null }));
    expect(result.ok).toBe(false);
  });

  it("accepts an authoritative graph checkpoint with topology outputs retries and ledgers", () => {
    const graphCheckpoint = {
      graph: {
        nodes: [
          { nodeId: "a", task: "first", dependsOn: [], retries: 1 },
          { nodeId: "b", task: "use {{a.result}}", dependsOn: ["a"], retries: 2 },
        ],
      },
      executionOrder: ["a", "b"],
      nodes: [
        { nodeId: "a", status: "completed", output: "done", retryAttempt: 1, retriesRemaining: 0 },
        { nodeId: "b", status: "running", runId: "old-b", retryAttempt: 1, retriesRemaining: 1 },
      ],
      startedAtMs: 1_699_999_990_000,
      cumulativeTokens: 1200,
      cumulativeCost: 0.42,
      nodeCacheData: [{ nodeId: "a", cacheReadTokens: 20, cacheWriteTokens: 5 }],
      nodeTokenSpend: [{ nodeId: "a", tokens: 1200 }],
      nodeCost: [{ nodeId: "a", cost: 0.42 }],
      skippedNodesEmitted: [],
    };
    const checkpoint = parseDurableGraphCheckpoint(graphCheckpoint);
    expect(checkpoint.ok).toBe(true);
    const result = parseDurableRunRecord(makeValidRecord({
      spawnTree: [
        { nodeId: "a", status: "completed" },
        { nodeId: "b", status: "running", runId: "old-b" },
      ],
      checkpointRef: "graph-runs/checkpoint-abc/durable-checkpoint.json",
    }));
    expect(result.ok).toBe(true);
    if (!checkpoint.ok) return;
    expect(checkpoint.value).toEqual(expect.objectContaining({
      executionOrder: ["a", "b"],
      cumulativeTokens: 1200,
      cumulativeCost: 0.42,
    }));
  });

  it("rejects a graph artifact whose node states diverge from its topology", () => {
    const malformed = {
      graph: { nodes: [{ nodeId: "a", task: "first", dependsOn: [] }] },
      executionOrder: ["a"],
      nodes: [{ nodeId: "other", status: "ready" }],
      startedAtMs: 1,
      cumulativeTokens: 0,
      cumulativeCost: 0,
      nodeCacheData: [],
      nodeTokenSpend: [],
      nodeCost: [],
      skippedNodesEmitted: [],
    };
    expect(parseDurableGraphCheckpoint(malformed).ok).toBe(false);
  });

  it("rejects a malformed DAG spawnTree entry that is missing the required status field", () => {
    const result = parseDurableRunRecord(makeValidRecord({ spawnTree: [{ nodeId: "a" }] }));
    expect(result.ok).toBe(false);
  });

  it("accepts a non-null cronOrigin string for a run launched from a cron schedule", () => {
    const result = parseDurableRunRecord(makeValidRecord({ cronOrigin: "daily-digest" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cronOrigin).toBe("daily-digest");
  });
});
