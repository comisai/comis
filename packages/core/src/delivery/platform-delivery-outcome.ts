// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";
import { ERROR_KINDS, type ErrorKind } from "../logging/log-fields.js";

const ErrorKindSchema = z.enum(ERROR_KINDS);
const PositiveCountSchema = z.number().int().positive().safe();
const NonnegativeCountSchema = z.number().int().nonnegative().safe();
const TimestampSchema = z.number().int().nonnegative().safe();

export const PlatformDeliveryOutcomeSchema = z.union([
  z.strictObject({
    status: z.literal("accepted"),
    deliveredChunks: PositiveCountSchema,
    settledAtMs: TimestampSchema,
    lastMessageId: z.string().min(1).max(512).optional(),
  }),
  z.strictObject({
    status: z.literal("partial"),
    errorKind: ErrorKindSchema,
    deliveredChunks: PositiveCountSchema,
    failedChunks: PositiveCountSchema,
    settledAtMs: TimestampSchema,
    lastMessageId: z.string().min(1).max(512).optional(),
  }),
  z.strictObject({
    status: z.literal("rejected"),
    errorKind: ErrorKindSchema,
    deliveredChunks: z.literal(0),
    failedChunks: PositiveCountSchema,
    settledAtMs: TimestampSchema,
  }),
  z.strictObject({
    status: z.literal("unknown"),
    errorKind: ErrorKindSchema,
    deliveredChunks: NonnegativeCountSchema,
    failedChunks: PositiveCountSchema,
    ambiguousChunks: PositiveCountSchema,
    settledAtMs: TimestampSchema,
    lastMessageId: z.string().min(1).max(512).optional(),
  }).superRefine((outcome, ctx) => {
    if (outcome.ambiguousChunks > outcome.failedChunks) {
      ctx.addIssue({
        code: "custom",
        path: ["ambiguousChunks"],
        message: "ambiguous chunks cannot exceed failed chunks",
      });
    }
  }),
]);
export type PlatformDeliveryOutcome = z.infer<typeof PlatformDeliveryOutcomeSchema>;

export type PlatformChunkDeliveryOutcome =
  | { status: "accepted"; charCount: number; retried: boolean; messageId?: string }
  | { status: "rejected"; charCount: number; retried: boolean; errorKind: ErrorKind }
  | { status: "unknown"; charCount: number; retried: boolean; errorKind: ErrorKind };

export type PlatformDeliveryClassificationError = {
  code: "no_attempts" | "invalid_input";
  errorKind: "precondition" | "validation";
  message: string;
};

/** Fold platform attempts in original chunk order into one immutable truth. */
export function classifyPlatformDelivery(
  chunks: readonly PlatformChunkDeliveryOutcome[],
  settledAtMs: number,
): Result<PlatformDeliveryOutcome, PlatformDeliveryClassificationError> {
  if (chunks.length === 0) {
    return err({ code: "no_attempts", errorKind: "precondition", message: "No platform chunks were attempted" });
  }
  if (!Number.isSafeInteger(settledAtMs) || settledAtMs < 0 || chunks.some((chunk) => (
    !Number.isSafeInteger(chunk.charCount) || chunk.charCount < 0
  ))) {
    return err({ code: "invalid_input", errorKind: "validation", message: "Invalid platform delivery evidence" });
  }

  const accepted = chunks.filter((chunk) => chunk.status === "accepted");
  const failed = chunks.filter((chunk) => chunk.status !== "accepted");
  const ambiguous = chunks.filter((chunk) => chunk.status === "unknown");
  const lastAccepted = accepted.at(-1);
  const lastMessageId = lastAccepted?.status === "accepted" ? lastAccepted.messageId : undefined;

  let candidate: PlatformDeliveryOutcome;
  if (ambiguous.length > 0) {
    const firstAmbiguous = ambiguous[0]!;
    candidate = {
      status: "unknown",
      errorKind: firstAmbiguous.errorKind,
      deliveredChunks: accepted.length,
      failedChunks: failed.length,
      ambiguousChunks: ambiguous.length,
      settledAtMs,
      ...(lastMessageId !== undefined ? { lastMessageId } : {}),
    };
  } else if (failed.length > 0 && accepted.length > 0) {
    const firstRejected = failed[0]!;
    candidate = {
      status: "partial",
      errorKind: firstRejected.errorKind,
      deliveredChunks: accepted.length,
      failedChunks: failed.length,
      settledAtMs,
      ...(lastMessageId !== undefined ? { lastMessageId } : {}),
    };
  } else if (failed.length > 0) {
    const firstRejected = failed[0]!;
    candidate = {
      status: "rejected",
      errorKind: firstRejected.errorKind,
      deliveredChunks: 0,
      failedChunks: failed.length,
      settledAtMs,
    };
  } else {
    candidate = {
      status: "accepted",
      deliveredChunks: accepted.length,
      settledAtMs,
      ...(lastMessageId !== undefined ? { lastMessageId } : {}),
    };
  }
  const parsed = PlatformDeliveryOutcomeSchema.safeParse(candidate);
  return parsed.success
    ? ok(parsed.data)
    : err({ code: "invalid_input", errorKind: "validation", message: "Invalid platform delivery aggregate" });
}
