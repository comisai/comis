// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { ERROR_KINDS, type ErrorKind } from "../logging/log-fields.js";

export const AgentExecutionFinishReasonSchema = z.enum([
  "stop",
  "max_steps",
  "budget_exceeded",
  "budget_exhausted",
  "circuit_open",
  "provider_degraded",
  "context_loop",
  "context_exhausted",
  "output_starved",
  "session_reset",
  "loop_detected",
  "prompt_timeout",
  "spend_exceeded",
  "input_too_large",
  "completed_with_tool_errors",
  "narration_stall",
  "tool_invocation_stall",
  "background_pending",
  "cancelled",
  "error",
]);
export type AgentExecutionFinishReason = z.infer<typeof AgentExecutionFinishReasonSchema>;

export const AgentExecutionAbortReasonSchema = z.enum([
  "user_stop",
  "budget_exceeded",
  "circuit_breaker",
  "max_steps",
  "context_exhausted",
  "pipeline_timeout",
  "loop_detected",
  "spend_exceeded",
  "denial_breaker",
  "caller_cancelled",
]);
export type AgentExecutionAbortReason = z.infer<typeof AgentExecutionAbortReasonSchema>;

export const ModelResolutionSourceSchema = z.enum([
  "explicit_config",
  "cron_job_override",
  "parent_inherited",
  "family_default",
  "agent_primary",
]);
export type ModelResolutionSource = z.infer<typeof ModelResolutionSourceSchema>;

export const ExecutionSideEffectSummarySchema = z.strictObject({
  schedulingCapabilityInvoked: z.boolean(),
  outboundDeliveryCapabilityInvoked: z.boolean(),
  deferredWorkCapabilityInvoked: z.boolean(),
  unclassifiedInvocationObserved: z.boolean(),
});
export type ExecutionSideEffectSummary = z.infer<typeof ExecutionSideEffectSummarySchema>;

const ErrorKindSchema = z.enum(ERROR_KINDS);
const FailureFinishReasonSchema = AgentExecutionFinishReasonSchema.exclude(["stop", "cancelled"]);
const FailureAbortReasonSchema = AgentExecutionAbortReasonSchema.exclude([
  "user_stop",
  "caller_cancelled",
]);

export const AgentTurnExecutionOutcomeSchema = z.union([
  z.strictObject({ status: z.literal("completed"), finishReason: z.literal("stop") }),
  z.strictObject({
    status: z.literal("failed"),
    finishReason: FailureFinishReasonSchema,
    errorKind: ErrorKindSchema,
  }),
  z.strictObject({
    status: z.literal("aborted"),
    abortReason: z.enum(["user_stop", "caller_cancelled"]),
    finishReason: AgentExecutionFinishReasonSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("aborted"),
    abortReason: FailureAbortReasonSchema,
    finishReason: AgentExecutionFinishReasonSchema.optional(),
    errorKind: ErrorKindSchema,
  }),
  z.strictObject({ status: z.literal("unknown"), errorKind: ErrorKindSchema }),
]);
export type AgentTurnExecutionOutcome = z.infer<typeof AgentTurnExecutionOutcomeSchema>;

/** Classify finish reasons whose failure kind follows from the closed discriminator. */
export function classifyAgentFinishErrorKind(
  reason: AgentExecutionFinishReason,
): ErrorKind | undefined {
  switch (reason) {
    case "stop":
    case "cancelled":
    case "error":
    case "completed_with_tool_errors":
      return undefined;
    case "prompt_timeout":
      return "timeout";
    case "circuit_open":
    case "provider_degraded":
      return "dependency";
    case "input_too_large":
      return "validation";
    case "session_reset":
    case "narration_stall":
    case "tool_invocation_stall":
      return "internal";
    case "background_pending":
      return "precondition";
    case "max_steps":
    case "budget_exceeded":
    case "budget_exhausted":
    case "context_loop":
    case "context_exhausted":
    case "output_starved":
    case "loop_detected":
    case "spend_exceeded":
      return "resource";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function classifyAgentAbortErrorKind(
  reason: AgentExecutionAbortReason,
): ErrorKind | undefined {
  switch (reason) {
    case "user_stop":
    case "caller_cancelled":
      return undefined;
    case "circuit_breaker": return "dependency";
    case "pipeline_timeout": return "timeout";
    case "denial_breaker": return "precondition";
    case "budget_exceeded":
    case "max_steps":
    case "context_exhausted":
    case "loop_detected":
    case "spend_exceeded":
      return "resource";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/** Reduce the two authoritative terminal discriminators into one strict outcome. */
export function classifyAgentTurnExecutionOutcome(input: {
  finishReason: AgentExecutionFinishReason;
  abortReason?: AgentExecutionAbortReason;
  errorKind?: ErrorKind;
}): AgentTurnExecutionOutcome {
  if (input.abortReason !== undefined) {
    if (input.abortReason === "user_stop" || input.abortReason === "caller_cancelled") {
      return {
        status: "aborted",
        abortReason: input.abortReason,
        finishReason: input.finishReason,
      };
    }
    return {
      status: "aborted",
      abortReason: input.abortReason,
      finishReason: input.finishReason,
      errorKind: classifyAgentAbortErrorKind(input.abortReason) ?? input.errorKind ?? "internal",
    };
  }
  if (input.finishReason === "cancelled") {
    return {
      status: "aborted",
      abortReason: "caller_cancelled",
      finishReason: "cancelled",
    };
  }
  if (input.finishReason === "stop") {
    return { status: "completed", finishReason: "stop" };
  }
  return {
    status: "failed",
    finishReason: input.finishReason,
    errorKind: input.errorKind ?? classifyAgentFinishErrorKind(input.finishReason) ?? "internal",
  };
}
