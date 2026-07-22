// SPDX-License-Identifier: Apache-2.0
import type { ClockPort, ErrorKind, TimerHandle, TimerPort, TypedEventBus } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import type { SchedulerLogger } from "../shared-types.js";
import {
  classifyCronDependencyOutcome,
  type CronExecutionStartedRow,
  type CronExecutionTerminalRow,
  type CronTerminalOutcome,
} from "../execution/cron-execution-record.js";
import {
  emitDurableCronStarted,
  emitDurableCronTerminal,
} from "../execution/cron-execution-events.js";
import {
  emitCronModelDrift,
  prepareCronModelDriftEvidence,
} from "../execution/cron-model-drift.js";
import type { ExecutionTracker } from "../execution/execution-tracker.js";
import { resolveSchedulerPhaseMs } from "../scheduler-phase.js";
import {
  CronRuntimeExecutionInputSchema,
  CronRuntimeOutcomeSchema,
  SCHEDULER_TERMINATION_GRACE_MS,
  mapCronRuntimeErrorStage,
  type CronRuntimeError,
  type CronRuntimeExecutionInput,
  type CronRuntimeExecutor,
  type CronRuntimeOutcome,
} from "./cron-runtime.js";
import {
  TERMINAL_JOB_RETENTION_MS,
  type CronActiveClaim,
  type CronStore,
  type CronTrigger,
  type CronWorkKind,
} from "./cron-store.js";
import type { CronJob } from "./cron-types.js";

const MAX_TIMER_DELAY_MS = 60_000;

export type CronRootRegistrationError = {
  errorKind: ErrorKind;
  message: string;
};

export interface CronRootRegistrar {
  register(input: {
    rootRunId: string;
    executionId: string;
    job: CronJob;
  }): Promise<Result<void, CronRootRegistrationError>>;
  release(rootRunId: string): Promise<Result<void, CronRootRegistrationError>>;
}

export interface CronSchedulerDeps {
  store: CronStore;
  tracker: ExecutionTracker;
  executor: CronRuntimeExecutor;
  rootRegistrar: CronRootRegistrar;
  eventBus: TypedEventBus;
  logger: SchedulerLogger;
  clock: ClockPort;
  timers: TimerPort;
  bootId: string;
  idFactory: () => string;
  config: {
    maxRunsPerTick: number;
    defaultTimeoutMs: number;
    staggerWindowMs: number;
  };
}

export type CronSchedulerErrorCode =
  | "not_initialized"
  | "not_active"
  | "maintenance_required"
  | "active_execution"
  | "initialization_failed"
  | "invalid_configuration"
  | "operation_failed";

export type CronSchedulerLifecycleError = {
  code: CronSchedulerErrorCode;
  errorKind: ErrorKind;
  message: string;
};

export interface CronScheduler {
  initialize(): Promise<Result<void, CronSchedulerLifecycleError>>;
  reload(): Promise<Result<void, CronSchedulerLifecycleError>>;
  activate(): Result<void, CronSchedulerLifecycleError>;
  enterMaintenance(): Result<{ activeExecutions: number }, CronSchedulerLifecycleError>;
  closeAdmission(): { readonly activeExecutions: number };
  waitForIdle(): Promise<void>;
  abortActive(): { readonly activeExecutions: number };
  stop(): Promise<Result<void, CronSchedulerLifecycleError>>;
  addJob(job: CronJob): Promise<Result<void, CronSchedulerLifecycleError>>;
  replaceJob(jobId: string, job: CronJob): Promise<Result<void, CronSchedulerLifecycleError>>;
  removeJob(jobId: string): Promise<Result<boolean, CronSchedulerLifecycleError>>;
  getJobs(): Result<readonly CronJob[], CronSchedulerLifecycleError>;
  runMissedJobs(): Promise<Result<readonly string[], CronSchedulerLifecycleError>>;
  runJob(jobId: string): Promise<Result<string, CronSchedulerLifecycleError>>;
}

