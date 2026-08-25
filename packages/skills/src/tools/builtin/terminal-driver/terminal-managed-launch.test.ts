// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import type { ManagedTerminalBindingResolver } from "./terminal-managed-binding.js";
import type { TerminalSessionRegistry } from "./terminal-session-registry.js";
import {
  confirmManagedTerminalLaunch,
  reserveManagedTerminalLaunch,
} from "./terminal-managed-launch.js";

const OWNER = { agentId: "agent_a", sessionKey: "session_a" };
const AUTHORITY = {
  managedRunId: "managed-run_a",
  workspaceLeaseId: "workspace-lease_a",
  serviceInstanceId: "service-instance_a",
  canonicalRoot: "/srv/comis-workspaces/run-a",
};

describe("managed terminal launch authority", () => {
  it("reserves an opaque terminal identity before creation", async () => {
    const reserve = vi.fn(async () => ({ kind: "bound" as const }));
    const binding = { reserve } as unknown as ManagedTerminalBindingResolver;

    const result = await reserveManagedTerminalLaunch(binding, AUTHORITY, OWNER);

    expect(result).toMatchObject({ kind: "reserved", terminalSessionId: expect.any(String) });
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      managedRunId: "managed-run_a",
      terminalSessionId: expect.any(String),
    }));
  });

  it("confirms termination and retires a refused launch binding", async () => {
    const terminateAndConfirm = vi.fn(async () => ok(undefined));
    const release = vi.fn(async () => ({ kind: "released" as const }));
    const binding = {
      bind: vi.fn(async () => ({ kind: "rejected" as const, reason: "release_reserved" })),
      release,
    } as unknown as ManagedTerminalBindingResolver;

    const result = await confirmManagedTerminalLaunch({
      registry: { terminateAndConfirm } as unknown as TerminalSessionRegistry,
      binding,
      authority: AUTHORITY,
      reservedTerminalSessionId: "terminal-session_a",
      result: {
        sessionId: "terminal-session_a",
        allowId: "bash",
        cols: 80,
        rows: 24,
        rootProcessIdentity: { pid: 6200, startIdentity: "linux:991" },
      },
      owner: OWNER,
    });

    expect(result).toEqual({ kind: "rejected", reason: "release_reserved" });
    expect(terminateAndConfirm).toHaveBeenCalledWith("terminal-session_a", OWNER);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({
      terminalSessionId: "terminal-session_a",
    }));
  });
});
