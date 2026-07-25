// SPDX-License-Identifier: Apache-2.0
/** Daemon-owned root lease and budget registration for claimed cron work. */
import {
  formatSessionKey,
  type ComisLogger,
  type OutputGuardPort,
} from "@comis/core";
import type { BoundedAutonomyBudgetHolder } from "@comis/agent";
import type { LeaseManager } from "@comis/infra";
import { resolveInternalTurnIdentity } from "@comis/orchestrator";
import type { CronJob, CronRootRegistrar } from "@comis/scheduler";
import { err, ok, tryCatch } from "@comis/shared";

export interface CronRootRegistrarDeps {
  tenantId: string;
  leaseManager: Pick<LeaseManager, "mintLease" | "revoke">;
  outputGuard: Pick<OutputGuardPort, "registerSecret">;
  boundedAutonomyHolder: BoundedAutonomyBudgetHolder;
  logger: ComisLogger;
}

/** One stable synthetic conversation per job, shared by registration and execution. */
export function resolveCronTurnIdentity(
  tenantId: string,
  job: Pick<CronJob, "id" | "agentId">,
) {
  return resolveInternalTurnIdentity({
    tenantId,
    agentId: job.agentId,
    originKind: "scheduler",
    instanceId: job.id,
    conversationId: `cron-job-${job.id}`,
    principalId: `scheduler-cron-${job.agentId}`,
  });
}

export function createCronRootRegistrar(deps: CronRootRegistrarDeps): CronRootRegistrar {
  return {
    async register(input) {
      const boundedAutonomy = deps.boundedAutonomyHolder.current;
      if (boundedAutonomy === undefined) {
        return err({
          errorKind: "precondition" as const,
          message: "Bounded autonomy is not bound for cron root registration",
        });
      }
      const identity = resolveCronTurnIdentity(deps.tenantId, input.job);
      if (!identity.ok) {
        deps.logger.error({
          executionId: input.executionId,
          jobId: input.job.id,
          agentId: input.job.agentId,
          step: "root_identity",
          errorKind: "validation" as const,
          hint: "Verify the persisted cron job identity before retrying the occurrence",
        }, "Cron root identity resolution failed");
        return err({ errorKind: "validation" as const, message: identity.error.message });
      }

      const issued = tryCatch(() => deps.leaseManager.mintLease({
        agentId: input.job.agentId,
        caps: [],
        budgetRef: `cron:${input.executionId}`,
        sessionKey: formatSessionKey(identity.value.displaySessionKey),
        trustLevel: "user",
        turnScope: identity.value.turnScope,
        rootRunId: input.rootRunId,
      }));
      if (!issued.ok) {
        deps.logger.error({
          executionId: input.executionId,
          jobId: input.job.id,
          step: "root_lease_mint",
          errorKind: "internal" as const,
          hint: "Inspect the shared capability lease manager before retrying cron execution",
        }, "Cron root lease mint failed");
        return err({ errorKind: "internal" as const, message: "Cron root lease mint failed" });
      }

      const anchored = tryCatch(() => {
        deps.outputGuard.registerSecret(issued.value.bearer);
        boundedAutonomy.registerRoot(input.rootRunId, issued.value.leaseId, undefined);
      });
      if (!anchored.ok) {
        deps.leaseManager.revoke(issued.value.leaseId);
        deps.logger.error({
          executionId: input.executionId,
          jobId: input.job.id,
          step: "root_budget_anchor",
          errorKind: "internal" as const,
          hint: "Inspect bounded-autonomy budget wiring before retrying cron execution",
        }, "Cron root budget registration failed");
        return err({ errorKind: "internal" as const, message: "Cron root budget registration failed" });
      }
      return ok(undefined);
    },

    async release(rootRunId) {
      const evictRootIfIdle = deps.boundedAutonomyHolder.current?.evictRootIfIdle;
      if (evictRootIfIdle === undefined) {
        return err({
          errorKind: "precondition" as const,
          message: "Bounded autonomy root release is not bound",
        });
      }
      const released = tryCatch(() => evictRootIfIdle(rootRunId));
      if (!released.ok) {
        deps.logger.error({
          rootRunId,
          step: "root_release",
          errorKind: "internal" as const,
          hint: "Inspect bounded-autonomy root state; live descendants retain their existing budget",
        }, "Cron root release failed");
        return err({ errorKind: "internal" as const, message: "Cron root release failed" });
      }
      return ok(undefined);
    },
  };
}
