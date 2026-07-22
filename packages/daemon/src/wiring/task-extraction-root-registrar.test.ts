// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createTaskExtractionRootRegistrar } from "./task-extraction-root-registrar.js";

function setup(overrides: Record<string, unknown> = {}) {
  const mintLease = vi.fn(() => ({ leaseId: "lease-a", bearer: "bearer-a" }));
  const revoke = vi.fn();
  const registerSecret = vi.fn();
  const registerRoot = vi.fn();
  const evictRootIfIdle = vi.fn();
  const logger = { error: vi.fn() };
  const registrar = createTaskExtractionRootRegistrar({
    tenantId: "tenant-a",
    leaseManager: { mintLease, revoke },
    outputGuard: { registerSecret },
    boundedAutonomyHolder: { current: { registerRoot, evictRootIfIdle } },
    logger,
    ...overrides,
  } as never);
  return {
    registrar,
    mintLease,
    revoke,
    registerSecret,
    registerRoot,
    evictRootIfIdle,
    logger,
  };
}

describe("task extraction root registrar", () => {
  it("anchors the exact scheduler-issued extraction root with no capabilities", async () => {
    const data = setup();

    const result = await data.registrar.registerRoot({
      agentId: "agent-a",
      rootRunId: "root-task-extract-a",
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(data.mintLease).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      caps: [],
      budgetRef: "task-extraction:root-task-extract-a",
      sessionKey: "tenant-a:agent:agent-a:scheduler-task-extraction-agent-a:scheduler:task-extraction:root-task-extract-a:peer:scheduler-task-extraction-agent-a",
      rootRunId: "root-task-extract-a",
    }));
    expect(data.registerSecret).toHaveBeenCalledWith("bearer-a");
    expect(data.registerRoot).toHaveBeenCalledWith("root-task-extract-a", "lease-a", undefined);
  });

  it("rejects an invalid root before minting a lease", async () => {
    const data = setup();

    const result = await data.registrar.registerRoot({
      agentId: "agent-a",
      rootRunId: "root-session-a",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_root", errorKind: "validation" } });
    expect(data.mintLease).not.toHaveBeenCalled();
  });

  it("revokes a lease when the budget anchor cannot be registered", async () => {
    const data = setup({
      boundedAutonomyHolder: {
        current: {
          registerRoot: vi.fn(() => { throw new Error("anchor failed"); }),
          evictRootIfIdle: vi.fn(),
        },
      },
    });

    const result = await data.registrar.registerRoot({
      agentId: "agent-a",
      rootRunId: "root-task-extract-a",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "anchor_failed", errorKind: "internal" } });
    expect(data.revoke).toHaveBeenCalledWith("lease-a");
  });

  it("releases only the exact settled extraction root through the shared owner", async () => {
    const data = setup();

    const result = await data.registrar.releaseRoot("root-task-extract-a");

    expect(result).toEqual({ ok: true, value: undefined });
    expect(data.evictRootIfIdle).toHaveBeenCalledWith("root-task-extract-a");
  });
});
