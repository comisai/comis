// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  emitObservationalEventSafely,
  type ComisLogger,
  type ManagedRunAttentionRecord,
  type ManagedRunContentPort,
  type ManagedRunOwnerScope,
  type ManagedRunRecord,
  type ManagedRunStorePort,
  type TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { managedRunAttentionId } from "./managed-run-attention-identity.js";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/;

const ManagedAttentionResponseIngressSchema = z.strictObject({
  operationId: z.string().min(1).max(128).regex(OPAQUE_ID_PATTERN),
  serviceInstanceId: z.string().min(1).max(256).regex(OPAQUE_ID_PATTERN),
  managedRunId: z.string().min(1).max(256).regex(OPAQUE_ID_PATTERN),
  externalKey: z.string().min(1).max(256),
});

export interface ManagedAttentionResponseIngressInput {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly externalKey: string;
}

export type ManagedAttentionResponseRejectionReason =
  | "attention_not_found"
  | "invalid_request"
  | "managed_run_not_found"
  | "state_mismatch";

export type ManagedAttentionResponseIngressOutcome =
  | {
    readonly kind: "pending";
    readonly managedRunId: string;
    readonly externalKey: string;
  }
  | {
    readonly kind: "delivered";
    readonly managedRunId: string;
    readonly externalKey: string;
    readonly response: string;
  }
  | { readonly kind: "rejected"; readonly reasonCode: ManagedAttentionResponseRejectionReason };

export interface ManagedAttentionResponseBridge {
  receiveAttentionResponse(
    input: ManagedAttentionResponseIngressInput,
  ): Promise<Result<ManagedAttentionResponseIngressOutcome, Error>>;
}

export interface ManagedAttentionResponseBridgeDeps {
  readonly store: ManagedRunStorePort;
  readonly contentStore: ManagedRunContentPort;
  readonly nowMs: () => number;
  readonly eventBus: TypedEventBus;
  readonly logger: ComisLogger;
}

async function invoke<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(invoked.error);
  const settled = await fromPromise(invoked.value);
  return settled.ok ? settled.value : err(settled.error);
}

function ownerScope(record: ManagedRunRecord): ManagedRunOwnerScope {
  return {
    kind: "owner",
    tenantId: record.tenantId,
    agentId: record.agentId,
    principalId: record.principalId,
    conversationRef: record.conversationRef,
  };
}

function contentScope(record: ManagedRunRecord) {
  return {
    tenantId: record.tenantId,
    agentId: record.agentId,
    managedRunId: record.managedRunId,
  };
}

