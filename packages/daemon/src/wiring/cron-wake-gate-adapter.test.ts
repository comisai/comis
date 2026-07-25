// SPDX-License-Identifier: Apache-2.0
import type { SessionKey } from "@comis/core";
import type { CronRuntimeExecutionInput } from "@comis/scheduler";
import { describe, expect, it, vi } from "vitest";
import { createCronWakeGateAdapter } from "./cron-wake-gate-adapter.js";
import type { WakeGateRunner } from "./wake-gate-runner.js";

const signal = new AbortController().signal;
const sessionKey = {
  tenantId: "tenant-a",
  agentId: "agent-a",
  userId: "cron:job-a",
  channelId: "job-a",
} as SessionKey;

function input(): Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }> {
  return {
    kind: "agent_turn",
    executionId: "11111111-1111-4111-8111-111111111111",
    scheduledForMs: 1_800_000_000_000,
    trigger: "scheduled",
    rootRunId: "root-cron-11111111-1111-4111-8111-111111111111",
    job: {
      id: "job-a",
      name: "Check",
      agentId: "agent-a",
      source: "authored",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_800_000_000_000 },
      lifecycle: {
        status: "scheduled",
        nextRunAtMs: 1_800_000_060_000,
        consecutiveDependencyErrors: 0,
      },
      payload: { kind: "agent_turn", message: "check" },
      sessionPolicy: { strategy: "fresh" },
      continuationMode: "none",
      wakeGate: { script: "console.log('{}')", language: "js", timeoutSeconds: 3 },
    },
  };
}

describe("cron wake-gate adapter", () => {
  it("passes the exact occurrence root, synthetic session, and abort signal to the runner", async () => {
    const runWakeGate = vi.fn(async () => ({
      verdict: { wake: true as const, context: "changed" },
      durationMs: 7,
      toolCalls: 2,
      failedOpen: false as const,
      rootRunId: input().rootRunId,
    }));
    const execute = createCronWakeGateAdapter({
      getRunner: () => ({ runWakeGate } as WakeGateRunner),
    });

    await expect(execute(input(), sessionKey, signal)).resolves.toEqual({
      status: "woke",
      durationMs: 7,
      toolCalls: 2,
      context: "changed",
    });
    expect(runWakeGate).toHaveBeenCalledWith(
      input().job.wakeGate,
      {
        agentId: "agent-a",
        jobId: "job-a",
        sessionKey: "tenant-a:agent:agent-a:cron:job-a:job-a",
        rootRunId: input().rootRunId,
      },
      signal,
    );
  });

  it("preserves fail-open cause and maps a missing or degraded runner to a closed unavailable result", async () => {
    const failed = createCronWakeGateAdapter({
      getRunner: () => ({
        runWakeGate: vi.fn(async () => ({
          verdict: { wake: true },
          durationMs: 4,
          toolCalls: 1,
          failedOpen: true,
          errorKind: "timeout",
        })),
      } as WakeGateRunner),
    });
    await expect(failed(input(), sessionKey, signal)).resolves.toEqual({
      status: "failed_open",
      durationMs: 4,
      toolCalls: 1,
      errorKind: "timeout",
    });

    const missing = createCronWakeGateAdapter({ getRunner: () => undefined });
    await expect(missing(input(), sessionKey, signal)).resolves.toEqual({
      status: "unavailable",
      reason: "wake_gate_unbound",
    });

    const degraded = createCronWakeGateAdapter({
      getRunner: () => ({ runWakeGate: vi.fn(async () => ({ runAsToday: true })) } as WakeGateRunner),
    });
    await expect(degraded(input(), sessionKey, signal)).resolves.toEqual({
      status: "unavailable",
      reason: "wake_gate_unbound",
    });
  });

  it("maps a clean skip without exposing gate context as delivery text", async () => {
    const execute = createCronWakeGateAdapter({
      getRunner: () => ({
        runWakeGate: vi.fn(async () => ({
          verdict: { wake: false, deliver: "No change" },
          durationMs: 5,
          toolCalls: 0,
          failedOpen: false,
        })),
      } as WakeGateRunner),
    });

    await expect(execute(input(), sessionKey, signal)).resolves.toEqual({
      status: "skip",
      durationMs: 5,
      toolCalls: 0,
      deliver: "No change",
    });
  });
});
