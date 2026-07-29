// SPDX-License-Identifier: Apache-2.0
/** Composition helper for deterministic failed-completion locale rendering. */

import { buildBackgroundTaskFailedNotice, catalogFromLocalePacks } from "@comis/agent";
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
): (agentId: string, resolvedLanguage?: string) => string {
  return (agentId, resolvedLanguage) => {
    const agentConfig = agents[agentId] ?? agents["default"];
    return buildBackgroundTaskFailedNotice(
      deterministicReplyLocale(resolvedLanguage, agentConfig?.language),
      catalogFromLocalePacks(agentConfig?.localePacks),
    );
  };
}
