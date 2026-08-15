// SPDX-License-Identifier: Apache-2.0
import type { ManagedRunRecord, ManagedRunStorePort } from "@comis/core";
import type { TerminalSessionRegistry } from "@comis/skills/tools";
import { err, fromPromise, ok, type Result } from "@comis/shared";

export type ManagedTerminalRevoker = (record: ManagedRunRecord) => Promise<Result<void, Error>>;

/** Terminate only live terminals whose daemon-held identity matches the durable run exactly. */
export function createManagedTerminalRevoker(
  registries: ReadonlyMap<string, TerminalSessionRegistry>,
  store: Pick<ManagedRunStorePort, "releaseTerminal">,
  nowMs: () => number,
): ManagedTerminalRevoker {
  return async (record) => {
    const registry = registries.get(record.agentId);
    if (registry === undefined) return err(new Error("managed terminal registry is unavailable"));
    const workspaceLeaseId = record.workspaceLeaseId;
    if (workspaceLeaseId === undefined) return err(new Error("managed terminal workspace lease is unavailable"));
    for (const terminalSessionId of record.terminalSessionIds) {
      const binding = registry.getManagedBinding?.(terminalSessionId);
      const owner = registry.getOwner?.(terminalSessionId);
      if (
        binding === undefined
        || owner === undefined
        || owner.agentId !== record.agentId
        || binding.managedRunId !== record.managedRunId
        || binding.workspaceLeaseId !== workspaceLeaseId
        || binding.serviceInstanceId !== record.serviceInstanceId
      ) return err(new Error("managed terminal release identity is unavailable or mismatched"));
      const terminated = await fromPromise(registry.terminateAndConfirm(terminalSessionId, owner));
      if (!terminated.ok) return err(terminated.error);
      if (!terminated.value.ok) return terminated.value;
      const released = await fromPromise(store.releaseTerminal(
        { kind: "service", serviceInstanceId: record.serviceInstanceId },
        {
          managedRunId: record.managedRunId,
          workspaceLeaseId,
          terminalSessionId,
          releasedAtMs: Math.max(record.updatedAtMs, nowMs()),
        },
      ));
      if (!released.ok) return err(released.error);
      if (!released.value.ok) return released.value;
      if (
        released.value.value.kind !== "released"
        && released.value.value.kind !== "identical_replay"
      ) return err(new Error("managed terminal binding was not durably retired"));
    }
    return ok(undefined);
  };
}
