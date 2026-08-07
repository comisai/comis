// SPDX-License-Identifier: Apache-2.0
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  parseInboundMessageProvenanceBatch,
  type OriginalInboundMessage,
} from "@comis/core";

export const RECENT_USER_TURN_COUNT = 8;

export interface RecentUserTurnSelectionEvidence {
  readonly turnCount: number;
  readonly charCount: number;
  readonly saturated: boolean;
}

export function describeRecentUserTurnSelection(
  turns: readonly string[],
): RecentUserTurnSelectionEvidence {
  return {
    turnCount: turns.length,
    charCount: turns.join("\n").length,
    saturated: turns.length >= RECENT_USER_TURN_COUNT,
  };
}

function selectBoundedDistinctTurns(turns: readonly string[]): string[] {
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const turn of turns) {
    if (seen.has(turn)) continue;
    seen.add(turn);
    distinct.push(turn);
  }
  if (distinct.length <= RECENT_USER_TURN_COUNT) return distinct;
  const intentAnchor = distinct[0];
  if (intentAnchor === undefined) return [];
  return [intentAnchor, ...distinct.slice(-(RECENT_USER_TURN_COUNT - 1))];
}

interface SessionEntryLike {
  readonly type?: unknown;
  readonly customType?: unknown;
  readonly data?: unknown;
}

interface ProvenanceBatch {
  readonly batchId: string;
  readonly recordedAt: number;
  readonly chunkCount: number;
  readonly chunks: Map<number, readonly OriginalInboundMessage[]>;
}

function collectProvenanceBatches(
  entries: readonly SessionEntryLike[],
  currentBatchId?: string,
): { batches: Map<string, ProvenanceBatch>; sawValidProvenance: boolean } {
  const batches = new Map<string, ProvenanceBatch>();
  let sawValidProvenance = false;
  for (const entry of entries) {
    if (
      entry.type !== "custom"
      || entry.customType !== INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE
    ) {
      continue;
    }
    const parsed = parseInboundMessageProvenanceBatch(entry.data);
    if (!parsed.ok) continue;
    sawValidProvenance = true;
    const value = parsed.value;
    if (value.batchId === currentBatchId) continue;
    const existing = batches.get(value.batchId);
    if (existing !== undefined) {
      if (
        existing.chunkCount !== value.chunkCount
        || existing.recordedAt !== value.recordedAt
      ) {
        batches.delete(value.batchId);
        continue;
      }
      if (!existing.chunks.has(value.chunkIndex)) {
        existing.chunks.set(value.chunkIndex, value.messages);
      }
      continue;
    }
    batches.set(value.batchId, {
      batchId: value.batchId,
      recordedAt: value.recordedAt,
      chunkCount: value.chunkCount,
      chunks: new Map([[value.chunkIndex, value.messages]]),
    });
  }
  return { batches, sawValidProvenance };
}

function completeProvenanceBatches(
  entries: readonly SessionEntryLike[],
  currentBatchId?: string,
): ProvenanceBatch[] {
  const { batches } = collectProvenanceBatches(entries, currentBatchId);
  return [...batches.values()]
    .filter((batch) => batch.chunks.size === batch.chunkCount)
    .sort((left, right) =>
      left.recordedAt - right.recordedAt
      || left.batchId.localeCompare(right.batchId),
    );
}

/** Read a bounded structured flag without parsing rendered prompt text. */
export function hasRecentForwardedUserTurn(
  entries: readonly SessionEntryLike[],
  currentBatchId?: string,
): boolean {
  return completeProvenanceBatches(entries, currentBatchId)
    .slice(-RECENT_USER_TURN_COUNT)
    .some((batch) => [...batch.chunks.values()].flat().some(
      (message) => message.isForwarded === true,
    ));
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block === null || typeof block !== "object") return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * Select the bounded user-authored context that disambiguates the next recall query.
 * Assistant and tool output are excluded so model-generated guesses cannot become
 * retrieval authority for the user's follow-up.
 */
export function selectRecentUserTurns(
  messages: readonly AgentMessage[],
  entries: readonly SessionEntryLike[] = [],
  currentBatchId?: string,
): string[] {
  const { batches, sawValidProvenance } = collectProvenanceBatches(
    entries,
    currentBatchId,
  );
  if (sawValidProvenance) {
    const turns = [...batches.values()]
      .filter((batch) => batch.chunks.size === batch.chunkCount)
      .sort((left, right) =>
        left.recordedAt - right.recordedAt
        || left.batchId.localeCompare(right.batchId),
      )
      .map((batch) =>
        Array.from({ length: batch.chunkCount }, (_, chunkIndex) =>
          batch.chunks.get(chunkIndex) ?? [],
        )
          .flat()
          .map((message) => message.text)
          .join("\n")
          .trim(),
      )
      .filter((text) => text.length > 0);
    return selectBoundedDistinctTurns(turns);
  }

  const userTurns: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" || !("content" in message)) continue;
    const text = extractText(message.content).trim();
    if (text.length > 0) userTurns.push(text);
  }
  return selectBoundedDistinctTurns(userTurns);
}
