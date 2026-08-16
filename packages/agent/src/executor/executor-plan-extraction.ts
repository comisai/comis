// SPDX-License-Identifier: Apache-2.0
/** Structured execution-plan extraction for the prompt runner. */
import type { ClockPort, ComisLogger, TypedEventBus } from "@comis/core";
import { extractPlanFromResponse } from "../planner/plan-extractor.js";
import type { ExecutionPlan } from "../planner/types.js";

/** Extract a structured execution plan from the first model response. */
export function extractExecutionPlan(params: {
  response: string;
  messageText: string;
  maxSteps: number;
  minSteps: number;
  executionStartMs: number;
  agentId: string | undefined;
  formattedKey: string;
  eventBus: TypedEventBus;
  logger: ComisLogger;
  clock: ClockPort;
}): ExecutionPlan | undefined {
  const { response, messageText, maxSteps, minSteps, executionStartMs, agentId, formattedKey, eventBus, logger, clock } = params;
  const steps = extractPlanFromResponse(response, maxSteps);
  if (steps === undefined || steps.length < minSteps) return undefined;
  const plan: ExecutionPlan = {
    active: true,
    request: messageText.slice(0, 200),
    steps,
    completedCount: 0,
    createdAtMs: clock.now(),
  };
  logger.info(
    { agentId, stepCount: steps.length, durationMs: clock.now() - executionStartMs },
    "SEP plan extracted",
  );
  eventBus.emit("sep:plan_extracted", {
    agentId: agentId ?? "default",
    sessionKey: formattedKey,
    stepCount: steps.length,
    timestamp: clock.now(),
  });
  return plan;
}
