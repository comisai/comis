// SPDX-License-Identifier: Apache-2.0
/** Normalize the jailed wake-gate runner into the strict cron runtime seam. */
import {
  formatSessionKey,
  type ClockPort,
  type SessionKey,
  type TypedEventBus,
} from "@comis/core";
import type { CronRuntimeExecutionInput } from "@comis/scheduler";
import type { CronWakeGateExecution } from "./cron-agent-turn-executor.js";
import type { WakeGateRunner } from "./wake-gate-runner.js";

type AgentTurnInput = Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }>;

export interface CronWakeGateAdapterDeps {
  getRunner(): WakeGateRunner | undefined;
  readonly eventBus: Pick<TypedEventBus, "emit">;
  readonly clock: ClockPort;
}

export function createCronWakeGateAdapter(deps: CronWakeGateAdapterDeps) {
  return async function runCronWakeGate(
    input: AgentTurnInput,
    sessionKey: SessionKey,
    signal: AbortSignal,
  ): Promise<CronWakeGateExecution> {
    const runner = deps.getRunner();
    if (runner === undefined || input.job.wakeGate === undefined) {
      return { status: "unavailable", reason: "wake_gate_unbound" };
    }
    const outcome = await runner.runWakeGate(input.job.wakeGate, {
      agentId: input.job.agentId,
      jobId: input.job.id,
      sessionKey: formatSessionKey(sessionKey),
      rootRunId: input.rootRunId,
    }, signal);
    if ("runAsToday" in outcome) {
      return { status: "unavailable", reason: "wake_gate_unbound" };
    }
    const wake = outcome.verdict.wake;
    deps.eventBus.emit("scheduler:wake_gate", {
      jobId: input.job.id,
      agentId: input.job.agentId,
      wake,
      durationMs: outcome.durationMs,
      toolCalls: outcome.toolCalls,
      estTurnsSaved: wake ? 0 : 1,
      failedOpen: outcome.failedOpen,
      timestamp: deps.clock.now(),
    });
    if (outcome.failedOpen) {
      return {
        status: "failed_open",
        durationMs: outcome.durationMs,
        toolCalls: outcome.toolCalls,
        errorKind: outcome.errorKind,
      };
    }
    if (!outcome.verdict.wake) {
      return {
        status: "skip",
        durationMs: outcome.durationMs,
        toolCalls: outcome.toolCalls,
        ...(outcome.verdict.deliver === undefined ? {} : { deliver: outcome.verdict.deliver }),
      };
    }
    return {
      status: "woke",
      durationMs: outcome.durationMs,
      toolCalls: outcome.toolCalls,
      ...(outcome.verdict.context === undefined ? {} : { context: outcome.verdict.context }),
    };
  };
}
