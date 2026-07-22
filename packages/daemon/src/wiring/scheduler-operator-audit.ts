// SPDX-License-Identifier: Apache-2.0
/** Durable, content-free audit emission for scheduler operator decisions. */
import {
  emitObservationalEventSafely,
  type ComisLogger,
  type TypedEventBus,
} from "@comis/core";

export interface SchedulerOperatorAuditDeps {
  readonly tenantId: string;
  readonly eventBus: Pick<TypedEventBus, "emitSafely">;
  readonly logger: Pick<ComisLogger, "warn">;
  readonly nowMs: () => number;
}

export interface SchedulerOperatorAuditInput {
  readonly agentId: string;
  readonly actionType: "cron.reset" | "tasks.cancel" | "tasks.reset";
  readonly classification: "mutate" | "destructive";
  readonly decision: "accepted" | "rejected";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Publish through the durable audit-event seam. The audit subscriber owns the
 * SQLite row, security JSONL record, and level-35 summary log.
 */
export function emitSchedulerOperatorAudit(
  deps: SchedulerOperatorAuditDeps,
  input: SchedulerOperatorAuditInput,
): void {
  emitObservationalEventSafely({ eventBus: deps.eventBus, logger: deps.logger }, "audit:event", {
    timestamp: deps.nowMs(),
    agentId: input.agentId,
    tenantId: deps.tenantId,
    actionType: input.actionType,
    kind: "audit",
    classification: input.classification,
    outcome: input.decision === "accepted" ? "success" : "denied",
    metadata: {
      actorScope: "admin",
      decision: input.decision,
      ...input.metadata,
    },
  });
}
