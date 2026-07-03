// SPDX-License-Identifier: Apache-2.0
/**
 * ActivityEvent — the canonical, redacted, structured event for the activity
 * pipeline.
 *
 * Carries *redacted structured data*, not final user-visible English strings.
 * Projections produce render frames per surface from the same canonical event
 * (an ACP IDE shows a structured tool-call panel while Telegram shows a themed
 * line). Pure domain model: no I/O, no logger, no channel knowledge.
 */
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";
import type { ErrorKind } from "../logging/log-fields.js";
import { ApprovalCorrelationSchema } from "./approval.js";

/** Sanitized, allowlisted, **richly-typed** view of tool params at emit time. */
export const RedactedParamValueSchema: z.ZodType =
  z.lazy(() => z.union([
    z.string(), z.number(), z.boolean(), z.null(),
    z.array(RedactedParamValueSchema),
    z.record(z.string(), RedactedParamValueSchema),
  ]));
export const RedactedParamsSchema = z.record(z.string(), RedactedParamValueSchema);

export const ActivityEventSchema = z.strictObject({
  // --- envelope ----------------------------------------------------------
  schemaVersion: z.literal(1),
  activityId: z.string().uuid(),
  parentActivityId: z.string().uuid().optional(),
  sessionKey: z.string(),
  agentId: z.string(),
  channelKey: z.string().optional(),
  traceId: z.string(),
  toolCallId: z.string().optional(),
  ts: z.string().datetime(),

  // --- canonical classification (drives projections) --------------------
  phase: z.enum(["start", "progress", "end"]),
  status: z.enum(["running", "completed", "failed", "skipped"]),
  kind: z.enum([
    "tool", "subagent", "model", "memory", "lifecycle", "approval", "clarify",
  ]),
  semanticPhase: z.enum([
    "tool", "coding", "web", "memory", "media", "thinking", "queued", "done", "error",
  ]),
  toolName: z.string().optional(),
  action: z.string().optional(),
  /** Sanitized + allowlisted params (already redacted at emit site). */
  params: RedactedParamsSchema.optional(),

  // --- correlation block: required when kind === "approval" -------------
  /** Present iff kind === "approval". Carries short callback id, choices, expiry. */
  approval: ApprovalCorrelationSchema.optional(),

  // --- canonical telemetry ----------------------------------------------
  durationMs: z.number().nonnegative().optional(),
  errorKind: z.enum([
    "config", "network", "auth", "validation", "precondition",
    "timeout", "resource", "dependency", "internal", "platform",
  ]).optional() satisfies z.ZodType<ErrorKind | undefined>,

  // --- rendering hints (advisory; not authoritative) --------------------
  /**
   * Default English label suggested by the label resolver. Plain-text
   * surfaces (IRC, Email, Echo) MAY use it as-is. Themable renderers
   * (Telegram skinned, ACP IDE) ignore it and project from the canonical
   * fields above. Length-capped at 120; renderers MUST NOT extend.
   */
  defaultLabel: z.string().max(120).optional(),
  defaultDetail: z.string().max(280).optional(),
}).refine(
  (e) => (e.kind === "approval") === (e.approval !== undefined),
  {
    message: "approval block must be present iff kind === 'approval'",
    path: ["approval"],
  },
);

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

/**
 * Single failure variant. Zod's `.max()` returns its own issue on the schema
 * branch — a separate `size_exceeded` variant would be unreachable. Tests
 * assert on Zod issues directly when bound violations occur.
 */
export type ActivityParseError = { kind: "schema"; issues: z.ZodIssue[] };

export function parseActivityEvent(raw: unknown): Result<ActivityEvent, ActivityParseError> {
  const parsed = ActivityEventSchema.safeParse(raw);
  if (!parsed.success) return err({ kind: "schema", issues: parsed.error.issues });
  return ok(parsed.data);
}
