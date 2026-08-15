// SPDX-License-Identifier: Apache-2.0
/** Content-free prompt-submission trajectory translation. */

import { boundedUnavailableSkills } from "./translate-skill-availability.js";

function boundedToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = [...new Set(value.filter(
    (name): name is string =>
      typeof name === "string"
      && /^[A-Za-z0-9_.:-]{1,128}$/u.test(name),
  ))].slice(0, 16);
  return names.length > 0 ? names : undefined;
}

function boundedRequestRelevanceHistory(value: unknown): {
  turnCount: number;
  charCount: number;
  saturated: boolean;
  recallDisposition?: "search" | "skip_oversized_token";
} | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.turnCount)
    || (record.turnCount as number) < 0
    || (record.turnCount as number) > 8
    || !Number.isSafeInteger(record.charCount)
    || (record.charCount as number) < 0
    || (record.charCount as number) > 1_000_000
    || typeof record.saturated !== "boolean"
  ) return undefined;
  return {
    turnCount: record.turnCount as number,
    charCount: record.charCount as number,
    saturated: record.saturated,
    ...(record.recallDisposition === "search"
      || record.recallDisposition === "skip_oversized_token"
      ? { recallDisposition: record.recallDisposition }
      : {}),
  };
}

function boundedOperatorPolicyToolProjections(value: unknown): Array<{
  toolName: string;
  sectionId: string;
  contentHash: string;
  projectedChars: number;
}> | undefined {
  if (!Array.isArray(value)) return undefined;
  const projections = value.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.toolName !== "string"
      || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(record.toolName)
      || typeof record.sectionId !== "string"
      || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(record.sectionId)
      || typeof record.contentHash !== "string"
      || !/^[a-f0-9]{64}$/u.test(record.contentHash)
      || !Number.isSafeInteger(record.projectedChars)
      || (record.projectedChars as number) < 0
      || (record.projectedChars as number) > 5_000
    ) return [];
    return [{
      toolName: record.toolName,
      sectionId: record.sectionId,
      contentHash: record.contentHash,
      projectedChars: record.projectedChars as number,
    }];
  }).slice(0, 16);
  return projections.length > 0 ? projections : undefined;
}

export function translatePromptPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const requestRelevantToolNames = boundedToolNames(
    payload.requestRelevantToolNames,
  );
  const requestRelevantPromptSkillNames = boundedToolNames(
    payload.requestRelevantPromptSkillNames,
  );
  const requestRelevanceHistory = boundedRequestRelevanceHistory(
    payload.requestRelevanceHistory,
  );
  const operatorPolicyToolProjections = boundedOperatorPolicyToolProjections(
    payload.operatorPolicyToolProjections,
  );
  return {
    promptChars: payload.promptChars,
    provider: payload.provider,
    modelId: payload.modelId,
    messageCount: payload.messageCount,
    systemDigest: payload.systemDigest,
    messagesDigest: payload.messagesDigest,
    ...(payload.inboundKind === "message" || payload.inboundKind === "edit"
      ? { inboundKind: payload.inboundKind }
      : {}),
    ...(Array.isArray(payload.unavailableSkills)
      ? { unavailableSkills: boundedUnavailableSkills(payload.unavailableSkills) }
      : {}),
    ...(requestRelevantToolNames !== undefined
      ? { requestRelevantToolNames }
      : {}),
    ...(requestRelevantPromptSkillNames !== undefined
      ? { requestRelevantPromptSkillNames }
      : {}),
    ...(requestRelevanceHistory !== undefined
      ? { requestRelevanceHistory }
      : {}),
    ...(operatorPolicyToolProjections !== undefined
      ? { operatorPolicyToolProjections }
      : {}),
    ...(typeof payload.groupHistoryMessageCount === "number"
      ? { groupHistoryMessageCount: payload.groupHistoryMessageCount }
      : {}),
    ...(typeof payload.groupHistoryCharCount === "number"
      ? { groupHistoryCharCount: payload.groupHistoryCharCount }
      : {}),
    ...(typeof payload.responseLocale === "string"
      ? { responseLocale: payload.responseLocale }
      : {}),
    ...(payload.responseLocaleSource === "request"
      || payload.responseLocaleSource === "explicit"
      || payload.responseLocaleSource === "unset"
      ? { responseLocaleSource: payload.responseLocaleSource }
      : {}),
    ...(typeof payload.responseLocaleEnforced === "boolean"
      ? { responseLocaleEnforced: payload.responseLocaleEnforced }
      : {}),
  };
}
