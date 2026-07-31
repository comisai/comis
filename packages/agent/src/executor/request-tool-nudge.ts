// SPDX-License-Identifier: Apache-2.0
/** Bounded recovery for small models that repeat an old answer instead of acting. */

import {
  emitObservationalEventSafely,
  getToolMetadata,
  matchesToolMutationRequest,
  type ClockPort,
  type ComisLogger,
  type TypedEventBus,
} from "@comis/core";
import {
  runContinuationTurn,
  type ContinuationTurnSession,
} from "./continuation-turn.js";
import type { ProviderDispatchGuard } from "./provider-dispatch.js";

export interface RequestToolNudgeOutcome {
  fired: boolean;
  recovered: boolean;
  response?: string;
  matchedToolNames: readonly string[];
  outcome:
    | "not_small_class"
    | "no_mutating_match"
    | "mutation_already_succeeded"
    | "not_action_request"
    | "recovered"
    | "still_no_mutation"
    | "followup_error";
}

export interface RunRequestToolNudgeDeps {
  session: ContinuationTurnSession;
  requestText: string;
  messages: unknown[];
  capabilityClass: string | undefined;
  requestRelevantToolNames: readonly string[];
  currentSuccessfulMutationCount: () => number;
  logger: ComisLogger;
  eventBus: TypedEventBus;
  sessionKey: string;
  clock: ClockPort;
  agentId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getVisibleAssistantText: (session: any) => string;
  guardProviderDispatch: ProviderDispatchGuard;
}

const SUBMODULE = "executor.request-tool-nudge";

/* eslint-disable @typescript-eslint/no-explicit-any */
function visibleTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as any[])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join(" ");
}

function hasToolCallBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return (content as any[]).some(
    (block) => block?.type === "toolCall" || block?.type === "tool_use",
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function repeatsEarlierAssistantAnswer(messages: unknown[]): boolean {
  const entries = messages as Array<{ role?: unknown; content?: unknown }>;
  const last = entries.at(-1);
  if (last?.role !== "assistant" || hasToolCallBlock(last.content)) return false;
  const current = visibleTextOf(last.content).trim();
  if (current.length === 0) return false;
  return entries.slice(0, -1).some(
    (entry) =>
      entry.role === "assistant"
      && visibleTextOf(entry.content).trim() === current,
  );
}

function buildDirective(
  toolNames: readonly string[],
  trigger: "repeated_answer" | "declared_mutation_request",
): string {
  const triggerFact = trigger === "repeated_answer"
    ? "Your last answer exactly repeated an earlier assistant answer."
    : "Capability metadata identifies the current wording as a direct mutation request.";
  return [
    "[comis: continuation — the current request still needs tool-backed action]",
    triggerFact,
    "No matching mutating tool action has succeeded in this turn.",
    `The active mutating tools matched to the current request are: ${toolNames.join(", ")}.`,
    "If the request is applicable, invoke a mutating action on the matching tool now.",
    "Read-only list, get, search, status, or inspect actions do not complete a change request.",
    "Otherwise, state the exact current blocker.",
    "Do not repeat the prior answer and do not claim success without a successful current-turn tool result.",
  ].join("\n");
}

export async function runRequestToolNudge(
  deps: RunRequestToolNudgeDeps,
): Promise<RequestToolNudgeOutcome> {
  const {
    capabilityClass,
    requestRelevantToolNames,
    currentSuccessfulMutationCount,
    logger,
    eventBus,
    sessionKey,
    clock,
    agentId,
  } = deps;
  if (capabilityClass !== "small" && capabilityClass !== "nano") {
    return {
      fired: false,
      recovered: false,
      matchedToolNames: [],
      outcome: "not_small_class",
    };
  }

  const matchedToolNames = requestRelevantToolNames.filter(
    (toolName) => getToolMetadata(toolName)?.isReadOnly === false,
  );
  if (matchedToolNames.length === 0) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames,
      outcome: "no_mutating_match",
    };
  }
  if (currentSuccessfulMutationCount() > 0) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames,
      outcome: "mutation_already_succeeded",
    };
  }
  const repeatedAnswer = repeatsEarlierAssistantAnswer(deps.messages);
  const declaredMutationRequest = matchedToolNames.some((toolName) =>
    matchesToolMutationRequest(toolName, deps.requestText)
  );
  if (!repeatedAnswer && !declaredMutationRequest) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames,
      outcome: "not_action_request",
    };
  }
  const trigger = repeatedAnswer ? "repeated_answer" : "declared_mutation_request";

  logger.info(
    {
      submodule: SUBMODULE,
      step: "request-tool-nudge",
      agentId,
      decision: "fire",
      reason: trigger,
      capabilityClass,
      matchedToolNames,
    },
    "Request-tool nudge firing",
  );

  const successfulMutationCountBefore = currentSuccessfulMutationCount();
  const continuation = await runContinuationTurn(
    deps.session,
    buildDirective(matchedToolNames, trigger),
    deps.guardProviderDispatch,
  );
  if (!continuation.ok) {
    logger.warn(
      {
        submodule: SUBMODULE,
        step: "request-tool-nudge",
        agentId,
        matchedToolNames,
        errorKind: "internal" as const,
        hint:
          "The bounded request-tool continuation failed; inspect provider admission "
          + "and the matched tool inventory in comis explain.",
      },
      "Request-tool nudge continuation failed",
    );
    emitObservationalEventSafely({ eventBus, logger }, "execution:recovery_attempted", {
      agentId: agentId ?? "default",
      sessionKey,
      reason: "request_tool_nudge",
      succeeded: false,
      timestamp: clock.now(),
    });
    return {
      fired: true,
      recovered: false,
      matchedToolNames,
      outcome: "followup_error",
    };
  }

  const response = deps.getVisibleAssistantText(deps.session);
  const successfulMutationCountAfter = currentSuccessfulMutationCount();
  const recovered =
    successfulMutationCountAfter > successfulMutationCountBefore
    && response.trim().length > 0;
  logger.info(
    {
      submodule: SUBMODULE,
      step: "request-tool-nudge",
      agentId,
      matchedToolNames,
      outcome: recovered ? "recovered" : "still_no_mutation",
      successfulMutationCountBefore,
      successfulMutationCountAfter,
    },
    "Request-tool nudge completed",
  );
  emitObservationalEventSafely({ eventBus, logger }, "execution:recovery_attempted", {
    agentId: agentId ?? "default",
    sessionKey,
    reason: "request_tool_nudge",
    succeeded: recovered,
    timestamp: clock.now(),
  });
  return recovered
    ? {
        fired: true,
        recovered: true,
        response,
        matchedToolNames,
        outcome: "recovered",
      }
    : {
        fired: true,
        recovered: false,
        matchedToolNames,
        outcome: "still_no_mutation",
      };
}
