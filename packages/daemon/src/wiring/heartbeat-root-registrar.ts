// SPDX-License-Identifier: Apache-2.0
/** Daemon-owned lease and autonomy-budget roots for claimed heartbeat work. */
import {
  formatSessionKey,
  type ComisLogger,
  type OutputGuardPort,
} from "@comis/core";
import type { BoundedAutonomyBudgetHolder } from "@comis/agent";
import type { LeaseManager } from "@comis/infra";
import { resolveInternalTurnIdentity } from "@comis/orchestrator";
import type {
  HeartbeatWakeCoordinatorDeps,
} from "@comis/scheduler";
import { err, ok, tryCatch } from "@comis/shared";

type HeartbeatRootRegistrar = Pick<
  HeartbeatWakeCoordinatorDeps,
  "registerRoot" | "releaseRoot"
>;

export interface HeartbeatRootRegistrarDeps {
  tenantId: string;
  leaseManager: Pick<LeaseManager, "mintLease" | "revoke">;
  outputGuard: Pick<OutputGuardPort, "registerSecret">;
  boundedAutonomyHolder: BoundedAutonomyBudgetHolder;
  idFactory(): string;
  logger: Pick<ComisLogger, "error">;
}

export function createHeartbeatRootRegistrar(
  deps: HeartbeatRootRegistrarDeps,
): {
  register: HeartbeatRootRegistrar["registerRoot"];
  release: HeartbeatRootRegistrar["releaseRoot"];
} {
  return { register, release };

  async function register(
    input: Parameters<HeartbeatRootRegistrar["registerRoot"]>[0],
  ): ReturnType<HeartbeatRootRegistrar["registerRoot"]> {
    const boundedAutonomy = deps.boundedAutonomyHolder.current;
    if (boundedAutonomy === undefined) {
      return err({ errorKind: "precondition", message: "Bounded autonomy is not bound for heartbeat root registration" });
    }
    const taskLane = input.lane === "task";
    const identity = resolveInternalTurnIdentity({
      tenantId: deps.tenantId,
      agentId: input.target.agentId,
      originKind: "scheduler",
      instanceId: taskLane ? "task-check" : "heartbeat",
      conversationId: taskLane ? input.correlationId : input.target.agentId,
      principalId: taskLane
        ? `scheduler-task-check-${input.target.agentId}`
        : `scheduler-heartbeat-${input.target.agentId}`,
    });
    if (!identity.ok) {
      return err({ errorKind: "validation", message: "Heartbeat root identity failed validation" });
    }
    const opaqueId = tryCatch(() => deps.idFactory());
    if (!opaqueId.ok || opaqueId.value.length === 0) {
      return err({ errorKind: "internal", message: "Heartbeat root id allocation failed" });
    }
    const rootRunId = `${taskLane ? "root-task-check" : "root-heartbeat"}-${opaqueId.value}`;
    const issued = tryCatch(() => deps.leaseManager.mintLease({
      agentId: input.target.agentId,
      caps: [],
      budgetRef: `${taskLane ? "task-check" : "heartbeat"}:${input.correlationId}`,
      sessionKey: formatSessionKey(identity.value.displaySessionKey),
      trustLevel: "user",
      turnScope: identity.value.turnScope,
      rootRunId,
    }));
    if (!issued.ok) {
      logFailure(input, "heartbeat_root_lease_mint", "internal", "Heartbeat root lease mint failed");
      return err({ errorKind: "internal", message: "Heartbeat root lease mint failed" });
    }
    const anchored = tryCatch(() => {
      deps.outputGuard.registerSecret(issued.value.bearer);
      boundedAutonomy.registerRoot(rootRunId, issued.value.leaseId, undefined);
    });
    if (!anchored.ok) {
      deps.leaseManager.revoke(issued.value.leaseId);
      logFailure(input, "heartbeat_root_budget_anchor", "internal", "Heartbeat root budget registration failed");
      return err({ errorKind: "internal", message: "Heartbeat root budget registration failed" });
    }
    return ok({ rootRunId });
  }

  async function release(rootRunId: string): ReturnType<HeartbeatRootRegistrar["releaseRoot"]> {
    const evictRootIfIdle = deps.boundedAutonomyHolder.current?.evictRootIfIdle;
    if (evictRootIfIdle === undefined) {
      return err({ errorKind: "precondition", message: "Bounded autonomy root release is not bound" });
    }
    const released = tryCatch(() => evictRootIfIdle(rootRunId));
    if (!released.ok) {
      deps.logger.error({
        rootRunId,
        step: "heartbeat_root_release",
        errorKind: "internal" as const,
        hint: "Inspect bounded-autonomy root ownership; the settled heartbeat must not be replayed",
      }, "Heartbeat root release failed");
      return err({ errorKind: "internal", message: "Heartbeat root release failed" });
    }
    return ok(undefined);
  }

  function logFailure(
    input: Parameters<HeartbeatRootRegistrar["registerRoot"]>[0],
    step: string,
    errorKind: "internal",
    message: string,
  ): void {
    deps.logger.error({
      correlationId: input.correlationId,
      agentId: input.target.agentId,
      step,
      errorKind,
      hint: "Inspect the shared capability lease and bounded-autonomy services before retrying the retained heartbeat occurrence",
    }, message);
  }
}
