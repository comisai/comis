// SPDX-License-Identifier: Apache-2.0
/**
 * Cron-handlers contract slice.
 *
 * Mirrors `packages/daemon/src/api/cron-handlers.ts` (8 methods — cron.* +
 * scheduler.wake). The spread order in `CRON_HANDLERS_CONTRACTS` is
 * load-bearing for `contracts.generated.*` artifacts byte-identical output.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "../types.js";

// ===========================================================================
// --- cron-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// cron.add
// ---------------------------------------------------------------------------

/**
 * `cron.add` — Register a new scheduled cron job. Rpc-scoped per
 * setup-gateway-api.ts:130-157. Handler path: cron-handlers.ts:71-133.
 *
 * The contract describes the WEB on-wire shape (nested `schedule.{kind,expr,
 * tz,everyMs,at}` + `message`); the handler body accepts BOTH the web shape
 * (nested) AND the legacy chat-tool shape (flat `schedule_kind` /
 * `schedule_every_ms` / etc.) to preserve existing handler-test invocations.
 *
 * Bespoke pre-Zod validation: duplicate job-name guard reads name on
 * rawParams.name BEFORE the schedule normalization (preserves the
 * "A job named X already exists" message-text contract).
 *
 * Request: `{ name, agentId?, schedule, message }` (web shape) — the
 * handler also accepts `{ name, schedule_kind, schedule_every_ms?,
 * schedule_expr?, timezone?, schedule_at?, payload_kind?, payload_text }`
 * (legacy flat shape). Loose-record on `schedule` (variant inner shape per
 * schedule.kind).
 *
 * Response: `{ jobId, name, schedule, model? }`. `schedule` is the normalized
 * CronSchedule shape (`{ kind: "every" | "cron" | "at", ... }`).
 */
