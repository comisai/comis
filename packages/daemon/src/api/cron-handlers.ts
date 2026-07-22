// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handlers throw typed boundary errors that rpc-dispatch maps to JSON-RPC errors.
/** Strict cron authoring, inventory, history, and manual-run RPC handlers. */
import { randomUUID } from "node:crypto";
import {
  CronAddContract,
  CronListContract,
  CronRemoveContract,
  CronResetContract,
  CronRunContract,
  CronRunsContract,
  CronStatusContract,
  CronUpdateContract,
  SchedulerWakeContract,
  requireCapability,
  stripInternalFields,
  systemGetEnv,
  type ClockPort,
} from "@comis/core";
import {
  CronDeliveryTargetSchema,
  CronPersistedJobSchema,
  computeNextRunAtMs,
  projectCronTerminalOutcome,
  resolveCronAuthoringSchedule,
  type CronAuthorablePayload,
  type CronAuthoringSchedule,
  type CronDeliveryTarget,
  type CronExecutionGroup,
  type CronJob,
  type CronJobLifecycle,
  type CronPersistedSchedule,
} from "@comis/scheduler";
import type { Result } from "@comis/shared";
import { AuthorizationError, PreconditionError, ValidationError } from "./errors.js";
import type { OrchestratorApiDeps } from "./types.js";
import type { RpcHandler } from "./types.js";

const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

export type CronHandlerDeps = OrchestratorApiDeps & { clock?: ClockPort };

type CronMutationError = { errorKind: string; message: string };

function unwrap<T>(result: Result<T, CronMutationError>): T {
  if (result.ok) return result.value;
  if (result.error.errorKind === "validation") throw new ValidationError(result.error.message);
  throw new PreconditionError(result.error.message);
}

function parseTarget(value: unknown): CronDeliveryTarget {
  const parsed = CronDeliveryTargetSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Invalid exact cron delivery target");
  return parsed.data;
}

function targetsEqual(left: CronDeliveryTarget, right: CronDeliveryTarget): boolean {
  const leftEndpoint = left.destinationEndpoint;
  const rightEndpoint = right.destinationEndpoint;
  return left.conversation.conversationRef === right.conversation.conversationRef
    && leftEndpoint.channelType === rightEndpoint.channelType
    && leftEndpoint.channelInstanceId === rightEndpoint.channelInstanceId
    && leftEndpoint.conversationId === rightEndpoint.conversationId
    && leftEndpoint.threadId === rightEndpoint.threadId
    && leftEndpoint.conversationKind === rightEndpoint.conversationKind;
}

function resolveAgentId(
  deps: CronHandlerDeps,
  rawParams: Record<string, unknown>,
  requestedAgentId?: string,
): string {
  const callerAgentId = typeof rawParams._agentId === "string" ? rawParams._agentId : undefined;
  const selected = requestedAgentId ?? callerAgentId ?? deps.defaultAgentId;
  if (
    requestedAgentId !== undefined
    && requestedAgentId !== callerAgentId
    && rawParams._trustLevel !== "admin"
  ) {
    throw new AuthorizationError("Admin access required for cross-agent cron selection");
  }
  return selected;
}

function resolveTarget(
  rawParams: Record<string, unknown>,
  agentId: string,
  requested: CronDeliveryTarget | null | undefined,
): CronDeliveryTarget | undefined {
  const callerAgentId = typeof rawParams._agentId === "string" ? rawParams._agentId : undefined;
  if (callerAgentId !== agentId) return requested ?? undefined;
  const trusted = rawParams._deliveryTarget === undefined
    ? undefined
    : parseTarget(rawParams._deliveryTarget);
  if (requested === null) {
    throw new AuthorizationError("Agent-authored cron mutations cannot clear the trusted request route");
  }
  if (requested !== undefined && (trusted === undefined || !targetsEqual(trusted, requested))) {
    throw new AuthorizationError("Agent-authored cron delivery target must exactly match the trusted request route");
  }
  return trusted;
}

function getJobs(scheduler: ReturnType<CronHandlerDeps["getAgentCronScheduler"]>): readonly CronJob[] {
  return unwrap(scheduler.getJobs());
}

