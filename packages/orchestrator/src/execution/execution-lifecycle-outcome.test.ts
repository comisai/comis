// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  classifyExecutionAbortReason,
  classifyExecutionFinishReason,
} from "./execution-lifecycle-outcome.js";
import type { ExecutionResult } from "@comis/agent";

function makeExecutionResult(
  terminal: Pick<ExecutionResult, "finishReason" | "terminalErrorKind">,
): ExecutionResult {
  return {
    response: "",
    sessionKey: {
      tenantId: "tenant_a",
      channel: "echo",
      channelInstanceId: "echo_a",
      channelId: "channel_a",
      userId: "user_a",
      agentId: "agent_a",
      chatType: "dm",
    },
    executionId: "execution_a",
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    sideEffectSummary: {
      schedulingCapabilityInvoked: false,
      outboundDeliveryCapabilityInvoked: false,
      deferredWorkCapabilityInvoked: false,
      unclassifiedInvocationObserved: false,
    },
    tokensUsed: { input: 0, output: 0, total: 0 },
    cost: { total: 0 },
    stepsExecuted: 0,
    llmCalls: 0,
    ...terminal,
  } as ExecutionResult;
}

describe("execution lifecycle outcome classification", () => {
  // A turn that COMPLETED and delivered a reply is not an execution failure, even
  // when a tool errored along the way. Classifying it as one made the Verified
  // Learning pipeline record a deterministic `failure` at 0.9 confidence for a
  // correct answer (live: one attachment-validation error that the agent retried
  // successfully in the same turn), and selected the "agent-runtime-failure"
  // delivery origin for a reply the agent genuinely produced. Same carve-out the
  // `background_pending` case already documents in this file.
  it("does not report an execution failure when the turn completed with tool errors", () => {
    const outcome = classifyExecutionFinishReason(
      makeExecutionResult({ finishReason: "completed_with_tool_errors", terminalErrorKind: "validation" }),
    );
    expect(outcome.status).not.toBe("error");
    expect(outcome.failureStage).toBeUndefined();
  });

  it("retains the tool errorKind on a completed-with-tool-errors turn", () => {
    const outcome = classifyExecutionFinishReason(
      makeExecutionResult({ finishReason: "completed_with_tool_errors", terminalErrorKind: "validation" }),
    );
    expect(outcome.errorKind).toBe("validation");
  });

  it("still reports an execution failure for a hard error finish", () => {
    const outcome = classifyExecutionFinishReason(
      makeExecutionResult({ finishReason: "error", terminalErrorKind: "internal" }),
    );
    expect(outcome.status).toBe("error");
    expect(outcome.failureStage).toBe("execution");
  });

  it.each([
    ["stop", { status: "success" }],
    ["max_steps", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["budget_exceeded", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["budget_exhausted", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["context_loop", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["context_exhausted", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["output_starved", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["loop_detected", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["spend_exceeded", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["circuit_open", { status: "error", failureStage: "execution", errorKind: "dependency" }],
    ["provider_degraded", { status: "error", failureStage: "execution", errorKind: "dependency" }],
    ["session_reset", { status: "error", failureStage: "execution", errorKind: "internal" }],
    ["tool_invocation_stall", { status: "error", failureStage: "execution", errorKind: "internal" }],
    ["prompt_timeout", { status: "timeout", failureStage: "execution", errorKind: "timeout" }],
    ["cancelled", { status: "aborted" }],
    ["input_too_large", { status: "error", failureStage: "execution", errorKind: "validation" }],
    ["error", { status: "error", failureStage: "execution", errorKind: "dependency" }],
    // A deliberate hand-off to background execution is NOT a delivery failure: the foreground turn
    // completed as designed and the terminal user outcome belongs to the background completion,
    // which emits its own delivery record. Recorded as an error it inflated the delivery error count
    // and made a successful backgrounded turn (9 tool calls, $6.87 of real work) read as failed.
    ["background_pending", { status: "filtered" }],
  ] as const)("classifies finish reason %s", (finishReason, expected) => {
    const result = finishReason === "error"
      ? makeExecutionResult({ finishReason, terminalErrorKind: "dependency" })
      : makeExecutionResult({ finishReason });
    expect(classifyExecutionFinishReason(result as never)).toEqual(expected);
  });

  it.each([
    ["user_stop", { status: "aborted" }],
    ["caller_cancelled", { status: "aborted" }],
    ["pipeline_timeout", { status: "timeout", failureStage: "execution", errorKind: "timeout" }],
    ["budget_exceeded", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["max_steps", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["context_exhausted", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["loop_detected", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["spend_exceeded", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["circuit_breaker", { status: "error", failureStage: "execution", errorKind: "dependency" }],
    ["denial_breaker", { status: "error", failureStage: "execution", errorKind: "precondition" }],
  ] as const)("classifies abort reason %s before downstream delivery", (reason, expected) => {
    expect(classifyExecutionAbortReason(reason as never)).toEqual(expected);
  });
});
