// SPDX-License-Identifier: Apache-2.0
/** Bounded recovery for small models that repeat an old answer instead of acting. */

import {
  emitObservationalEventSafely,
  getToolMetadata,
  matchesToolMutationRequest,
  scrubSecretsFromText,
  wrapExternalContent,
  type ClockPort,
  type ComisLogger,
  type TypedEventBus,
} from "@comis/core";
import { extractMcpServerName, tryCatch } from "@comis/shared";
import {
  runContinuationTurn,
  type ContinuationTurnSession,
} from "./continuation-turn.js";
import type { ProviderDispatchGuard } from "./provider-dispatch.js";
import { isRuntimeSelfReportRequest } from "./response-grounding.js";

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
  requestRelevantPromptSkillNames?: readonly string[];
  requestRelevantPromptSkillLocations?: readonly string[];
  requestRelevantPromptSkillWorkflowToolNames?: readonly string[];
  requestRelevantPromptSkillMinDistinctWebFetchUrls?: number;
  requestRelevantPromptSkillWorkflowContext?: string;
  currentSuccessfulMutationCount: () => number;
  currentSuccessfulToolCount: (toolNames?: readonly string[]) => number;
  currentDistinctSuccessfulWebFetchUrlCount?: () => number;
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
const MAX_WORKFLOW_RECEIPT_CHARS = 3_000;

interface WebFetchReceiptRecord {
  readonly toolName: string;
  readonly success: boolean;
  readonly citationUrlDigest?: string;
}

/** Count successful fetched URLs without exposing their values. */
export function countDistinctSuccessfulWebFetchUrls(
  records: readonly WebFetchReceiptRecord[],
): number {
  return new Set(records.flatMap((record) =>
    record.toolName === "web_fetch"
      && record.success
      && record.citationUrlDigest !== undefined
      ? [record.citationUrlDigest]
      : []
  )).size;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function visibleTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as any[])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join(" ");
}

function workflowArgumentHint(context: string): string | undefined {
  const terms = context.match(/[\p{L}\p{N}]+/gu) ?? [];
  const hint = terms.slice(-4).join(" ");
  return hint.length > 0 ? hint : undefined;
}