function findJob(
  scheduler: ReturnType<CronHandlerDeps["getAgentCronScheduler"]>,
  params: { jobId?: string; jobName?: string },
): CronJob {
  const jobs = getJobs(scheduler);
  if (params.jobId !== undefined) {
    const match = jobs.find((candidate) => candidate.id === params.jobId);
    if (match === undefined) throw new ValidationError(`Cron job not found: ${params.jobId}`);
    return match;
  }
  if (params.jobName === undefined) {
    throw new ValidationError("Missing required parameter: jobId or jobName");
  }
  const matches = jobs.filter((candidate) => candidate.name === params.jobName);
  if (matches.length === 0) throw new ValidationError(`Cron job not found: ${params.jobName}`);
  if (matches.length > 1) {
    throw new ValidationError(`Cron job name is ambiguous: ${params.jobName}`);
  }
  return matches[0]!;
}

function resolveSchedule(
  deps: CronHandlerDeps,
  agentId: string,
  schedule: CronAuthoringSchedule,
  authoredAtMs: number,
): CronPersistedSchedule {
  const config = deps.getAgentCronAuthoringConfig(agentId);
  return unwrap(resolveCronAuthoringSchedule(schedule, authoredAtMs, config.defaultTimezone));
}

function scheduledLifecycle(
  schedule: CronPersistedSchedule,
  authoredAtMs: number,
): Extract<CronJobLifecycle, { status: "scheduled" }> {
  const nextRunAtMs = computeNextRunAtMs(schedule, authoredAtMs);
  if (nextRunAtMs === undefined) {
    throw new ValidationError("Cron schedule has no future occurrence");
  }
  return { status: "scheduled", nextRunAtMs, consecutiveDependencyErrors: 0 };
}

function buildAuthoredJob(input: {
  id: string;
  name: string;
  agentId: string;
  schedule: CronPersistedSchedule;
  lifecycle: CronJobLifecycle;
  payload: CronAuthorablePayload;
  sessionPolicy?: unknown;
  continuationMode?: unknown;
  deliveryTarget?: CronDeliveryTarget;
  wakeGate?: unknown;
  cacheRetention?: unknown;
  toolPolicy?: unknown;
  maxConsecutiveDependencyErrors?: number;
}): CronJob {
  const common = {
    id: input.id,
    name: input.name,
    agentId: input.agentId,
    source: "authored" as const,
    schedule: input.schedule,
    lifecycle: input.lifecycle,
    ...(input.maxConsecutiveDependencyErrors === undefined
      ? {}
      : { maxConsecutiveDependencyErrors: input.maxConsecutiveDependencyErrors }),
  };
  let candidate: unknown;
  switch (input.payload.kind) {
    case "heartbeat_event":
      candidate = { ...common, payload: input.payload };
      break;
    case "delivery":
      if (input.deliveryTarget === undefined) {
        throw new ValidationError("Direct-delivery cron jobs require an exact delivery target");
      }
      candidate = { ...common, payload: input.payload, deliveryTarget: input.deliveryTarget };
      break;
    case "agent_turn":
      candidate = {
        ...common,
        payload: input.payload,
        sessionPolicy: input.sessionPolicy ?? { strategy: "fresh" },
        continuationMode: input.continuationMode ?? "none",
        ...(input.deliveryTarget === undefined ? {} : { deliveryTarget: input.deliveryTarget }),
        ...(input.wakeGate === undefined ? {} : { wakeGate: input.wakeGate }),
        ...(input.cacheRetention === undefined ? {} : { cacheRetention: input.cacheRetention }),
        ...(input.toolPolicy === undefined ? {} : { toolPolicy: input.toolPolicy }),
      };
      break;
    default: {
      const _exhaustive: never = input.payload;
      throw new ValidationError(`Unsupported cron payload: ${String(_exhaustive)}`);
    }
  }
  const parsed = CronPersistedJobSchema.safeParse(candidate);
  if (!parsed.success) throw new ValidationError("Cron job does not satisfy the strict persisted contract");
  return parsed.data;
}