type ExecutionWaitResult =
  | { kind: "settled"; result: Result<CronRuntimeOutcome, CronRuntimeError> }
  | { kind: "unsettled" };

export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  let initialized = false;
  let active = false;
  let timer: TimerHandle | undefined;
  const running = new Map<string, Promise<Result<string, CronSchedulerLifecycleError>>>();
  const activeControllers = new Map<string, AbortController>();
  const configError = validateConfig(deps);

  async function initialize(): Promise<Result<void, CronSchedulerLifecycleError>> {
    if (initialized) return ok(undefined);
    return load();
  }

  async function load(): Promise<Result<void, CronSchedulerLifecycleError>> {
    if (configError !== undefined) return err(configError);
    const store = await deps.store.initialize();
    if (!store.ok) return initializationFailure("cron store", store.error);
    const tracker = await deps.tracker.initialize();
    if (!tracker.ok) return initializationFailure("cron execution ledger", tracker.error);
    initialized = true;
    deps.logger.debug({ jobCount: store.value.jobs.length }, "Cron scheduler initialized");
    return ok(undefined);
  }

  async function reload(): Promise<Result<void, CronSchedulerLifecycleError>> {
    if (active) {
      return err(schedulerError(
        "maintenance_required",
        "precondition",
        "Cron scheduler must enter maintenance before strict state reload",
      ));
    }
    if (running.size > 0) {
      return err(schedulerError(
        "active_execution",
        "precondition",
        "Cron scheduler still has an accepted current-boot execution",
      ));
    }
    initialized = false;
    return load();
  }

  function activate(): Result<void, CronSchedulerLifecycleError> {
    if (!initialized) return err(schedulerError("not_initialized", "precondition", "Cron scheduler must be initialized before activation"));
    if (active) return ok(undefined);
    const validEligibility = validateStaggerEligibility();
    if (!validEligibility.ok) return validEligibility;
    active = true;
    armTimer();
    deps.logger.debug({ jobCount: currentJobCount() }, "Cron scheduler activated");
    return ok(undefined);
  }

  function closeAdmission(): { readonly activeExecutions: number } {
    active = false;
    cancelTimer();
    deps.logger.info({ activeExecutions: running.size }, "Cron scheduler stopped accepting work");
    return { activeExecutions: running.size };
  }

  async function waitForIdle(): Promise<void> {
    while (running.size > 0) {
      await Promise.allSettled([...running.values()]);
    }
  }

  function abortActive(): { readonly activeExecutions: number } {
    const activeExecutions = running.size;
    for (const controller of activeControllers.values()) controller.abort("shutdown");
    return { activeExecutions };
  }

  async function stop(): Promise<Result<void, CronSchedulerLifecycleError>> {
    closeAdmission();
    return ok(undefined);
  }

  function enterMaintenance(): Result<{ activeExecutions: number }, CronSchedulerLifecycleError> {
    active = false;
    cancelTimer();
    const status = { activeExecutions: running.size };
    deps.logger.info({ ...status, durationMs: 0 }, "Cron scheduler entered maintenance");
    return ok(status);
  }

  async function addJob(job: CronJob): Promise<Result<void, CronSchedulerLifecycleError>> {
    const ready = requireInitialized();
    if (!ready.ok) return ready;
    const validEligibility = validateJobStaggerEligibility(job);
    if (!validEligibility.ok) return validEligibility;
    const added = await deps.store.addJob(job);
    if (!added.ok) return operationFailure("add cron job", added.error);
    armTimer();
    return ok(undefined);
  }

  async function replaceJob(jobId: string, job: CronJob): Promise<Result<void, CronSchedulerLifecycleError>> {
    const ready = requireInitialized();
    if (!ready.ok) return ready;
    const validEligibility = validateJobStaggerEligibility(job);
    if (!validEligibility.ok) return validEligibility;
    const replaced = await deps.store.replaceAuthoredJob(jobId, job);
    if (!replaced.ok) return operationFailure("replace cron job", replaced.error);
    armTimer();
    return ok(undefined);
  }

  async function removeJob(jobId: string): Promise<Result<boolean, CronSchedulerLifecycleError>> {
    const ready = requireInitialized();
    if (!ready.ok) return ready;
    const removed = await deps.store.removeJob(jobId);
    if (!removed.ok) return operationFailure("remove cron job", removed.error);
    armTimer();
    return removed;
  }

  function getJobs(): Result<readonly CronJob[], CronSchedulerLifecycleError> {
    const jobs = deps.store.listJobs();
    return jobs.ok ? ok(jobs.value) : operationFailure("list cron jobs", jobs.error);
  }

  async function runMissedJobs(): Promise<Result<readonly string[], CronSchedulerLifecycleError>> {
    const ready = requireActive();
    if (!ready.ok) return ready;
    const snapshot = deps.store.getSnapshot();
    if (!snapshot.ok) return operationFailure("read due cron jobs", snapshot.error);
    const nowMs = deps.clock.now();
    const due: CronJob[] = [];
    for (const job of snapshot.value.jobs) {
      if (job.lifecycle.status !== "scheduled") continue;
      const eligibility = resolveEligibilityAtMs(job, snapshot.value.agentSchedulerSeed);
      if (!eligibility.ok) return eligibility;
      if (eligibility.value <= nowMs) due.push(job);
    }
    const selectedDue = due.slice(0, deps.config.maxRunsPerTick);
    const ids: string[] = [];
    for (const job of selectedDue) {
      const execution = await runOccurrence(
        job.id,
        job.lifecycle.status === "scheduled" && job.lifecycle.nextRunAtMs < nowMs ? "catchup" : "scheduled",
        job.lifecycle.status === "scheduled" ? job.lifecycle.nextRunAtMs : nowMs,
      );
      if (!execution.ok) return execution;
      ids.push(execution.value);
    }
    armTimer();
    return ok(ids);
  }

  async function runJob(jobId: string): Promise<Result<string, CronSchedulerLifecycleError>> {
    const ready = requireActive();
    if (!ready.ok) return ready;
    return runOccurrence(jobId, "manual", deps.clock.now());
  }

  async function runOccurrence(
    jobId: string,
    trigger: CronTrigger,
    scheduledForMs: number,
  ): Promise<Result<string, CronSchedulerLifecycleError>> {
    const executionId = deps.idFactory();
    if (running.has(executionId)) {
      return err(schedulerError("operation_failed", "precondition", "Cron execution id is already active"));
    }
    const controller = new AbortController();
    activeControllers.set(executionId, controller);
    const promise = executeOccurrence(jobId, executionId, trigger, scheduledForMs, controller);
    running.set(executionId, promise);
    try {
      return await promise;
    } finally {
      running.delete(executionId);
      activeControllers.delete(executionId);
    }
  }

  async function executeOccurrence(
    jobId: string,
    executionId: string,
    trigger: CronTrigger,
    scheduledForMs: number,
    controller: AbortController,
  ): Promise<Result<string, CronSchedulerLifecycleError>> {
    const initialJobs = deps.store.listJobs();
    if (!initialJobs.ok) return operationFailure("read cron job for claim", initialJobs.error);
    const candidate = initialJobs.value.find((job) => job.id === jobId);
    if (candidate === undefined) return err(schedulerError("operation_failed", "validation", "Cron job not found"));
    const workKind = workKindOf(candidate);
    const rootRunId = requiresGovernedRoot(workKind) ? `root-cron-${executionId}` : null;
    const claimedAtMs = deps.clock.now();
    const claimed = await deps.store.claim({
      jobId,
      executionId,
      bootId: deps.bootId,
      rootRunId,
      trigger,
      scheduledForMs: trigger === "manual" ? undefined : scheduledForMs,
      claimedAtMs,
    });
    if (!claimed.ok) return operationFailure("claim cron occurrence", claimed.error);

    const startedAtMs = deps.clock.now();
    const start: CronExecutionStartedRow = {
      executionId,
      bootId: deps.bootId,
      jobId: claimed.value.job.id,
      agentId: claimed.value.job.agentId,
      scheduledForMs: claimed.value.claim.scheduledForMs,
      trigger,
      recordType: "started",
      workKind,
      rootRunId,
      startedAtMs,
    };
    const started = await deps.tracker.appendStart(start, activeClaimIds());
    if (!started.ok) {
      logFailure("Cron execution start record failed", started.error, {
        executionId, jobId, step: "start_record",
        hint: "Repair the execution ledger; the durable claim will be reconciled before any future dispatch",
      });
      return operationFailure("append cron execution start", started.error);
    }
    emitDurableCronStarted({ eventBus: deps.eventBus, logger: deps.logger, start });

    if (rootRunId !== null) {
      const registered = await deps.rootRegistrar.register({ rootRunId, executionId, job: claimed.value.job });
      if (!registered.ok) {
        const terminal = makeTerminal(start, deps.clock.now(), {
          kind: "pre_dispatch_failure",
          stage: "root_registration",
          errorKind: "internal",
        });
        const completed = await appendAndSettle(claimed.value.claim, terminal, false);
        await releaseRoot(rootRunId);
        return completed.ok ? ok(executionId) : completed;
      }
    }

    const input = buildRuntimeInput(claimed.value.claim, claimed.value.job);
    if (!input.ok) {
      const terminal = makeTerminal(start, deps.clock.now(), {
        kind: "pre_dispatch_failure",
        stage: "executor_invalid_input",
        errorKind: "validation",
      });
      const completed = await appendAndSettle(claimed.value.claim, terminal, false);
      if (rootRunId !== null) await releaseRoot(rootRunId);
      return completed.ok ? ok(executionId) : completed;
    }

    const timeoutMs = resolveTimeoutMs(claimed.value.job, deps.config.defaultTimeoutMs);
    const waited = await awaitRuntime(input.value, timeoutMs, rootRunId, controller);
    if (!waited.ok) return waited;
    let outcome: CronTerminalOutcome;
    let keepRoot = false;
    if (waited.value.kind === "unsettled") {
      keepRoot = rootRunId !== null;
      outcome = {
        kind: "unsettled",
        reason: "deadline_termination_unestablished",
        rootRunId,
        errorKind: "timeout",
      };
    } else if (!waited.value.result.ok) {
      outcome = {
        kind: "pre_dispatch_failure",
        stage: mapCronRuntimeErrorStage(waited.value.result.error.code),
        errorKind: waited.value.result.error.errorKind,
      };
    } else {
      const parsed = CronRuntimeOutcomeSchema.safeParse(waited.value.result.value);
      if (!parsed.success) {
        logFailure("Cron runtime returned invalid terminal evidence", {
          errorKind: "validation", message: "Runtime outcome failed strict parsing",
        }, {
          executionId, jobId, step: "runtime_outcome",
          hint: "Repair the cron runtime adapter; the durable claim remains for conservative owner recovery",
        });
        return err(schedulerError("operation_failed", "validation", "Cron runtime returned invalid terminal evidence"));
      }
      outcome = terminalOutcomeOf(parsed.data);
    }

    const terminal = makeTerminal(start, deps.clock.now(), outcome);
    const completed = await appendAndSettle(claimed.value.claim, terminal, keepRoot);
    if (rootRunId !== null && !keepRoot) await releaseRoot(rootRunId);
    return completed.ok ? ok(executionId) : completed;
  }

  async function awaitRuntime(
    input: CronRuntimeExecutionInput,
    timeoutMs: number,
    rootRunId: string | null,
    controller: AbortController,
  ): Promise<Result<ExecutionWaitResult, CronSchedulerLifecycleError>> {
    let execution: Promise<Result<CronRuntimeOutcome, CronRuntimeError>>;
    try {
      execution = deps.executor.execute(input, controller.signal);
    } catch (cause) {
      return runtimeRejection(cause, input.executionId);
    }
    const firstDeadline = deferredSignal();
    const deadlineHandle = deps.timers.setTimeout(() => firstDeadline.resolve(), timeoutMs);
    deadlineHandle.unref();
    let first: { kind: "settled"; result: Result<CronRuntimeOutcome, CronRuntimeError> } | { kind: "deadline" };
    try {
      first = await Promise.race([
        execution.then((result) => ({ kind: "settled" as const, result })),
        firstDeadline.promise.then(() => ({ kind: "deadline" as const })),
      ]);
    } catch (cause) {
      deadlineHandle.cancel();
      return runtimeRejection(cause, input.executionId);
    }
    if (first.kind === "settled") {
      deadlineHandle.cancel();
      return ok(first);
    }

    controller.abort();
    const graceSignal = deferredSignal();
    const graceHandle = deps.timers.setTimeout(() => graceSignal.resolve(), SCHEDULER_TERMINATION_GRACE_MS);
    graceHandle.unref();
    let grace: { kind: "settled"; result: Result<CronRuntimeOutcome, CronRuntimeError> } | { kind: "expired" };
    try {
      grace = await Promise.race([
        execution.then((result) => ({ kind: "settled" as const, result })),
        graceSignal.promise.then(() => ({ kind: "expired" as const })),
      ]);
    } catch (cause) {
      graceHandle.cancel();
      return runtimeRejection(cause, input.executionId);
    }
    if (grace.kind === "settled") {
      graceHandle.cancel();
      return ok(grace);
    }

    void execution.then(
      async () => {
        if (rootRunId !== null) await releaseRoot(rootRunId);
        deps.logger.info({ executionId: input.executionId, step: "late_settlement" }, "Cron runtime settled after immutable unknown outcome");
      },
      (cause: unknown) => {
        logRuntimeRejection(cause, input.executionId, "late_settlement");
      },
    );
    return ok({ kind: "unsettled" });
  }

  async function appendAndSettle(
    claim: CronActiveClaim,
    terminal: CronExecutionTerminalRow,
    keepRoot: boolean,
  ): Promise<Result<void, CronSchedulerLifecycleError>> {
    const modelDrift = await prepareCronModelDriftEvidence({
      tracker: deps.tracker,
      logger: deps.logger,
      terminal,
    });
    const appended = await deps.tracker.appendTerminal(terminal, activeClaimIds());
    if (!appended.ok) {
      logFailure("Cron execution terminal record failed", appended.error, {
        executionId: terminal.executionId,
        jobId: terminal.jobId,
        step: "terminal_record",
        hint: "Repair the execution ledger; the durable claim will reconcile this started occurrence conservatively",
      });
      return operationFailure("append cron execution terminal", appended.error);
    }
    emitDurableCronTerminal({ eventBus: deps.eventBus, logger: deps.logger, terminal });
    if (modelDrift !== undefined) {
      emitCronModelDrift({ eventBus: deps.eventBus, logger: deps.logger, evidence: modelDrift });
    }
    const settled = await deps.store.settleClaim({
      executionId: claim.executionId,
      terminalAtMs: terminal.terminalAtMs,
      dependencyOutcome: classifyCronDependencyOutcome(terminal.outcome),
    });
    if (!settled.ok) {
      logFailure("Cron execution claim settlement failed", settled.error, {
        executionId: terminal.executionId,
        jobId: terminal.jobId,
        step: "claim_settlement",
        hint: "Repair the cron store; startup reconciliation will apply the immutable terminal exactly once",
      });
      return operationFailure("settle cron execution claim", settled.error);
    }
    deps.logger.info({
      executionId: terminal.executionId,
      jobId: terminal.jobId,
      durationMs: terminal.durationMs,
      outcomeKind: terminal.outcome.kind,
      keepRoot,
    }, "Cron execution reached durable terminal state");
    armTimer();
    return ok(undefined);
  }

  function armTimer(): void {
    cancelTimer();
    if (!active) return;
    const snapshot = deps.store.getSnapshot();
    if (!snapshot.ok) {
      logFailure("Cron timer could not read scheduler state", snapshot.error, {
        step: "timer_arm",
        hint: "Repair the cron store before scheduled execution can resume",
      });
      return;
    }
    const nowMs = deps.clock.now();
    const deadlines: number[] = [];
    for (const job of snapshot.value.jobs) {
      if (job.lifecycle.status === "scheduled") {
        const eligibility = resolveEligibilityAtMs(job, snapshot.value.agentSchedulerSeed);
        if (!eligibility.ok) {
          logFailure("Cron timer eligibility is invalid", eligibility.error, {
            jobId: job.id,
            step: "timer_arm",
            hint: "Reduce scheduler.cron.staggerWindowMs or recreate the recurring schedule inside the safe epoch range",
          });
          return;
        }
        deadlines.push(eligibility.value);
      }
      if (job.lifecycle.status === "one_shot_terminal") {
        const expiry = job.lifecycle.terminalAtMs + TERMINAL_JOB_RETENTION_MS;
        if (Number.isSafeInteger(expiry)) deadlines.push(expiry);
      }
    }
    if (deadlines.length === 0) return;
    const earliest = Math.min(...deadlines);
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliest - nowMs));
    timer = deps.timers.setTimeout(() => {
      timer = undefined;
      void runMissedJobs().then((result) => {
        if (!result.ok) {
          logFailure("Cron timer tick failed", result.error, {
            step: "timer_tick",
            hint: "Inspect scheduler health and persisted cron ownership before retrying",
          });
        }
        armTimer();
      });
    }, delay);
    timer.unref();
  }

  function cancelTimer(): void {
    timer?.cancel();
    timer = undefined;
  }

  function activeClaimIds(): string[] {
    const snapshot = deps.store.getSnapshot();
    return snapshot.ok ? snapshot.value.activeClaims.map((claim) => claim.executionId) : [];
  }

  async function releaseRoot(rootRunId: string): Promise<void> {
    const released = await deps.rootRegistrar.release(rootRunId);
    if (!released.ok) {
      logFailure("Cron execution root release failed", released.error, {
        rootRunId,
        step: "root_release",
        hint: "Inspect the root budget registry and release the completed cron root",
      });
    }
  }

  function logFailure(
    message: string,
    failure: { errorKind: ErrorKind; message: string },
    fields: Record<string, unknown> & { hint: string },
  ): void {
    deps.logger.error({ ...fields, err: failure.message, errorKind: failure.errorKind }, message);
  }

  function currentJobCount(): number {
    const jobs = deps.store.listJobs();
    return jobs.ok ? jobs.value.length : 0;
  }

  function validateStaggerEligibility(): Result<void, CronSchedulerLifecycleError> {
    const snapshot = deps.store.getSnapshot();
    if (!snapshot.ok) return operationFailure("validate cron stagger eligibility", snapshot.error);
    for (const job of snapshot.value.jobs) {
      const validated = validateJobStaggerEligibility(job, snapshot.value.agentSchedulerSeed);
      if (!validated.ok) return validated;
    }
    return ok(undefined);
  }

  function validateJobStaggerEligibility(
    job: CronJob,
    knownSeed?: string,
  ): Result<void, CronSchedulerLifecycleError> {
    if (job.lifecycle.status !== "scheduled" || job.schedule.kind === "at" || deps.config.staggerWindowMs === 0) {
      return ok(undefined);
    }
    const seedResult = knownSeed === undefined ? deps.store.getSnapshot() : undefined;
    if (seedResult !== undefined && !seedResult.ok) {
      return operationFailure("read scheduler seed", seedResult.error);
    }
    const seed = knownSeed ?? (seedResult?.ok === true ? seedResult.value.agentSchedulerSeed : "");
    const maxEligibility = BigInt(job.lifecycle.nextRunAtMs) + BigInt(deps.config.staggerWindowMs - 1);
    if (maxEligibility > BigInt(Number.MAX_SAFE_INTEGER)) {
      return err(schedulerError(
        "invalid_configuration",
        "config",
        "Cron stagger window exceeds the safe epoch range for a recurring job",
      ));
    }
    const eligibility = resolveEligibilityAtMs(job, seed);
    return eligibility.ok ? ok(undefined) : eligibility;
  }

  function resolveEligibilityAtMs(
    job: CronJob,
    agentSchedulerSeed: string,
  ): Result<number, CronSchedulerLifecycleError> {
    if (job.lifecycle.status !== "scheduled") {
      return err(schedulerError("operation_failed", "precondition", "Cron job has no scheduled eligibility"));
    }
    if (job.schedule.kind === "at" || deps.config.staggerWindowMs === 0) {
      return ok(job.lifecycle.nextRunAtMs);
    }
    const phase = resolveSchedulerPhaseMs(
      agentSchedulerSeed,
      "job",
      job.id,
      deps.config.staggerWindowMs,
    );
    if (!phase.ok) {
      return err(schedulerError("invalid_configuration", "config", phase.error.message));
    }
    const eligibility = BigInt(job.lifecycle.nextRunAtMs) + BigInt(phase.value);
    if (eligibility > BigInt(Number.MAX_SAFE_INTEGER)) {
      return err(schedulerError(
        "invalid_configuration",
        "config",
        "Cron stagger eligibility exceeds the safe epoch range",
      ));
    }
    return ok(Number(eligibility));
  }

  function requireInitialized(): Result<void, CronSchedulerLifecycleError> {
    return initialized
      ? ok(undefined)
      : err(schedulerError("not_initialized", "precondition", "Cron scheduler is not initialized"));
  }

  function requireActive(): Result<void, CronSchedulerLifecycleError> {
    const ready = requireInitialized();
    if (!ready.ok) return ready;
    return active
      ? ok(undefined)
      : err(schedulerError("not_active", "precondition", "Cron scheduler is not accepting execution"));
  }

  return {
    initialize,
    reload,
    activate,
    enterMaintenance,
    closeAdmission,
    waitForIdle,
    abortActive,
    stop,
    addJob,
    replaceJob,
    removeJob,
    getJobs,
    runMissedJobs,
    runJob,
  };
}

