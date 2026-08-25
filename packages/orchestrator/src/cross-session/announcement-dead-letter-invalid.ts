// SPDX-License-Identifier: Apache-2.0
/** Private evidence retained for a dead-letter row that cannot be replayed. */

import { createHash } from "node:crypto";
import { systemNowMs } from "@comis/core";
import { tryCatch, type Result } from "@comis/shared";

export type InvalidDeadLetterReason =
  | "invalid_json"
  | "schema_mismatch"
  | "oversized_row";

export interface InvalidDeadLetterRecord {
  readonly recordType: "invalid_record";
  readonly id: string;
  readonly reason: InvalidDeadLetterReason;
  readonly sourceLine: number;
  readonly detectedAt: number;
  readonly rawDigest: string;
  readonly rawBytes: number;
  /** Private bounded evidence. Never include this field in logs or operator projections. */
  readonly rawLine: string;
  readonly rawTruncated: boolean;
}

export const MAX_DEAD_LETTER_ROW_BYTES = 1_048_576;
const MAX_INVALID_RAW_CHARS = 4_096;

function digest(value: string): Result<string, Error> {
  return tryCatch(() => createHash("sha256").update(value).digest("hex"));
}

export function createOversizedDeadLetterRecord(
  rawDigest: string,
  rawBytes: number,
  rawLine: string,
  sourceLine: number,
): Result<InvalidDeadLetterRecord, Error> {
  const idDigest = digest(`${sourceLine}\u0000${rawDigest}`);
  if (!idDigest.ok) return idDigest;
  return {
    ok: true,
    value: {
      recordType: "invalid_record",
      id: `invalid:${idDigest.value}`,
      reason: "oversized_row",
      sourceLine,
      detectedAt: systemNowMs(),
      rawDigest,
      rawBytes,
      rawLine: rawLine.slice(0, MAX_INVALID_RAW_CHARS),
      rawTruncated: true,
    },
  };
}

export function createInvalidDeadLetterRecord(
  rawLine: string,
  sourceLine: number,
  parsedJson: boolean,
): Result<InvalidDeadLetterRecord, Error> {
  const rawBytes = Buffer.byteLength(rawLine, "utf8");
  const rawDigest = digest(rawLine);
  if (!rawDigest.ok) return rawDigest;
  const idDigest = digest(`${sourceLine}\u0000${rawDigest.value}`);
  if (!idDigest.ok) return idDigest;
  return {
    ok: true,
    value: {
      recordType: "invalid_record",
      id: `invalid:${idDigest.value}`,
      reason: rawBytes > MAX_DEAD_LETTER_ROW_BYTES
        ? "oversized_row"
        : parsedJson
          ? "schema_mismatch"
          : "invalid_json",
      sourceLine,
      detectedAt: systemNowMs(),
      rawDigest: rawDigest.value,
      rawBytes,
      rawLine: rawLine.slice(0, MAX_INVALID_RAW_CHARS),
      rawTruncated: rawLine.length > MAX_INVALID_RAW_CHARS,
    },
  };
}

export function isInvalidDeadLetterRecord(
  value: unknown,
): value is InvalidDeadLetterRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.recordType === "invalid_record"
    && typeof record.id === "string"
    && record.id.length > 0
    && (
      record.reason === "invalid_json"
      || record.reason === "schema_mismatch"
      || record.reason === "oversized_row"
    )
    && typeof record.sourceLine === "number"
    && Number.isSafeInteger(record.sourceLine)
    && record.sourceLine > 0
    && typeof record.detectedAt === "number"
    && Number.isFinite(record.detectedAt)
    && typeof record.rawDigest === "string"
    && /^[a-f0-9]{64}$/u.test(record.rawDigest)
    && typeof record.rawBytes === "number"
    && Number.isSafeInteger(record.rawBytes)
    && record.rawBytes >= 0
    && typeof record.rawLine === "string"
    && record.rawLine.length <= MAX_INVALID_RAW_CHARS
    && typeof record.rawTruncated === "boolean";
}
