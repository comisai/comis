// SPDX-License-Identifier: Apache-2.0
/**
 * Small store-read helpers for the LCD leaf pass, extracted from
 * lcd-compaction-trigger.ts (file-size invariant: ≤800 lines — the trigger sits
 * at the cap). BYTE-IDENTICAL
 * relocations — same signatures, same bodies, same scoping; no behavior change.
 *
 * Both read the injected `ContextStorePort` agent+tenant-scoped via `scope`
 * and are pure beyond that read.
 *
 * @module
 */

import type { ContextStorePort, ContextStoreScope } from "@comis/core";

/**
 * The most recent summary's content for continuity (the leaf summarizer's 8th
 * param), or undefined when none exists. The read is agent + tenant scoped via
 * `scope`. Returns the last summary of ANY kind.
 */
export function previousSummaryContent(
  store: ContextStorePort,
  scope: ContextStoreScope,
): string | undefined {
  const summaries = store.getSummaries(scope);
  if (summaries.length === 0) return undefined;
  return summaries[summaries.length - 1]!.content;
}

/**
 * Map the selected chunk's first/last covered message id to the contiguous
 * `context_items` ordinal window `[startOrdinal, endOrdinal]`,
 * using the `ordinalById` map built by `resolveContext` from the SAME resolved
 * view the chunk was selected from. `startOrdinal` is the ordinal of the chunk's
 * FIRST message id; `endOrdinal` the LAST. Because both the chunk and the map
 * derive from one resolved `context_items` walk, the lookup always succeeds for a
 * selected message-ref — the divergence path is retained only as a defensive
 * guard against a future non-1:1 mapping (it never corrupts ordering).
 */
export function chunkOrdinalWindow(
  ordinalById: Map<string, number>,
  firstMessageId: string,
  lastMessageId: string,
): { startOrdinal: number; endOrdinal: number } | undefined {
  const startOrdinal = ordinalById.get(firstMessageId);
  const endOrdinal = ordinalById.get(lastMessageId);
  if (startOrdinal === undefined || endOrdinal === undefined) return undefined;
  if (endOrdinal < startOrdinal) return undefined;
  return { startOrdinal, endOrdinal };
}
