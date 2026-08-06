// SPDX-License-Identifier: Apache-2.0
/** Composition helper for deterministic failed-completion locale rendering. */

import {
  buildBackgroundTaskFailedNotice,
  buildLoopDetectedReply,
  catalogFromLocalePacks,
} from "@comis/agent";
import type { AgentConfig } from "@comis/core";
import { tryCatch } from "@comis/shared";

function deterministicReplyLocale(
  resolvedLanguage: string | undefined,
  configuredLanguage: string | undefined,
): string | undefined {
  if (resolvedLanguage === undefined) return configuredLanguage;
  const parsed = tryCatch(() => new Intl.Locale(resolvedLanguage));
  return parsed.ok
    && typeof parsed.value.language === "string"
    && parsed.value.language !== "und"
    ? resolvedLanguage
    : configuredLanguage ?? resolvedLanguage;
}

export function createAnnouncementFailureNoticeRenderer(
  agents: Readonly<Record<string, AgentConfig>>,
): (agentId: string, resolvedLanguage?: string, finishReason?: string) => string {
  return (agentId, resolvedLanguage, finishReason) => {
    const agentConfig = agents[agentId] ?? agents["default"];
    const language = deterministicReplyLocale(resolvedLanguage, agentConfig?.language);
    const localeCatalog = catalogFromLocalePacks(agentConfig?.localePacks);
    const failureNotice = buildBackgroundTaskFailedNotice(language, localeCatalog);
    return finishReason === "loop_detected"
      ? `${failureNotice}\n\n${buildLoopDetectedReply({ language, localeCatalog })}`
      : failureNotice;
  };
}
