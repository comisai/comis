// SPDX-License-Identifier: Apache-2.0

import {
  conversationScopeToSessionKey,
  formatSessionKey,
  verifyWorkspacePolicySnapshot,
  type ComisLogger,
  type ManagedRunRecord,
  type NormalizedMessage,
  type WorkspacePolicySnapshot,
} from "@comis/core";
import {
  createContinuationRequestContext,
  type ContinuationExecutionEngine,
  type ContinuationExecutionHooks,
  type ContinuationExecutionOutcome,
} from "@comis/agent";
import { err, type Result } from "@comis/shared";

export interface ManagedRunContinuationCallerDeps {
  readonly engine: ContinuationExecutionEngine;
  readonly resolveWorkspacePolicy: (
    agentId: string,
    policyHash: string,
  ) => Promise<Result<WorkspacePolicySnapshot, Error>>;
  readonly logger: ComisLogger;
}

export interface ManagedRunContinuationCall<TFinalized> {
  readonly record: ManagedRunRecord;
  readonly claimId: string;
  readonly triggeringSequence: number;
  readonly announcement: string;
  readonly hooks: ContinuationExecutionHooks<TFinalized>;
}

export interface ManagedRunContinuationCaller {
  execute<TFinalized>(
    input: ManagedRunContinuationCall<TFinalized>,
  ): Promise<Result<ContinuationExecutionOutcome<TFinalized>, Error>>;
}

/** Re-enter the exact managed-run conversation through the shared continuation engine. */
export function createManagedRunContinuationCaller(
  deps: ManagedRunContinuationCallerDeps,
): ManagedRunContinuationCaller {
  const log = deps.logger.child({ submodule: "managed-run-continuation-caller" });
  return Object.freeze({
    execute: async <TFinalized>(input: ManagedRunContinuationCall<TFinalized>) => {
      const policy = await deps.resolveWorkspacePolicy(
        input.record.agentId,
        input.record.workspacePolicyHash,
      );
      if (!policy.ok) return policy;
      if (
        !verifyWorkspacePolicySnapshot(policy.value).ok
        || policy.value.agentId !== input.record.agentId
        || policy.value.combinedHash !== input.record.workspacePolicyHash
      ) {
        return err(new Error("Managed-run workspace policy does not match recorded authority"));
      }
      const projected = conversationScopeToSessionKey(input.record.turnScope.conversation);
      if (!projected.ok) return err(new Error(projected.error.message));
      const requestContext = createContinuationRequestContext(
        input.record,
        projected.value,
        input.record.workspacePolicyHash,
      );
      if (!requestContext.ok) return requestContext;
      const message: NormalizedMessage = {
        id: input.claimId,
        channelId: input.record.deliveryOrigin.channelId,
        channelType: "managed_run",
        senderId: "managed-run-controller",
        text: input.announcement,
        timestamp: input.record.updatedAtMs,
        attachments: [],
        metadata: {
          managedRunId: input.record.managedRunId,
          serviceInstanceId: input.record.serviceInstanceId,
          triggeringSequence: input.triggeringSequence,
          traceId: input.record.traceId,
        },
      };
      return deps.engine.execute({
        continuationId: input.claimId,
        source: "managed_run",
        sourceId: input.record.managedRunId,
        agentId: input.record.agentId,
        authority: input.record,
        requestContext: requestContext.value,
        sessionKey: projected.value,
        formattedSessionKey: formatSessionKey(projected.value),
        message,
        journalKey: input.claimId,
        workspacePolicyHash: input.record.workspacePolicyHash,
        workspacePolicySnapshot: policy.value,
        capturedCapabilityCeiling: {
          toolIds: input.record.capturedToolIds,
          viewHash: input.record.capturedCapabilityViewHash,
        },
        beforeExecute: () => {
          log.debug({
            step: "managed-run-continuation-execute",
            managedRunId: input.record.managedRunId,
            serviceInstanceId: input.record.serviceInstanceId,
            triggeringSequence: input.triggeringSequence,
          }, "Invoking managed-run continuation");
        },
        hooks: input.hooks,
      });
    },
  });
}
