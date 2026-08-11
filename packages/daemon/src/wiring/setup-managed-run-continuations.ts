// SPDX-License-Identifier: Apache-2.0
import {
  conversationScopeToSessionKey,
  resolvePlatformDeliveryResult,
  type ChannelPort,
  type CapabilityServiceEvidencePolicy,
  type ComisLogger,
  type DeliveryService,
  type ManagedRunContentPort,
  type ManagedAttentionReplyPort,
  type ManagedRunRecord,
  type ManagedRunStorePort,
  type OutwardSendLedgerPort,
  type SessionKey,
  type TimerPort,
  type TypedEventBus,
  type WorkspacePolicySnapshot,
} from "@comis/core";
import type { ContinuationExecutionEngine } from "@comis/agent";
import { err, fromPromise, isSilentResponse, ok, type Result } from "@comis/shared";
import { wrapOutwardSend } from "../api/outward-ledger-wrap.js";
import { createManagedRunContinuationCaller } from "./managed-run-continuation-caller.js";
import {
  createManagedRunContinuationCoordinator,
  type ManagedRunContinuationExecutionOutcome,
} from "./managed-run-continuation-coordinator.js";
import type { ManagedRunVerifiedDelivery } from "./managed-run-evidence-verifier.js";
import { materializeManagedRunAttachment } from "./managed-run-delivery-attachment.js";
import {
  createManagedRunContinuationRuntime,
  type ManagedRunContinuationRuntime,
} from "./managed-run-continuation-runtime.js";

export type ManagedRunContinuationDelivery = (
  record: ManagedRunRecord,
  claimId: string,
  finalized: ManagedRunFinalizedResult,
  phase: "cleanup_pending" | "ready",
  verifiedDelivery?: ManagedRunVerifiedDelivery,
) => Promise<Result<ManagedRunContinuationExecutionOutcome, Error>>;

export interface ManagedRunFinalizedResult {
  readonly response: string;
  readonly executionId: string;
  readonly cleanupRequired: boolean;
}

export interface ManagedRunFinalizedResultRecoveryInput {
  readonly agentId: string;
  readonly sessionKey: SessionKey;
  readonly journalKey: string;
}

export interface ManagedRunContinuationsContext {
  readonly runtime: ManagedRunContinuationRuntime;
  readonly attentionReplies: ManagedAttentionReplyPort;
  shutdown(): Promise<void>;
}

