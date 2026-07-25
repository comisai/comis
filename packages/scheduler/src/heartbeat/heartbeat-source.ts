// SPDX-License-Identifier: Apache-2.0
/** Closed, content-free contract implemented by non-model monitoring sources. */
import { ERROR_KINDS } from "@comis/core";
import type { ErrorKind } from "@comis/core";
import type { Result } from "@comis/shared";
import { z } from "zod";
import { SchedulerDiagnosticCounterSchema } from "../cron/cron-runtime.js";

const CodeTokenSchema = z.string().regex(/^[a-z][a-z0-9_]*$/).max(64);

export const HeartbeatSourceIdSchema = CodeTokenSchema;

export const MonitoringSourceDiagnosticSchema = z.strictObject({
  level: z.enum(["ok", "alert", "critical"]),
  observedAtMs: z.number().int().nonnegative().safe(),
  code: CodeTokenSchema,
  counters: z.array(SchedulerDiagnosticCounterSchema).max(32),
}).superRefine((value, ctx) => {
  const names = new Set<string>();
  for (const [index, counter] of value.counters.entries()) {
    if (names.has(counter.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["counters", index, "name"],
        message: "counter names must be unique",
      });
    }
    names.add(counter.name);
  }
});
export type MonitoringSourceDiagnostic = z.infer<typeof MonitoringSourceDiagnosticSchema>;

export const MonitoringSourceErrorSchema = z.strictObject({
  code: CodeTokenSchema,
  errorKind: z.enum(ERROR_KINDS),
});
export type MonitoringSourceError = z.infer<typeof MonitoringSourceErrorSchema>;

export interface HeartbeatSourcePort {
  readonly id: string;
  check(
    signal: AbortSignal,
  ): Promise<Result<MonitoringSourceDiagnostic, MonitoringSourceError>>;
}

export function monitoringSourceError(
  code: string,
  errorKind: ErrorKind,
): MonitoringSourceError {
  const parsed = MonitoringSourceErrorSchema.safeParse({ code, errorKind });
  return parsed.success
    ? parsed.data
    : { code: "invalid_source_error", errorKind: "internal" };
}
