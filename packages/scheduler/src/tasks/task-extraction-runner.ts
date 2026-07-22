// SPDX-License-Identifier: Apache-2.0
import type { ClockPort, ErrorKind, TimerHandle, TimerPort } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import type { BoundTaskCandidate, TaskExtractionOutputError } from "./task-extractor.js";
import { parseTaskExtractionOutput } from "./task-extractor.js";
import type { TaskExtractionItem } from "./task-extraction-queue.js";

export const TASK_MODEL_TIMEOUT_MS = 30_000;

export interface TaskExtractionModelSession {
  run(input:
    | { readonly mode: "initial" }
    | { readonly mode: "repair"; readonly invalidOutput: string }
  ): Promise<Result<{ readonly raw: string }, TaskExtractionModelError>>;
}

export interface TaskExtractionModelError {
  readonly code: string;
  readonly errorKind: ErrorKind;
}

export interface TaskExtractionRunnerConfig {
  readonly batchMax: number;
  readonly defaultWindowMs: number;
}

type TaskExtractionRunnerCoreOutcome =
  | {
    readonly status: "persisted";
    readonly agentId: string;
    readonly rootRunId: string;
    readonly itemCount: number;
    readonly candidateCount: number;
    readonly createdCount: number;
    readonly mergedCount: number;
    readonly taskIds: readonly string[];
    readonly releaseErrorKind?: ErrorKind;
  }
  | {
    readonly status: "dropped";
    readonly agentId: string;
    readonly rootRunId: string;
    readonly itemCount: number;
    readonly stage: "root_registration" | "model" | "model_output" | "deadline" | "live_gate" | "persistence_fence" | "store" | "internal";
    readonly errorKind: ErrorKind;
    readonly releaseErrorKind?: ErrorKind;
  };

export type TaskExtractionRunnerOutcome = TaskExtractionRunnerCoreOutcome & {
  readonly sourceExecutionIds: readonly string[];
  readonly durationMs: number;
};

export type TaskExtractionSubmitError =
  | { readonly code: "not_accepting"; readonly errorKind: "precondition" }
  | { readonly code: "already_running"; readonly errorKind: "precondition" }
  | { readonly code: "invalid_batch"; readonly errorKind: "validation" };

export interface TaskExtractionRunner {
  activate(): Result<void, { readonly code: "closed"; readonly errorKind: "precondition" }>;
  submit(agentId: string, items: readonly TaskExtractionItem[]): Result<void, TaskExtractionSubmitError>;
  close(): { readonly activeCount: number };
  waitForIdle(): Promise<void>;
  getStatus(): { readonly accepting: boolean; readonly activeCount: number };
}

interface ActiveOperation {
  readonly agentId: string;
  readonly rootRunId: string;
  readonly items: readonly TaskExtractionItem[];
  readonly startedAtMs: number;
  readonly controller: AbortController;
  persistFenceOpen: boolean;
  timedOut: boolean;
  done?: Promise<void>;
}

interface StageError {
  readonly stage: Extract<TaskExtractionRunnerOutcome, { status: "dropped" }>["stage"];
  readonly errorKind: ErrorKind;
}

