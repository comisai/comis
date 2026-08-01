// SPDX-License-Identifier: Apache-2.0
/** Suppress redundant paired recall already present in the live conversation tail. */

import {
  formatSessionKey,
  type MemorySearchResult,
  type SessionKey,
} from "@comis/core";

export interface RecentTailRecallPartition {
  kept: MemorySearchResult[];
  duplicateIds: string[];
}

function pairedUserText(content: string): string | undefined {
  const prefix = "[user] ";
  const separator = "\n[agent] ";
  if (!content.startsWith(prefix)) return undefined;
  const separatorIndex = content.indexOf(separator, prefix.length);
  if (separatorIndex < 0) return undefined;
  return content.slice(prefix.length, separatorIndex).trim();
}

/**
 * Partition only exact duplicates of user turns already carried by the current
 * session context. Distinct same-session memories and every cross-session
 * memory remain eligible; pinned entries remain authoritative.
 */
export function partitionRecentTailRecall(
  results: readonly MemorySearchResult[],
  sessionKey: SessionKey,
  recentUserTurns: readonly string[],
): RecentTailRecallPartition {
  if (recentUserTurns.length === 0 || results.length === 0) {
    return { kept: [...results], duplicateIds: [] };
  }
  const currentSessionKey = formatSessionKey(sessionKey);
  const currentTurns = new Set(
    recentUserTurns.map((turn) => turn.trim()).filter((turn) => turn.length > 0),
  );
  const kept: MemorySearchResult[] = [];
  const duplicateIds: string[] = [];
  for (const result of results) {
    const isPaired = result.entry.tags.includes("paired")
      && result.entry.tags.includes("conversation");
    const userText = isPaired ? pairedUserText(result.entry.content) : undefined;
    const duplicate = result.entry.pinned !== true
      && result.entry.source.sessionKey === currentSessionKey
      && userText !== undefined
      && currentTurns.has(userText);
    if (duplicate) duplicateIds.push(result.entry.id);
    else kept.push(result);
  }
  return { kept, duplicateIds };
}
