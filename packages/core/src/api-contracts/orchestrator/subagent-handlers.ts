// SPDX-License-Identifier: Apache-2.0
/**
 * Subagent-handlers contract slice.
 *
 * Mirrors `packages/daemon/src/api/subagent-handlers.ts` (7 methods —
 * subagent.*). Spread order in `SUBAGENT_HANDLERS_CONTRACTS` matches the
 * orchestrator contracts array byte for byte to keep
 * `contracts.generated.*` artifacts byte-identical.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "../types.js";
import { ERROR_KINDS } from "../../logging/log-fields.js";
import { SUBAGENT_RESULT_SUMMARY_MAX_CHARS } from "../../domain/subagent-context-types.js";

// ===========================================================================
// --- subagent-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// subagent.list
// ---------------------------------------------------------------------------

/**
 * `subagent.list` — List sub-agent runs filtered by recent time. The RPC route
 * is owner-scoped by the handler; the admin route may additionally select an
 * exact child agent or spawn tree.
 *
 * Agent responses contain only content-free lifecycle fields. Admin responses
 * retain the full diagnostic run records.
 */
export const SubagentListContract = defineContract({
  method: "subagent.list",
  request: z.object({
    recentMinutes: z.number().int().positive().max(10_080).optional(),
    agentId: z.string().min(1).max(256).optional(),
    rootRunId: z.string().min(1).max(256).optional(),
  }),
  response: z.object({
    runs: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
  }),
  scopes: ["rpc", "admin"] as const,
});

// ---------------------------------------------------------------------------
// subagent.wait
// ---------------------------------------------------------------------------

const SubagentResultRefSchema = z.strictObject({
  ref: z.string().min(1).max(1_024),
  kind: z.enum(["jsonl", "json", "csv", "html", "text", "binary"]),
  bytes: z.number().int().nonnegative().safe(),
  rows: z.number().int().nonnegative().safe().optional(),
  schema: z.array(z.string().max(256)).max(256).optional(),
  preview: z.string().max(4_096),
  expiresAt: z.string().min(1).max(64),
});

export const SubagentSuccessCompletionSchema = z.strictObject({
  endReason: z.literal("completed"),
  completedAtMs: z.number().int().nonnegative().safe(),
  summary: z.string().max(SUBAGENT_RESULT_SUMMARY_MAX_CHARS).optional(),
  resultRef: SubagentResultRefSchema.optional(),
});

export const SubagentFailureCompletionSchema = z.strictObject({
  endReason: z.enum(["failed", "killed", "watchdog_timeout", "ghost_sweep"]),
  completedAtMs: z.number().int().nonnegative().safe(),
  errorKind: z.enum(ERROR_KINDS),
  summary: z.string().max(SUBAGENT_RESULT_SUMMARY_MAX_CHARS).optional(),
  resultRef: SubagentResultRefSchema.optional(),
});

export const SubagentCompletionSchema = z.union([
  SubagentSuccessCompletionSchema,
  SubagentFailureCompletionSchema,
]);

export const SubagentRunTelemetrySchema = z.strictObject({
  tokensUsedTotal: z.number().int().nonnegative().safe(),
  costTotal: z.number().nonnegative().finite(),
  finishReason: z.string().min(1).max(128),
  stepsExecuted: z.number().int().nonnegative().safe(),
  cacheReadTokens: z.number().int().nonnegative().safe(),
  cacheWriteTokens: z.number().int().nonnegative().safe(),
});

const SubagentWaitResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    runId: z.string().min(1).max(256),
    status: z.literal("completed"),
    completion: SubagentCompletionSchema,
  }),
  z.strictObject({ runId: z.string().min(1).max(256), status: z.literal("denied_unknown") }),
  z.strictObject({ runId: z.string().min(1).max(256), status: z.literal("timeout") }),
  z.strictObject({ runId: z.string().min(1).max(256), status: z.literal("cancelled") }),
]);

/** Wait without polling for the caller's active direct children or selected runs. */
export const SubagentWaitContract = defineContract({
  method: "subagent.wait",
  request: z.strictObject({
    runIds: z.array(z.string().min(1).max(256))
      .min(1)
      .max(32)
      .optional(),
    timeoutMs: z.number().int().min(0).max(300_000).optional(),
  }),
  response: z.strictObject({
    results: z.array(SubagentWaitResultSchema).max(32),
  }),
  scopes: ["rpc", "admin"] as const,
});

