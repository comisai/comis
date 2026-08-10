// SPDX-License-Identifier: Apache-2.0
import type { ManagedRunRecord } from "@comis/core";
import type { TerminalSessionRegistry } from "@comis/skills/tools";
import { err, fromPromise, ok, type Result } from "@comis/shared";

export type ManagedTerminalRevoker = (record: ManagedRunRecord) => Promise<Result<void, Error>>;

/** Terminate only live terminals whose daemon-held identity matches the durable run exactly. */
export function createManagedTerminalRevoker(
  registries: ReadonlyMap<string, TerminalSessionRegistry>,
): ManagedTerminalRevoker {
  return async (record) => {
    const registry = registries.get(record.agentId);
    if (registry === undefined) return err(new Error("managed terminal registry is unavailable"));
    for (const terminalSessionId of record.terminalSessionIds) {
      const binding = registry.getManagedBinding?.(terminalSessionId);
      const owner = registry.getOwner?.(terminalSessionId);
      if (
        binding === undefined
        || owner === undefined
        || owner.agentId !== record.agentId
        || binding.managedRunId !== record.managedRunId
        || binding.workspaceLeaseId !== record.workspaceLeaseId
        || binding.serviceInstanceId !== record.serviceInstanceId
      ) return err(new Error("managed terminal release identity is unavailable or mismatched"));
      const terminated = await fromPromise(registry.terminateAndConfirm(terminalSessionId, owner));
      if (!terminated.ok) return err(terminated.error);
      if (!terminated.value.ok) return terminated.value;
    }
    return ok(undefined);
  };
}
