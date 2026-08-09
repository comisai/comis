// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { CapabilityServiceInstanceConfigSchema } from "./capability-service-instance-schema.js";

const PRIVATE_DIRECTORY_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

const PrivateContentDirectorySchema = z.string().min(1).max(1_024).superRefine((value, ctx) => {
  const segments = value.split("/");
  if (
    isAbsolute(value)
    || normalize(value) !== value
    || segments.some((segment) => (
      segment === "."
      || segment === ".."
      || !PRIVATE_DIRECTORY_SEGMENT_PATTERN.test(segment)
    ))
  ) {
    ctx.addIssue({
      code: "custom",
      message: "capability-service privateContentDirectory must be a normalized relative path",
    });
  }
});

/** Restart-only capability-service topology and managed-run runtime bounds. */
export const CapabilityServicesConfigSchema = z.strictObject({
  instances: z.array(CapabilityServiceInstanceConfigSchema).max(256).default([]),
  privateContentDirectory: PrivateContentDirectorySchema.default("managed-runs/private"),
  reportRetentionMs: z.number().int().positive().max(365 * 86_400_000)
    .default(30 * 86_400_000),
  maxObservedClockSkewMs: z.number().int().nonnegative().max(86_400_000)
    .default(300_000),
  recoveryBatchSize: z.number().int().positive().max(10_000).default(256),
  requestDeadlineMs: z.number().int().min(100).max(60_000).default(5_000),
});

export type CapabilityServicesConfig = z.infer<typeof CapabilityServicesConfigSchema>;
