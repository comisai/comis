// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  classifyExecutionAbortReason,
  classifyExecutionFinishReason,
} from "./execution-lifecycle-outcome.js";

describe("execution lifecycle outcome classification", () => {
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
    ["prompt_timeout", { status: "timeout", failureStage: "execution", errorKind: "timeout" }],
    ["input_too_large", { status: "error", failureStage: "execution", errorKind: "validation" }],
    ["error", { status: "error", failureStage: "execution" }],
  ] as const)("classifies finish reason %s", (finishReason, expected) => {
    expect(classifyExecutionFinishReason(finishReason)).toEqual(expected);
  });

  it.each([
    ["user_stop", { status: "aborted" }],
    ["pipeline_timeout", { status: "timeout", failureStage: "execution", errorKind: "timeout" }],
    ["budget_exceeded", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["max_steps", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["context_exhausted", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["loop_detected", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["spend_exceeded", { status: "error", failureStage: "execution", errorKind: "resource" }],
    ["circuit_breaker", { status: "error", failureStage: "execution", errorKind: "dependency" }],
    ["denial_breaker", { status: "error", failureStage: "execution", errorKind: "precondition" }],
  ] as const)("classifies abort reason %s before downstream delivery", (reason, expected) => {
    expect(classifyExecutionAbortReason(reason)).toEqual(expected);
  });
});
