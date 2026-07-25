// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import type {
  CronRootRegistrar,
  CronRuntimeExecutionInput,
  CronRuntimeExecutor,
} from "@comis/scheduler";
import { createLateBoundCronRuntime } from "./cron-runtime-binding.js";

const input = {
  kind: "heartbeat_event",
  executionId: "execution_a",
  scheduledForMs: 1,
  trigger: "scheduled",
  job: {
    id: "job_a",
    name: "Job A",
    agentId: "agent_a",
    source: "authored",
    schedule: { kind: "every", everyMs: 1_000, anchorMs: 0 },
    lifecycle: { status: "scheduled", nextRunAtMs: 1_000, consecutiveDependencyErrors: 0 },
    payload: { kind: "heartbeat_event", text: "check", wakeMode: "now" },
  },
} satisfies CronRuntimeExecutionInput;

describe("late-bound cron runtime", () => {
  it("fails closed before runtime dependencies are bound", async () => {
    const binding = createLateBoundCronRuntime();

    expect(binding.isBound()).toBe(false);
    await expect(binding.executor.execute(input, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: "not_bound", errorKind: "precondition" },
    });
    await expect(binding.rootRegistrar.register({
      rootRunId: "root-cron-execution_a",
      executionId: "execution_a",
      job: input.job,
    })).resolves.toMatchObject({ ok: false, error: { errorKind: "precondition" } });
  });

  it("delegates execution and root ownership after one coherent bind", async () => {
    const execute = vi.fn(async () => ok({
      kind: "heartbeat_event" as const,
      status: "dispatched" as const,
      correlationId: "correlation_a",
      queueDisposition: "accepted" as const,
    }));
    const register = vi.fn(async () => ok(undefined));
    const release = vi.fn(async () => ok(undefined));
    const binding = createLateBoundCronRuntime();

    binding.bind({
      executor: { execute } satisfies CronRuntimeExecutor,
      rootRegistrar: { register, release } satisfies CronRootRegistrar,
    });

    expect(binding.isBound()).toBe(true);
    await binding.executor.execute(input, new AbortController().signal);
    await binding.rootRegistrar.release("root-cron-execution_a");
    expect(execute).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("root-cron-execution_a");
  });

  it("fails late continuations closed after final lifecycle closure", async () => {
    const execute = vi.fn(async () => ok({
      kind: "heartbeat_event" as const,
      status: "dispatched" as const,
      correlationId: "correlation_a",
      queueDisposition: "accepted" as const,
    }));
    const binding = createLateBoundCronRuntime();
    binding.bind({
      executor: { execute },
      rootRegistrar: { register: async () => ok(undefined), release: async () => ok(undefined) },
    });

    binding.close();

    expect(binding.isBound()).toBe(false);
    await expect(binding.executor.execute(input, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: "not_bound", errorKind: "precondition" },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
