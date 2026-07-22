// SPDX-License-Identifier: Apache-2.0
import { runWithContext } from "@comis/core";
import { ok } from "@comis/shared";
import type { CronRuntimeExecutionInput } from "@comis/scheduler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createCronMemoryActionRunners } from "./cron-memory-action-runners.js";

const agentMocks = vi.hoisted(() => ({
  createLlmReflectionAdapter: vi.fn(() => ({ reflect: vi.fn() })),
  runMemoryReview: vi.fn(),
  runReflection: vi.fn(),
}));

vi.mock("@comis/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/agent")>();
  return {
    ...actual,
    createLlmReflectionAdapter: agentMocks.createLlmReflectionAdapter,
    runMemoryReview: agentMocks.runMemoryReview,
    runReflection: agentMocks.runReflection,
  };
});

const NOW_MS = 1_800_000_000_000;

function lifecycleInput(): Extract<CronRuntimeExecutionInput, { kind: "internal_action" }> {
  return {
    executionId: "execution-a",
    scheduledForMs: NOW_MS,
    trigger: "scheduled",
    kind: "internal_action",
    rootRunId: "root-cron-execution-a",
    job: {
      id: "memory-lifecycle",
      name: "Memory lifecycle",
      agentId: "agent-a",
      source: "built_in",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: NOW_MS },
      lifecycle: { status: "scheduled", nextRunAtMs: NOW_MS + 60_000, consecutiveDependencyErrors: 0 },
      payload: { kind: "internal_action", action: "memory_lifecycle" },
    },
  };
}

function modelInput(
  action: "memory_review" | "reflection",
): Extract<CronRuntimeExecutionInput, { kind: "internal_action" }> {
  return {
    ...lifecycleInput(),
    job: {
      ...lifecycleInput().job,
      id: action,
      name: action,
      payload: { kind: "internal_action", action },
    },
  };
}

function emptyReflectionResult() {
  return {
    selected: 0,
    admitted: 0,
    maxTopicCardinality: 0,
    singleOwnerCorroborated: 0,
    distinctTopicKeys: 0,
    skipped: 0,
    emptyReflections: 0,
    untrustedDrops: 0,
    nameLengthRejections: 0,
    sourceTrajectoryCount: 0,
    totalSourceChars: 0,
  };
}

function deps() {
  const emit = vi.fn();
  const runLifecycleSweep = vi.fn(async () => ok({
    scanned: 9,
    promoted: 0,
    demoted: 1,
    evicted: 2,
  }));
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), audit: vi.fn(), child: vi.fn(),
  };
  logger.child.mockImplementation(() => logger);
  const getSecret = vi.fn((name: string) => {
    void name;
    return undefined;
  });
  const readAuth = vi.fn(async (_provider: string) => ({
    type: "api_key" as const,
    env: {
      AWS_REGION: "il-central-1",
      AWS_PROFILE: "test-profile",
    },
  }));
  return {
    container: {
      config: {
        agents: {
          "agent-a": {
            memoryReview: { enabled: true },
            learning: { enabled: true, forget: { failureEvictionFloor: 3 } },
          },
        },
        providers: {
          entries: { "amazon-bedrock": { type: "amazon-bedrock" } },
        },
      },
      eventBus: { emit },
      secretManager: { get: getSecret },
    } as never,
    tenantId: "tenant-a",
    clock: createFakeClock(NOW_MS),
    logger: logger as never,
    workspaceDirs: new Map(),
    memoryAdapter: {} as never,
    sessionStore: {} as never,
    memoryLifecycleStore: { runLifecycleSweep } as never,
    authStorages: new Map([["agent-a", { read: readAuth } as never]]),
    reflection: {
      buildSourceTrajectories: vi.fn(async () => []),
      outcomeSignal: {} as never,
      learnedSkillStore: {} as never,
    } as never,
    _emit: emit,
    _getSecret: getSecret,
    _readAuth: readAuth,
    _runLifecycleSweep: runLifecycleSweep,
  };
}

