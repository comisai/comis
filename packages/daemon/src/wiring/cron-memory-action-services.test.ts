// SPDX-License-Identifier: Apache-2.0
import { err, ok } from "@comis/shared";
import type { CronRuntimeExecutionInput } from "@comis/scheduler";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createCronMemoryActionServices } from "./cron-memory-action-services.js";

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
      lifecycle: { status: "scheduled", nextRunAtMs: NOW_MS + 60_000, consecutiveDependencyErrors: 0 },
      payload: { kind: "internal_action", action },
    },
  };
}

function deps() {
  const reserveBudget = vi.fn(() => ({ kind: "ok" as const, reservation: {}, warn: null }));
  const executeMemoryReview = vi.fn(async (request: { onUsage(usage: unknown): void }) => {
    request.onUsage({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
      durationMs: 50,
    });
    return ok({ status: "completed" as const, counters: [] });
  });
  const executeMemoryLifecycle = vi.fn(async () => ok({
    status: "completed" as const,
    counters: [
      { name: "scanned", value: 8 },
      { name: "evicted", value: 2 },
    ],
  }));
  const executeReflection = vi.fn(async (request: { onUsage(usage: unknown): void }) => {
    request.onUsage({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: { input: 0.002, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.006 },
      durationMs: 75,
    });
    return ok({
      status: "completed" as const,
      counters: [{ name: "selected", value: 4 }, { name: "admitted", value: 1 }],
    });
  });
  return {
    agents: {
      "agent-a": {
        provider: "openai",
        model: "gpt-5",
        operationModels: {
          cron: { model: "openai:gpt-5-mini" },
          skillSynthesis: { model: "openai:gpt-5-mini" },
        },
        memoryReview: { enabled: true },
        memoryLifecycle: { enabled: true },
        learning: { enabled: true },
      },
    },
    clock: createFakeClock(NOW_MS),
    boundedAutonomyHolder: { current: { reserveBudget } },
    executeMemoryReview,
    executeMemoryLifecycle,
    executeReflection,
    eventBus: { emit: vi.fn() },
    logger: {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), audit: vi.fn(),
    } as never,
    _reserveBudget: reserveBudget,
    _review: executeMemoryReview,
    _lifecycle: executeMemoryLifecycle,
    _reflection: executeReflection,
  };
}

describe("cron memory action services", () => {
  it("resolves current enable gates and operation-model provenance", () => {
    const services = createCronMemoryActionServices(deps());

    expect(services.resolveAction("memory_review", "agent-a")).toEqual(ok({
      enabled: true,
      modelResolved: "openai:gpt-5-mini",
      modelResolutionSource: "explicit_config",
    }));
    expect(services.resolveAction("memory_lifecycle", "agent-a")).toEqual(ok({
      enabled: true,
      modelResolved: null,
      modelResolutionSource: null,
    }));
  });

  it("attributes review usage to the exact root and returns settled evidence", async () => {
    const runtimeDeps = deps();
    const services = createCronMemoryActionServices(runtimeDeps);
    const signal = new AbortController().signal;

    const result = await services.executeMemoryReview(input("memory_review"), signal);

    expect(result).toEqual(ok({ status: "completed", counters: [] }));
    expect(runtimeDeps._review).toHaveBeenCalledWith(expect.objectContaining({
      input: input("memory_review"),
      signal: expect.any(AbortSignal),
      onUsage: expect.any(Function),
    }));
    expect(runtimeDeps._reserveBudget).toHaveBeenCalledWith(
      "root-cron-execution-a",
      "openai",
      "gpt-5-mini",
      0.0031,
      125,
    );
    expect(services.readMetrics("memory_review", "root-cron-execution-a")).toEqual({
      totalTokens: 125,
      costUsd: 0.0031,
      llmCalls: 1,
    });
  });

  it("aborts model-backed work when the per-root budget rejects usage", async () => {
    const runtimeDeps = deps();
    runtimeDeps._reserveBudget.mockReturnValue({
      kind: "exceeded",
      error: new Error("token cap"),
    } as never);
    runtimeDeps._reflection.mockImplementation(async (request: { onUsage(usage: unknown): void; signal: AbortSignal }) => {
      request.onUsage({
        inputTokens: 200,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: { input: 0.002, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.006 },
        durationMs: 75,
      });
      expect(request.signal.aborted).toBe(true);
      return err({ errorKind: "resource", message: "reflection aborted" });
    });
    const services = createCronMemoryActionServices(runtimeDeps);

    const result = await services.executeReflection(input("reflection"), new AbortController().signal);

    expect(result).toEqual(ok({
      status: "aborted",
      abortReason: "budget_exceeded",
      counters: [],
    }));
  });

  it("retains partial reflection counters on a settled action failure", async () => {
    const runtimeDeps = deps();
    runtimeDeps._reflection.mockResolvedValue(ok({
      status: "failed",
      errorKind: "dependency",
      counters: [{ name: "selected", value: 4 }, { name: "admitted", value: 1 }],
    }));
    const services = createCronMemoryActionServices(runtimeDeps);

    const result = await services.executeReflection(input("reflection"), new AbortController().signal);

    expect(result).toEqual(ok({
      status: "failed",
      errorKind: "dependency",
      counters: [{ name: "selected", value: 4 }, { name: "admitted", value: 1 }],
    }));
  });

  it("returns keyless lifecycle counters without consulting the model budget", async () => {
    const runtimeDeps = deps();
    const services = createCronMemoryActionServices(runtimeDeps);

    const result = await services.executeMemoryLifecycle(input("memory_lifecycle"), new AbortController().signal);

    expect(result).toEqual(ok({
      status: "completed",
      counters: [{ name: "scanned", value: 8 }, { name: "evicted", value: 2 }],
    }));
    expect(runtimeDeps._reserveBudget).not.toHaveBeenCalled();
    expect(services.readMetrics("memory_lifecycle", "root-cron-execution-a")).toEqual({
      totalTokens: null,
      costUsd: null,
      llmCalls: 0,
    });
  });

  it("fails before action dispatch for an unknown agent", async () => {
    const runtimeDeps = deps();
    const services = createCronMemoryActionServices(runtimeDeps);

    expect(services.resolveAction("memory_review", "missing")).toEqual(err({
      code: "precondition_failed",
      errorKind: "config",
      message: "Cron internal action agent configuration is unavailable",
    }));
  });
});
