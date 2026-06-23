// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseDurableRunRecord, type DurableRunRecord } from "./durable-run.js";

/**
 * Local valid-record factory (AGENTS §2.5) — a fully-populated DurableRunRecord
 * the happy-path tests start from, then mutate one field to drive each
 * rejection case. The `caps` are real AgentCapability members; the spawnTree
 * defaults to the flat string[] shape.
 */
function makeValidRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    rootRunId: "root-run-abc",
    spawnTree: ["lease-1", "lease-2"],
    caps: ["orch:read", "orch:message"],
    leaseIds: ["lease-1", "lease-2"],
    budgetConsumed: 0.42,
    cronOrigin: null,
    stepIndex: 0,
    status: "running",
    lastHeartbeatAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("parseDurableRunRecord domain validation", () => {
  it("parses a fully populated valid record and returns ok with every field", () => {
    const result = parseDurableRunRecord(makeValidRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record: DurableRunRecord = result.value;
    expect(record.rootRunId).toBe("root-run-abc");
    expect(record.spawnTree).toEqual(["lease-1", "lease-2"]);
    expect(record.caps).toEqual(["orch:read", "orch:message"]);
    expect(record.leaseIds).toEqual(["lease-1", "lease-2"]);
    expect(record.budgetConsumed).toBe(0.42);
    expect(record.cronOrigin).toBeNull();
    expect(record.stepIndex).toBe(0);
    expect(record.status).toBe("running");
    expect(record.lastHeartbeatAt).toBe(1_700_000_000_000);
  });

  it("rejects an empty object because required fields are missing", () => {
    const result = parseDurableRunRecord({});
    expect(result.ok).toBe(false);
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

  it("accepts stepIndex of -1 the never-sent sentinel for a checkpointed-but-unsent run", () => {
    const result = parseDurableRunRecord(makeValidRecord({ stepIndex: -1 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stepIndex).toBe(-1);
  });

  it("rejects stepIndex of -2 because only -1 is the allowed sentinel floor below zero", () => {
    const result = parseDurableRunRecord(makeValidRecord({ stepIndex: -2 }));
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer stepIndex because the outward counter is a whole step number", () => {
    const result = parseDurableRunRecord(makeValidRecord({ stepIndex: 1.5 }));
    expect(result.ok).toBe(false);
  });

  it("accepts a flat string array spawnTree the leaseId-node shape of a flat run", () => {
    const result = parseDurableRunRecord(makeValidRecord({ spawnTree: ["lease-a", "lease-b"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.spawnTree).toEqual(["lease-a", "lease-b"]);
  });

  it("accepts a DAG object array spawnTree with nodeId status and optional runId entries", () => {
    const spawnTree = [
      { nodeId: "a", status: "completed" },
      { nodeId: "b", status: "running", runId: "r1" },
    ];
    const result = parseDurableRunRecord(makeValidRecord({ spawnTree }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.spawnTree).toEqual(spawnTree);
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
