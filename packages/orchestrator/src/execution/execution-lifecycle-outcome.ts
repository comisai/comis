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
    case "error":
    case "completed_with_tool_errors":
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