export const CronAddContract = defineContract({
  method: "cron.add",
  request: z.object({
    // Web on-wire shape (nested schedule + message + agentId at top level).
    name: z.string(),
    agentId: z.string().optional(),
    schedule: z.record(z.string(), z.unknown()).optional(),
    message: z.string().optional(),
    // Optional pass-through fields (preserved by handler normalization).
    sessionTarget: z.string().optional(),
    deliveryTarget: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    // Legacy flat shape (chat-tool path — exercised by 14+ existing tests).
    schedule_kind: z.string().optional(),
    payload_kind: z.string().optional(),
    payload_text: z.string().optional(),
    schedule_expr: z.string().optional(),
    timezone: z.string().optional(),
    schedule_every_ms: z.number().optional(),
    schedule_at: z.string().optional(),
    /** Relative one-shot: seconds from now (schedule_kind="in"). Timezone-free — for "in N minutes/hours" reminders. */
    schedule_in_seconds: z.number().optional(),
    // Optional model + session strategy + wake mode (read directly by handler).
    model: z.string().optional(),
    session_target: z.string().optional(),
    wake_mode: z.string().optional(),
    forward_to_main: z.boolean().optional(),
    session_strategy: z.string().optional(),
    max_history_turns: z.number().optional(),
  }),
  response: z.object({
    jobId: z.string(),
    name: z.string(),
    schedule: z.record(z.string(), z.unknown()),
    model: z.string().optional(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.list
// ---------------------------------------------------------------------------

/**
 * `cron.list` — List scheduled jobs for the calling agent. Rpc-scoped per
 * setup-gateway-api.ts:130-134. Handler path: cron-handlers.ts:135-155.
 *
 * Request: `{}` (handler reads `_agentId` from rawParams).
 * Response: `{ jobs: Job[] }`. Each Job carries `id`, `name`, `agentId`,
 * `enabled`, `schedule`, `payload`, `sessionTarget`, `nextRunAtMs?`,
 * `lastRunAtMs?`, `consecutiveErrors`, `createdAtMs`, optional
 * `deliveryTarget`. The Job entries are loose-records — the schedule +
 * payload + deliveryTarget inner shapes vary by job kind.
 */
export const CronListContract = defineContract({
  method: "cron.list",
  // TARGET-01: optional explicit `agentId` selects one agent's jobs; `agentId: "*"`
  // returns EVERY agent's jobs (each tagged by `agentId`) — the admin inventory view
  // I lacked when a non-default agent's crons were invisible. Absent → connection
  // `_agentId` ?? default (unchanged per-connection scoping).
  request: z.object({ agentId: z.string().optional() }),
  response: z.object({
    jobs: z.array(z.record(z.string(), z.unknown())),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.update
// ---------------------------------------------------------------------------

/**
 * `cron.update` — Update an existing job's fields. Rpc-scoped per
 * setup-gateway-api.ts:155-157. Handler path: cron-handlers.ts:157-193.
 *
 * Bespoke pre-Zod validation:
 *   - Missing job (by jobId or jobName) → `"Job not found: <id>"`.
 *   - Ambiguous jobName → `"Ambiguous job name <name>: N jobs share this name"`.
 *
 * Request: `{ jobId?, jobName?, enabled?, name?, sessionTarget?, schedule?,
 *   message?, deliveryTarget? | null }`. Either `jobId` (web UI path) OR
 *   `jobName` (chat-tool path) resolves the job. `schedule` is the nested
 *   `{ kind, expr?, tz?, everyMs?, at? }`. `deliveryTarget = null` clears the
 *   field (channel un-binding).
 *
 * Response: `{ jobName, updated }`.
 */
export const CronUpdateContract = defineContract({
  method: "cron.update",
  request: z.object({
    jobId: z.string().optional(),
    jobName: z.string().optional(),
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    sessionTarget: z.string().optional(),
    schedule: z.record(z.string(), z.unknown()).optional(),
    message: z.string().optional(),
    deliveryTarget: z.nullable(z.record(z.string(), z.unknown())).optional(),
  }),
  response: z.object({
    jobName: z.string(),
    updated: z.boolean(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.remove
// ---------------------------------------------------------------------------

/**
 * `cron.remove` — Remove a job by name. Rpc-scoped per
 * setup-gateway-api.ts:155-157. Handler path: cron-handlers.ts:195-202.
 *
 * Bespoke pre-Zod validation:
 *   - Unknown jobName → `"Job not found: <name>"`.
 *   - Ambiguous jobName → `"Ambiguous job name <name>: N jobs share this name"`.
 *
 * Request: `{ jobName }`. Resolves by name only (no jobId fallback for remove).
 * Response: `{ jobName, removed }`.
 */
export const CronRemoveContract = defineContract({
  method: "cron.remove",
  request: z.object({
    jobName: z.string(),
  }),
  response: z.object({
    jobName: z.string(),
    removed: z.boolean(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.status
// ---------------------------------------------------------------------------

/**
 * `cron.status` — Report scheduler availability for the calling agent.
 * Rpc-scoped per setup-gateway-api.ts:155-157. Handler path:
 * cron-handlers.ts:204-211.
 *
 * Request: `{}` (handler reads `_agentId` from rawParams).
 * Response: `{ running, jobCount }`. `running: true` only when the scheduler
 * is registered for the resolved agentId.
 */
export const CronStatusContract = defineContract({
  method: "cron.status",
  request: z.object({ agentId: z.string().optional() }), // TARGET-01
  response: z.object({
    running: z.boolean(),
    jobCount: z.number(),
    resolvedAgentId: z.string().optional(), // TARGET-01: the agent this status is for
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.runs
// ---------------------------------------------------------------------------

/**
 * `cron.runs` — Return execution-history entries for a job. Rpc-scoped per
 * setup-gateway-api.ts:155-157. Handler path: cron-handlers.ts:213-222.
 *
 * Bespoke pre-Zod validation: missing/unknown jobName falls through to the
 * tracker check (empty runs returned).
 *
 * Request: `{ jobName, limit? }`. `limit` defaults to 20 in the handler.
 * Response: `{ runs: RunEntry[] }`. RunEntry is a loose-record (tracker
 * shape: `{ runId, jobId, startedAt, completedAt, status, ... }`).
 */
export const CronRunsContract = defineContract({
  method: "cron.runs",
  request: z.object({
    jobName: z.string(),
    limit: z.number().optional(),
    agentId: z.string().optional(), // TARGET-01: which agent's run-history
  }),
  response: z.object({
    runs: z.array(z.record(z.string(), z.unknown())),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.run
// ---------------------------------------------------------------------------

/**
 * `cron.run` — Trigger a job (force) or run all due jobs. Rpc-scoped per
 * setup-gateway-api.ts:155-157. Handler path: cron-handlers.ts:224-239.
 *
 * Bespoke pre-Zod validation:
 *   - Force mode + unknown jobName → `"Job not found: <name>"`.
 *
 * Request: `{ jobName?, mode? }`. `mode` defaults to "force"; "due" runs all
 *   missed jobs (no jobName required for "due").
 * Response: `{ triggered, mode, jobName? }`.
 */
export const CronRunContract = defineContract({
  method: "cron.run",
  request: z.object({
    jobName: z.string().optional(),
    mode: z.string().optional(),
    // TARGET-01: explicit per-agent targeting. When present it selects that agent's
    // per-agent scheduler; absent, the handler falls back to the connection `_agentId`
    // then the default — but the response ALWAYS states the resolved agent (I5).
    agentId: z.string().optional(),
  }),
  response: z.object({
    triggered: z.boolean(),
    mode: z.string(),
    jobName: z.string().optional(),
    // TARGET-01: the agent the trigger actually acted on (never a silent default).
    resolvedAgentId: z.string().optional(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// scheduler.wake
// ---------------------------------------------------------------------------

/**
 * `scheduler.wake` — Request an immediate heartbeat tick (debounced via
 * wakeCoalescer). Registration-plane-agnostic — there is NO explicit
 * setup-gateway-api.ts entry for `scheduler.wake`; the dispatcher resolves it
 * intrinsically through the rpcDispatch map. Scope is implicit rpc (no admin
 * trust check in handler body). Handler path: cron-handlers.ts:241-245.
 *
 * Request: `{ source? }`. `source` defaults to "agent" if not provided.
 * Response: `{ woke, source }`.
 */
export const SchedulerWakeContract = defineContract({
  method: "scheduler.wake",
  request: z.object({
    source: z.string().optional(),
  }),
  response: z.object({
    woke: z.boolean(),
    source: z.string(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * cron-handlers slice (8 contracts — cron.* + scheduler.wake). Spread order
 * is determinism-critical for codegen output stability.
 */
export const CRON_HANDLERS_CONTRACTS = [
  CronAddContract,
  CronListContract,
  CronUpdateContract,
  CronRemoveContract,
  CronStatusContract,
  CronRunsContract,
  CronRunContract,
  SchedulerWakeContract,
] as const;
