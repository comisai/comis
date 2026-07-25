// SPDX-License-Identifier: Apache-2.0
import {
  BackgroundTaskOriginSchema,
  createConversationRef,
  getOriginalInboundMessages,
  type EventMap,
  type DeliveryFailureReceipt,
  type DeliveryQueueDisposition,
  type NormalizedMessage,
  type PlatformDeliveryOutcome,
  type RequestContext,
  type TaskExtractionPort,
  type WorkspacePolicyPort,
} from "@comis/core";
import type { ExecutionResult } from "@comis/agent";
import type { Result } from "@comis/shared";
import { classifyExecutionFinishReason } from "./execution-lifecycle-outcome.js";

export interface TaskExtractionCaptureDeps {
  readonly taskExtractionPort: TaskExtractionPort;
  readonly workspacePolicyPort: WorkspacePolicyPort;
}

export type TaskExtractionCaptureSkipReason =
  | "capture_unavailable"
  | "synthetic_turn"
  | "execution_not_successful"
  | "execution_aborted"
  | "input_not_plain_text"
  | "render_not_plain_text"
  | "side_effect_observed"
  | "delivery_not_accepted"
  | "physical_message_ineligible"
  | "origin_mismatch"
  | "policy_snapshot_unavailable";

export type TaskExtractionCaptureOutcome =
  | { readonly status: "enqueued"; readonly disposition: "enqueued" | "oldest_dropped" }
  | { readonly status: "skipped"; readonly reason: TaskExtractionCaptureSkipReason }
  | { readonly status: "rejected"; readonly reason: "invalid_turn" | "not_accepting" };

type TaskExtractionDeliveryResult = Result<
  | { readonly status: "suppressed"; readonly reason: "visible_replies" }
  | (PlatformDeliveryOutcome & { readonly queueDisposition: DeliveryQueueDisposition }),
  DeliveryFailureReceipt
>;

type TaskExtractionFilterResult =
  | { readonly deliver: true; readonly text: string; readonly mediaDelivery?: unknown }
  | { readonly deliver: false; readonly mediaDelivery?: unknown };

export interface TaskExtractionCaptureInput {
  readonly agentId: string;
  readonly channelInstanceId: string;
  readonly effectiveMsg: NormalizedMessage;
  readonly originalMsg: NormalizedMessage;
  readonly result: ExecutionResult;
  readonly filterResult: TaskExtractionFilterResult;
  readonly delivery: TaskExtractionDeliveryResult;
  readonly requestContext: RequestContext | undefined;
  readonly abortReason?: EventMap["execution:aborted"]["reason"];
}

/** Admit only one fully settled, attributable, plain-text interactive exchange. */
export function captureTaskExtractionTurn(
  deps: TaskExtractionCaptureDeps | undefined,
  input: TaskExtractionCaptureInput,
): TaskExtractionCaptureOutcome {
  if (deps === undefined) return { status: "skipped", reason: "capture_unavailable" };
  const context = input.requestContext;
  if (
    context === undefined
    || context.learningEligible !== true
    || input.effectiveMsg.metadata?.isRestartContinuation === true
    || input.originalMsg.metadata?.isRestartContinuation === true
  ) {
    return { status: "skipped", reason: "synthetic_turn" };
  }
  if (classifyExecutionFinishReason(input.result).status !== "success") {
    return { status: "skipped", reason: "execution_not_successful" };
  }
  if (input.abortReason !== undefined) {
    return { status: "skipped", reason: "execution_aborted" };
  }
  if (
    input.originalMsg.attachments.length !== 0
    || input.effectiveMsg.attachments.length !== 0
  ) {
    return { status: "skipped", reason: "input_not_plain_text" };
  }
  if (
    !input.filterResult.deliver
    || input.filterResult.mediaDelivery !== undefined
    || input.filterResult.text.trim().length === 0
  ) {
    return { status: "skipped", reason: "render_not_plain_text" };
  }
  const sideEffects = input.result.sideEffectSummary;
  if (
    sideEffects.schedulingCapabilityInvoked
    || sideEffects.outboundDeliveryCapabilityInvoked
    || sideEffects.deferredWorkCapabilityInvoked
    || sideEffects.unclassifiedInvocationObserved
  ) {
    return { status: "skipped", reason: "side_effect_observed" };
  }
  if (
    !input.delivery.ok
    || input.delivery.value.status !== "accepted"
    || input.delivery.value.deliveredChunks < 1
    || input.delivery.value.queueDisposition === "retry_pending"
  ) {
    return { status: "skipped", reason: "delivery_not_accepted" };
  }

  // Read physical provenance exactly once. The effective text may contain a
  // security-wrapped API transcript and is never used as the user artifact.
  const physicalMessages = getOriginalInboundMessages(input.effectiveMsg);
  const physical = physicalMessages.length === 1 ? physicalMessages[0] : undefined;
  if (
    physical === undefined
    || physical.text.trim().length === 0
    || physical.channelType !== input.effectiveMsg.channelType
    || physical.channelId !== input.effectiveMsg.channelId
    || physical.senderId !== input.effectiveMsg.senderId
  ) {
    return { status: "skipped", reason: "physical_message_ineligible" };
  }

  const turnScope = context.turnScope;
  const deliveryOrigin = context.deliveryOrigin;
  const conversationRef = turnScope === undefined
    ? undefined
    : createConversationRef(turnScope.conversation);
  const rawHopCount = input.effectiveMsg.metadata?.backgroundHopCount;
  const backgroundHopCount = rawHopCount === undefined ? 0 : rawHopCount;
  if (
    context.agentId !== input.agentId
    || turnScope === undefined
    || deliveryOrigin === undefined
    || !conversationRef?.ok
    || turnScope.conversation.agentId !== input.agentId
    || turnScope.endpoint.channelInstanceId !== input.channelInstanceId
    || turnScope.endpoint.channelType !== input.effectiveMsg.channelType
    || turnScope.endpoint.conversationId !== input.effectiveMsg.channelId
    || !Number.isSafeInteger(backgroundHopCount)
    || Number(backgroundHopCount) < 0
  ) {
    return { status: "skipped", reason: "origin_mismatch" };
  }
  const origin = BackgroundTaskOriginSchema.safeParse({
    turnScope,
    conversationRef: conversationRef.value,
    deliveryOrigin,
    traceId: context.traceId ?? null,
    responseLocalePolicy: input.result.responseLocalePolicy,
    backgroundHopCount,
  });
  if (!origin.success) return { status: "skipped", reason: "origin_mismatch" };

  const policyHash = input.result.workspacePolicyHash;
  if (policyHash === undefined) {
    return { status: "skipped", reason: "policy_snapshot_unavailable" };
  }
  const policy = deps.workspacePolicyPort.get(policyHash);
  if (
    !policy.ok
    || policy.value.agentId !== input.agentId
    || policy.value.combinedHash !== policyHash
  ) {
    return { status: "skipped", reason: "policy_snapshot_unavailable" };
  }
  const admitted = deps.taskExtractionPort.enqueue({
    sourceExecutionId: input.result.executionId,
    origin: origin.data,
    workspacePolicySnapshot: policy.value,
    responseLocalePolicy: input.result.responseLocalePolicy,
    capturedAtMs: input.delivery.value.settledAtMs,
    userText: physical.text,
    deliveredAssistantText: input.filterResult.text,
  });
  return admitted.ok
    ? { status: "enqueued", disposition: admitted.value }
    : { status: "rejected", reason: admitted.error.code };
}
