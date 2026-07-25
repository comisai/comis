// SPDX-License-Identifier: Apache-2.0
import { err, ok, tryCatch, type Result } from "@comis/shared";
import { z } from "zod";
import type { TaskExtractionItem } from "./task-extraction-queue.js";

const MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_CANDIDATE_TEXT_BYTES = 4 * 1_024;
const MAX_TASK_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

const CandidateSchema = z.strictObject({
  itemId: z.string().min(1).max(256),
  text: z.string().min(1),
  dueInSecondsEarliest: z.number().int().nonnegative().safe(),
  dueInSecondsLatest: z.number().int().nonnegative().safe().optional(),
  confidence: z.number().min(0).max(1),
});

const OutputSchema = z.strictObject({ candidates: z.array(CandidateSchema).max(64) });

export interface BoundTaskCandidate {
  readonly item: TaskExtractionItem;
  readonly text: string;
  readonly confidence: number;
  readonly dueEarliestMs: number;
  readonly dueLatestMs: number;
  readonly expiresAtMs: number;
}

export type TaskExtractionOutputError =
  | { readonly code: "output_too_large"; readonly errorKind: "validation" }
  | { readonly code: "invalid_output"; readonly errorKind: "validation" }
  | { readonly code: "candidate_too_large"; readonly errorKind: "validation"; readonly itemId: string }
  | { readonly code: "unknown_item"; readonly errorKind: "validation"; readonly itemId: string }
  | { readonly code: "duplicate_item"; readonly errorKind: "validation"; readonly itemId: string }
  | { readonly code: "invalid_time_range"; readonly errorKind: "validation"; readonly itemId: string }
  | { readonly code: "before_minimum_due"; readonly errorKind: "validation"; readonly itemId: string }
  | { readonly code: "time_overflow"; readonly errorKind: "validation"; readonly itemId: string };

export function parseTaskExtractionOutput(input: {
  readonly raw: string;
  readonly items: readonly TaskExtractionItem[];
  readonly batchMax: number;
  readonly defaultWindowMs: number;
}): Result<readonly BoundTaskCandidate[], TaskExtractionOutputError> {
  if (Buffer.byteLength(input.raw, "utf8") > MAX_OUTPUT_BYTES) {
    return err({ code: "output_too_large", errorKind: "validation" });
  }
  const decoded = tryCatch(() => JSON.parse(input.raw) as unknown);
  if (!decoded.ok) return err({ code: "invalid_output", errorKind: "validation" });
  const parsed = OutputSchema.safeParse(decoded.value);
  if (!parsed.success || parsed.data.candidates.length > input.batchMax) {
    return err({ code: "invalid_output", errorKind: "validation" });
  }
  const itemsById = new Map<string, TaskExtractionItem>();
  for (const item of input.items) {
    if (itemsById.has(item.itemId)) {
      return err({ code: "duplicate_item", errorKind: "validation", itemId: item.itemId });
    }
    itemsById.set(item.itemId, item);
  }
  const candidateIds = new Set<string>();
  const bound: BoundTaskCandidate[] = [];
  for (const candidate of parsed.data.candidates) {
    if (candidateIds.has(candidate.itemId)) {
      return err({ code: "duplicate_item", errorKind: "validation", itemId: candidate.itemId });
    }
    candidateIds.add(candidate.itemId);
    const item = itemsById.get(candidate.itemId);
    if (item === undefined) {
      return err({ code: "unknown_item", errorKind: "validation", itemId: candidate.itemId });
    }
    if (
      candidate.text.trim().length === 0
      || Buffer.byteLength(candidate.text, "utf8") > MAX_CANDIDATE_TEXT_BYTES
    ) {
      return err({ code: "candidate_too_large", errorKind: "validation", itemId: candidate.itemId });
    }
    const times = resolveCandidateTimes({
      item,
      earliestSeconds: candidate.dueInSecondsEarliest,
      latestSeconds: candidate.dueInSecondsLatest,
      defaultWindowMs: input.defaultWindowMs,
    });
    if (!times.ok) return times;
    bound.push({
      item,
      text: candidate.text,
      confidence: candidate.confidence,
      ...times.value,
    });
  }
  return ok(bound);
}

function resolveCandidateTimes(input: {
  readonly item: TaskExtractionItem;
  readonly earliestSeconds: number;
  readonly latestSeconds?: number;
  readonly defaultWindowMs: number;
}): Result<{
  dueEarliestMs: number;
  dueLatestMs: number;
  expiresAtMs: number;
}, TaskExtractionOutputError> {
  const { item } = input;
  if (
    input.earliestSeconds <= 0
    || input.earliestSeconds > MAX_TASK_LIFETIME_MS / 1_000
    || input.latestSeconds !== undefined && (
      input.latestSeconds < input.earliestSeconds
      || input.latestSeconds > MAX_TASK_LIFETIME_MS / 1_000
    )
    || !Number.isSafeInteger(input.defaultWindowMs)
    || input.defaultWindowMs <= 0
  ) {
    return err({ code: "invalid_time_range", errorKind: "validation", itemId: item.itemId });
  }
  const earliestOffset = input.earliestSeconds * 1_000;
  const latestOffset = input.latestSeconds === undefined ? undefined : input.latestSeconds * 1_000;
  const dueEarliestMs = item.capturedAtMs + earliestOffset;
  const expiresAtMs = item.capturedAtMs + MAX_TASK_LIFETIME_MS;
  const dueLatestMs = latestOffset === undefined
    ? dueEarliestMs + input.defaultWindowMs
    : item.capturedAtMs + latestOffset;
  if (
    !Number.isSafeInteger(dueEarliestMs)
    || !Number.isSafeInteger(dueLatestMs)
    || !Number.isSafeInteger(expiresAtMs)
  ) {
    return err({ code: "time_overflow", errorKind: "validation", itemId: item.itemId });
  }
  if (dueEarliestMs < item.minimumDueAtMs) {
    return err({ code: "before_minimum_due", errorKind: "validation", itemId: item.itemId });
  }
  if (dueLatestMs < dueEarliestMs || dueLatestMs > expiresAtMs) {
    return err({ code: "invalid_time_range", errorKind: "validation", itemId: item.itemId });
  }
  return ok({ dueEarliestMs, dueLatestMs, expiresAtMs });
}