/** Protect managed continuation delivery with a retained operation and exact endpoint. */
export function createManagedRunContinuationDelivery(deps: {
  readonly adaptersByType: ReadonlyMap<string, ChannelPort>;
  readonly deliveryService: DeliveryService;
  readonly outwardLedger?: OutwardSendLedgerPort;
  readonly attachmentDirectory?: string;
  readonly logger: ComisLogger;
}): ManagedRunContinuationDelivery {
  return async (record, claimId, finalized, phase, verifiedDelivery) => {
    if (phase === "cleanup_pending") return ok({ deliveryState: "unavailable" });
    const response = isSilentResponse(finalized.response) ? "" : finalized.response;
    if (deps.outwardLedger === undefined) return ok({ deliveryState: "unavailable" });
    const endpoint = record.turnScope.endpoint;
    const adapter = deps.adaptersByType.get(endpoint.channelType);
    if (adapter === undefined || adapter.channelId !== endpoint.channelInstanceId) {
      return ok({ deliveryState: "unavailable" });
    }
    const idempotencyKey = `managed-run-continuation:${claimId}`;
    const allocated = await deps.outwardLedger.allocateStep(record.rootRunId, idempotencyKey);
    if (!allocated.ok) return allocated;
    if (verifiedDelivery?.kind === "attachment") {
      const sendAttachment = adapter.sendAttachment;
      if (deps.attachmentDirectory === undefined || sendAttachment === undefined) {
        return ok({ deliveryState: "unavailable" });
      }
      const materialized = materializeManagedRunAttachment(
        deps.attachmentDirectory,
        claimId,
        verifiedDelivery,
      );
      if (!materialized.ok) return materialized;
      const operationText = JSON.stringify({
        evidenceRef: verifiedDelivery.evidenceRef,
        contentHash: verifiedDelivery.contentHash,
        fileName: verifiedDelivery.fileName,
        mediaType: verifiedDelivery.mediaType,
        caption: response,
      });
      const delivered = await wrapOutwardSend({
        ledger: deps.outwardLedger,
        rootRunId: record.rootRunId,
        outwardStepIndex: allocated.value,
        agentId: record.agentId,
        channelType: endpoint.channelType,
        channelId: endpoint.conversationId,
        operationKind: "attachment_send",
        operationOptions: {
          evidenceRef: verifiedDelivery.evidenceRef,
          contentHash: verifiedDelivery.contentHash,
          fileName: verifiedDelivery.fileName,
          mediaType: verifiedDelivery.mediaType,
        },
        text: operationText,
        logger: deps.logger,
        doSend: async () => {
          const attempted = await fromPromise(sendAttachment(
            endpoint.conversationId,
            {
              type: "file",
              url: materialized.value.path,
              mimeType: verifiedDelivery.mediaType,
              fileName: verifiedDelivery.fileName,
              ...(response.length === 0 ? {} : { caption: response }),
            },
            endpoint.threadId === undefined ? {} : { threadId: endpoint.threadId },
          ));
          if (!attempted.ok) return attempted;
          if (!attempted.value.ok) return attempted.value;
          return attempted.value.value.kind === "tracked"
            ? ok({ messageId: attempted.value.value.messageId })
            : err(new Error("Managed-run attachment delivery did not return a platform receipt"));
        },
      });
      const cleaned = materialized.value.cleanup();
      if (!cleaned.ok) return cleaned;
      return delivered.ok
        ? ok({ deliveryState: "verified", verifiedEvidenceRef: verifiedDelivery.evidenceRef })
        : err(delivered.error);
    }
    const text = verifiedDelivery?.kind === "reference"
      ? [response, verifiedDelivery.url].filter((part) => part.length > 0).join("\n\n")
      : response;
    if (text.length === 0) return ok({ deliveryState: "not_required" });
    const delivered = await wrapOutwardSend({
      ledger: deps.outwardLedger,
      rootRunId: record.rootRunId,
      outwardStepIndex: allocated.value,
      agentId: record.agentId,
      channelType: endpoint.channelType,
      channelId: endpoint.conversationId,
      operationKind: "message_send",
      text,
      logger: deps.logger,
      doSend: async () => {
        const attempted = await fromPromise(deps.deliveryService.deliverToChannel(
          adapter,
          endpoint.conversationId,
          text,
          {
            completionMode: "settled",
            authority: {
              tenantId: record.tenantId,
              agentId: record.agentId,
              conversationRef: record.conversationRef,
            },
            destinationEndpoint: endpoint,
            ...(endpoint.threadId === undefined ? {} : { threadId: endpoint.threadId }),
            origin: "managed-run-continuation",
          },
        ));
        if (!attempted.ok) return attempted;
        const resolved = resolvePlatformDeliveryResult(attempted.value);
        if (!resolved.ok) return err(new Error(resolved.error.message));
        if (resolved.value.platform.status !== "accepted") {
          return err(new Error("Managed-run continuation was not accepted by the originating platform"));
        }
        const messageId = resolved.value.platform.lastMessageId;
        return messageId === undefined
          ? err(new Error("Managed-run continuation delivery did not return a platform receipt"))
          : ok({ messageId });
      },
    });
    return delivered.ok
      ? ok({
        deliveryState: "verified",
        ...(verifiedDelivery === undefined ? {} : { verifiedEvidenceRef: verifiedDelivery.evidenceRef }),
      })
      : err(delivered.error);
  };
}

