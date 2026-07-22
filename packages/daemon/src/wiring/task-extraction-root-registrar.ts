// SPDX-License-Identifier: Apache-2.0
/** Daemon-owned capability and budget root for one volatile extraction batch. */
import {
  formatSessionKey,
  type ComisLogger,
  type OutputGuardPort,
} from "@comis/core";
import type { BoundedAutonomyBudgetHolder } from "@comis/agent";
import type { LeaseManager } from "@comis/infra";
import { resolveInternalTurnIdentity } from "@comis/orchestrator";
import type { TaskExtractionModelError } from "@comis/scheduler";
import { err, ok, tryCatch, type Result } from "@comis/shared";

export interface TaskExtractionRootRegistrarDeps {
  readonly tenantId: string;
  readonly leaseManager: Pick<LeaseManager, "mintLease" | "revoke">;
  readonly outputGuard: Pick<OutputGuardPort, "registerSecret">;
  readonly boundedAutonomyHolder: BoundedAutonomyBudgetHolder;
  readonly logger: Pick<ComisLogger, "error">;
}

export interface TaskExtractionRootRegistrar {
  registerRoot(input: {
    readonly agentId: string;
    readonly rootRunId: string;
  }): Promise<Result<void, TaskExtractionModelError>>;
  releaseRoot(rootRunId: string): Promise<Result<void, TaskExtractionModelError>>;
}

export function createTaskExtractionRootRegistrar(
  deps: TaskExtractionRootRegistrarDeps,
): TaskExtractionRootRegistrar {
  return { registerRoot, releaseRoot };

  async function registerRoot(input: {
    readonly agentId: string;
    readonly rootRunId: string;
  }): Promise<Result<void, TaskExtractionModelError>> {
    if (!validExtractionRoot(input.rootRunId)) {
      return err({ code: "invalid_root", errorKind: "validation" });
    }
    const boundedAutonomy = deps.boundedAutonomyHolder.current;
    if (boundedAutonomy === undefined) {
      return err({ code: "not_bound", errorKind: "precondition" });
    }
    const identity = resolveInternalTurnIdentity({
      tenantId: deps.tenantId,
      agentId: input.agentId,
      originKind: "scheduler",
      instanceId: "task-extraction",
      conversationId: input.rootRunId,
      principalId: `scheduler-task-extraction-${input.agentId}`,
    });
    if (!identity.ok) {
      return err({ code: "invalid_identity", errorKind: "validation" });
    }
    const issued = tryCatch(() => deps.leaseManager.mintLease({
      agentId: input.agentId,
      caps: [],
      budgetRef: `task-extraction:${input.rootRunId}`,
      sessionKey: formatSessionKey(identity.value.displaySessionKey),
      trustLevel: "user",
      turnScope: identity.value.turnScope,
      rootRunId: input.rootRunId,
    }));
    if (!issued.ok) {
      logFailure(input, "task_extraction_root_lease", "lease_failed");
      return err({ code: "lease_failed", errorKind: "internal" });
    }
    const anchored = tryCatch(() => {
      deps.outputGuard.registerSecret(issued.value.bearer);
      boundedAutonomy.registerRoot(input.rootRunId, issued.value.leaseId, undefined);
    });
    if (!anchored.ok) {
      deps.leaseManager.revoke(issued.value.leaseId);
      logFailure(input, "task_extraction_root_anchor", "anchor_failed");
      return err({ code: "anchor_failed", errorKind: "internal" });
    }
    return ok(undefined);
  }

  async function releaseRoot(rootRunId: string): Promise<Result<void, TaskExtractionModelError>> {
    if (!validExtractionRoot(rootRunId)) {
      return err({ code: "invalid_root", errorKind: "validation" });
    }
    const evictRootIfIdle = deps.boundedAutonomyHolder.current?.evictRootIfIdle;
    if (evictRootIfIdle === undefined) {
      return err({ code: "not_bound", errorKind: "precondition" });
    }
    const released = tryCatch(() => evictRootIfIdle(rootRunId));
    if (!released.ok) {
      deps.logger.error({
        rootRunId,
        step: "task_extraction_root_release",
        errorKind: "internal" as const,
        hint: "Inspect bounded-autonomy root ownership; the volatile extraction batch must not be replayed.",
      }, "Task extraction root release failed");
      return err({ code: "release_failed", errorKind: "internal" });
    }
    return ok(undefined);
  }

  function logFailure(
    input: { readonly agentId: string; readonly rootRunId: string },
    step: string,
    code: "lease_failed" | "anchor_failed",
  ): void {
    deps.logger.error({
      agentId: input.agentId,
      rootRunId: input.rootRunId,
      step,
      errorKind: "internal" as const,
      hint: "Inspect the shared capability lease and bounded-autonomy services before enabling task extraction.",
    }, code === "lease_failed"
      ? "Task extraction root lease mint failed"
      : "Task extraction root budget registration failed");
  }
}

function validExtractionRoot(rootRunId: string): boolean {
  return rootRunId.startsWith("root-task-extract-")
    && rootRunId.length > "root-task-extract-".length
    && rootRunId.length <= 256
    && Buffer.byteLength(rootRunId, "utf8") <= 256;
}
