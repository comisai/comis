// SPDX-License-Identifier: Apache-2.0
import {
  ActivityRecordingOutcomeClassSchema,
  NormalizedMessageSchema,
} from "@comis/core";
import { z } from "zod";

export const InboundActivityInputSchema = z.strictObject({
  traceId: z.guid(),
  occurredAtMs: z.number().int().nonnegative(),
  message: NormalizedMessageSchema,
});

export const DeliveryAttemptInputSchema = z.strictObject({
  traceId: z.guid(),
  occurredAtMs: z.number().int().nonnegative(),
  channelType: z.string().min(1).max(128),
  channelId: z.string().min(1).max(1_024),
  text: z.string(),
  options: z.unknown(),
  origin: z.string().max(256),
  chunkIndex: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive(),
});

const DeliveryAttemptReceiptSchema = z.strictObject({
  recordId: z.string().regex(/^record:\d{20}$/),
  sequence: z.number().int().positive(),
  recordHash: z.string().regex(/^[0-9a-f]{64}$/),
  attemptId: z.guid(),
  settlementCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  traceId: z.guid(),
  occurredAtMs: z.number().int().nonnegative(),
});

const DeliveryErrorSchema = z.strictObject({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
});

const DeliveryOutcomeBaseSchema = z.strictObject({
  attempt: DeliveryAttemptReceiptSchema,
  occurredAtMs: z.number().int().nonnegative(),
});

export const DeliveryOutcomeInputSchema = z.discriminatedUnion("outcomeClass", [
  DeliveryOutcomeBaseSchema.extend({
    outcomeClass: z.literal(ActivityRecordingOutcomeClassSchema.enum.success),
    platformMessageId: z.string().min(1),
  }),
  DeliveryOutcomeBaseSchema.extend({
    outcomeClass: z.enum([
      ActivityRecordingOutcomeClassSchema.enum.platform_error,
      ActivityRecordingOutcomeClassSchema.enum.adapter_throw,
    ]),
    error: DeliveryErrorSchema,
  }),
]);

export const EvidenceExportInputSchema = z.strictObject({
  afterSequence: z.number().int().nonnegative().optional(),
  snapshotHeadSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1_000),
});
