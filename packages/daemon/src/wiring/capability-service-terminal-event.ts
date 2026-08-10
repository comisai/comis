// SPDX-License-Identifier: Apache-2.0
import type { z } from "zod";
import {
  CapabilityTerminalEventRequestSchema,
  CapabilityTerminalEventResponseSchema,
} from "@comis/capability-service-sdk";
import type {
  CapabilityServiceControlFailure,
  CapabilityServiceTerminalEventAcknowledgement,
  CapabilityServiceTerminalEventCommand,
  ClockPort,
  ComisLogger,
} from "@comis/core";
import { err, type Result } from "@comis/shared";

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
