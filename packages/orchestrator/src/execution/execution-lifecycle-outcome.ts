// SPDX-License-Identifier: Apache-2.0
import type {
  DeliveryFailureStage,
  DeliveryStatus,
  ErrorKind,
  EventMap,
} from "@comis/core";
import type { ExecutionResult } from "@comis/agent";

/** Exact status metadata emitted at the message-lifecycle boundary. */
export interface LifecycleOutcome {
  status: DeliveryStatus;
  failureStage?: DeliveryFailureStage;
  errorKind?: ErrorKind;
}

/** Classify the executor's closed terminal reason before filter/delivery policy. */
export function classifyExecutionFinishReason(
  result: ExecutionResult,
): LifecycleOutcome {
  switch (result.finishReason) {
    case "stop":
      return { status: "success" };
    case "prompt_timeout":
      return { status: "timeout", failureStage: "execution", errorKind: "timeout" };
    case "max_steps":
    case "budget_exceeded":
    case "budget_exhausted":
    case "context_loop":
    case "context_exhausted":
    case "output_starved":
    case "loop_detected":
    case "spend_exceeded":
      return { status: "error", failureStage: "execution", errorKind: "resource" };
    case "circuit_open":
    case "provider_degraded":
      return { status: "error", failureStage: "execution", errorKind: "dependency" };
    case "session_reset":
    case "narration_stall":
    case "tool_invocation_stall":
      return { status: "error", failureStage: "execution", errorKind: "internal" };
    // NOT a failure. The foreground turn deliberately promoted its remaining work and ended without
    // a terminal user reply; the terminal outcome belongs to the background completion, which emits
    // its OWN delivery record. Recorded as an error it inflated the delivery error count and made a
    // successful backgrounded turn read as failed.
    //
    // `filtered`, not `success`: no reply was delivered ON THIS TURN, and `success` additionally
    // selects the "agent" delivery origin and paints a success indicator — neither of which is true
    // of a hand-off. `finishReason` still reaches the delivery tracer, so the background lifecycle
    // stays identifiable and obs.explain keeps its dedicated `background_pending` verdict.
    case "background_pending":
      return { status: "filtered" };
    case "input_too_large":
      return { status: "error", failureStage: "execution", errorKind: "validation" };
    // NOT an execution failure. The name is literal: the turn COMPLETED and
    // delivered a reply; a tool errored somewhere along the way, which the tool
    // stats, the normalized `failures[]` and the session rollup's `degraded`
    // flag all already record. Classified as `error` + `failureStage:
    // "execution"` it was indistinguishable from a turn that produced nothing,
    // so the Verified Learning pipeline banked a deterministic `failure` at 0.9
    // confidence against a correct answer (live: one attachment-validation
    // error the agent retried successfully in the same turn), and the delivery
    // took the "agent-runtime-failure" origin for a reply the agent genuinely
    // wrote. `errorKind` is retained so the tool fault stays diagnosable.
    // Same carve-out, and the same reasoning, as `background_pending` above.
    case "completed_with_tool_errors":
      return {
        status: "success",
        ...(result.terminalErrorKind === undefined
          ? {}
          : { errorKind: result.terminalErrorKind }),
      };
    case "error":
      return {
        status: "error",
        failureStage: "execution",
        errorKind: result.terminalErrorKind,
      };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

/** Abort events override executor and delivery outcomes. */
export function classifyExecutionAbortReason(
  reason: EventMap["execution:aborted"]["reason"],
): LifecycleOutcome {
  switch (reason) {
    case "user_stop":
      return { status: "aborted" };
    case "pipeline_timeout":
      return { status: "timeout", failureStage: "execution", errorKind: "timeout" };
    case "budget_exceeded":
    case "max_steps":
    case "context_exhausted":
    case "loop_detected":
    case "spend_exceeded":
      return { status: "error", failureStage: "execution", errorKind: "resource" };
    case "circuit_breaker":
      return { status: "error", failureStage: "execution", errorKind: "dependency" };
    case "denial_breaker":
      return { status: "error", failureStage: "execution", errorKind: "precondition" };
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