describe("cron memory action runners", () => {
  beforeEach(() => {
    agentMocks.createLlmReflectionAdapter.mockClear();
    agentMocks.runMemoryReview.mockReset().mockResolvedValue(ok(undefined));
    agentMocks.runReflection.mockReset().mockResolvedValue(ok(emptyReflectionResult()));
  });

  it("returns lifecycle sweep counters and emits counts-only observations", async () => {
    const runtimeDeps = deps();
    const runners = createCronMemoryActionRunners(runtimeDeps);

    const result = await runners.executeMemoryLifecycle({
      input: lifecycleInput(),
      signal: new AbortController().signal,
    });

    expect(result).toEqual(ok({
      status: "completed",
      counters: [
        { name: "scanned", value: 9 },
        { name: "promoted", value: 0 },
        { name: "demoted", value: 1 },
        { name: "evicted", value: 2 },
      ],
    }));
    expect(runtimeDeps._runLifecycleSweep).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      agentId: "agent-a",
      now: NOW_MS,
      policy: { evictionEnabled: true, failureEvictionFloor: 3 },
    });
    expect(runtimeDeps._emit).toHaveBeenCalledWith("learning:lifecycle_swept", {
      agentId: "agent-a",
      scanned: 9,
      promoted: 0,
      demoted: 1,
      evicted: 2,
      timestamp: NOW_MS,
    });
  });

  it("honors cancellation before the lifecycle store is called", async () => {
    const runtimeDeps = deps();
    const runners = createCronMemoryActionRunners(runtimeDeps);
    const controller = new AbortController();
    controller.abort();

    const result = await runners.executeMemoryLifecycle({ input: lifecycleInput(), signal: controller.signal });

    expect(result).toMatchObject({ ok: false, error: { errorKind: "timeout" } });
    expect(runtimeDeps._runLifecycleSweep).not.toHaveBeenCalled();
  });

  it("admits native model auth and passes provider configuration into memory review", async () => {
    const runtimeDeps = deps();
    const runners = createCronMemoryActionRunners(runtimeDeps);
    const input = modelInput("memory_review");

    const result = await runWithContext({
      tenantId: "tenant-a",
      agentId: "agent-a",
      traceId: "trace-a",
      sessionKey: "cron-memory-review",
      rootRunId: input.rootRunId,
      turnScope: {},
    } as never, () => runners.executeMemoryReview({
      input,
      signal: new AbortController().signal,
      resolution: {
        provider: "amazon-bedrock",
        modelId: "anthropic.claude-sonnet",
      } as never,
      onUsage: vi.fn(),
    }));

    expect(result).toEqual(ok({ status: "completed", counters: [] }));
    const reviewDeps = agentMocks.runMemoryReview.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(reviewDeps).toMatchObject({
      providerEnv: {
        AWS_REGION: "il-central-1",
        AWS_PROFILE: "test-profile",
      },
    });
    expect(reviewDeps).not.toHaveProperty("apiKey");
    expect(runtimeDeps._readAuth).toHaveBeenCalledWith("amazon-bedrock");
  });

  it("admits native model auth and passes provider configuration into reflection", async () => {
    const runtimeDeps = deps();
    const agentConfig = (runtimeDeps.container as never as {
      config: { agents: Record<string, Record<string, unknown>> };
    }).config.agents["agent-a"]!;
    agentConfig.learning = {
      enabled: true,
      reflect: {
        minConfidence: 0.8,
        maxDocsPerRun: 4,
        corroboration: {},
      },
    };
    const runners = createCronMemoryActionRunners(runtimeDeps);
    const input = modelInput("reflection");

    const result = await runners.executeReflection({
      input,
      signal: new AbortController().signal,
      resolution: {
        provider: "amazon-bedrock",
        modelId: "anthropic.claude-sonnet",
      } as never,
      onUsage: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, value: { status: "completed" } });
    expect(agentMocks.createLlmReflectionAdapter).toHaveBeenCalledTimes(4);
    for (const [adapterDeps] of agentMocks.createLlmReflectionAdapter.mock.calls) {
      expect(adapterDeps).toMatchObject({
        providerEnv: {
          AWS_REGION: "il-central-1",
          AWS_PROFILE: "test-profile",
        },
      });
      expect(adapterDeps).not.toHaveProperty("apiKey");
    }
    expect(runtimeDeps._readAuth).toHaveBeenCalledWith("amazon-bedrock");
  });
});
