// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { ManagedRunRecord } from "@comis/core";
import type { TerminalSessionRegistry } from "@comis/skills/tools";
import { ok } from "@comis/shared";
import { createManagedTerminalRevoker } from "./managed-terminal-revoker.js";

const RECORD = {
  managedRunId: "managed-run_a",
  workspaceLeaseId: "workspace-lease_a",
  serviceInstanceId: "service-instance_a",
  agentId: "agent_a",
  terminalSessionIds: ["terminal-session_a"],
} as unknown as ManagedRunRecord;

function makeRegistry(overrides: Partial<TerminalSessionRegistry> = {}): TerminalSessionRegistry {
  return {
    getManagedBinding: vi.fn(() => ({
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      serviceInstanceId: "service-instance_a",
    })),
    getOwner: vi.fn(() => ({ agentId: "agent_a", sessionKey: "session_a" })),
    terminateAndConfirm: vi.fn(async () => ok(undefined)),
    kill: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as TerminalSessionRegistry;
}

describe("managed terminal release authority", () => {
  it("kills only an exact live run lease and service binding", async () => {
    const registry = makeRegistry();
    const revoke = createManagedTerminalRevoker(new Map([["agent_a", registry]]));

    await expect(revoke(RECORD)).resolves.toEqual({ ok: true, value: undefined });
    expect(registry.terminateAndConfirm).toHaveBeenCalledWith(
      "terminal-session_a",
      { agentId: "agent_a", sessionKey: "session_a" },
    );
    expect(registry.kill).not.toHaveBeenCalled();
  });

  it("fails closed without killing a mismatched or unresolved terminal", async () => {
    const mismatched = makeRegistry({
      getManagedBinding: vi.fn(() => ({
        managedRunId: "managed-run_other",
        workspaceLeaseId: "workspace-lease_a",
        serviceInstanceId: "service-instance_a",
      })),
    });
    const revokeMismatch = createManagedTerminalRevoker(new Map([["agent_a", mismatched]]));
    const revokeMissing = createManagedTerminalRevoker(new Map());

    await expect(revokeMismatch(RECORD)).resolves.toMatchObject({ ok: false });
    await expect(revokeMissing(RECORD)).resolves.toMatchObject({ ok: false });
    expect(mismatched.terminateAndConfirm).not.toHaveBeenCalled();
  });
});
