// SPDX-License-Identifier: Apache-2.0
/**
 * The host-to-service run commands sent over an established control endpoint:
 * activate, abandon, and cancel.
 *
 * Extracted from the socket host for the same reason the terminal-event sender
 * was: the host owns framing, authentication, replay, and lifecycle, and every
 * command body it also carried inline made the file harder to read for the
 * properties that actually matter there.
 *
 * Each sender narrows the transport failure to the port's own failure shape.
 * The `step` a transport attaches is deliberately dropped: it describes where
 * in the socket exchange the call stopped, which is host detail, while the
 * caller's decision only ever turns on rejected versus uncertain versus
 * unavailable.
 *
 * @module
 */
import type { z } from "zod";
import {
  CapabilityAbandonRequestSchema,
  CapabilityAbandonResponseSchema,
  CapabilityActivateRequestSchema,
  CapabilityActivateResponseSchema,
  CapabilityCancelRequestSchema,
  CapabilityCancelResponseSchema,
} from "@comis/capability-service-sdk";
import type {
  CapabilityServiceAbandonAcknowledgement,
  CapabilityServiceAbandonCommand,
  CapabilityServiceActivateAcknowledgement,
  CapabilityServiceActivateCommand,
  CapabilityServiceCancelAcknowledgement,
  CapabilityServiceCancelCommand,
  CapabilityServiceControlFailure,
} from "@comis/core";
import { err, type Result } from "@comis/shared";

export type SendControl = <T>(
  frame: unknown,
  requestSchema: z.ZodType,
  responseSchema: z.ZodType,
) => Promise<Result<T, CapabilityServiceControlFailure & { readonly step?: string }>>;

function narrow<T>(
  result: Result<T, CapabilityServiceControlFailure & { readonly step?: string }>,
): Result<T, CapabilityServiceControlFailure> {
  return result.ok ? result : err({ kind: result.error.kind, reasonCode: result.error.reasonCode });
}

/** Commit one prepared run after the host has durably bound its authority. */
export async function sendEndpointActivate(
  command: CapabilityServiceActivateCommand,
  sendControl: SendControl,
): Promise<Result<CapabilityServiceActivateAcknowledgement, CapabilityServiceControlFailure>> {
  return narrow(await sendControl<CapabilityServiceActivateAcknowledgement>({
    jsonrpc: "2.0",
    id: command.operationId,
    method: "managedRuns.activate",
    params: {
      operationId: command.operationId,
      managedRunId: command.managedRunId,
      externalRunRef: command.externalRunRef,
      registrationNonce: command.registrationNonce,
      ...(command.workspaceLeaseId === undefined ? {} : { workspaceLeaseId: command.workspaceLeaseId }),
      ...(command.executionAttachmentId === undefined
        ? {}
        : { executionAttachmentId: command.executionAttachmentId }),
      ...(command.attachmentTargetName === undefined
        ? {}
        : { attachmentTargetName: command.attachmentTargetName }),
    },
  }, CapabilityActivateRequestSchema, CapabilityActivateResponseSchema));
}

/** Reap a preparation the host could not bind, under the recorded disposition. */
export async function sendEndpointAbandon(
  command: CapabilityServiceAbandonCommand,
  sendControl: SendControl,
): Promise<Result<CapabilityServiceAbandonAcknowledgement, CapabilityServiceControlFailure>> {
  return narrow(await sendControl<CapabilityServiceAbandonAcknowledgement>({
    jsonrpc: "2.0",
    id: command.operationId,
    method: "managedRuns.abandon",
    params: {
      operationId: command.operationId,
      externalRunRef: command.externalRunRef,
      registrationNonce: command.registrationNonce,
      reason: command.reason,
      disposition: command.disposition,
    },
  }, CapabilityAbandonRequestSchema, CapabilityAbandonResponseSchema));
}

/** Ask a running service to stop one bound run; idempotent by operation ID. */
export async function sendEndpointCancel(
  command: CapabilityServiceCancelCommand,
  sendControl: SendControl,
): Promise<Result<CapabilityServiceCancelAcknowledgement, CapabilityServiceControlFailure>> {
  return narrow(await sendControl<CapabilityServiceCancelAcknowledgement>({
    jsonrpc: "2.0",
    id: command.operationId,
    method: "managedRuns.cancel",
    params: {
      operationId: command.operationId,
      managedRunId: command.managedRunId,
      reason: command.reason,
    },
  }, CapabilityCancelRequestSchema, CapabilityCancelResponseSchema));
}