function buildRuntimeInput(
  claim: CronActiveClaim,
  job: CronJob,
): Result<CronRuntimeExecutionInput, CronSchedulerLifecycleError> {
  const common = {
    executionId: claim.executionId,
    scheduledForMs: claim.scheduledForMs,
    trigger: claim.trigger,
  };
  let candidate: unknown;
  switch (job.payload.kind) {
    case "agent_turn": candidate = { ...common, kind: "agent_turn", rootRunId: claim.rootRunId, job }; break;
    case "heartbeat_event": candidate = { ...common, kind: "heartbeat_event", job }; break;
    case "internal_action": candidate = { ...common, kind: "internal_action", rootRunId: claim.rootRunId, job }; break;
    case "delivery": candidate = { ...common, kind: "delivery_only", job }; break;
    default: {
      const _exhaustive: never = job.payload;
      return _exhaustive;
    }
  }
  const parsed = CronRuntimeExecutionInputSchema.safeParse(candidate);
  return parsed.success
    ? ok(parsed.data)
    : err(schedulerError("operation_failed", "validation", "Cron runtime input failed strict validation"));
}

function terminalOutcomeOf(outcome: CronRuntimeOutcome): CronTerminalOutcome {
  switch (outcome.kind) {
    case "agent_turn": {
      const { durationMs: _durationMs, ...metrics } = outcome.outcome.metrics;
      return { kind: "agent_turn", ...outcome.outcome, metrics };
    }
    case "wake_gate_skip": return {
      kind: outcome.kind,
      rootRunId: outcome.rootRunId,
      gateDurationMs: outcome.durationMs,
      gateToolCalls: outcome.toolCalls,
      delivery: outcome.delivery,
      continuation: outcome.continuation,
    };
    case "agent_turn_pre_model_skip": return outcome;
    case "heartbeat_event": return {
      kind: outcome.kind,
      correlationId: outcome.correlationId,
      queueDisposition: outcome.queueDisposition,
    };
    case "internal_action": return outcome;
    case "delivery_only": return outcome;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function makeTerminal(
  start: CronExecutionStartedRow,
  terminalAtMs: number,
  outcome: CronTerminalOutcome,
): CronExecutionTerminalRow {
  return {
    executionId: start.executionId,
    bootId: start.bootId,
    jobId: start.jobId,
    agentId: start.agentId,
    scheduledForMs: start.scheduledForMs,
    trigger: start.trigger,
    recordType: "terminal",
    workKind: start.workKind,
    terminalAtMs,
    durationMs: terminalAtMs - start.startedAtMs,
    outcome,
  };
}

function workKindOf(job: CronJob): CronWorkKind {
  switch (job.payload.kind) {
    case "agent_turn": return "agent_turn";
    case "heartbeat_event": return "heartbeat_event";
    case "internal_action": return "internal_action";
    case "delivery": return "delivery_only";
    default: {
      const _exhaustive: never = job.payload;
      return _exhaustive;
    }
  }
}

function requiresGovernedRoot(workKind: CronWorkKind): boolean {
  return workKind === "agent_turn" || workKind === "internal_action";
}

function resolveTimeoutMs(job: CronJob, defaultTimeoutMs: number): number {
  return job.payload.kind === "agent_turn" && job.payload.timeoutSeconds !== undefined
    ? job.payload.timeoutSeconds * 1_000
    : defaultTimeoutMs;
}

function validateConfig(deps: CronSchedulerDeps): CronSchedulerLifecycleError | undefined {
  if (!Number.isSafeInteger(deps.config.maxRunsPerTick) || deps.config.maxRunsPerTick <= 0) {
    return schedulerError("invalid_configuration", "config", "Cron per-tick run limit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(deps.config.defaultTimeoutMs) || deps.config.defaultTimeoutMs <= 0) {
    return schedulerError("invalid_configuration", "config", "Cron execution timeout must be a positive safe integer");
  }
  if (!Number.isSafeInteger(deps.config.staggerWindowMs) || deps.config.staggerWindowMs < 0) {
    return schedulerError("invalid_configuration", "config", "Cron stagger window must be a nonnegative safe integer");
  }
  if (deps.bootId.length === 0 || deps.bootId.length > 256) {
    return schedulerError("invalid_configuration", "config", "Cron boot identity is invalid");
  }
  return undefined;
}

function schedulerError(code: CronSchedulerErrorCode, errorKind: ErrorKind, message: string): CronSchedulerLifecycleError {
  return { code, errorKind, message };
}

function operationFailure(
  operation: string,
  failure: { errorKind: ErrorKind; message: string },
): Result<never, CronSchedulerLifecycleError> {
  return err(schedulerError("operation_failed", failure.errorKind, `Unable to ${operation}: ${failure.message}`));
}

function deferredSignal(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function runtimeRejection(
  cause: unknown,
  executionId: string,
): Result<never, CronSchedulerLifecycleError> {
  logRuntimeRejection(cause, executionId, "runtime_execute");
  return err(schedulerError(
    "operation_failed",
    "internal",
    "Cron runtime rejected outside its Result contract; the durable started claim remains for owner recovery",
  ));
}

function logRuntimeRejection(_cause: unknown, _executionId: string, _step: string): void {
  // The daemon executor must translate throwing boundaries into its closed Result.
}

function initializationFailure(
  component: string,
  failure: { errorKind: ErrorKind; message: string },
): Result<never, CronSchedulerLifecycleError> {
  return err(schedulerError(
    "initialization_failed",
    failure.errorKind,
    `Unable to initialize ${component}: ${failure.message}`,
  ));
}