function replacementLifecycle(
  existing: CronJob,
  schedule: CronPersistedSchedule,
  nowMs: number,
  scheduleChanged: boolean,
  paused: boolean | undefined,
): CronJobLifecycle {
  if (scheduleChanged) {
    const next = scheduledLifecycle(schedule, nowMs);
    return paused === true
      ? {
          status: "paused",
          nextRunAtMs: next.nextRunAtMs,
          consecutiveDependencyErrors: next.consecutiveDependencyErrors,
          reason: "operator",
        }
      : next;
  }
  if (paused === undefined) return existing.lifecycle;
  if (existing.lifecycle.status !== "scheduled" && existing.lifecycle.status !== "paused") {
    throw new PreconditionError("Terminal or claimed one-shot jobs cannot be paused or resumed");
  }
  return paused
    ? {
        status: "paused",
        nextRunAtMs: existing.lifecycle.nextRunAtMs,
        consecutiveDependencyErrors: existing.lifecycle.consecutiveDependencyErrors,
        reason: "operator",
      }
    : {
        status: "scheduled",
        nextRunAtMs: existing.lifecycle.nextRunAtMs,
        consecutiveDependencyErrors: existing.lifecycle.consecutiveDependencyErrors,
      };
}

function projectRun(group: CronExecutionGroup) {
  const terminal = group.terminal;
  const projection = terminal === undefined
    ? { status: "started" as const, deliveryStatus: "not_requested" as const }
    : projectCronTerminalOutcome(terminal.outcome);
  return {
    executionId: group.start.executionId,
    jobId: group.start.jobId,
    agentId: group.start.agentId,
    scheduledForMs: group.start.scheduledForMs,
    trigger: group.start.trigger,
    workKind: group.start.workKind,
    rootRunId: group.start.rootRunId,
    startedAtMs: group.start.startedAtMs,
    ...(terminal === undefined
      ? {}
      : { terminalAtMs: terminal.terminalAtMs, durationMs: terminal.durationMs }),
    ...projection,
  };
}

