// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import type { ManagedRunAttentionRecord, ManagedRunRecord } from "@comis/core";
import { createCapabilityServiceHandlers } from "./capability-service-handlers.js";
import type { ManagedRunOperatorContext } from "./managed-run-context.js";

const NOW_MS = 1_800_000_600_000;

function run(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    managedRunId: "managed-run-a",
    serviceInstanceId: "service-instance-a",
    status: "active",
    ...overrides,
  } as ManagedRunRecord;
}

function attention(overrides: Partial<ManagedRunAttentionRecord> = {}): ManagedRunAttentionRecord {
  return {
    attentionId: "attention-a",
    managedRunId: "managed-run-a",
    status: "open",
    externalKey: "decision-a",
    createdAtMs: 1_800_000_000_000,
    ...overrides,
  } as ManagedRunAttentionRecord;
}

function handlers(overrides: Partial<ManagedRunOperatorContext> = {}) {
  const context = {
    store: {
      getForAdministration: vi.fn(async () => ok(run())),
      listForAdministration: vi.fn(async () => ok([run(), run({ managedRunId: "managed-run-b", status: "unknown" })])),
      listAttentionForAdministration: vi.fn(async () => ok([attention()])),
    },
    cancellation: { cancel: vi.fn() },
    instances: [{
      serviceInstanceId: "service-instance-a",
      serviceDefinitionId: "example.service",
      enabled: true,
      mcpServerName: "example",
      allowedAgents: ["agent-a"],
      allowedWorkspaceRoots: ["/approved/workspaces/example"],
      allowedRuntimeRoots: ["/private/runtime/example"],
      control: { transport: "unix", socketPath: "/private/run/example.sock", credentialRef: "secret://x/y" },
    }],
    definitionScopes: () => ["health", "report"],
    instanceState: () => ({ state: "connected" as const, reasonCodes: [] }),
    heartbeatMaxAgeMs: 300_000,
    nowMs: () => NOW_MS,
    ...overrides,
  } as unknown as ManagedRunOperatorContext;
  return createCapabilityServiceHandlers({ managedRuns: context });
}

describe("capability-service operator handlers", () => {
  it("counts only the runs an operator would act on", async () => {
    const result = await handlers()["capabilityServices.list"]!({}, {} as never);

    expect(result).toMatchObject({
      total: 1,
      rows: [expect.objectContaining({
        serviceInstanceId: "service-instance-a",
        state: "connected",
        activeRunCount: 2,
        degradedRunCount: 1,
      })],
    });
  });

  it("never renders a socket path or credential reference", async () => {
    // These rows are meant to be safe to paste into a review. A support bundle
    // that carries the control socket and the secret reference is a disclosure.
    const listed = await handlers()["capabilityServices.list"]!({}, {} as never);
    const detailed = await handlers()["capabilityServices.get"]!(
      { serviceInstanceId: "service-instance-a" },
      {} as never,
    );

    for (const payload of [listed, detailed]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("secret://");
      expect(serialized).not.toContain("example.sock");
      expect(serialized).not.toContain("credentialRef");
    }
  });

  it("reports whether the host requires liveness from this instance", async () => {
    const declared = await handlers()["capabilityServices.get"]!(
      { serviceInstanceId: "service-instance-a" },
      {} as never,
    ) as { instance: { livenessRequired: boolean } };
    const undeclared = await handlers({ definitionScopes: () => ["report"] })["capabilityServices.get"]!(
      { serviceInstanceId: "service-instance-a" },
      {} as never,
    ) as { instance: { livenessRequired: boolean } };

    expect(declared.instance.livenessRequired).toBe(true);
    expect(undeclared.instance.livenessRequired).toBe(false);
  });

  it("returns nothing for an instance this deployment does not configure", async () => {
    const result = await handlers()["capabilityServices.get"]!(
      { serviceInstanceId: "service-instance-zz" },
      {} as never,
    );

    expect(result).toEqual({});
  });

  it("lists attention as identifiers and status, never the question", async () => {
    const result = await handlers()["managedAttention.list"]!(
      { managedRunId: "managed-run-a" },
      {} as never,
    ) as { rows: Record<string, unknown>[] };

    expect(result.rows[0]).toEqual({
      schemaVersion: 1,
      attentionId: "attention-a",
      managedRunId: "managed-run-a",
      status: "open",
      externalKey: "decision-a",
      createdAtMs: 1_800_000_000_000,
    });
  });
});
