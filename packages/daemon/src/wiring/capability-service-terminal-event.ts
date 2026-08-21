// SPDX-License-Identifier: Apache-2.0
import type { z } from "zod";
import {
  CapabilityTerminalEventRequestSchema,
  CapabilityTerminalEventResponseSchema,
} from "@comis/capability-service-sdk";
import { createHash } from "node:crypto";
import type {
  CapabilityServiceControlFailure,
  CapabilityServiceControlPort,
  CapabilityServiceTerminalEventAcknowledgement,
  CapabilityServiceTerminalEventCommand,
  ClockPort,
  ComisLogger,
  ManagedRunStorePort,
} from "@comis/core";
import type { ManagedTerminalEventSink } from "@comis/skills/tools";
import { err, fromPromise, ok, type Result } from "@comis/shared";

type SendControl = <T>(
  frame: unknown,
  requestSchema: z.ZodType,
  responseSchema: z.ZodType,
) => Promise<Result<T, CapabilityServiceControlFailure & { readonly step?: string }>>;

/** Send one strict instance-scoped terminal transition over an established endpoint. */
export async function sendEndpointTerminalEvent(
  command: CapabilityServiceTerminalEventCommand,
  sendControl: SendControl,
): Promise<Result<CapabilityServiceTerminalEventAcknowledgement, CapabilityServiceControlFailure>> {
  const result = await sendControl<CapabilityServiceTerminalEventAcknowledgement>({
    jsonrpc: "2.0",
    id: command.operationId,
    method: "managedRuns.terminalEvent",
    params: {
      operationId: command.operationId,
      managedRunId: command.managedRunId,
      workspaceLeaseId: command.workspaceLeaseId,
      terminalSessionId: command.terminalSessionId,
      transition: command.transition,
    },
  }, CapabilityTerminalEventRequestSchema, CapabilityTerminalEventResponseSchema);
  return result.ok ? result : err({ kind: result.error.kind, reasonCode: result.error.reasonCode });
}

/** Route a terminal transition only to its already-selected service endpoint. */
export async function forwardTerminalEvent(deps: {
  readonly command: CapabilityServiceTerminalEventCommand;
  readonly endpoint?: { terminalEvent(command: CapabilityServiceTerminalEventCommand): Promise<Result<CapabilityServiceTerminalEventAcknowledgement, CapabilityServiceControlFailure>> };
  readonly clock: ClockPort;
  readonly logger: ComisLogger;
  readonly onFailure: (failure: CapabilityServiceControlFailure) => void;
}): Promise<Result<CapabilityServiceTerminalEventAcknowledgement, CapabilityServiceControlFailure>> {
  if (deps.endpoint === undefined) return err({ kind: "unavailable", reasonCode: "instance_not_connected" });
  const startedAtMs = deps.clock.now();
  deps.logger.debug({ serviceInstanceId: deps.command.serviceInstanceId, managedRunId: deps.command.managedRunId, terminalSessionId: deps.command.terminalSessionId, transition: deps.command.transition, step: "capability-service-terminal-event" }, "Sending managed terminal transition");
  const result = await deps.endpoint.terminalEvent(deps.command);
  if (!result.ok) deps.onFailure(result.error);
  else deps.logger.info({ serviceInstanceId: deps.command.serviceInstanceId, managedRunId: deps.command.managedRunId, terminalSessionId: deps.command.terminalSessionId, transition: deps.command.transition, durationMs: Math.max(0, deps.clock.now() - startedAtMs) }, "Managed terminal transition call completed");
  return result;
}

function transitionFailureHint(
  failure: CapabilityServiceControlFailure,
  transition: CapabilityServiceTerminalEventCommand["transition"],
): string {
  if (failure.kind === "rejected") {
    return "Inspect the owning capability service task state, initiative dependencies, and worker scheduling capacity before retrying this managed terminal transition";
  }
  return transition === "exited" || transition === "released"
    ? "Check the capabilityServices socket and owning service instance; local durable retirement continues independently"
    : "Check the capabilityServices socket and owning service instance; terminal, lease, and content were preserved";
}

/** Build the content-free lifecycle bridge. Failures are observed but never trigger cleanup. */
export function createManagedTerminalEventBridge(deps: {
  readonly control: CapabilityServiceControlPort;
  readonly store: Pick<ManagedRunStorePort, "releaseTerminal">;
  readonly logger: ComisLogger;
  readonly nowMs: () => number;
}): ManagedTerminalEventSink {
  let sequence = 0;
  const notify = async (input: Parameters<ManagedTerminalEventSink["publish"]>[0]): Promise<Result<void, Error>> => {
    sequence += 1;
    const operationDigest = createHash("sha256")
      .update(`${input.managedRunId}\0${input.terminalSessionId}\0${input.transition}\0${deps.nowMs()}\0${sequence}`, "utf8")
      .digest("hex").slice(0, 32);
    const called = await fromPromise(deps.control.terminalEvent({
      operationId: `operation-terminal-${operationDigest}`,
      ...input,
    }));
    const failure: CapabilityServiceControlFailure | undefined = !called.ok
      ? { kind: "uncertain", reasonCode: "control_invocation_failed" }
      : called.value.ok ? undefined : called.value.error;
    if (failure !== undefined) {
      deps.logger.warn({
        serviceInstanceId: input.serviceInstanceId,
        managedRunId: input.managedRunId,
        terminalSessionId: input.terminalSessionId,
        transition: input.transition,
        reasonCode: failure.reasonCode,
        errorKind: failure.kind === "rejected" ? "precondition" as const : "dependency" as const,
        hint: transitionFailureHint(failure, input.transition),
      }, "Managed terminal transition delivery failed");
      return err(new Error(`managed terminal transition ${failure.kind}: ${failure.reasonCode}`));
    }
    return ok(undefined);
  };
  const retire: NonNullable<ManagedTerminalEventSink["retire"]> = async (input) => {
    await notify(input);
    const released = await fromPromise(deps.store.releaseTerminal(
        { kind: "service", serviceInstanceId: input.serviceInstanceId },
        {
          managedRunId: input.managedRunId,
          workspaceLeaseId: input.workspaceLeaseId,
          terminalSessionId: input.terminalSessionId,
          releasedAtMs: deps.nowMs(),
        },
      ));
    if (
      released.ok
      && released.value.ok
      && (released.value.value.kind === "released" || released.value.value.kind === "identical_replay")
    ) return ok(undefined);
    deps.logger.warn({
      serviceInstanceId: input.serviceInstanceId,
      managedRunId: input.managedRunId,
      terminalSessionId: input.terminalSessionId,
      errorKind: "resource" as const,
      hint: "Reconcile the exact managed run, workspace lease, and terminal binding before retrying cleanup",
    }, "Managed terminal settlement was not durably recorded");
    if (!released.ok) return err(released.error);
    if (!released.value.ok) return err(released.value.error);
    return err(new Error(`managed terminal retirement was rejected: ${released.value.value.kind}`));
  };
  return {
    publish: async (input) => {
      if (input.transition === "exited" || input.transition === "released") {
        return retire({ ...input, transition: input.transition });
      }
      return notify(input);
    },
    retire,
  };
}