export function createCronHandlers(deps: CronHandlerDeps): Record<string, RpcHandler> {
  const clock = deps.clock;
  if (clock === undefined) {
    throw new PreconditionError("Cron RPC handlers require an injected clock");
  }
  return {
    [CronAddContract.method]: async (rawParams) => {
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:cron");
      const params = CronAddContract.request.parse(stripInternalFields(rawParams));
      const agentId = resolveAgentId(deps, rawParams, params.agentId);
      const scheduler = deps.getAgentCronScheduler(agentId);
      if (getJobs(scheduler).some((candidate) => candidate.name === params.name)) {
        throw new PreconditionError(`A cron job named "${params.name}" already exists`);
      }
      const nowMs = clock.now();
      const schedule = resolveSchedule(deps, agentId, params.schedule, nowMs);
      const deliveryTarget = resolveTarget(rawParams, agentId, params.deliveryTarget);
      const job = buildAuthoredJob({
        id: randomUUID(),
        name: params.name,
        agentId,
        schedule,
        lifecycle: scheduledLifecycle(schedule, nowMs),
        payload: params.payload,
        sessionPolicy: params.sessionPolicy,
        continuationMode: params.continuationMode,
        deliveryTarget,
        wakeGate: params.wakeGate,
        cacheRetention: params.cacheRetention,
        toolPolicy: params.toolPolicy,
        maxConsecutiveDependencyErrors: params.maxConsecutiveDependencyErrors,
      });
      unwrap(await scheduler.addJob(job));
      const result = { jobId: job.id, name: job.name, schedule: job.schedule };
      if (IS_DEV) CronAddContract.response.parse(result);
      return result;
    },

    [CronListContract.method]: async (rawParams) => {
      const params = CronListContract.request.parse(stripInternalFields(rawParams));
      if (params.agentId === "*") {
        if (rawParams._trustLevel !== "admin") {
          throw new AuthorizationError("Admin access required for all-agent cron inventory");
        }
        const jobs = [...deps.cronSchedulers.values()].flatMap((scheduler) => [...getJobs(scheduler)]);
        const result = { jobs };
        if (IS_DEV) CronListContract.response.parse(result);
        return result;
      }
      const agentId = resolveAgentId(deps, rawParams, params.agentId);
      const scheduler = deps.cronSchedulers.get(agentId);
      const result = { jobs: scheduler === undefined ? [] : [...getJobs(scheduler)] };
      if (IS_DEV) CronListContract.response.parse(result);
      return result;
    },

    [CronUpdateContract.method]: async (rawParams) => {
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:cron");
      const params = CronUpdateContract.request.parse(stripInternalFields(rawParams));
      const agentId = resolveAgentId(deps, rawParams);
      const scheduler = deps.getAgentCronScheduler(agentId);
      const existing = findJob(scheduler, params);
      if (existing.source === "built_in") {
        throw new PreconditionError("Config-owned cron jobs cannot be updated through cron.update");
      }
      const nowMs = clock.now();
      const schedule = params.schedule === undefined
        ? existing.schedule
        : resolveSchedule(deps, agentId, params.schedule, nowMs);
      const payload = params.payload ?? existing.payload;
      const requestedTarget = params.deliveryTarget === undefined
        ? ("deliveryTarget" in existing ? existing.deliveryTarget : undefined)
        : params.deliveryTarget;
      const deliveryTarget = resolveTarget(rawParams, agentId, requestedTarget);
      const updated = buildAuthoredJob({
        id: existing.id,
        name: params.name ?? existing.name,
        agentId,
        schedule,
        lifecycle: replacementLifecycle(existing, schedule, nowMs, params.schedule !== undefined, params.paused),
        payload,
        sessionPolicy: params.sessionPolicy
          ?? ("sessionPolicy" in existing ? existing.sessionPolicy : undefined),
        continuationMode: params.continuationMode
          ?? ("continuationMode" in existing ? existing.continuationMode : undefined),
        deliveryTarget,
        wakeGate: params.wakeGate === null
          ? undefined
          : params.wakeGate ?? ("wakeGate" in existing ? existing.wakeGate : undefined),
        cacheRetention: params.cacheRetention === null
          ? undefined
          : params.cacheRetention ?? ("cacheRetention" in existing ? existing.cacheRetention : undefined),
        toolPolicy: params.toolPolicy === null
          ? undefined
          : params.toolPolicy ?? ("toolPolicy" in existing ? existing.toolPolicy : undefined),
        maxConsecutiveDependencyErrors: params.maxConsecutiveDependencyErrors === null
          ? undefined
          : params.maxConsecutiveDependencyErrors ?? existing.maxConsecutiveDependencyErrors,
      });
      unwrap(await scheduler.replaceJob(existing.id, updated));
      const result = { jobName: updated.name, updated: true };
      if (IS_DEV) CronUpdateContract.response.parse(result);
      return result;
    },

    [CronRemoveContract.method]: async (rawParams) => {
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:cron");
      const params = CronRemoveContract.request.parse(stripInternalFields(rawParams));
      const agentId = resolveAgentId(deps, rawParams);
      const scheduler = deps.getAgentCronScheduler(agentId);
      const existing = findJob(scheduler, params);
      if (existing.source === "built_in") {
        throw new PreconditionError("Config-owned cron jobs cannot be removed through cron.remove");
      }
      const removed = unwrap(await scheduler.removeJob(existing.id));
      const result = { jobName: existing.name, removed };
      if (IS_DEV) CronRemoveContract.response.parse(result);
      return result;
    },

    [CronStatusContract.method]: async (rawParams) => {
      const params = CronStatusContract.request.parse(stripInternalFields(rawParams));
      const agentId = resolveAgentId(deps, rawParams, params.agentId);
      const controller = deps.cronMaintenanceControllers.get(agentId);
      if (controller === undefined) throw new ValidationError(`Cron maintenance state not found: ${agentId}`);
      const status = unwrap(await controller.status());
      const result = {
        ...status,
        running: status.state === "active",
        resolvedAgentId: agentId,
      };
      if (IS_DEV) CronStatusContract.response.parse(result);
      return result;
    },

    [CronResetContract.method]: async (rawParams) => {
      if (rawParams._trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for cron authority reset");
      }
      const params = CronResetContract.request.parse(stripInternalFields(rawParams));
      const agentId = params.agentId ?? deps.defaultAgentId;
      const controller = deps.cronMaintenanceControllers.get(agentId);
      if (controller === undefined) throw new ValidationError(`Cron maintenance state not found: ${agentId}`);
      const resetResult = params.target === "store"
        ? await controller.reset({
          target: "store",
          expectedDigests: params.expectedDigests,
          confirmed: true,
          actorScope: "admin",
        })
        : params.target === "ledger"
          ? await controller.reset({
            target: "ledger",
            expectedDigests: params.expectedDigests,
            confirmed: true,
            actorScope: "admin",
          })
          : await controller.reset({
            target: "all",
            expectedDigests: params.expectedDigests,
            confirmed: true,
            actorScope: "admin",
          });
      const reset = unwrap(resetResult);
      const result = { ...reset, resolvedAgentId: agentId };
      if (IS_DEV) CronResetContract.response.parse(result);
      return result;
    },

    [CronRunsContract.method]: async (rawParams) => {
      const params = CronRunsContract.request.parse(stripInternalFields(rawParams));
      const agentId = resolveAgentId(deps, rawParams, params.agentId);
      const scheduler = deps.cronSchedulers.get(agentId);
      const tracker = deps.executionTrackers.get(agentId);
      if (scheduler === undefined || tracker === undefined) return { runs: [] };
      const existing = findJob(scheduler, { jobName: params.jobName });
      const history = unwrap(await tracker.listHistory({ jobId: existing.id, limit: params.limit ?? 20 }));
      const result = { runs: history.map(projectRun) };
      if (IS_DEV) CronRunsContract.response.parse(result);
      return result;
    },

    [CronRunContract.method]: async (rawParams) => {
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:cron");
      const params = CronRunContract.request.parse(stripInternalFields(rawParams));
      const agentId = resolveAgentId(deps, rawParams, params.agentId);
      const scheduler = deps.getAgentCronScheduler(agentId);
      if ((params.mode ?? "force") === "due") {
        const executionIds = unwrap(await scheduler.runMissedJobs());
        const result = { triggered: true, mode: "due" as const, resolvedAgentId: agentId, executionIds };
        if (IS_DEV) CronRunContract.response.parse(result);
        return result;
      }
      const existing = findJob(scheduler, { jobName: params.jobName });
      const executionId = unwrap(await scheduler.runJob(existing.id));
      const result = {
        triggered: true,
        mode: "force" as const,
        jobName: existing.name,
        resolvedAgentId: agentId,
        executionId,
      };
      if (IS_DEV) CronRunContract.response.parse(result);
      return result;
    },

    [SchedulerWakeContract.method]: async (rawParams) => {
      const params = SchedulerWakeContract.request.parse(stripInternalFields(rawParams));
      if (deps.heartbeatCoordinator === undefined) {
        throw new PreconditionError("Heartbeat coordinator not available");
      }
      const target = params.target === "monitoring"
        ? { kind: "monitoring" as const }
        : { kind: "agent" as const, agentId: resolveAgentId(deps, rawParams) };
      if (target.kind === "agent" && deps.agents[target.agentId] === undefined) {
        throw new ValidationError(`Agent not found: ${target.agentId}`);
      }
      const admitted = deps.heartbeatCoordinator.submitWake({
        target,
        reason: "wake",
        timing: { kind: "routine", notBeforeMs: deps.schedulerNowMs() },
      });
      if (!admitted.ok) {
        if (admitted.error.errorKind === "validation") {
          throw new ValidationError(`Scheduler wake admission failed: ${admitted.error.code}`);
        }
        throw new PreconditionError(`Scheduler wake admission failed: ${admitted.error.code}`);
      }
      const result = admitted.value;
      if (IS_DEV) SchedulerWakeContract.response.parse(result);
      return result;
    },
  };
}
