// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type {
  ManagedTerminalBindingResolver,
  ManagedTerminalResolveOutcome,
} from "./terminal-managed-binding.js";
import type {
  CreateResult,
  SessionOwner,
  TerminalSessionRegistry,
} from "./terminal-session-registry.js";

type ManagedTerminalLaunchAuthority = Extract<
  ManagedTerminalResolveOutcome,
  { readonly kind: "resolved" }
>["binding"];

export async function reserveManagedTerminalLaunch(
  binding: ManagedTerminalBindingResolver,
  authority: ManagedTerminalLaunchAuthority,
  owner: SessionOwner,
): Promise<
  | { readonly kind: "reserved"; readonly terminalSessionId: string }
  | { readonly kind: "rejected"; readonly reason: string }
> {
  const terminalSessionId = randomUUID();
  const reserved = await binding.reserve({
    managedRunId: authority.managedRunId,
    workspaceLeaseId: authority.workspaceLeaseId,
    serviceInstanceId: authority.serviceInstanceId,
    terminalSessionId,
    owner,
  });
  return reserved.kind === "bound"
    ? { kind: "reserved", terminalSessionId }
    : { kind: "rejected", reason: reserved.reason };
}

export async function retireManagedTerminalLaunch(input: {
  readonly registry: TerminalSessionRegistry;
  readonly binding: ManagedTerminalBindingResolver;
  readonly authority: ManagedTerminalLaunchAuthority;
  readonly reservedTerminalSessionId: string;
  readonly liveTerminalSessionId?: string;
  readonly owner: SessionOwner;
}): Promise<{ readonly kind: "released" } | { readonly kind: "rejected"; readonly reason: string }> {
  if (input.liveTerminalSessionId !== undefined) {
    const terminated = await input.registry.terminateAndConfirm(
      input.liveTerminalSessionId,
      input.owner,
    );
    if (!terminated.ok) return { kind: "rejected", reason: "termination_unconfirmed" };
  }
  const released = await input.binding.release({
    managedRunId: input.authority.managedRunId,
    workspaceLeaseId: input.authority.workspaceLeaseId,
    serviceInstanceId: input.authority.serviceInstanceId,
    terminalSessionId: input.reservedTerminalSessionId,
    owner: input.owner,
  });
  return released.kind === "released"
    ? released
    : { kind: "rejected", reason: released.reason };
}

export async function retireFailedManagedTerminalLaunch(input: {
  readonly registry: TerminalSessionRegistry;
  readonly binding: ManagedTerminalBindingResolver;
  readonly authority: ManagedTerminalLaunchAuthority;
  readonly reservedTerminalSessionId: string;
  readonly owner: SessionOwner;
}) {
  return retireManagedTerminalLaunch({
    ...input,
    ...(input.registry.get(input.reservedTerminalSessionId, input.owner) === undefined
      ? {}
      : { liveTerminalSessionId: input.reservedTerminalSessionId }),
  });
}

export async function confirmManagedTerminalLaunch(input: {
  readonly registry: TerminalSessionRegistry;
  readonly binding: ManagedTerminalBindingResolver;
  readonly authority: ManagedTerminalLaunchAuthority;
  readonly reservedTerminalSessionId: string;
  readonly result: CreateResult;
  readonly owner: SessionOwner;
}): Promise<{ readonly kind: "bound" } | { readonly kind: "rejected"; readonly reason: string }> {
  const rootProcessIdentity = input.result.rootProcessIdentity;
  if (
    rootProcessIdentity === undefined
    || input.result.sessionId !== input.reservedTerminalSessionId
  ) {
    const retired = await retireManagedTerminalLaunch({
      ...input,
      liveTerminalSessionId: input.result.sessionId,
    });
    return retired.kind === "released"
      ? { kind: "rejected", reason: "terminal root identity is unavailable" }
      : retired;
  }
  const bound = await input.binding.bind({
    managedRunId: input.authority.managedRunId,
    workspaceLeaseId: input.authority.workspaceLeaseId,
    serviceInstanceId: input.authority.serviceInstanceId,
    terminalSessionId: input.result.sessionId,
    rootProcessIdentity,
    owner: input.owner,
  });
  if (bound.kind === "bound") return bound;
  const retired = await retireManagedTerminalLaunch({
    ...input,
    liveTerminalSessionId: input.result.sessionId,
  });
  return retired.kind === "released"
    ? { kind: "rejected", reason: bound.reason }
    : retired;
}
