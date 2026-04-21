// SPDX-License-Identifier: Apache-2.0
/**
 * Cron RPC handler module.
 * Handles all cron-related and scheduler RPC methods:
 *   cron.add, cron.list, cron.update, cron.remove,
 *   cron.status, cron.runs, cron.run, scheduler.wake
 * Extracted from daemon.ts rpcCallInner for independent testability.
 * @module
 */

import type { CronScheduler, ExecutionTracker, WakeCoalescer } from "@comis/scheduler";
import { sanitizeToolOutput } from "@comis/agent";
import { buildCronSchedule } from "../wiring/daemon-utils.js";
import { randomUUID } from "node:crypto";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by cron RPC handlers. */
export interface CronHandlerDeps {
  defaultAgentId: string;
  getAgentCronScheduler: (agentId: string) => CronScheduler;
  cronSchedulers: Map<string, CronScheduler>;
  executionTrackers: Map<string, ExecutionTracker>;
  wakeCoalescer: WakeCoalescer;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Resolve a job by its human-readable name.
 * Throws if no match or if multiple jobs share the same name.
 */
function resolveJobByName(
  scheduler: { getJobs(): Array<{ id: string; name: string }> },
  jobName: string,
): { id: string; name: string } {
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
  return resolveJobByName(scheduler, params.jobName as string);
}

/**
 * Create a record of cron/scheduler RPC handlers bound to the given deps.
 */
export function createCronHandlers(deps: CronHandlerDeps): Record<string, RpcHandler> {
  return {
    "cron.add": async (params) => {
      const name = params.name as string;
      const scheduleKind = params.schedule_kind as string;
      const payloadKind = params.payload_kind as string;
      const payloadText = params.payload_text as string;

      // Reject duplicate job names
      const cronAgentIdForCheck = (params._agentId as string) ?? deps.defaultAgentId;
      const existingScheduler = deps.cronSchedulers.get(cronAgentIdForCheck);
      if (existingScheduler && existingScheduler.getJobs().some((j) => j.name === name)) {
        throw new Error(`A job named "${name}" already exists. Use a different name or remove the existing job first.`);
      }

      const model = params.model as string | undefined;

      // Sanitize payload text to prevent prompt injection
      const sanitizedText = sanitizeToolOutput(payloadText);

      // Build schedule from params
      const schedule = buildCronSchedule(scheduleKind, params);

      // Build payload
      const payload =
        payloadKind === "agent_turn"
          ? { kind: "agent_turn" as const, message: sanitizedText, ...(model ? { model } : {}) }
          : { kind: "system_event" as const, text: sanitizedText };

      // Build CronJob
      const cronAgentId = (params._agentId as string) ?? deps.defaultAgentId;
      const sessionTarget = (params.session_target as string) ?? "isolated";
      const wakeMode = (params.wake_mode as string) ?? "next-heartbeat";
      const forwardToMain = (params.forward_to_main as boolean) ?? false;
      const sessionStrategy = (params.session_strategy as string) ?? "fresh";
      const maxHistoryTurns = (params.max_history_turns as number) ?? undefined;
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
        enabled: true,
        consecutiveErrors: 0,
        createdAtMs: Date.now(),
        // Capture delivery target from current context if available
        deliveryTarget: params._deliveryTarget as
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
      return { jobId: job.id, name: job.name, schedule: job.schedule, model: payloadKind === "agent_turn" ? (model ?? "default") : undefined };
    },

    "cron.list": async (params) => {
      const cronAgentId = (params._agentId as string) ?? deps.defaultAgentId;
      const scheduler = deps.cronSchedulers.get(cronAgentId);
      if (!scheduler) return { jobs: [] };
      return {
        jobs: scheduler.getJobs().map((j) => ({
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
        })),
      };
    },

    "cron.update": async (params) => {
      const cronAgentId = (params._agentId as string) ?? deps.defaultAgentId;
      const agentScheduler = deps.getAgentCronScheduler(cronAgentId);
      const matched = resolveJob(agentScheduler, params);
      const jobs = agentScheduler.getJobs();
      const job = jobs.find((j) => j.id === matched.id)!;
      if (params.enabled !== undefined) job.enabled = params.enabled as boolean;
      if (params.name !== undefined) job.name = params.name as string;
      if (params.sessionTarget !== undefined) job.sessionTarget = params.sessionTarget as "main" | "isolated";
      // Schedule: accept raw schedule object (web UI) or build from schedule_kind (chat tool)
      if (params.schedule !== undefined) {
        const sched = params.schedule as { kind: string; everyMs?: number; expr?: string; tz?: string; at?: string };
        if (sched.kind === "every" && sched.everyMs) {
          job.schedule = { kind: "every" as const, everyMs: sched.everyMs };
        } else if (sched.kind === "cron" && sched.expr) {
          job.schedule = { kind: "cron" as const, expr: sched.expr, tz: sched.tz };
        } else if (sched.kind === "at" && sched.at) {
          job.schedule = { kind: "at" as const, at: sched.at };
        }
      }
      // Payload message: accept message (web UI) or payload object
      if (params.message !== undefined) {
        job.payload = { ...job.payload, kind: "agent_turn" as const, message: params.message as string };
      }
      // Delivery target: set structured target or clear with null
      if (params.deliveryTarget !== undefined) {
        job.deliveryTarget = params.deliveryTarget === null
          ? undefined
          : (params.deliveryTarget as {
              channelId: string;
              userId: string;
              tenantId: string;
              channelType?: string;
            });
      }
      return { jobName: job.name, updated: true };
    },

    "cron.remove": async (params) => {
      const cronAgentId = (params._agentId as string) ?? deps.defaultAgentId;
      const agentScheduler = deps.getAgentCronScheduler(cronAgentId);
      const jobName = params.jobName as string;
      const matched = resolveJobByName(agentScheduler, jobName);
      const removed = await agentScheduler.removeJob(matched.id);
      return { jobName, removed };
    },

    "cron.status": async (params) => {
      const cronAgentId = (params._agentId as string) ?? deps.defaultAgentId;
      const scheduler = deps.cronSchedulers.get(cronAgentId);
      return {
        running: scheduler !== undefined,
        jobCount: scheduler ? scheduler.getJobs().length : 0,
      };
    },

    "cron.runs": async (params) => {
      const cronAgentId = (params._agentId as string) ?? deps.defaultAgentId;
      const scheduler = deps.cronSchedulers.get(cronAgentId);
      const tracker = deps.executionTrackers.get(cronAgentId);
      if (!tracker || !scheduler) return { runs: [] };
      const jobName = params.jobName as string;
      const matched = resolveJobByName(scheduler, jobName);
      const limit = (params.limit as number) ?? 20;
      return { runs: await tracker.getHistory(matched.id, limit) };
    },

    "cron.run": async (params) => {
      const cronAgentId = (params._agentId as string) ?? deps.defaultAgentId;
      const agentScheduler = deps.getAgentCronScheduler(cronAgentId);
      const jobName = params.jobName as string;
      const mode = (params.mode as string) ?? "force";
      if (mode === "due") {
        await agentScheduler.runMissedJobs();
        return { triggered: true, mode: "due" };
      }
      // Force mode: resolve by name, make immediately due, execute via normal pipeline
      const matched = resolveJobByName(agentScheduler, jobName);
      const job = agentScheduler.getJobs().find((j) => j.id === matched.id);
      if (job) job.nextRunAtMs = 0;
      await agentScheduler.runMissedJobs();
      return { triggered: true, mode: "force", jobName: matched.name };
    },

    "scheduler.wake": async (params) => {
      // Fire-and-forget debounced dispatch via coalescer
      deps.wakeCoalescer.requestHeartbeatNow("wake");
      return { woke: true, source: (params.source as string) ?? "agent" };
    },
  };
}
