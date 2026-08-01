// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  invalidateSpawnTreeState,
  killSpawnTree,
  type SpawnTreeControlDeps,
} from "./spawn-tree-control.js";

function makeDeps(): SpawnTreeControlDeps {
  return {
    leaseManager: {
      revokeByRootRun: vi.fn().mockReturnValue({ revoked: 2 }),
    } as unknown as SpawnTreeControlDeps["leaseManager"],
    subAgentRunner: {
      killByRootRun: vi.fn().mockReturnValue({ killed: 2 }),
    },
    graphCoordinator: {
      cancelByRootRunId: vi.fn().mockReturnValue({ graphsCancelled: 1, killed: 1 }),
    },
    durableRuns: {
      invalidateForRevoke: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    } as unknown as NonNullable<SpawnTreeControlDeps["durableRuns"]>,
    revokeDurableRoot: vi.fn(),
    retireRootRunId: vi.fn().mockReturnValue(true),
    eventBus: { emit: vi.fn() },
    now: () => 123,
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as SpawnTreeControlDeps;
}

describe("spawn tree control", () => {
  it("hard-stops graph and runner children before revoking durable authority", async () => {
    const deps = makeDeps();

    await expect(killSpawnTree(deps, "root-a")).resolves.toEqual({ killed: 3 });
    expect(deps.graphCoordinator!.cancelByRootRunId).toHaveBeenCalledWith("root-a");
    expect(deps.subAgentRunner.killByRootRun).toHaveBeenCalledWith("root-a");
    expect(deps.leaseManager.revokeByRootRun).toHaveBeenCalledWith("root-a");
    expect(deps.eventBus!.emit).toHaveBeenCalledWith("autonomy:killed", {
      rootRunId: "root-a",
      killed: 3,
      timestamp: 123,
    });
  });

  it("retires in-memory root authority when durable storage is absent", async () => {
    const deps = makeDeps();
    deps.durableRuns = undefined;

    await expect(invalidateSpawnTreeState(deps, "root-b", "lease.revoke")).resolves.toBe(true);
    expect(deps.revokeDurableRoot).toHaveBeenCalledWith("root-b");
    expect(deps.retireRootRunId).toHaveBeenCalledWith("root-b");
  });
});