function currentWorkflowToolReceipts(
  messages: readonly unknown[],
  workflowToolNames: readonly string[],
): string | undefined {
  const names = new Set(workflowToolNames);
  const entries = messages as Array<{
    role?: unknown;
    toolName?: unknown;
    content?: unknown;
    isError?: unknown;
  }>;
  const requestIndex = entries.findLastIndex((entry) =>
    entry.role === "user"
    && !visibleTextOf(entry.content).includes("[comis: continuation —")
  );
  const receipts = entries.slice(requestIndex + 1).flatMap((entry) => {
    if (
      entry.role !== "toolResult"
      || typeof entry.toolName !== "string"
      || !names.has(entry.toolName)
    ) return [];
    const text = scrubSecretsFromText(visibleTextOf(entry.content)).text.trim();
    return text.length > 0
      ? [{ toolName: entry.toolName, failed: entry.isError === true, text }]
      : [];
  });
  if (receipts.length === 0) return undefined;
  const perReceiptChars = Math.max(
    120,
    Math.floor((MAX_WORKFLOW_RECEIPT_CHARS - receipts.length * 40) / receipts.length),
  );
  return receipts.map((receipt, index) => [
    `Receipt ${index + 1}: ${receipt.failed ? "failed" : "successful"} ${receipt.toolName}`,
    receipt.text.slice(0, perReceiptChars),
  ].join("\n")).join("\n\n").slice(0, MAX_WORKFLOW_RECEIPT_CHARS).trim();
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
  /\b(?:call|check|compare|discover|fetch|find|get|inspect|invoke|look\s+up|query|read|run|search|test|use|verify)\b/iu;

function claimsExternalActionAttempt(messages: unknown[]): boolean {
  const entries = messages as Array<{ role?: unknown; content?: unknown }>;
  const last = entries.at(-1);
  return last?.role === "assistant"
    && !hasToolCallBlock(last.content)
    && EXTERNAL_ACTION_ATTEMPT_PATTERN.test(visibleTextOf(last.content));
}

function buildDirective(
  toolNames: readonly string[],
  promptSkillNames: readonly string[],
  promptSkillLocations: readonly string[],
  promptSkillWorkflowToolNames: readonly string[],
  promptSkillWorkflowContext: string | undefined,
  minDistinctWebFetchUrls: number | undefined,
  distinctWebFetchUrlCount: number,
  trigger:
    | "repeated_answer"
    | "declared_mutation_request"
    | "claimed_action_attempt"
    | "explicit_tool_use_request"
    | "prompt_skill_route"
    | "runtime_self_report",
): string {
  const triggerFact = trigger === "repeated_answer"
    ? "Your last answer exactly repeated an earlier assistant answer."
    : trigger === "declared_mutation_request"
      ? "Capability metadata identifies the current wording as a direct mutation request."
      : trigger === "claimed_action_attempt"
      ? "Your last answer claimed an external action attempt without a current-turn tool receipt."
      : trigger === "runtime_self_report"
        ? "The current request asks for a runtime self-report, but no current obs_query receipt exists."
        : trigger === "prompt_skill_route"
          ? "Capability routing identified a request-relevant prompt skill, but its procedure was not loaded."
        : "The current request explicitly asks to use a matched capability, but no current-turn tool receipt exists.";
  const capabilityGuidance = toolNames.flatMap((toolName) => {
    const guidance = getToolMetadata(toolName)?.mutationRecoveryGuidance?.trim();
    return guidance
      ? [`Capability-owned recovery for ${toolName}: ${guidance.slice(0, MAX_RECOVERY_GUIDANCE_CHARS)}`]
      : [];
  });
  const promptSkillGuidance = promptSkillNames.length > 0
    ? [
        `The request-relevant prompt skills are: ${promptSkillNames.join(", ")}.`,
        promptSkillLocations.length > 0
          ? `Use read with this exact trusted registry location: ${promptSkillLocations.join(", ")}.`
          : "Use read with the exact <location> for the best match from Available Skills; never guess a generic path.",
        ...(promptSkillWorkflowToolNames.length > 0
          ? [`After loading it, complete the procedure with these required workflow tools: ${promptSkillWorkflowToolNames.join(", ")}.`]
          : []),
        ...(minDistinctWebFetchUrls === undefined
          ? []
          : [
              `Content-free receipts currently prove ${distinctWebFetchUrlCount} of ${minDistinctWebFetchUrls} distinct successful web_fetch URLs.`,
              "Only a successful fetch of a new URL advances that evidence count; a duplicate URL does not.",
            ]),
        ...(promptSkillWorkflowContext
          ? [
              "Derive context-dependent workflow arguments from this immediately preceding user request; do not pass the current elliptical wording literally:",
              wrapExternalContent(promptSkillWorkflowContext, {
                source: "channel_history",
                includeWarning: true,
              }),
              ...(workflowArgumentHint(promptSkillWorkflowContext)
                ? [
                    `Concrete workflow argument hint: ${JSON.stringify(workflowArgumentHint(promptSkillWorkflowContext))}. Use these prior-request terms instead of terms from the current elliptical wording.`,
                  ]
                : []),
            ]
          : []),
      ]
    : [];
  return [
    "[comis: continuation — the current request still needs tool-backed action]",
    triggerFact,
    "No matching tool action has succeeded in this turn.",
    `The active tools matched to the current request are: ${toolNames.join(", ")}.`,
    "If the request is applicable, invoke the matching tools now and ground the answer in their current-turn results.",
    "Use exact identifiers from trusted operator policy and the current request; never guess or substitute a nearby target.",
    "Never infer a secret or credential name from its contents or the active channel.",
    ...promptSkillGuidance,
    ...capabilityGuidance,
    "Read-only list, get, search, status, or inspect actions do not complete a change request.",
    "Otherwise, state the exact current blocker.",
    "Do not repeat the prior answer and do not claim success without a successful current-turn tool result.",
  ].join("\n");
}

function buildPromptSkillWorkflowDirective(
  workflowToolNames: readonly string[],
  promptSkillLocations: readonly string[],
  actionToolNames: readonly string[],
  minDistinctWebFetchUrls: number | undefined,
  distinctWebFetchUrlCount: number,
  workflowContext?: string,
): string {
  const requestedActionToolNames = promptSkillLocations.length > 0
    ? actionToolNames.filter((toolName) => toolName !== "read")
    : actionToolNames;
  const priorRequest = workflowContext
    ? wrapExternalContent(workflowContext, {
        source: "channel_history",
        includeWarning: true,
      })
    : undefined;
  return [
    "[comis: continuation — the loaded prompt skill workflow is still pending]",
    "The request-relevant prompt skill procedure has not completed the requested action.",
    ...(promptSkillLocations.length > 0
      ? [`If it is not loaded yet, use read with: ${promptSkillLocations.join(", ")}.`]
      : []),
    `Complete its supporting workflow with: ${workflowToolNames.join(", ")}.`,
    ...(minDistinctWebFetchUrls === undefined
      ? []
      : [
          `Content-free receipts currently prove ${distinctWebFetchUrlCount} of ${minDistinctWebFetchUrls} distinct successful web_fetch URLs.`,
          "Fetch new URLs until the receipt count reaches the required minimum; duplicate URLs do not advance it.",
        ]),
    "Use supporting workflow tools only for commands prescribed by the loaded procedure; do not use exec to reread the skill manifest.",
    ...(requestedActionToolNames.length > 0
      ? [`Complete the requested action with: ${requestedActionToolNames.join(", ")}.`]
      : []),
    priorRequest
      ? `The immediately preceding user request was:\n${priorRequest}`
      : "Resolve context-dependent arguments from the recent user requests already in context.",
    "Derive concrete workflow arguments from that prior request; do not pass the current elliptical wording literally.",
    "After a successful workflow result, follow the loaded procedure's response contract and preserve its canonical identifiers.",
    "Do not repeat the skill read or a previously attempted tool path, and do not claim completion without a successful workflow-tool receipt.",
  ].join("\n");
}

function buildPromptSkillResultNarrationDirective(receipts?: string): string {
  return [
    "[comis: continuation — narrate the completed prompt skill workflow]",
    "A required prompt-skill workflow tool succeeded in this turn.",
    "Give the final user-facing answer now from that successful receipt.",
    "Follow the loaded procedure's response contract exactly and preserve canonical identifiers from the result.",
    "Use only current-turn workflow receipts as evidence for current success, failure, availability, and citations.",
    "Do not carry an earlier failure or unavailable-source claim into this answer; mention one only when a current-turn tool receipt records it, using its exact identifier.",
    "Every cited URL must come from a successful current-turn web_fetch receipt.",
    ...(receipts
      ? [
          "The bounded current-turn workflow receipts are:",
          wrapExternalContent(receipts, { source: "unknown", includeWarning: true }),
        ]
      : []),
    "Do not invoke another tool, ask for context already supplied, or replace a specific result with a generic capability.",
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
  const runtimeSelfReportRequest = isRuntimeSelfReportRequest(deps.requestText);
  const activeToolNames = deps.session.getActiveToolNames === undefined
    ? undefined
    : tryCatch(() => deps.session.getActiveToolNames!());
  const obsQueryActive = activeToolNames?.ok === true
    ? activeToolNames.value.includes("obs_query")
    : requestRelevantToolNames.includes("obs_query");
  const effectiveRelevantToolNames = runtimeSelfReportRequest && obsQueryActive
    ? [...new Set([...requestRelevantToolNames, "obs_query"])]
    : requestRelevantToolNames;

  const runtimeSelfReportRecovery = runtimeSelfReportRequest && obsQueryActive;
  const promptSkillRecovery =
    (deps.requestRelevantPromptSkillNames?.length ?? 0) > 0
    && (deps.requestRelevantPromptSkillLocations?.length ?? 0) > 0;
  const promptSkillProcedureLoaded = () =>
    !promptSkillRecovery || currentSuccessfulToolCount(["read"]) > 0;
  const minDistinctWebFetchUrls =
    deps.requestRelevantPromptSkillMinDistinctWebFetchUrls;
  const distinctWebFetchUrlCount = () =>
    deps.currentDistinctSuccessfulWebFetchUrlCount?.() ?? 0;
  const webFetchEvidenceSatisfied = () =>
    minDistinctWebFetchUrls === undefined
    || distinctWebFetchUrlCount() >= minDistinctWebFetchUrls;
  if (
    capabilityClass !== "small"
    && capabilityClass !== "nano"
    && !runtimeSelfReportRecovery
    && !promptSkillRecovery
  ) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames: [],
      outcome: "not_small_class",
    };
  }

  const matchedToolNames = effectiveRelevantToolNames.filter(
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
    && (
      explicitToolUseRequest
      || claimedActionAttempt
      || runtimeSelfReportRecovery
      || promptSkillRecovery
    );
  if (!mutationRecoveryRequested && !readRecoveryRequested) {
    return {
      fired: false,
      recovered: false,
      matchedToolNames,
      outcome: "not_action_request",
    };
  }
  const useReadRecovery = readRecoveryRequested && !mutationRecoveryRequested;
  const trigger = runtimeSelfReportRecovery
    ? "runtime_self_report"
    : declaredMutationRequest
      ? "declared_mutation_request"
      : promptSkillRecovery
        ? "prompt_skill_route"
        : useReadRecovery && explicitToolUseRequest
          ? "explicit_tool_use_request"
          : repeatedAnswer
            ? "repeated_answer"
            : "claimed_action_attempt";
  const recoveryToolNames = runtimeSelfReportRecovery
    ? ["obs_query"]
    : useReadRecovery
      ? toolBackedReadNames
      : mutatingToolNames;
  const successfulCount = useReadRecovery
    ? () => currentSuccessfulToolCount(recoveryToolNames)
    : currentSuccessfulMutationCount;
  if (
    successfulCount() > 0
    && webFetchEvidenceSatisfied()
    && promptSkillProcedureLoaded()
  ) {
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
  const continuationOptions = (deps.requestRelevantPromptSkillNames?.length ?? 0) > 0
    ? undefined
    : { restrictToToolNames: recoveryToolNames };
  let continuation = await runContinuationTurn(
    deps.session,
    buildDirective(
      recoveryToolNames,
      deps.requestRelevantPromptSkillNames ?? [],
      deps.requestRelevantPromptSkillLocations ?? [],
      deps.requestRelevantPromptSkillWorkflowToolNames ?? [],
      deps.requestRelevantPromptSkillWorkflowContext,
      minDistinctWebFetchUrls,
      distinctWebFetchUrlCount(),
      trigger,
    ),
    deps.guardProviderDispatch,
    continuationOptions,
  );
  const promptSkillWorkflowTools = deps.requestRelevantPromptSkillWorkflowToolNames ?? [];
  const workflowEvidencePending = minDistinctWebFetchUrls !== undefined
    && !webFetchEvidenceSatisfied();
  if (
    continuation.ok
    && promptSkillWorkflowTools.length > 0
    && (
      workflowEvidencePending
      || successfulCount() === successfulToolCountBefore
      || !promptSkillProcedureLoaded()
    )
  ) {
    logger.info(
      {
        submodule: SUBMODULE,
        step: "prompt-skill-workflow-nudge",
        agentId,
        workflowToolNames: promptSkillWorkflowTools,
        minDistinctWebFetchUrls,
        distinctWebFetchUrlCount: distinctWebFetchUrlCount(),
      },
      "Loaded prompt skill requires one bounded workflow continuation",
    );
    const workflowRecoveryTools = [...new Set([
      ...(deps.requestRelevantPromptSkillLocations?.length ? ["read"] : []),
      ...promptSkillWorkflowTools,
      ...recoveryToolNames,
    ])];
    continuation = await runContinuationTurn(
      deps.session,
      buildPromptSkillWorkflowDirective(
        promptSkillWorkflowTools,
        deps.requestRelevantPromptSkillLocations ?? [],
        recoveryToolNames,
        minDistinctWebFetchUrls,
        distinctWebFetchUrlCount(),
        deps.requestRelevantPromptSkillWorkflowContext,
      ),
      deps.guardProviderDispatch,
      { restrictToToolNames: workflowRecoveryTools },
    );
  }
  const evidenceGatedWorkflowCompleted = minDistinctWebFetchUrls !== undefined
    && webFetchEvidenceSatisfied();
  const promptSkillWorkflowCompleted = (
    promptSkillProcedureLoaded() || evidenceGatedWorkflowCompleted
  )
    && (minDistinctWebFetchUrls === undefined
      ? successfulCount() > successfulToolCountBefore
      : webFetchEvidenceSatisfied());
  if (
    continuation.ok
    && promptSkillWorkflowTools.length > 0
    && promptSkillWorkflowCompleted
  ) {
    logger.info(
      {
        submodule: SUBMODULE,
        step: "prompt-skill-result-narration",
        agentId,
        workflowToolNames: promptSkillWorkflowTools,
      },
      "Successful prompt skill workflow requires one bounded result narration",
    );
    continuation = await runContinuationTurn(
      deps.session,
      buildPromptSkillResultNarrationDirective(
        currentWorkflowToolReceipts(deps.messages, promptSkillWorkflowTools),
      ),
      deps.guardProviderDispatch,
      { restrictToToolNames: [] },
    );
  }
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
  const procedureCompletionProvable = (
    promptSkillProcedureLoaded() || evidenceGatedWorkflowCompleted
  )
    && (minDistinctWebFetchUrls === undefined
      ? !(
          useReadRecovery
          && (deps.requestRelevantPromptSkillNames?.length ?? 0) > 0
          && promptSkillWorkflowTools.length > 0
        )
      : webFetchEvidenceSatisfied());
  const recovered =
    (
      successfulToolCountAfter > successfulToolCountBefore
      || promptSkillWorkflowCompleted
    )
    && response.trim().length > 0
    && procedureCompletionProvable;
  logger.info(
    {
      submodule: SUBMODULE,
      step: "request-tool-nudge",
      agentId,
      matchedToolNames: recoveryToolNames,
      outcome: recovered ? "recovered" : "still_no_tool_call",
      successfulToolCountBefore,
      successfulToolCountAfter,
      procedureCompletionProvable,
      minDistinctWebFetchUrls,
      distinctWebFetchUrlCount: distinctWebFetchUrlCount(),
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