// ---------------------------------------------------------------------------
// subagent.kill
// ---------------------------------------------------------------------------

/**
 * `subagent.kill` — Mark a running sub-agent run as failed. Agent callers may
 * control only an exact direct child; admins may control any selected run.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `target` → `"Missing required parameter: target"`.
 *   - killRun returns !killed → throws with the result's error message.
 *
 * Request: `{ target }`. `target` is the runId.
 * Response: `{ killed, runId }`.
 */
export const SubagentKillContract = defineContract({
  method: "subagent.kill",
  request: z.object({
    target: z.string(),
  }),
  response: z.object({
    killed: z.boolean(),
    runId: z.string(),
  }),
  scopes: ["rpc", "admin"] as const,
});

// ---------------------------------------------------------------------------
// subagent.steer
// ---------------------------------------------------------------------------

/**
 * `subagent.steer` — Steer a running sub-agent. Flag-gated on
 * `security.agentToAgent.steerInject` (default false):
 *   - flag OFF (default): kill the current run and respawn with a new task
 *     → `{ status: "steered", oldRunId, newRunId }`.
 *   - flag ON: inject the message into the RUNNING child's live SDK session at
 *     its next step boundary (transcript + progress preserved, same runId; no
 *     kill, no respawn) → `{ status: "steered_inject", runId }`.
 * Rate-limited at 2s per target (shared across both branches).
 * Agent callers may steer only an exact direct child; admins may steer any
 * selected run. The handler frames the new task as untrusted external text.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `target` → `"Missing required parameter: target"`.
 *   - Missing `message` → `"Missing required parameter: message"`.
 *   - Rate-limit (< 2s since last steer to same target) → `"Rate limited: wait
 *     2s between steers to same target"`.
 *   - flag OFF: killRun !killed → throws; getRunStatus undefined after kill →
 *     `"Run details not found after kill: <id>"`.
 *   - flag ON: getRunStatus undefined → `"Unknown run ID: <id>"`; steerRun
 *     `!steered` → throws the steerRun error (e.g. no live session).
 *
 * Request: `{ target, message }`.
 * Response: discriminated union on `status` —
 *   `{ status: "steered", oldRunId, newRunId }` (kill+respawn) |
 *   `{ status: "steered_inject", runId }` (live inject).
 */
export const SubagentSteerContract = defineContract({
  method: "subagent.steer",
  request: z.object({
    target: z.string(),
    message: z.string(),
  }),
  response: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("steered"),
      oldRunId: z.string(),
      newRunId: z.string(),
    }),
    z.object({
      status: z.literal("steered_inject"),
      runId: z.string(),
    }),
  ]),
  scopes: ["rpc", "admin"] as const,
});

const SubagentSpawnAdmissionStateSchema = z.strictObject({
  paused: z.boolean(),
  acceptingSpawns: z.boolean(),
  resetsOnRestart: z.literal(true),
});

const SubagentSpawnAdmissionMutationSchema = SubagentSpawnAdmissionStateSchema.extend({
  changed: z.boolean(),
});

/** Pause new sub-agent admission for the lifetime of this daemon process. */
export const SubagentPauseContract = defineContract({
  method: "subagent.pause",
  request: z.strictObject({}),
  response: SubagentSpawnAdmissionMutationSchema,
  scopes: ["admin"] as const,
});

/** Resume new sub-agent admission unless shutdown has closed it permanently. */
export const SubagentResumeContract = defineContract({
  method: "subagent.resume",
  request: z.strictObject({}),
  response: SubagentSpawnAdmissionMutationSchema,
  scopes: ["admin"] as const,
});

/** Inspect the process-lifetime sub-agent admission gate. */
export const SubagentStatusContract = defineContract({
  method: "subagent.status",
  request: z.strictObject({}),
  response: SubagentSpawnAdmissionStateSchema,
  scopes: ["admin"] as const,
});

/**
 * subagent-handlers slice (7 contracts — subagent.*). Spread order matches
 * the orchestrator contracts array byte for byte — determinism-critical
 * for codegen output stability.
 */
export const SUBAGENT_HANDLERS_CONTRACTS = [
  SubagentListContract,
  SubagentWaitContract,
  SubagentKillContract,
  SubagentSteerContract,
  SubagentPauseContract,
  SubagentResumeContract,
  SubagentStatusContract,
] as const;
