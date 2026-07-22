// SPDX-License-Identifier: Apache-2.0
import { tryGetContext } from "@comis/core";
import { err, ok } from "@comis/shared";
import type { CronRuntimeExecutionInput } from "@comis/scheduler";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createCronInternalActionExecutor } from "./cron-internal-action-executor.js";

const NOW_MS = 1_800_000_000_000;

function input(action: "memory_review" | "memory_lifecycle" | "reflection"): Extract<CronRuntimeExecutionInput, { kind: "internal_action" }> {
  return {
    executionId: "execution-a",
    scheduledForMs: NOW_MS,
    trigger: "scheduled",
    kind: "internal_action",
    rootRunId: "root-cron-execution-a",
    job: {
      id: action,
      name: action,
      agentId: "agent-a",
      source: "built_in",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: NOW_MS },
      lifecycle: {
        status: "scheduled",
        nextRunAtMs: NOW_MS + 60_000,
        consecutiveDependencyErrors: 0,
      },
      payload: { kind: "internal_action", action },
    },
  };
}

function deps() {
  const resolveAction = vi.fn((action: "memory_review" | "memory_lifecycle" | "reflection") => ok({
    enabled: true,
    modelResolved: action === "memory_lifecycle" ? null : "openai:gpt-5-mini",
    modelResolutionSource: action === "memory_lifecycle" ? null : "explicit_config" as const,
  }));
  const completedModel = { status: "completed" as const, counters: [{ name: "reviewed", value: 3 }] };
  const executeMemoryReview = vi.fn(async () => ok(completedModel));
  const executeMemoryLifecycle = vi.fn(async () => ok({
    status: "completed" as const,
    counters: [{ name: "scanned", value: 8 }],
  }));
  const executeReflection = vi.fn(async () => ok(completedModel));
  const readMetrics = vi.fn((action: "memory_review" | "memory_lifecycle" | "reflection") => action === "memory_lifecycle"
    ? { totalTokens: null, costUsd: null, llmCalls: 0 }
    : { totalTokens: 120, costUsd: 0.01, llmCalls: 1 });
  return {
    tenantId: "tenant-a",
    clock: createFakeClock(NOW_MS),
    idFactory: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    resolveAction,
    executeMemoryReview,
    executeMemoryLifecycle,
    executeReflection,
    readMetrics,
    logger: {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), audit: vi.fn(),
    } as never,
    _resolveAction: resolveAction,
    _review: executeMemoryReview,
    _lifecycle: executeMemoryLifecycle,
    _reflection: executeReflection,
    _readMetrics: readMetrics,
  };
}

describe("cron internal action executor", () => {
  it("runs model-backed work inside the immutable cron root context", async () => {
    const runtimeDeps = deps();
    let observedContext: ReturnType<typeof tryGetContext>;
    runtimeDeps._review.mockImplementation(async () => {
      observedContext = tryGetContext();
      return ok({ status: "completed" as const, counters: [{ name: "reviewed", value: 3 }] });
    });
    const execute = createCronInternalActionExecutor(runtimeDeps);

    const result = await execute(input("memory_review"), new AbortController().signal);

    expect(result).toEqual(ok({
      kind: "internal_action",
      action: "memory_review",
      rootRunId: "root-cron-execution-a",
      modelResolved: "openai:gpt-5-mini",
      modelResolutionSource: "explicit_config",
      metrics: { totalTokens: 120, costUsd: 0.01, llmCalls: 1 },
      execution: { status: "completed", counters: [{ name: "reviewed", value: 3 }] },
    }));
    expect(observedContext).toMatchObject({
      tenantId: "tenant-a",
      agentId: "agent-a",
      rootRunId: "root-cron-execution-a",
      trustLevel: "user",
      traceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(runtimeDeps._review).toHaveBeenCalledWith(input("memory_review"), expect.any(AbortSignal));
  });

  it("returns keyless lifecycle counters without fabricated model evidence", async () => {
    const runtimeDeps = deps();
    const execute = createCronInternalActionExecutor(runtimeDeps);

    const result = await execute(input("memory_lifecycle"), new AbortController().signal);

    expect(result).toEqual(ok({
      kind: "internal_action",
      action: "memory_lifecycle",
      rootRunId: "root-cron-execution-a",
      modelResolved: null,
      modelResolutionSource: null,
      metrics: { totalTokens: null, costUsd: null, llmCalls: 0 },
      execution: { status: "completed", counters: [{ name: "scanned", value: 8 }] },
    }));
    expect(runtimeDeps._lifecycle).toHaveBeenCalledOnce();
  });

  it("rechecks the current enable gate and skips before service dispatch", async () => {
    const runtimeDeps = deps();
    runtimeDeps._resolveAction.mockReturnValue(ok({
      enabled: false,
      modelResolved: "openai:gpt-5-mini",
      modelResolutionSource: "explicit_config",
    }));
    const execute = createCronInternalActionExecutor(runtimeDeps);

    const result = await execute(input("reflection"), new AbortController().signal);

    expect(result).toEqual(ok({
      kind: "internal_action",
      action: "reflection",
      rootRunId: "root-cron-execution-a",
      modelResolved: "openai:gpt-5-mini",
      modelResolutionSource: "explicit_config",
      metrics: { totalTokens: 0, costUsd: 0, llmCalls: 0 },
      execution: { status: "skipped", reason: "configuration_disabled", counters: [] },
    }));
    expect(runtimeDeps._reflection).not.toHaveBeenCalled();
  });

  it("settles a pre-dispatch deadline abort without invoking the action", async () => {
    const runtimeDeps = deps();
    const execute = createCronInternalActionExecutor(runtimeDeps);
    const controller = new AbortController();
    controller.abort();

    const result = await execute(input("memory_review"), controller.signal);

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "internal_action",
        execution: { status: "aborted", abortReason: "pipeline_timeout", counters: [] },
      },
    });
    expect(runtimeDeps._review).not.toHaveBeenCalled();
  });

  it("records unknown when an invoked action rejects without settlement evidence", async () => {
    const runtimeDeps = deps();
    runtimeDeps._reflection.mockRejectedValue(new Error("connection lost"));
    const execute = createCronInternalActionExecutor(runtimeDeps);

    const result = await execute(input("reflection"), new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "internal_action",
        execution: { status: "unknown", errorKind: "internal", counters: [] },
      },
    });
  });

  it("surfaces configuration resolution failure before any action begins", async () => {
    const runtimeDeps = deps();
    runtimeDeps._resolveAction.mockReturnValue(err({
      code: "precondition_failed",
      errorKind: "config",
      message: "agent configuration unavailable",
    }));
    const execute = createCronInternalActionExecutor(runtimeDeps);

    const result = await execute(input("memory_review"), new AbortController().signal);

    expect(result).toEqual(err({
      code: "precondition_failed",
      errorKind: "config",
      message: "agent configuration unavailable",
    }));
    expect(runtimeDeps._review).not.toHaveBeenCalled();
  });
});
