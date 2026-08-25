// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";

import { createTerminalSessionRetirement } from "./terminal-session-retirement.js";
import type { SessionHandle } from "./terminal-session-types.js";

function makeHandle(): SessionHandle {
  return {
    sessionId: "terminal-session_a",
    allowId: "bash",
    command: "/bin/bash",
    status: "exited",
    cols: 80,
    rows: 24,
    lastActivity: 1,
    startedAt: 1,
    owner: { agentId: "agent_a", sessionKey: "session_a" },
    durable: true,
    tmuxName: "comis-terminal-session_a",
    managedRunId: "managed-run_a",
    workspaceLeaseId: "workspace-lease_a",
    serviceInstanceId: "service-instance_a",
  };
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("terminal session durable retirement", () => {
  it("retains registry authority when detached tmux termination is unconfirmed", async () => {
    const handle = makeHandle();
    const sessions = new Map([[handle.sessionId, handle]]);
    const retireManagedSession = vi.fn(async () => ok(undefined));
    const retirement = createTerminalSessionRetirement({
      sessions,
      durability: {
        killTmuxSession: () => err(new Error("tmux still alive")),
        retireManagedSession,
      },
      cleanupWorkspace: vi.fn(),
      logger: makeLogger(),
      terminateWorker: async () => ok(undefined),
      sendWorkerKill: vi.fn(),
    });

    await expect(retirement.terminateRetireAndDropManaged(handle)).resolves.toEqual(
      err(new Error("tmux still alive")),
    );
    expect(retireManagedSession).not.toHaveBeenCalled();
    expect(sessions.get(handle.sessionId)).toBe(handle);
  });

  it("retains registry authority when durable descriptor deletion fails", async () => {
    const handle = makeHandle();
    const sessions = new Map([[handle.sessionId, handle]]);
    const retirement = createTerminalSessionRetirement({
      sessions,
      durability: {
        descriptorStore: {
          persist: () => ok(undefined),
          recover: () => [],
          remove: () => err(new Error("descriptor deletion failed")),
        },
        killTmuxSession: () => ok(undefined),
        retireManagedSession: async () => ok(undefined),
      },
      cleanupWorkspace: vi.fn(),
      logger: makeLogger(),
      terminateWorker: async () => ok(undefined),
      sendWorkerKill: vi.fn(),
    });

    await expect(retirement.terminateRetireAndDropManaged(handle)).resolves.toEqual(
      err(new Error("descriptor deletion failed")),
    );
    expect(sessions.get(handle.sessionId)).toBe(handle);
  });
});
