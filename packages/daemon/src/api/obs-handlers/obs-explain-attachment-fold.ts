// SPDX-License-Identifier: Apache-2.0
import {
  MEDIA_REMOTE_FETCH_LIMIT_CONFIG_KEY,
  type IncidentSignals,
} from "@comis/core";
import { asNumber } from "./obs-explain-signals-fields.js";

/** The prompt immediately before the latest prompt anchor, when present. */
export function previousPromptSequence(
  records: ReadonlyArray<Record<string, unknown>>,
  latestPromptSeq: number | undefined,
): number | undefined {
  if (latestPromptSeq === undefined) return undefined;
  let previousPromptSeq: number | undefined;
  for (const record of records) {
    if (record.traceSchema !== "comis-trajectory" || record.type !== "prompt.submitted") continue;
    const seq = asNumber(record.seq);
    if (
      seq !== undefined
      && seq < latestPromptSeq
      && (previousPromptSeq === undefined || seq > previousPromptSeq)
    ) previousPromptSeq = seq;
  }
  return previousPromptSeq;
}

function isBoundedInteger(
  value: number | undefined,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return value !== undefined
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= max;
}

/** Fold one trusted pre-prompt rejection into the latest selected turn. */
export function accumulateMediaAttachmentRejection(
  target: NonNullable<IncidentSignals["mediaAttachmentRejections"]>,
  type: string,
  data: Record<string, unknown>,
  recordSeq: number | undefined,
  latestPromptSeq: number | undefined,
  previousPromptSeq: number | undefined,
): boolean {
  if (type !== "media.attachment.rejected") return false;
  const inLatestTurn = recordSeq !== undefined
    && (previousPromptSeq === undefined || recordSeq > previousPromptSeq)
    && (latestPromptSeq === undefined || recordSeq < latestPromptSeq);
  const attachmentIndex = asNumber(data.attachmentIndex);
  const sizeBytes = asNumber(data.sizeBytes);
  const maxBytes = asNumber(data.maxBytes);
  if (
    inLatestTurn
    && isBoundedInteger(attachmentIndex, 15)
    && isBoundedInteger(sizeBytes)
    && isBoundedInteger(maxBytes)
    && data.reason === "size_exceeded"
    && data.configKey === MEDIA_REMOTE_FETCH_LIMIT_CONFIG_KEY
  ) {
    target.push({
      attachmentIndex,
      reason: "size_exceeded",
      sizeBytes,
      maxBytes,
      configKey: MEDIA_REMOTE_FETCH_LIMIT_CONFIG_KEY,
    });
  }
  return true;
}
