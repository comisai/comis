// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  CronAddContract,
  CronListContract,
  CronRunContract,
  CronRunsContract,
  CronResetContract,
  CronStatusContract,
  CronUpdateContract,
} from "./cron-handlers.js";

describe("strict cron wake-gate authoring contracts", () => {
  it("accepts a complete nested wake gate on cron creation", () => {
    const request = {
      name: "watcher",
      schedule: { kind: "cron" as const, expr: "*/5 * * * *", tz: "UTC" },
      payload: { kind: "agent_turn" as const, message: "Inspect the current state" },
      wakeGate: {
        script: "return input.changed === true",
        language: "js" as const,
        timeoutSeconds: 10,
      },
    };

    expect(CronAddContract.request.parse(request)).toEqual(request);
  });

  it("rejects flat wake-gate aliases and incomplete nested gates", () => {
    const base = {
      name: "watcher",
      schedule: { kind: "every" as const, everyMs: 60_000 },
      payload: { kind: "delivery" as const, text: "Status update" },
    };

    expect(() => CronAddContract.request.parse({
      ...base,
      wake_gate_script: "return true",
    })).toThrow();
    expect(() => CronAddContract.request.parse({
      ...base,
      wakeGate: { script: "return true", language: "js" },
    })).toThrow();
  });

  it("accepts replacement or removal of an update wake gate", () => {
    expect(CronUpdateContract.request.parse({
      jobId: "job-1",
      wakeGate: { script: "return false", language: "ts", timeoutSeconds: 5 },
    })).toEqual({
      jobId: "job-1",
      wakeGate: { script: "return false", language: "ts", timeoutSeconds: 5 },
    });
    expect(CronUpdateContract.request.parse({ jobName: "watcher", wakeGate: null })).toEqual({
      jobName: "watcher",
      wakeGate: null,
    });
  });
});

describe("cron operator and agent route scopes", () => {
  it("declares inventory history status and manual run as agent-reachable RPC routes", () => {
    for (const contract of [
      CronListContract,
      CronRunContract,
      CronRunsContract,
      CronStatusContract,
    ]) {
      expect(contract.scopes).toEqual(["rpc"]);
    }
  });

  it("keeps guarded reset admin-only with target-specific digest compare-and-set fields", () => {
    expect(CronResetContract.scopes).toEqual(["admin"]);
    expect(CronResetContract.request.parse({
      target: "all",
      expectedDigests: { store: "a".repeat(64), ledger: null },
      confirmed: true,
      agentId: "agent-a",
    })).toEqual({
      target: "all",
      expectedDigests: { store: "a".repeat(64), ledger: null },
      confirmed: true,
      agentId: "agent-a",
    });
    expect(() => CronResetContract.request.parse({
      target: "store",
      expectedDigests: { ledger: "b".repeat(64) },
      confirmed: true,
    })).toThrow();
    expect(() => CronResetContract.request.parse({
      target: "ledger",
      expectedDigests: { ledger: "b".repeat(64) },
      confirmed: false,
    })).toThrow();
  });

  it("accepts content-free raw authority and maintenance status", () => {
    expect(CronStatusContract.response.parse({
      state: "failed",
      configuredEnabled: true,
      running: false,
      strictAuthoritiesValid: false,
      ownershipReconciled: false,
      jobCount: 0,
      activeClaimCount: 0,
      resolvedAgentId: "agent-a",
      store: { exists: true, bytes: 42, digest: "a".repeat(64) },
      ledger: { exists: false, bytes: 0, digest: null },
      intent: { status: "invalid", digest: "c".repeat(64) },
      lastError: { code: "intent_invalid", errorKind: "validation" },
    })).toMatchObject({ state: "failed", resolvedAgentId: "agent-a" });
  });
});
