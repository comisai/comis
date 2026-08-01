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
import { extractMcpServerName } from "@comis/shared";
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
    | "no_tool_match"
    | "tool_already_succeeded"
    | "tool_work_deferred"
    | "tool_denied_terminally"
    | "not_action_request"
    | "recovered"
    | "still_no_tool_call"
    | "followup_error";
}

export interface RunRequestToolNudgeDeps {
  session: ContinuationTurnSession;
  requestText: string;
  messages: unknown[];
  capabilityClass: string | undefined;
  requestRelevantToolNames: readonly string[];
  currentSuccessfulMutationCount: () => number;
  currentSuccessfulToolCount: () => number;
  /** Accepted non-terminal handoffs for tools matched to this request. */
  currentDeferredWorkCount: () => number;
  /** Matching tool receipts carrying a terminal policy denial. */
  currentTerminalDenialCount: () => number;
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
const MAX_RECOVERY_GUIDANCE_CHARS = 800;

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

const EXTERNAL_ACTION_ATTEMPT_PATTERN =
  /\b(?:i|we)\s+(?:attempted|tried)\s+to\s+(?:access|apply|change|check|connect|create|delete|download|edit|fetch|install|invoke|modify|open|post|read|remove|restart|run|save|search|send|set|store|update|upload|verify|write)\b/iu;

const EXPLICIT_TOOL_USE_REQUEST_PATTERN =
  /\b(?:call|check|compare|fetch|get|inspect|invoke|look\s+up|query|read|run|search|test|use|verify)\b/iu;

function claimsExternalActionAttempt(messages: unknown[]): boolean {
  const entries = messages as Array<{ role?: unknown; content?: unknown }>;
  const last = entries.at(-1);
  return last?.role === "assistant"
    && !hasToolCallBlock(last.content)
    && EXTERNAL_ACTION_ATTEMPT_PATTERN.test(visibleTextOf(last.content));
}

function buildDirective(
  toolNames: readonly string[],
  trigger:
    | "repeated_answer"
    | "declared_mutation_request"
    | "claimed_action_attempt"
    | "explicit_tool_use_request",
): string {
  const triggerFact = trigger === "repeated_answer"
    ? "Your last answer exactly repeated an earlier assistant answer."
    : trigger === "declared_mutation_request"
      ? "Capability metadata identifies the current wording as a direct mutation request."
      : trigger === "claimed_action_attempt"
        ? "Your last answer claimed an external action attempt without a current-turn tool receipt."
        : "The current request explicitly asks to use a matched capability, but no current-turn tool receipt exists.";
  const capabilityGuidance = toolNames.flatMap((toolName) => {
    const guidance = getToolMetadata(toolName)?.mutationRecoveryGuidance?.trim();
    return guidance
      ? [`Capability-owned recovery for ${toolName}: ${guidance.slice(0, MAX_RECOVERY_GUIDANCE_CHARS)}`]
      : [];
  });
  return [
    "[comis: continuation — the current request still needs tool-backed action]",
    triggerFact,
    "No matching tool action has succeeded in this turn.",
    `The active tools matched to the current request are: ${toolNames.join(", ")}.`,
    "If the request is applicable, invoke the matching tools now and ground the answer in their current-turn results.",
    "Use exact identifiers from trusted operator policy and the current request; never guess or substitute a nearby target.",
    "Never infer a secret or credential name from its contents or the active channel.",
    ...capabilityGuidance,
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
    currentSuccessfulToolCount,
    currentDeferredWorkCount,
    currentTerminalDenialCount,
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
    (toolName) =>
      getToolMetadata(toolName)?.isReadOnly !== undefined
      || extractMcpServerName(toolName) !== undefined,
  );
  if (matchedToolNames.length === 0) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames,
      outcome: "no_tool_match",
    };
  }
  const mutatingToolNames = matchedToolNames.filter(
    (toolName) => getToolMetadata(toolName)?.isReadOnly === false,
  );
  const toolBackedReadNames = matchedToolNames.filter(
    (toolName) =>
      getToolMetadata(toolName)?.isReadOnly === true
      || extractMcpServerName(toolName) !== undefined,
  );
  const declaredMutationRequest = mutatingToolNames.some((toolName) =>
    matchesToolMutationRequest(toolName, deps.requestText)
  );
  const explicitToolUseRequest = toolBackedReadNames.length > 0
    && EXPLICIT_TOOL_USE_REQUEST_PATTERN.test(deps.requestText);
  const repeatedAnswer = repeatsEarlierAssistantAnswer(deps.messages);
  const claimedActionAttempt = claimsExternalActionAttempt(deps.messages);
  const mutationRecoveryRequested = mutatingToolNames.length > 0
    && (repeatedAnswer || declaredMutationRequest || claimedActionAttempt);
  const readRecoveryRequested = toolBackedReadNames.length > 0
    && (explicitToolUseRequest || claimedActionAttempt);
  if (!mutationRecoveryRequested && !readRecoveryRequested) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames,
      outcome: "not_action_request",
    };
  }
  const useReadRecovery = readRecoveryRequested && !mutationRecoveryRequested;
  const trigger = declaredMutationRequest
    ? "declared_mutation_request"
    : useReadRecovery && explicitToolUseRequest
      ? "explicit_tool_use_request"
      : repeatedAnswer
        ? "repeated_answer"
        : "claimed_action_attempt";
  const recoveryToolNames = useReadRecovery
    ? toolBackedReadNames
    : mutatingToolNames;
  const successfulCount = useReadRecovery
    ? currentSuccessfulToolCount
    : currentSuccessfulMutationCount;
  if (successfulCount() > 0) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames: recoveryToolNames,
      outcome: "tool_already_succeeded",
    };
  }
  if (currentTerminalDenialCount() > 0) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames: recoveryToolNames,
      outcome: "tool_denied_terminally",
    };
  }
  if (currentDeferredWorkCount() > 0) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames: recoveryToolNames,
      outcome: "tool_work_deferred",
    };
  }

  logger.info(
    {
      submodule: SUBMODULE,
      step: "request-tool-nudge",
      agentId,
      decision: "fire",
      reason: trigger,
      capabilityClass,
      matchedToolNames: recoveryToolNames,
    },
    "Request-tool nudge firing",
  );

  const successfulToolCountBefore = successfulCount();
  const continuation = await runContinuationTurn(
    deps.session,
    buildDirective(recoveryToolNames, trigger),
    deps.guardProviderDispatch,
  );
  if (!continuation.ok) {
    logger.warn(
      {
        submodule: SUBMODULE,
        step: "request-tool-nudge",
        agentId,
        matchedToolNames: recoveryToolNames,
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
      matchedToolNames: recoveryToolNames,
      outcome: "followup_error",
    };
  }

  const response = deps.getVisibleAssistantText(deps.session);
  const successfulToolCountAfter = successfulCount();
  const recovered =
    successfulToolCountAfter > successfulToolCountBefore
    && response.trim().length > 0;
  logger.info(
    {
      submodule: SUBMODULE,
      step: "request-tool-nudge",
      agentId,
      matchedToolNames: recoveryToolNames,
      outcome: recovered ? "recovered" : "still_no_tool_call",
      successfulToolCountBefore,
      successfulToolCountAfter,
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
        matchedToolNames: recoveryToolNames,
        outcome: "recovered",
      }
    : {
        fired: true,
        recovered: false,
        matchedToolNames: recoveryToolNames,
        outcome: "still_no_tool_call",
      };
}