/** Deliver one owner-bound private response only to the service that owns its managed run. */
export function createManagedAttentionResponseBridge(
  deps: ManagedAttentionResponseBridgeDeps,
): ManagedAttentionResponseBridge {
  function emitFailure(
    reasonCode: ManagedAttentionResponseRejectionReason | "storage_failure",
    identity?: { readonly serviceInstanceId: string; readonly managedRunId: string },
  ): void {
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "managed_run:attention_response_delivery_failed",
      {
        reasonCode,
        ...(identity === undefined ? {} : identity),
        timestamp: deps.nowMs(),
      },
    );
  }

  function rejectResponse(
    reasonCode: ManagedAttentionResponseRejectionReason,
    identity?: { readonly serviceInstanceId: string; readonly managedRunId: string },
  ): Result<ManagedAttentionResponseIngressOutcome, Error> {
    deps.logger.warn({
      ...(identity === undefined ? {} : identity),
      reasonCode,
      errorKind: reasonCode === "invalid_request" ? "validation" as const : "precondition" as const,
      hint: "Verify the managed-run ID, external decision key, owning service instance, and current attention state before retrying",
    }, "Managed attention response delivery rejected");
    deps.logger.audit({
      decision: "deny",
      reasonCode,
      ...(identity === undefined ? {} : identity),
    }, "Managed attention response delivery rejected");
    emitFailure(reasonCode, identity);
    return ok({ kind: "rejected", reasonCode });
  }

  function storageFailure<T>(
    step: string,
    identity: { readonly serviceInstanceId: string; readonly managedRunId: string },
    cause: Error,
  ): Result<T, Error> {
    deps.logger.error({
      ...identity,
      step,
      errorKind: "internal" as const,
      hint: "Inspect the managed-run SQLite store and owner-only private-content root before retrying with a new operation ID",
    }, "Managed attention response delivery failed");
    emitFailure("storage_failure", identity);
    return err(cause);
  }

  async function readResponse(
    record: ManagedRunRecord,
    attention: ManagedRunAttentionRecord,
    identity: { readonly serviceInstanceId: string; readonly managedRunId: string },
  ): Promise<Result<string, Error>> {
    if (attention.responseRef === undefined) {
      return storageFailure("attention-response-reference", identity, new Error(
        "deliverable managed-run attention is missing its private response reference",
      ));
    }
    const responseRef = attention.responseRef;
    const body = await invoke(() => deps.contentStore.getAttentionBody(
      contentScope(record),
      responseRef,
    ));
    if (!body.ok) return storageFailure("attention-response-read", identity, body.error);
    if (body.value === undefined) {
      return storageFailure("attention-response-read", identity, new Error(
        "managed-run attention private response body is missing",
      ));
    }
    const decoded = tryCatch(() => new TextDecoder("utf-8", { fatal: true }).decode(body.value));
    if (!decoded.ok || decoded.value.length === 0) {
      return storageFailure(
        "attention-response-decode",
        identity,
        decoded.ok ? new Error("managed-run attention private response body is empty") : decoded.error,
      );
    }
    return decoded;
  }

  return Object.freeze({
    receiveAttentionResponse: async (
      input: ManagedAttentionResponseIngressInput,
    ): Promise<Result<ManagedAttentionResponseIngressOutcome, Error>> => {
      const startedAtMs = deps.nowMs();
      const parsed = ManagedAttentionResponseIngressSchema.safeParse(input);
      if (!parsed.success) return rejectResponse("invalid_request");
      const identity = {
        serviceInstanceId: parsed.data.serviceInstanceId,
        managedRunId: parsed.data.managedRunId,
      };
      deps.logger.debug({ ...identity, step: "attention-response-authority" },
        "Resolving managed attention response authority");
      const recordResult = await invoke(() => deps.store.get(
        { kind: "service", serviceInstanceId: identity.serviceInstanceId },
        identity.managedRunId,
      ));
      if (!recordResult.ok) {
        return storageFailure("attention-response-authority", identity, recordResult.error);
      }
      if (recordResult.value === undefined) {
        return rejectResponse("managed_run_not_found", identity);
      }
      const record = recordResult.value;
      const exactAttentionId = managedRunAttentionId({
        ...identity,
        externalKey: parsed.data.externalKey,
      });
      const scope = ownerScope(record);
      const attentionResult = await invoke(() => deps.store.getAttention(scope, exactAttentionId));
      if (!attentionResult.ok) {
        return storageFailure("attention-response-index", identity, attentionResult.error);
      }
      const attention = attentionResult.value;
      if (
        attention === undefined
        || attention.managedRunId !== identity.managedRunId
        || attention.serviceInstanceId !== identity.serviceInstanceId
        || attention.externalKey !== parsed.data.externalKey
      ) {
        return rejectResponse("attention_not_found", identity);
      }
      if (attention.status === "open") {
        deps.logger.info({
          ...identity,
          durationMs: Math.max(0, deps.nowMs() - startedAtMs),
        }, "Managed attention response remains pending");
        return ok({
          kind: "pending",
          managedRunId: identity.managedRunId,
          externalKey: parsed.data.externalKey,
        });
      }
      if (attention.status !== "response_pending" && attention.status !== "delivered") {
        return rejectResponse("state_mismatch", identity);
      }
      deps.logger.debug({ ...identity, step: "attention-response-private-body" },
        "Reading managed attention private response");
      const response = await readResponse(record, attention, identity);
      if (!response.ok) return response;

      let newlyDelivered = false;
      if (attention.status === "response_pending") {
        deps.logger.debug({ ...identity, step: "attention-response-delivery" },
          "Committing managed attention response delivery");
        const delivered = await invoke(() => deps.store.markAttentionDelivered(scope, {
          operationId: parsed.data.operationId,
          attentionId: exactAttentionId,
          deliveredAtMs: deps.nowMs(),
        }));
        if (!delivered.ok) {
          return storageFailure("attention-response-delivery", identity, delivered.error);
        }
        if (delivered.value.kind === "updated") newlyDelivered = true;
        else if (delivered.value.kind === "state_mismatch") {
          const raced = await invoke(() => deps.store.getAttention(scope, exactAttentionId));
          if (!raced.ok) return storageFailure("attention-response-race", identity, raced.error);
          if (raced.value?.status !== "delivered") return rejectResponse("state_mismatch", identity);
        } else if (delivered.value.kind !== "identical_replay") {
          return rejectResponse("state_mismatch", identity);
        }
      }

      const durationMs = Math.max(0, deps.nowMs() - startedAtMs);
      deps.logger.info({ ...identity, durationMs }, "Managed attention response delivered");
      if (newlyDelivered) {
        emitObservationalEventSafely(
          { eventBus: deps.eventBus, logger: deps.logger },
          "managed_run:attention_response_delivered",
          {
            ...identity,
            attentionId: exactAttentionId,
            durationMs,
            timestamp: deps.nowMs(),
          },
        );
      }
      return ok({
        kind: "delivered",
        managedRunId: identity.managedRunId,
        externalKey: parsed.data.externalKey,
        response: response.value,
      });
    },
  });
}
