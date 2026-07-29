// SPDX-License-Identifier: Apache-2.0
/** Composition helper for deterministic failed-completion locale rendering. */

import { buildBackgroundTaskFailedNotice, catalogFromLocalePacks } from "@comis/agent";
import type { AgentConfig } from "@comis/core";

export function createAnnouncementFailureNoticeRenderer(
  agents: Readonly<Record<string, AgentConfig>>,
): (agentId: string, resolvedLanguage?: string) => string {
  return (agentId, resolvedLanguage) => {
    const agentConfig = agents[agentId] ?? agents["default"];
    return buildBackgroundTaskFailedNotice(
      resolvedLanguage ?? agentConfig?.language,
      catalogFromLocalePacks(agentConfig?.localePacks),
    );
  };
}
