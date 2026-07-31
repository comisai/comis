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

export function translatePromptPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const requestRelevantToolNames = boundedToolNames(
    payload.requestRelevantToolNames,
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