export function createTaskExtractionRunner(deps: {
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly idFactory: () => string;
  readonly getConfig: (agentId: string) => TaskExtractionRunnerConfig;
  readonly isEnabled: (agentId: string) => boolean;
  registerRoot(input: { readonly agentId: string; readonly rootRunId: string }): Promise<Result<void, TaskExtractionModelError>>;
  releaseRoot(rootRunId: string): Promise<Result<void, TaskExtractionModelError>>;
  readonly withModelSession: <T>(
    input: {
      readonly agentId: string;
      readonly rootRunId: string;
      readonly items: readonly TaskExtractionItem[];
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
    use: (session: TaskExtractionModelSession) => Promise<T>,
  ) => Promise<Result<T, TaskExtractionModelError>>;
  persistCandidates(
    agentId: string,
    candidates: readonly BoundTaskCandidate[],
  ): Promise<Result<{
    readonly createdCount: number;
    readonly mergedCount: number;
    readonly taskIds: readonly string[];
  }, TaskExtractionModelError>>;
  readonly onOutcome: (outcome: TaskExtractionRunnerOutcome) => void;
}): TaskExtractionRunner {
  let lifecycle: "inactive" | "active" | "closed" = "inactive";
  const active = new Map<string, ActiveOperation>();

  function activate(): Result<void, { readonly code: "closed"; readonly errorKind: "precondition" }> {
    if (lifecycle === "closed") return err({ code: "closed", errorKind: "precondition" });
    lifecycle = "active";
    return ok(undefined);
  }

  function submit(agentId: string, items: readonly TaskExtractionItem[]): Result<void, TaskExtractionSubmitError> {
    if (lifecycle !== "active") return err({ code: "not_accepting", errorKind: "precondition" });
    if (active.has(agentId)) return err({ code: "already_running", errorKind: "precondition" });
    const root = tryCatch(deps.idFactory);
    if (
      !root.ok
      || !validIdentifier(agentId)
      || !root.value.startsWith("root-task-extract-")
      || !validIdentifier(root.value)
      || items.length < 1
      || items.length > 64
      || items.some((candidate) => candidate.origin.turnScope.conversation.agentId !== agentId)
      || items.some((candidate) => (
        candidate.workspacePolicySnapshot.combinedHash
        !== items[0]!.workspacePolicySnapshot.combinedHash
      ))
    ) return err({ code: "invalid_batch", errorKind: "validation" });
    const startedAtMs = deps.clock.now();
    if (!validTime(startedAtMs)) return err({ code: "invalid_batch", errorKind: "validation" });
    const operation: ActiveOperation = {
      agentId,
      rootRunId: root.value,
      items: structuredClone(items),
      startedAtMs,
      controller: new AbortController(),
      persistFenceOpen: true,
      timedOut: false,
    };
    active.set(agentId, operation);
    operation.done = observe(operation);
    return ok(undefined);
  }

  async function observe(operation: ActiveOperation): Promise<void> {
    const observed = await fromPromise(runOperation(operation));
    if (!observed.ok) {
      notify({
        status: "dropped",
        agentId: operation.agentId,
        rootRunId: operation.rootRunId,
        itemCount: operation.items.length,
        stage: "internal",
        errorKind: "internal",
      });
    }
    active.delete(operation.agentId);
  }

  async function runOperation(operation: ActiveOperation): Promise<void> {
    const registered = await fromPromise(deps.registerRoot({
      agentId: operation.agentId,
      rootRunId: operation.rootRunId,
    }));
    if (!registered.ok) {
      notify(dropped(operation, "root_registration", "internal"));
      return;
    }
    if (!registered.value.ok) {
      notify(dropped(operation, "root_registration", registered.value.error.errorKind));
      return;
    }
    const outcome = await runRegistered(operation);
    const released = await fromPromise(deps.releaseRoot(operation.rootRunId));
    const releaseErrorKind = !released.ok
      ? "internal" as const
      : released.value.ok ? undefined : released.value.error.errorKind;
    notify(releaseErrorKind === undefined ? outcome : { ...outcome, releaseErrorKind });
  }

  async function runRegistered(operation: ActiveOperation): Promise<TaskExtractionRunnerCoreOutcome> {
    if (!operation.persistFenceOpen || lifecycle !== "active") return dropped(operation, "persistence_fence", "precondition");
    if (!safeEnabled(deps.isEnabled, operation.agentId)) return dropped(operation, "live_gate", "precondition");
    const startedAtMs = deps.clock.now();
    const deadlineAtMs = startedAtMs + TASK_MODEL_TIMEOUT_MS;
    if (!validTime(startedAtMs) || !Number.isSafeInteger(deadlineAtMs)) return dropped(operation, "internal", "internal");
    const timeout = armDeadline(operation, deadlineAtMs);
    const modeled = await fromPromise(deps.withModelSession({
      agentId: operation.agentId,
      rootRunId: operation.rootRunId,
      items: operation.items,
      deadlineAtMs,
      signal: operation.controller.signal,
    }, (session) => extractCandidates(session, operation, deps.getConfig)));
    timeout.cancel();
    if (!modeled.ok) return dropped(operation, "model", "internal");
    if (!modeled.value.ok) return dropped(operation, "model", modeled.value.error.errorKind);
    if (!modeled.value.value.ok) return dropped(operation, modeled.value.value.error.stage, modeled.value.value.error.errorKind);
    if (operation.timedOut) return dropped(operation, "deadline", "timeout");
    if (!operation.persistFenceOpen || lifecycle !== "active") return dropped(operation, "persistence_fence", "precondition");
    if (!safeEnabled(deps.isEnabled, operation.agentId)) return dropped(operation, "live_gate", "precondition");
    const candidates = modeled.value.value.value;
    const persisted = await fromPromise(deps.persistCandidates(operation.agentId, candidates));
    if (!persisted.ok) return dropped(operation, "store", "internal");
    if (!persisted.value.ok) return dropped(operation, "store", persisted.value.error.errorKind);
    return {
      status: "persisted",
      agentId: operation.agentId,
      rootRunId: operation.rootRunId,
      itemCount: operation.items.length,
      candidateCount: candidates.length,
      createdCount: persisted.value.value.createdCount,
      mergedCount: persisted.value.value.mergedCount,
      taskIds: persisted.value.value.taskIds,
    };
  }

  function armDeadline(operation: ActiveOperation, deadlineAtMs: number): TimerHandle {
    const handle = deps.timers.setTimeout(() => {
      operation.timedOut = true;
      operation.persistFenceOpen = false;
      operation.controller.abort();
    }, Math.max(0, deadlineAtMs - deps.clock.now()));
    handle.unref();
    return handle;
  }

  function close(): { readonly activeCount: number } {
    lifecycle = "closed";
    for (const operation of active.values()) {
      operation.persistFenceOpen = false;
      operation.controller.abort();
    }
    return { activeCount: active.size };
  }

  async function waitForIdle(): Promise<void> {
    while (active.size > 0) {
      await Promise.all([...active.values()].map((operation) => operation.done));
    }
  }

  function notify(outcome: TaskExtractionRunnerCoreOutcome): void {
    const operation = active.get(outcome.agentId);
    const sourceExecutionIds = operation === undefined
      ? []
      : [...new Set(operation.items.map((item) => item.sourceExecutionId))];
    const durationMs = operation === undefined
      ? 0
      : Math.max(0, deps.clock.now() - operation.startedAtMs);
    tryCatch(() => deps.onOutcome({ ...outcome, sourceExecutionIds, durationMs }));
  }

  return {
    activate,
    submit,
    close,
    waitForIdle,
    getStatus: () => ({ accepting: lifecycle === "active", activeCount: active.size }),
  };
}

async function extractCandidates(
  session: TaskExtractionModelSession,
  operation: ActiveOperation,
  getConfig: (agentId: string) => TaskExtractionRunnerConfig,
): Promise<Result<readonly BoundTaskCandidate[], StageError>> {
  const config = tryCatch(() => getConfig(operation.agentId));
  if (!config.ok || !validConfig(config.value)) return err({ stage: "internal", errorKind: "config" });
  const initial = await fromPromise(session.run({ mode: "initial" }));
  if (!initial.ok) return err({ stage: "model", errorKind: "internal" });
  if (!initial.value.ok) return err({ stage: "model", errorKind: initial.value.error.errorKind });
  const parsed = parseTaskExtractionOutput({
    raw: initial.value.value.raw,
    items: operation.items,
    batchMax: config.value.batchMax,
    defaultWindowMs: config.value.defaultWindowMs,
  });
  if (parsed.ok) return parsed;
  if (parsed.error.code === "output_too_large") return err(outputError(parsed.error));
  const repaired = await fromPromise(session.run({ mode: "repair", invalidOutput: initial.value.value.raw }));
  if (!repaired.ok) return err({ stage: "model", errorKind: "internal" });
  if (!repaired.value.ok) return err({ stage: "model", errorKind: repaired.value.error.errorKind });
  const reparsed = parseTaskExtractionOutput({
    raw: repaired.value.value.raw,
    items: operation.items,
    batchMax: config.value.batchMax,
    defaultWindowMs: config.value.defaultWindowMs,
  });
  return reparsed.ok ? reparsed : err(outputError(reparsed.error));
}

function outputError(_error: TaskExtractionOutputError): StageError {
  return { stage: "model_output", errorKind: "validation" };
}

function dropped(
  operation: ActiveOperation,
  stage: Extract<TaskExtractionRunnerOutcome, { status: "dropped" }>["stage"],
  errorKind: ErrorKind,
): TaskExtractionRunnerCoreOutcome {
  return {
    status: "dropped",
    agentId: operation.agentId,
    rootRunId: operation.rootRunId,
    itemCount: operation.items.length,
    stage,
    errorKind,
  };
}

function safeEnabled(read: (agentId: string) => boolean, agentId: string): boolean {
  const enabled = tryCatch(() => read(agentId));
  return enabled.ok && enabled.value === true;
}

function validConfig(config: TaskExtractionRunnerConfig): boolean {
  return Number.isSafeInteger(config.batchMax)
    && config.batchMax >= 1
    && config.batchMax <= 64
    && Number.isSafeInteger(config.defaultWindowMs)
    && config.defaultWindowMs >= 1;
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 256 && Buffer.byteLength(value, "utf8") <= 256;
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
