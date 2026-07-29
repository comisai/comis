// SPDX-License-Identifier: Apache-2.0
/** Typed durable projection for non-activating group chatter. */

import {
  GroupHistoryContextEntrySchema,
  MAX_GROUP_HISTORY_CONTEXT_MESSAGES,
  type GroupHistoryContextEntry,
} from "@comis/core";
import { z } from "zod";

const GROUP_HISTORY_STORAGE_KIND = "comis.group-history-context";

const StoredGroupHistoryEntrySchema = GroupHistoryContextEntrySchema.extend({
  kind: z.literal(GROUP_HISTORY_STORAGE_KIND),
});

export interface GroupHistorySelection {
  readonly entries: GroupHistoryContextEntry[];
  readonly charCount: number;
  readonly invalidCount: number;
}

export function createStoredGroupHistoryEntry(
  entry: GroupHistoryContextEntry,
): z.infer<typeof StoredGroupHistoryEntrySchema> {
  return {
    kind: GROUP_HISTORY_STORAGE_KIND,
    ...entry,
  };
}

export function appendStoredGroupHistory(
  rows: readonly unknown[],
  entry: GroupHistoryContextEntry,
  configuredLimit: number,
): unknown[] {
  const retainedCount = Math.max(0, configuredLimit - 1);
  const retained = retainedCount === 0 ? [] : rows.slice(-retainedCount);
  return [...retained, createStoredGroupHistoryEntry(entry)];
}

export function selectStoredGroupHistory(
  rows: readonly unknown[],
  configuredLimit: number,
): GroupHistorySelection {
  const entries: GroupHistoryContextEntry[] = [];
  let invalidCount = 0;

  for (const row of rows) {
    if (
      typeof row !== "object"
      || row === null
      || !("kind" in row)
      || row.kind !== GROUP_HISTORY_STORAGE_KIND
    ) {
      continue;
    }
    const parsed = StoredGroupHistoryEntrySchema.safeParse(row);
    if (!parsed.success) {
      invalidCount += 1;
      continue;
    }
    entries.push({
      senderId: parsed.data.senderId,
      text: parsed.data.text,
    });
  }

  const limit = Math.min(configuredLimit, MAX_GROUP_HISTORY_CONTEXT_MESSAGES);
  const selected = entries.slice(-limit);
  const charCount = selected.reduce(
    (total, entry) => total + entry.senderId.length + entry.text.length + 4,
    Math.max(0, selected.length - 1),
  );
  return { entries: selected, charCount, invalidCount };
}
