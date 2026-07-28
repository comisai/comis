// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  AgentExecutionAbortReasonSchema,
  AgentExecutionFinishReasonSchema,
  AgentTurnExecutionOutcomeSchema,
  ModelResolutionSourceSchema,
  classifyAgentFinishErrorKind,
  classifyAgentTurnExecutionOutcome,
} from "./agent-execution-outcome.js";

describe("closed agent execution outcome contracts", () => {
  it("accepts every settled finish member and rejects SDK spelling aliases", () => {
    const members = [
      "stop", "max_steps", "budget_exceeded", "budget_exhausted", "circuit_open",
      "provider_degraded", "context_loop", "context_exhausted", "output_starved",
      "session_reset", "loop_detected", "prompt_timeout", "spend_exceeded",
      "input_too_large", "completed_with_tool_errors", "narration_stall",
      "background_pending", "error",
    ];
    expect(members.every((member) => AgentExecutionFinishReasonSchema.safeParse(member).success)).toBe(true);
    expect(AgentExecutionFinishReasonSchema.safeParse("end_turn").success).toBe(false);
  });

  it("keeps abort and model-resolution vocabularies closed", () => {
    expect(AgentExecutionAbortReasonSchema.options).toEqual([
      "user_stop", "budget_exceeded", "circuit_breaker", "max_steps", "context_exhausted",
      "pipeline_timeout", "loop_detected", "spend_exceeded", "denial_breaker",
    ]);
    expect(ModelResolutionSourceSchema.options).toEqual([
      "explicit_config", "cron_job_override", "parent_inherited", "family_default", "agent_primary",
    ]);
  });

  it("requires error classification for failed and non-user abort outcomes", () => {
    expect(AgentTurnExecutionOutcomeSchema.safeParse({ status: "completed", finishReason: "stop" }).success).toBe(true);
    expect(AgentTurnExecutionOutcomeSchema.safeParse({ status: "failed", finishReason: "error" }).success).toBe(false);
    expect(AgentTurnExecutionOutcomeSchema.safeParse({
      status: "failed", finishReason: "completed_with_tool_errors", errorKind: "dependency",
    }).success).toBe(true);
    expect(AgentTurnExecutionOutcomeSchema.safeParse({ status: "aborted", abortReason: "user_stop" }).success).toBe(true);
    expect(AgentTurnExecutionOutcomeSchema.safeParse({ status: "aborted", abortReason: "max_steps" }).success).toBe(false);
  });

  it("classifies every intrinsic failure reason without inspecting prose", () => {
    expect(classifyAgentFinishErrorKind("prompt_timeout")).toBe("timeout");
    expect(classifyAgentFinishErrorKind("provider_degraded")).toBe("dependency");
    expect(classifyAgentFinishErrorKind("input_too_large")).toBe("validation");
    expect(classifyAgentFinishErrorKind("background_pending")).toBe("precondition");
    expect(classifyAgentFinishErrorKind("narration_stall")).toBe("internal");
    expect(classifyAgentFinishErrorKind("output_starved")).toBe("resource");
    expect(classifyAgentFinishErrorKind("error")).toBeUndefined();
  });

  it("classifies terminal turns from authoritative abort and finish discriminators", () => {
    expect(classifyAgentTurnExecutionOutcome({ finishReason: "stop" })).toEqual({
      status: "completed",
      finishReason: "stop",
    });
    expect(classifyAgentTurnExecutionOutcome({
      finishReason: "stop",
      abortReason: "user_stop",
    })).toEqual({ status: "aborted", abortReason: "user_stop", finishReason: "stop" });
    expect(classifyAgentTurnExecutionOutcome({
      finishReason: "provider_degraded",
    })).toEqual({ status: "failed", finishReason: "provider_degraded", errorKind: "dependency" });
    expect(classifyAgentTurnExecutionOutcome({
      finishReason: "error",
      errorKind: "auth",
    })).toEqual({ status: "failed", finishReason: "error", errorKind: "auth" });
    expect(classifyAgentTurnExecutionOutcome({
      finishReason: "stop",
      abortReason: "pipeline_timeout",
    })).toEqual({
      status: "aborted",
      abortReason: "pipeline_timeout",
      finishReason: "stop",
      errorKind: "timeout",
    });
  });
});