/** Assemble managed reports onto the shared continuation execution engine. */
export async function setupManagedRunContinuations(deps: {
  readonly eventBus: TypedEventBus;
  readonly store: ManagedRunStorePort;
  readonly contentStore: ManagedRunContentPort;
  readonly attentionReplies: ManagedAttentionReplyPort;
  readonly engine: ContinuationExecutionEngine;
  readonly recoverFinalizedResult: (
    input: ManagedRunFinalizedResultRecoveryInput,
  ) => Promise<Result<ManagedRunFinalizedResult | undefined, Error>>;
  readonly resolveWorkspacePolicy: (
    agentId: string,
    policyHash: string,
  ) => Promise<Result<WorkspacePolicySnapshot, Error>>;
  readonly deliver: ManagedRunContinuationDelivery;
  readonly resolveEvidencePolicies: (
    serviceInstanceId: string,
  ) => readonly CapabilityServiceEvidencePolicy[] | undefined;
  readonly nowMs: () => number;
  readonly timers: TimerPort;
  readonly heartbeatMaxAgeMs: number;
  readonly claimTtlMs: number;
  readonly recoveryBatchSize: number;
  readonly logger: ComisLogger;
}): Promise<Result<ManagedRunContinuationsContext, Error>> {
  const caller = createManagedRunContinuationCaller({
    engine: deps.engine,
    resolveWorkspacePolicy: deps.resolveWorkspacePolicy,
    logger: deps.logger,
  });
  const coordinator = createManagedRunContinuationCoordinator({
    store: deps.store,
    contentStore: deps.contentStore,
    nowMs: deps.nowMs,
    heartbeatMaxAgeMs: deps.heartbeatMaxAgeMs,
    claimTtlMs: deps.claimTtlMs,
    resolveEvidencePolicies: deps.resolveEvidencePolicies,
    eventBus: deps.eventBus,
    logger: deps.logger,
    execute: async (input) => {
      const deliverFinalized = (
        finalized: ManagedRunFinalizedResult,
        phase: "cleanup_pending" | "ready",
      ) => input.verifiedDelivery === undefined
        ? deps.deliver(input.record, input.claimId, finalized, phase)
        : deps.deliver(input.record, input.claimId, finalized, phase, input.verifiedDelivery);
      const projected = conversationScopeToSessionKey(input.record.turnScope.conversation);
      if (!projected.ok) return err(new Error(projected.error.message));
      const recovered = await deps.recoverFinalizedResult({
        agentId: input.record.agentId,
        sessionKey: projected.value,
        journalKey: input.claimId,
      });
      if (!recovered.ok) return recovered;
      if (recovered.value !== undefined) {
        return deliverFinalized(
          recovered.value,
          recovered.value.cleanupRequired ? "cleanup_pending" : "ready",
        );
      }
      const executed = await caller.execute({
        record: input.record,
        claimId: input.claimId,
        triggeringSequence: input.triggeringSequence,
        announcement: input.announcement,
        hooks: {
          onProviderStart: () => ok(undefined),
          onJournalFinalizedResult: async () => undefined,
          onFinalizedResult: (finalized, phase) => deliverFinalized({
            response: finalized.response,
            executionId: finalized.executionId,
            cleanupRequired: finalized.finishReason === "session_reset",
          }, phase).then((delivered) => {
            if (!delivered.ok) return Promise.reject(delivered.error);
            return delivered.value;
          }),
        },
      });
      if (!executed.ok) return executed;
      return ok(executed.value.finalizedValue ?? { deliveryState: "unavailable" });
    },
  });
  const runtime = createManagedRunContinuationRuntime({
    eventBus: deps.eventBus,
    store: deps.store,
    coordinator,
    nowMs: deps.nowMs,
    timers: deps.timers,
    recoveryBatchSize: deps.recoveryBatchSize,
    logger: deps.logger,
  });
  const recovered = await runtime.recover();
  if (!recovered.ok) {
    await runtime.shutdown();
    await deps.engine.shutdown();
    return recovered;
  }
  return ok(Object.freeze({
    runtime,
    attentionReplies: deps.attentionReplies,
    shutdown: async () => {
      await runtime.shutdown();
      await deps.engine.shutdown();
    },
  }));
}
