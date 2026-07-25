// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createHeartbeatRootRegistrar } from "./heartbeat-root-registrar.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  const mintLease = vi.fn(() => ({ leaseId: "lease-a", bearer: "bearer-a" }));
  const revoke = vi.fn();
  const registerRoot = vi.fn();
  const evictRootIfIdle = vi.fn();
  const registerSecret = vi.fn();
  return {
    deps: {
      tenantId: "tenant-a",
      leaseManager: { mintLease, revoke },
      outputGuard: { registerSecret },
      boundedAutonomyHolder: { current: { registerRoot, evictRootIfIdle } },
      idFactory: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...overrides,
    } as never,
    mintLease,
    revoke,
    registerRoot,
    evictRootIfIdle,
    registerSecret,
  };
}

describe("heartbeat root registrar", () => {
  it("mints and anchors a normal heartbeat root under its isolated scheduler identity", async () => {
    const runtime = makeDeps();
    const registrar = createHeartbeatRootRegistrar(runtime.deps);

    const result = await registrar.register({
      correlationId: "heartbeat-a",
      target: { kind: "agent", agentId: "agent-a" },
      lane: "normal",
      reason: "cron",
    });

    expect(result).toEqual({
      ok: true,
      value: { rootRunId: "root-heartbeat-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    expect(runtime.mintLease).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      caps: [],
      budgetRef: "heartbeat:heartbeat-a",
      sessionKey: "tenant-a:agent:agent-a:scheduler-heartbeat-agent-a:scheduler:heartbeat:agent-a:peer:scheduler-heartbeat-agent-a",
      rootRunId: "root-heartbeat-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
    expect(runtime.registerSecret).toHaveBeenCalledWith("bearer-a");
    expect(runtime.registerRoot).toHaveBeenCalledWith(
      "root-heartbeat-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "lease-a",
      undefined,
    );
  });

  it("uses a separate root namespace for task-lane checks", async () => {
    const runtime = makeDeps();
    const result = await createHeartbeatRootRegistrar(runtime.deps).register({
      correlationId: "task-a",
      target: { kind: "agent", agentId: "agent-a" },
      lane: "task",
      reason: "task",
    });

    expect(result).toMatchObject({
      ok: true,
      value: { rootRunId: "root-task-check-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    expect(runtime.mintLease).toHaveBeenCalledWith(expect.objectContaining({
      caps: [],
      budgetRef: "task-check:task-a",
      sessionKey: expect.stringContaining("scheduler:task-check:task-a"),
      rootRunId: "root-task-check-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
  });

  it("fails closed before minting when bounded autonomy is unavailable", async () => {
    const runtime = makeDeps({ boundedAutonomyHolder: { current: undefined } });
    const result = await createHeartbeatRootRegistrar(runtime.deps).register({
      correlationId: "heartbeat-a",
      target: { kind: "agent", agentId: "agent-a" },
      lane: "normal",
      reason: "manual",
    });

    expect(result).toMatchObject({ ok: false, error: { errorKind: "precondition" } });
    expect(runtime.mintLease).not.toHaveBeenCalled();
  });

  it("revokes a partially issued lease when root anchoring fails", async () => {
    const runtime = makeDeps({
      boundedAutonomyHolder: {
        current: {
          registerRoot: vi.fn(() => { throw new Error("anchor failed"); }),
          evictRootIfIdle: vi.fn(),
        },
      },
    });
    const result = await createHeartbeatRootRegistrar(runtime.deps).register({
      correlationId: "heartbeat-a",
      target: { kind: "agent", agentId: "agent-a" },
      lane: "normal",
      reason: "manual",
    });

    expect(result).toMatchObject({ ok: false, error: { errorKind: "internal" } });
    expect(runtime.revoke).toHaveBeenCalledWith("lease-a");
  });

  it("releases the exact registered root through the shared budget owner", async () => {
    const runtime = makeDeps();
    const result = await createHeartbeatRootRegistrar(runtime.deps).release("root-heartbeat-a");

    expect(result).toEqual({ ok: true, value: undefined });
    expect(runtime.evictRootIfIdle).toHaveBeenCalledWith("root-heartbeat-a");
  });
});
