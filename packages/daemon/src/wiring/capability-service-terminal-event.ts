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
import { err, fromPromise, type Result } from "@comis/shared";

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

/** Build the content-free lifecycle bridge. Failures are observed but never trigger cleanup. */
export function createManagedTerminalEventBridge(deps: {
  readonly control: CapabilityServiceControlPort;
  readonly store: Pick<ManagedRunStorePort, "releaseTerminal">;
  readonly logger: ComisLogger;
  readonly nowMs: () => number;
}): ManagedTerminalEventSink {
  let sequence = 0;
  return {
    publish: async (input) => {
      sequence += 1;
      const operationDigest = createHash("sha256")
        .update(`${input.managedRunId}\0${input.terminalSessionId}\0${input.transition}\0${deps.nowMs()}\0${sequence}`, "utf8")
        .digest("hex").slice(0, 32);
      const called = await fromPromise(deps.control.terminalEvent({
        operationId: `operation-terminal-${operationDigest}`,
        ...input,
      }));
      if (!called.ok || !called.value.ok) {
        deps.logger.warn({
          serviceInstanceId: input.serviceInstanceId,
          managedRunId: input.managedRunId,
          terminalSessionId: input.terminalSessionId,
          transition: input.transition,
          errorKind: "dependency" as const,
          hint: "Check the capabilityServices socket and owning service instance; terminal, lease, and content were preserved",
        }, "Managed terminal transition delivery failed");
        return;
      }
      if (input.transition !== "released") return;
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
        !released.ok
        || !released.value.ok
        || (released.value.value.kind !== "released" && released.value.value.kind !== "identical_replay")
      ) {
        deps.logger.warn({
          serviceInstanceId: input.serviceInstanceId,
          managedRunId: input.managedRunId,
          terminalSessionId: input.terminalSessionId,
          errorKind: "resource" as const,
          hint: "Reconcile the exact managed run, workspace lease, and terminal binding before retrying cleanup",
        }, "Managed terminal release was not durably recorded");
      }
    },
  };
}
