// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";

/** Closed lifecycle outcomes for a processed inbound message. */
export const DeliveryStatusSchema = z.enum([
  "success",
  "error",
  "timeout",
  "filtered",
  "aborted",
]);

export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/** Boundary at which a failed lifecycle became terminal. */
export const DeliveryFailureStageSchema = z.enum(["execution", "delivery"]);

export type DeliveryFailureStage = z.infer<typeof DeliveryFailureStageSchema>;

/** Parse an unknown failure boundary without throwing. */
export function parseDeliveryFailureStage(
  raw: unknown,
): Result<DeliveryFailureStage, z.ZodError> {
  const parsed = DeliveryFailureStageSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}

/** Parse an unknown lifecycle status without throwing. */
export function parseDeliveryStatus(raw: unknown): Result<DeliveryStatus, z.ZodError> {
  const parsed = DeliveryStatusSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
