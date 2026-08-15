// SPDX-License-Identifier: Apache-2.0
/** Prompt-runner adapter for request-tool recovery and prompt-skill completion. */

import { classifyToolInvocationMutation, formatSessionKey } from "@comis/core";
import {
  countDistinctSuccessfulWebFetchUrls,
  countDistinctSuccessfulWebSearchQueries,
  isRecoveryEvidenceToolName,
  runRequestToolNudge,
} from "../request-tool-nudge.js";
import { isReadOnlyTool } from "../tool-parallelism.js";
import { getVisibleAssistantText } from "../phase-filter.js";
import { resolveProviderDispatchGuard } from "../provider-dispatch.js";
import { hasAcceptedDelegation } from "./accepted-delegation.js";
import type { RunPromptParams } from "./prompt-runner-types.js";

export function hasEnforcedPromptSkillRoute(params: RunPromptParams): boolean {
  return (params.requestRelevantPromptSkillNames?.length ?? 0) > 0
    && (params.requestRelevantPromptSkillLocations?.length ?? 0) > 0;
}

/** Run request-tool recovery without treating an accepted child as parent-work evidence. */
export async function runRequestToolNudgeStep(params: RunPromptParams): Promise<void> {
  const { session, agentId, result, deps } = params;
  if (result.narrateNudge?.fired === true) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionMessages: unknown[] = (session as any).messages ?? [];
  const records = () => params.bridge.getResult().toolExecResults ?? [];
  const excludeDelegationReceipt = hasEnforcedPromptSkillRoute(params)
    && hasAcceptedDelegation(records());
  const successfulDiscoveredEvidenceToolNames = records().filter(
    (record) => record.success
      && record.backgrounded !== true
      && isRecoveryEvidenceToolName(record.toolName)
      && isReadOnlyTool(record.toolName)
      && params.isDeferredToolDiscovered?.(record.toolName) === true,
  ).map((record) => record.toolName);
  const recoveryRelevantToolNames = [...new Set([
    ...(params.requestRelevantToolNames ?? []).filter(
      (toolName) => !excludeDelegationReceipt || toolName !== "sessions_spawn",
    ),
    ...successfulDiscoveredEvidenceToolNames,
  ])];
  const outcome = await runRequestToolNudge({
    session,
    requestText: params.msg.originalMessages?.map((message) => message.text).join("\n") ?? params.msg.text,
    messages: sessionMessages,
    capabilityClass: params.modelProfile?.capabilityClass,
    requestRelevantToolNames: recoveryRelevantToolNames,
    requestRelevantPromptSkillNames: params.requestRelevantPromptSkillNames ?? [],
    requestRelevantPromptSkillLocations: params.requestRelevantPromptSkillLocations ?? [],
    requestRelevantPromptSkillWorkflowToolNames: params.requestRelevantPromptSkillWorkflowToolNames ?? [],
    requestRelevantPromptSkillMinDistinctWebFetchUrls: params.requestRelevantPromptSkillMinDistinctWebFetchUrls,
    requestRelevantPromptSkillMinDistinctWebSearchQueries: params.requestRelevantPromptSkillMinDistinctWebSearchQueries,
    requestRelevantPromptSkillWorkflowContext: params.requestRelevantPromptSkillWorkflowContext,
    currentSuccessfulMutationCount: () => records().filter(
      (record) => record.success
        && (!excludeDelegationReceipt || record.toolName !== "sessions_spawn")
        && classifyToolInvocationMutation(
          record.toolName,
          record.action === undefined ? {} : { action: record.action },
        ) === "mutating",
    ).length,
    currentSuccessfulToolCount: (toolNames) => {
      const completionNames = (params.requestRelevantPromptSkillWorkflowToolNames?.length ?? 0) > 0
        ? params.requestRelevantPromptSkillWorkflowToolNames
        : recoveryRelevantToolNames;
      const relevantNames = new Set(toolNames ?? completionNames ?? []);
      return records().filter((record) =>
        record.success && relevantNames.has(record.toolName)
      ).length;
    },
    currentSuccessfulNonWorkflowToolCount: (toolNames) => {
      const relevantNames = toolNames === undefined ? undefined : new Set(toolNames);
      const workflowNames = new Set([
        ...(params.requestRelevantPromptSkillWorkflowToolNames ?? []),
        ...((params.requestRelevantPromptSkillLocations?.length ?? 0) > 0 ? ["read"] : []),
      ]);
      return records().filter(
        (record) => record.success && record.backgrounded !== true
          && isRecoveryEvidenceToolName(record.toolName)
          && isReadOnlyTool(record.toolName)
          && (relevantNames === undefined || relevantNames.has(record.toolName))
          && !workflowNames.has(record.toolName),
      ).length;
    },
    currentDistinctSuccessfulWebFetchUrlCount: () =>
      countDistinctSuccessfulWebFetchUrls(records()),
    currentDistinctSuccessfulWebSearchQueryCount: () =>
      countDistinctSuccessfulWebSearchQueries(records()),
    currentDeferredWorkCount: () => {
      const relevantNames = new Set(recoveryRelevantToolNames);
      return records().filter(
        (record) => record.backgrounded === true && relevantNames.has(record.toolName),
      ).length;
    },
    currentTerminalDenialCount: () => {
      const relevantNames = new Set(recoveryRelevantToolNames);
      return records().filter(
        (record) => !record.success && record.failureCode === "permission_denied"
          && relevantNames.has(record.toolName),
      ).length;
    },
    logger: deps.logger,
    eventBus: deps.eventBus,
    sessionKey: formatSessionKey(params.sessionKey),
    clock: deps.clock,
    agentId,
    getVisibleAssistantText,
    guardProviderDispatch: resolveProviderDispatchGuard(params.executionOverrides?.onProviderStart),
  });
  if (outcome.recovered && outcome.response) {
    result.response = outcome.response;
  }
  if (outcome.fired) {
    result.requestToolNudge = {
      fired: true,
      recovered: outcome.recovered,
      matchedToolNames: outcome.matchedToolNames,
    };
  }
}
