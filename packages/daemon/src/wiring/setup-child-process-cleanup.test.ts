// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { setupChildProcessCleanup } from "./setup-child-process-cleanup.js";

function makeBus() {
  const handlers = new Map<string, (data: never) => void>();
  return {
    on(event: string, handler: (data: never) => void) {
      handlers.set(event, handler);
      return this;
    },
    fire(event: string, data: unknown) {
      handlers.get(event)?.(data as never);
    },
  };
}

describe("setupChildProcessCleanup", () => {
  it("reaps only the child session owner after an unresolved background handoff", async () => {
    const bus = makeBus();
    const killOwned = vi.fn().mockResolvedValue(ok(2));
    setupChildProcessCleanup({
      eventBus: bus as never,
      logger: createMockLogger(),
      getRegistry: (agentId) => agentId === "agent-1" ? { killOwned } as never : undefined,
    });

    bus.fire("subagent:background_processes_abandoned", {
      runId: "run-1",
      agentId: "agent-1",
      sessionKey: "child-session",
      count: 2,
      timestamp: 10,
    });
    await Promise.resolve();

    expect(killOwned).toHaveBeenCalledOnce();
    expect(killOwned).toHaveBeenCalledWith("child-session");
  });

  it("preserves exact-owner cleanup for an explicit sub-agent kill", async () => {
    const bus = makeBus();
    const killOwned = vi.fn().mockResolvedValue(ok(1));
    setupChildProcessCleanup({
      eventBus: bus as never,
      logger: createMockLogger(),
      getRegistry: () => ({ killOwned }) as never,
    });

    bus.fire("subagent:killed", {
      runId: "run-2",
      agentId: "agent-1",
      sessionKey: "child-session-2",
      killedBy: "operator",
      runtimeMs: 20,
      timestamp: 20,
    });
    await Promise.resolve();

    expect(killOwned).toHaveBeenCalledWith("child-session-2");
  });
});
