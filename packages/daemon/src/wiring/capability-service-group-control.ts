// SPDX-License-Identifier: Apache-2.0
import type {
  CapabilityServiceControlFailure,
  CapabilityServiceGroupAbandonAcknowledgement,
  CapabilityServiceGroupAbandonCommand,
  CapabilityServiceGroupActivateAcknowledgement,
  CapabilityServiceGroupActivateCommand,
  ClockPort,
  ComisLogger,
} from "@comis/core";
import { err, type Result } from "@comis/shared";

interface GroupControlEndpoint {
  activateGroup(command: CapabilityServiceGroupActivateCommand): Promise<Result<
    CapabilityServiceGroupActivateAcknowledgement,
    CapabilityServiceControlFailure
  >>;
  abandonGroup(command: CapabilityServiceGroupAbandonCommand): Promise<Result<
    CapabilityServiceGroupAbandonAcknowledgement,
    CapabilityServiceControlFailure
  >>;
}

interface GroupControlDeps {
  readonly endpoint: GroupControlEndpoint | undefined;
  readonly clock: ClockPort;
  readonly logger: ComisLogger;
  readonly onFailure: (failure: CapabilityServiceControlFailure) => void;
}

export async function forwardGroupActivate(
  deps: GroupControlDeps & { readonly command: CapabilityServiceGroupActivateCommand },
): Promise<Result<CapabilityServiceGroupActivateAcknowledgement, CapabilityServiceControlFailure>> {
  if (deps.endpoint === undefined) {
    return err({ kind: "unavailable", reasonCode: "instance_not_connected" });
  }
  const startedAtMs = deps.clock.now();
  deps.logger.debug({
    serviceInstanceId: deps.command.serviceInstanceId,
    managedRunGroupId: deps.command.managedRunGroupId,
    memberCount: deps.command.members.length,
    step: "capability-service-group-activate",
  }, "Sending capability-service group activation");
  const result = await deps.endpoint.activateGroup(deps.command);
  if (!result.ok) deps.onFailure(result.error);
  else deps.logger.info({
    serviceInstanceId: deps.command.serviceInstanceId,
    managedRunGroupId: deps.command.managedRunGroupId,
    memberCount: deps.command.members.length,
    durationMs: Math.max(0, deps.clock.now() - startedAtMs),
  }, "Capability-service group activation call completed");
  return result;
}

export async function forwardGroupAbandon(
  deps: GroupControlDeps & { readonly command: CapabilityServiceGroupAbandonCommand },
): Promise<Result<CapabilityServiceGroupAbandonAcknowledgement, CapabilityServiceControlFailure>> {
  if (deps.endpoint === undefined) {
    return err({ kind: "unavailable", reasonCode: "instance_not_connected" });
  }
  const startedAtMs = deps.clock.now();
  deps.logger.debug({
    serviceInstanceId: deps.command.serviceInstanceId,
    managedRunGroupId: deps.command.managedRunGroupId,
    step: "capability-service-group-abandon",
  }, "Sending capability-service group abandon");
  const result = await deps.endpoint.abandonGroup(deps.command);
  if (!result.ok) deps.onFailure(result.error);
  else deps.logger.info({
    serviceInstanceId: deps.command.serviceInstanceId,
    managedRunGroupId: deps.command.managedRunGroupId,
    durationMs: Math.max(0, deps.clock.now() - startedAtMs),
  }, "Capability-service group abandon call completed");
  return result;
}
