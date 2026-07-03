// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Cron RPC handler module.
 * Handles all cron-related and scheduler RPC methods:
 *   cron.add, cron.list, cron.update, cron.remove,
 *   cron.status, cron.runs, cron.run, scheduler.wake
 *
 * Handlers use computed-property keys (`[<Contract>.method]:`) so the
 * bidirectional 1:1 architecture test resolves them to the registry.
 * Per-method pipeline: bespoke pre-Zod guards FIRST (using rawParams reads —
 * preserves user-friendly error messages matching existing handler-test
 * assertions) → stripInternalFields → request.parse → business logic →
 * dev-mode response.parse.
 *
 * The `cron.add` body normalizes the WEB shape (nested
 * `schedule.{kind,expr,tz,everyMs,at}` + `message`) into the legacy flat
 * shape (`schedule_kind`/`schedule_every_ms`/etc.) before calling
 * `buildCronSchedule`. The flat path is exercised by existing tests.
 *
 * @module
 */

import { sanitizeToolOutput } from "@comis/agent";
import {
  CronAddContract,
  CronListContract,
  CronUpdateContract,
  CronRemoveContract,
  CronStatusContract,
  CronRunsContract,
  CronRunContract,
  SchedulerWakeContract,
  stripInternalFields,
  requireCapability,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
import { buildCronSchedule } from "../wiring/daemon-utils.js";
import type { CronSchedule } from "@comis/scheduler";
import { randomUUID } from "node:crypto";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Single source of truth: OrchestratorApiDeps (shared with graph, heartbeat,
// subagent handlers).
import type { OrchestratorApiDeps as CronHandlerDeps } from "./types.js";
export type { CronHandlerDeps };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a job by its human-readable name.
 * Throws if no match or if multiple jobs share the same name.
 */
function resolveJobByName(
  scheduler: { getJobs(): Array<{ id: string; name: string }> },
  jobName: string | undefined,
): { id: string; name: string } {
  if (!jobName) {
    // Echoing the unmatched var produced "Job not found: undefined" when a
    // caller used the wrong param key (observed in a live run).
    throw new Error("Missing required parameter: jobName (resolve names via cron.list)");
  }
  const matches = scheduler.getJobs().filter((j) => j.name === jobName);
  if (matches.length === 0) throw new Error(`Job not found: ${jobName}`);
  if (matches.length > 1)
    throw new Error(
      `Ambiguous job name "${jobName}": ${matches.length} jobs share this name. Use cron.list to see all jobs.`,
    );
  return matches[0]!;
}

/**
 * Resolve a job by ID (preferred) or name (fallback for chat tool compat).
 * Web UI sends jobId; chat tool sends jobName.
 */
function resolveJob(
  scheduler: { getJobs(): Array<{ id: string; name: string }> },
  params: Record<string, unknown>,
): { id: string; name: string } {
  const jobId = params.jobId as string | undefined;
  if (jobId) {
    const match = scheduler.getJobs().find((j) => j.id === jobId);
    if (!match) throw new Error(`Job not found: ${jobId}`);
    return match;
  }
  const jobName = params.jobName as string | undefined;
  if (!jobName) {
    // Echoing the unmatched var produced "Job not found: undefined" when a
    // caller used the wrong param key (observed in a live run).
    throw new Error(
      "Missing required parameter: jobId or jobName (resolve names via cron.list)",
    );
  }
  return resolveJobByName(scheduler, jobName);
}

/**
 * Normalize cron.add params: convert WEB shape (nested `schedule` + `message`
 * + top-level `agentId`) into the flat shape used by buildCronSchedule.
 * Returns the params unchanged if already in flat shape (legacy chat-tool
 * path — exercised by existing handler-test assertions).
 *
 * Server-side normalization belongs in the handler, not the dispatcher.
 */
function normalizeCronAddParams(params: Record<string, unknown>): Record<string, unknown> {
  // Already in flat shape (schedule_kind present) — pass through unchanged.
  // The legacy chat-tool path uses schedule_kind + payload_text directly.
  if (typeof params.schedule_kind === "string") {
    return params;
  }
  // Web shape — nested schedule + message at the top level.
  const schedule = params.schedule as Record<string, unknown> | undefined;
  return {
    ...params,
    name: params.name,
    schedule_kind: schedule?.kind ?? "cron",
    payload_kind: "agent_turn",
    payload_text: params.message,
    // Empty string -> undefined so handler uses defaultAgentId.
    _agentId: params._agentId ?? (params.agentId ? params.agentId : undefined),
    // Flat schedule params expected by buildCronSchedule.
    schedule_expr: schedule?.expr,
    timezone: schedule?.tz,
    schedule_every_ms: schedule?.everyMs,
    schedule_at: schedule?.at,
    schedule_in_seconds: schedule?.seconds,
    // Fold the web nested wake-gate into the flat authoring fields the cron.add
    // body reads. The script is code for the jail and is carried through
    // untouched -- it is never scrubbed as payload text.
    wake_gate_script: (params.wakeGate as { script?: string } | undefined)?.script,
    wake_gate_language: (params.wakeGate as { language?: string } | undefined)?.language,
  };
}

/**
 * Create a record of cron/scheduler RPC handlers bound to the given deps.
 */
export function createCronHandlers(deps: CronHandlerDeps): Record<string, RpcHandler> {
  return {
    [CronAddContract.method]: async (rawParams) => {
      // In-process capability gate — the agent loop skips
      // checkScope, so orch:cron is enforced here, reading the injected
      // _capabilities from raw params BEFORE the strip.
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:cron");

      // Normalize WEB shape (nested schedule + message) into flat shape
      // BEFORE the bespoke duplicate-name guard so the name reads
      // consistently. The legacy flat shape passes through unchanged.
      const normalized = normalizeCronAddParams(rawParams);

      const name = normalized.name as string;
      const scheduleKind = normalized.schedule_kind as CronSchedule["kind"];
      const payloadKind = normalized.payload_kind as string;
      const payloadText = normalized.payload_text as string;

      // Reject duplicate job names (bespoke FIRST — preserves error message).
      const cronAgentIdForCheck = (normalized._agentId as string) ?? deps.defaultAgentId;
      const existingScheduler = deps.cronSchedulers.get(cronAgentIdForCheck);
      if (existingScheduler && existingScheduler.getJobs().some((j) => j.name === name)) {
        throw new Error(`A job named "${name}" already exists. Use a different name or remove the existing job first.`);
      }

      // Dev-mode contract.request.parse runs on the WEB on-wire shape (the
      // original rawParams), NOT the normalized flat shape — the contract
      // describes the on-wire shape only. Internal fields are stripped before
      // parse.
      const userParams = stripInternalFields(rawParams);
      CronAddContract.request.parse(userParams);

      const model = normalized.model as string | undefined;

      // Sanitize payload text to prevent prompt injection
      const sanitizedText = sanitizeToolOutput(payloadText);

      // Build schedule from normalized params
      const schedule = buildCronSchedule(scheduleKind, normalized);

      // Build payload
      const payload =
        payloadKind === "agent_turn"
          ? { kind: "agent_turn" as const, message: sanitizedText, ...(model ? { model } : {}) }
          : { kind: "system_event" as const, text: sanitizedText };

      // Build CronJob
      const cronAgentId = (normalized._agentId as string) ?? deps.defaultAgentId;
      const sessionTarget = (normalized.session_target as string) ?? "isolated";
      const wakeMode = (normalized.wake_mode as string) ?? "next-heartbeat";
      const forwardToMain = (normalized.forward_to_main as boolean) ?? false;
      const sessionStrategy = (normalized.session_strategy as string) ?? "fresh";
      const maxHistoryTurns = (normalized.max_history_turns as number) ?? undefined;
      // Pre-run wake-gate authoring. The script is CODE for the jail, so it is
      // read raw and NEVER passed through sanitizeToolOutput (that helper scrubs
      // payload TEXT). Language falls back to the store schema value.
      const wakeGateScript = normalized.wake_gate_script as string | undefined;
      const wakeGateLanguage = normalized.wake_gate_language as "js" | "ts" | undefined;
      const job = {
        id: randomUUID(),
        name,
        agentId: cronAgentId,
        schedule,
        payload,
        sessionTarget: sessionTarget as "main" | "isolated",
        wakeMode: wakeMode as "now" | "next-heartbeat",
        forwardToMain,
        sessionStrategy: sessionStrategy as "fresh" | "rolling" | "accumulate",
        ...(maxHistoryTurns !== undefined ? { maxHistoryTurns } : {}),
        // A wake-gate is added only when a script was authored -- an un-gated job
        // is byte-identical to one built without these params. The script is
        // stored verbatim (never sanitized); language falls back to the store
        // schema value.
        ...(wakeGateScript
          ? { wakeGate: { script: wakeGateScript, language: wakeGateLanguage ?? "js", timeoutSeconds: 30 } }
          : {}),
        enabled: true,
        consecutiveErrors: 0,
        createdAtMs: systemNowMs(),
        // Capture delivery target from current context if available
        deliveryTarget: rawParams._deliveryTarget as
          | {
              channelId: string;
              userId: string;
              tenantId: string;
              channelType?: string;
            }
          | undefined,
      };

      const agentScheduler = deps.getAgentCronScheduler(cronAgentId);
      await agentScheduler.addJob(job);
      const result = {
        jobId: job.id,
        name: job.name,
        schedule: job.schedule as unknown as Record<string, unknown>,
        ...(payloadKind === "agent_turn" ? { model: model ?? "default" } : {}),
      };
      if (IS_DEV) CronAddContract.response.parse(result);
      return result;
    },

    [CronListContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = CronListContract.request.parse(userParams);

      // Job → wire shape (each row carries its own agentId, so the "*" all-agents
      // view is self-describing).
      const mapJob = (j: ReturnType<ReturnType<CronHandlerDeps["getAgentCronScheduler"]>["getJobs"]>[number]) => ({
        id: j.id,
        name: j.name,
        agentId: j.agentId,
        enabled: j.enabled,
        schedule: j.schedule,
        payload: j.payload,
        sessionTarget: j.sessionTarget,
        nextRunAtMs: j.nextRunAtMs,
        lastRunAtMs: j.lastRunAtMs,
        consecutiveErrors: j.consecutiveErrors,
        createdAtMs: j.createdAtMs,
        deliveryTarget: j.deliveryTarget,
      });

      // `agentId: "*"` → every agent's jobs (the admin inventory view; without
      // it a non-default agent's crons were invisible).
      if (params.agentId === "*") {
        const jobs: Array<ReturnType<typeof mapJob>> = [];
        for (const scheduler of deps.cronSchedulers.values()) {
          jobs.push(...scheduler.getJobs().map(mapJob));
        }
        const result = { jobs: jobs as unknown as Array<Record<string, unknown>> };
        if (IS_DEV) CronListContract.response.parse(result);
        return result;
      }

      // Explicit `agentId` wins over the connection `_agentId`, then the default
      // (preserves per-connection scoping for the un-targeted call).
      const cronAgentId = params.agentId ?? (rawParams._agentId as string) ?? deps.defaultAgentId;
      const scheduler = deps.cronSchedulers.get(cronAgentId);
      if (!scheduler) {
        const result = { jobs: [] };
        if (IS_DEV) CronListContract.response.parse(result);
        return result;
      }
      const result = {
        jobs: scheduler.getJobs().map(mapJob) as unknown as Array<Record<string, unknown>>,
      };
      if (IS_DEV) CronListContract.response.parse(result);
      return result;
    },

    [CronUpdateContract.method]: async (rawParams) => {
      // In-process capability gate (see cron.add).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:cron");

      const userParams = stripInternalFields(rawParams);
      CronUpdateContract.request.parse(userParams);

      const cronAgentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const agentScheduler = deps.getAgentCronScheduler(cronAgentId);
      const matched = resolveJob(agentScheduler, rawParams);
      const jobs = agentScheduler.getJobs();
      const job = jobs.find((j) => j.id === matched.id)!;
      if (rawParams.enabled !== undefined) job.enabled = rawParams.enabled as boolean;
      if (rawParams.name !== undefined) job.name = rawParams.name as string;
      if (rawParams.sessionTarget !== undefined) job.sessionTarget = rawParams.sessionTarget as "main" | "isolated";
      // Schedule: accept raw schedule object (web UI) or build from schedule_kind (chat tool)
      if (rawParams.schedule !== undefined) {
        // Closed-union retype: Zod-validated upstream, structurally compatible with CronSchedule.
        // We narrow via discriminator + presence checks rather than `as CronSchedule` to preserve the existing partial-shape tolerance for legacy payloads.
        const sched = rawParams.schedule as { kind: CronSchedule["kind"]; everyMs?: number; expr?: string; tz?: string; at?: string };
        if (sched.kind === "every" && sched.everyMs) {
          job.schedule = { kind: "every" as const, everyMs: sched.everyMs };
        } else if (sched.kind === "cron" && sched.expr) {
          job.schedule = { kind: "cron" as const, expr: sched.expr, tz: sched.tz };
        } else if (sched.kind === "at" && sched.at) {
          job.schedule = { kind: "at" as const, at: sched.at };
        }
      }
      // Payload message: accept message (web UI) or payload object
      if (rawParams.message !== undefined) {
        job.payload = { ...job.payload, kind: "agent_turn" as const, message: rawParams.message as string };
      }
      // Wake-gate: accept the flat (chat tool) or nested (web) shape. The script
      // is CODE for the jail, so it is set raw and NEVER passed through
      // sanitizeToolOutput. A non-empty script sets/replaces the gate; an
      // explicit empty script CLEARS it; an absent script leaves the existing
      // gate untouched. Language falls back to the store schema value.
      const wakeGateNested = rawParams.wakeGate as
        | { script?: string; language?: "js" | "ts"; timeoutSeconds?: number }
        | undefined;
      const updateWakeGateScript = (rawParams.wake_gate_script as string | undefined) ?? wakeGateNested?.script;
      if (updateWakeGateScript === "") {
        // An explicit empty script clears the gate. Writing { script: "" } would
        // fail the store schema (script.min(1)) and drop the whole job on the
        // next reload -- clearing is the only safe reading of "".
        job.wakeGate = undefined;
      } else if (updateWakeGateScript !== undefined) {
        const updateWakeGateLanguage =
          (rawParams.wake_gate_language as "js" | "ts" | undefined) ?? wakeGateNested?.language;
        job.wakeGate = {
          script: updateWakeGateScript,
          language: updateWakeGateLanguage ?? "js",
          timeoutSeconds: wakeGateNested?.timeoutSeconds ?? 30,
        };
      }
      // Delivery target: set structured target or clear with null
      if (rawParams.deliveryTarget !== undefined) {
        job.deliveryTarget = rawParams.deliveryTarget === null
          ? undefined
          : (rawParams.deliveryTarget as {
              channelId: string;
              userId: string;
              tenantId: string;
              channelType?: string;
            });
      }
      const result = { jobName: job.name, updated: true };
      if (IS_DEV) CronUpdateContract.response.parse(result);
      return result;
    },

    [CronRemoveContract.method]: async (rawParams) => {
      // In-process capability gate (see cron.add).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:cron");

      const userParams = stripInternalFields(rawParams);
      CronRemoveContract.request.parse(userParams);

      const cronAgentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const agentScheduler = deps.getAgentCronScheduler(cronAgentId);
      const jobName = rawParams.jobName as string;
      const matched = resolveJobByName(agentScheduler, jobName);
      const removed = await agentScheduler.removeJob(matched.id);
      const result = { jobName, removed };
      if (IS_DEV) CronRemoveContract.response.parse(result);
      return result;
    },

    [CronStatusContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = CronStatusContract.request.parse(userParams);

      const cronAgentId = params.agentId ?? (rawParams._agentId as string) ?? deps.defaultAgentId; // explicit agentId wins over the connection default
      const scheduler = deps.cronSchedulers.get(cronAgentId);
      const result = {
        running: scheduler !== undefined,
        jobCount: scheduler ? scheduler.getJobs().length : 0,
        resolvedAgentId: cronAgentId,
      };
      if (IS_DEV) CronStatusContract.response.parse(result);
      return result;
    },

    [CronRunsContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = CronRunsContract.request.parse(userParams);

      const cronAgentId = params.agentId ?? (rawParams._agentId as string) ?? deps.defaultAgentId; // explicit agentId wins over the connection default
      const scheduler = deps.cronSchedulers.get(cronAgentId);
      const tracker = deps.executionTrackers.get(cronAgentId);
      if (!tracker || !scheduler) {
        const result = { runs: [] };
        if (IS_DEV) CronRunsContract.response.parse(result);
        return result;
      }
      const matched = resolveJobByName(scheduler, params.jobName);
      const limit = params.limit ?? 20;
      const runs = await tracker.getHistory(matched.id, limit);
      const result = { runs: runs as unknown as Array<Record<string, unknown>> };
      if (IS_DEV) CronRunsContract.response.parse(result);
      return result;
    },

    [CronRunContract.method]: async (rawParams) => {
      // In-process capability gate (see cron.add).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:cron");

      const userParams = stripInternalFields(rawParams);
      const params = CronRunContract.request.parse(userParams);

      // Explicit request `agentId` wins over the connection `_agentId`,
      // then the default — and we ALWAYS report the agent we resolved (no silent
      // default; a silently-defaulted target triggered the wrong agent's cron 3× in live runs).
      const cronAgentId = params.agentId ?? (rawParams._agentId as string) ?? deps.defaultAgentId;
      const agentScheduler = deps.getAgentCronScheduler(cronAgentId);
      const jobName = params.jobName;
      const mode = params.mode ?? "force";
      if (mode === "due") {
        await agentScheduler.runMissedJobs();
        const result = { triggered: true, mode: "due", resolvedAgentId: cronAgentId };
        if (IS_DEV) CronRunContract.response.parse(result);
        return result;
      }
      // Force mode: resolve by name, make immediately due, execute via normal pipeline
      const matched = resolveJobByName(agentScheduler, jobName!);
      const job = agentScheduler.getJobs().find((j) => j.id === matched.id);
      if (job) job.nextRunAtMs = 0;
      await agentScheduler.runMissedJobs();
      const result = { triggered: true, mode: "force", jobName: matched.name, resolvedAgentId: cronAgentId };
      if (IS_DEV) CronRunContract.response.parse(result);
      return result;
    },

    [SchedulerWakeContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = SchedulerWakeContract.request.parse(userParams);

      // Fire-and-forget debounced dispatch via coalescer
      deps.wakeCoalescer.requestHeartbeatNow("wake");
      const result = { woke: true, source: params.source ?? "agent" };
      if (IS_DEV) SchedulerWakeContract.response.parse(result);
      return result;
    },
  };
}
