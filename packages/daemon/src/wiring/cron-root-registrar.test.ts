// SPDX-License-Identifier: Apache-2.0
import { formatSessionKey } from "@comis/core";
import { describe, expect, it, vi } from "vitest";
import { createCronRootRegistrar, resolveCronTurnIdentity } from "./cron-root-registrar.js";

function builtInJob() {
  return {
    id: "memory-review",
    name: "Memory review",
    agentId: "agent-a",
    source: "built_in" as const,
    schedule: { kind: "every" as const, everyMs: 60_000, anchorMs: 1_800_000_000_000 },
    lifecycle: {
      status: "scheduled" as const,
      nextRunAtMs: 1_800_000_060_000,
      consecutiveDependencyErrors: 0,
    },
    payload: { kind: "internal_action" as const, action: "memory_review" as const },
  };
}

function deps() {
  const mintLease = vi.fn(() => ({ leaseId: "lease-cron", bearer: "a".repeat(48) }));
  const revoke = vi.fn(() => ({ revoked: 1 }));
  const registerRoot = vi.fn();
  const evictRootIfIdle = vi.fn();
  const registerSecret = vi.fn();
  return {
    tenantId: "tenant-a",
    leaseManager: { mintLease, revoke },
    outputGuard: { registerSecret },
    boundedAutonomyHolder: { current: { registerRoot, evictRootIfIdle } },
    logger: {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), audit: vi.fn(),
    } as never,
    _mintLease: mintLease,
    _revoke: revoke,
    _registerRoot: registerRoot,
    _evictRootIfIdle: evictRootIfIdle,
    _registerSecret: registerSecret,
  };
}

describe("cron root registrar", () => {
  it("registers the cron root against the exact synthetic job session", async () => {
    const runtimeDeps = deps();
    const registrar = createCronRootRegistrar(runtimeDeps);
    const job = builtInJob();
    const identity = resolveCronTurnIdentity("tenant-a", job);
    if (!identity.ok) throw identity.error;

    const result = await registrar.register({
      rootRunId: "root-cron-execution-a",
      executionId: "execution-a",
      job,
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(runtimeDeps._mintLease).toHaveBeenCalledWith({
      agentId: "agent-a",
      caps: [],
      budgetRef: "cron:execution-a",
      sessionKey: formatSessionKey(identity.value.displaySessionKey),
      trustLevel: "user",
      turnScope: identity.value.turnScope,
      rootRunId: "root-cron-execution-a",
    });
    expect(runtimeDeps._registerSecret).toHaveBeenCalledWith("a".repeat(48));
    expect(runtimeDeps._registerRoot).toHaveBeenCalledWith(
      "root-cron-execution-a",
      "lease-cron",
      undefined,
    );
  });

  it("fails closed before minting when bounded autonomy is not bound", async () => {
    const runtimeDeps = deps();
    runtimeDeps.boundedAutonomyHolder.current = undefined;
    const registrar = createCronRootRegistrar(runtimeDeps);

    const result = await registrar.register({
      rootRunId: "root-cron-execution-a",
      executionId: "execution-a",
      job: builtInJob(),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        errorKind: "precondition",
        message: "Bounded autonomy is not bound for cron root registration",
      },
    });
    expect(runtimeDeps._mintLease).not.toHaveBeenCalled();
  });

  it("revokes the anchor lease when root registration fails", async () => {
    const runtimeDeps = deps();
    runtimeDeps._registerRoot.mockImplementation(() => {
      throw new Error("budget unavailable");
    });
    const registrar = createCronRootRegistrar(runtimeDeps);

    const result = await registrar.register({
      rootRunId: "root-cron-execution-a",
      executionId: "execution-a",
      job: builtInJob(),
    });

    expect(result).toMatchObject({ ok: false, error: { errorKind: "internal" } });
    expect(runtimeDeps._revoke).toHaveBeenCalledWith("lease-cron");
  });

  it("evicts only an idle root at the scheduler settlement boundary", async () => {
    const runtimeDeps = deps();
    const registrar = createCronRootRegistrar(runtimeDeps);

    const result = await registrar.release("root-cron-execution-a");

    expect(result).toEqual({ ok: true, value: undefined });
    expect(runtimeDeps._evictRootIfIdle).toHaveBeenCalledWith("root-cron-execution-a");
    expect(runtimeDeps._revoke).not.toHaveBeenCalled();
  });
});
