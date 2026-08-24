// SPDX-License-Identifier: Apache-2.0
/**
 * Retirement-producer state resolution.
 *
 * Answers one question for the announcement retirement path: is the producer
 * that owns a replay guard still active, already terminal, or gone? Graph,
 * session, and tool-result producers each prove that differently — a graph by
 * liveness, a session by its durable checkpoint, a tool result by whether its
 * result row was committed — so each branch reads its own authority rather
 * than a shared guess.
 *
 * @module
 */
import type {
  AnnouncementRetirementProducer,
  AnnouncementRetirementProducerState,
  DurableRunPort,
  SessionStorePort,
} from "@comis/core";
import { isAnnouncementProducerRecoveryOutcome } from "@comis/orchestrator";
import { err, ok, type Result } from "@comis/shared";

export function createRetirementProducerStateResolver(deps: {
  sessionStore: Pick<SessionStorePort, "loadByRef">
    & Partial<Pick<SessionStorePort, "save">>;
  durableRuns?: Pick<DurableRunPort, "getByCheckpoint">;
  graphProducerExists?: (graphId: string) => boolean;
}): (
  producer: AnnouncementRetirementProducer,
) => Promise<Result<AnnouncementRetirementProducerState, Error>> {
  return async (producer) => {
    if (producer.kind === "graph") {
      return ok((deps.graphProducerExists?.(producer.graphId) ?? true)
        ? { status: "active" as const }
        : { status: "absent" as const });
    }
    if (producer.kind === "session") {
      const session = deps.sessionStore.loadByRef({
        tenantId: producer.tenantId,
        agentId: producer.agentId,
      }, producer.conversationRef);
      if (!session.ok) return err(session.error);
      const recoveryHandoff = session.value === undefined
        ? undefined
        : session.value.metadata.announcementProducerRecoveryOutcome;
      const handoffRecord = typeof recoveryHandoff === "object"
        && recoveryHandoff !== null
        && !Array.isArray(recoveryHandoff)
        ? recoveryHandoff as Record<string, unknown>
        : undefined;
      const recoveryOutcome = handoffRecord?.checkpointId === producer.checkpointId
        ? handoffRecord.outcome
        : undefined;
      if (
        isAnnouncementProducerRecoveryOutcome(recoveryOutcome)
        && recoveryOutcome.kind === "session"
      ) {
        return ok({
          status: "terminal" as const,
          terminalReason: recoveryOutcome.terminalReason,
          recoveryOutcome,
        });
      }
      if (!deps.durableRuns) return ok({ status: "absent" as const });
      const checkpoint = await deps.durableRuns.getByCheckpoint(producer.checkpointId);
      if (!checkpoint.ok) return checkpoint;
      if (!checkpoint.value) return ok({ status: "absent" as const });
      if (checkpoint.value.status === "running") return ok({ status: "active" as const });
      return ok({
        status: "terminal" as const,
        ...(checkpoint.value.terminalReason
          ? { terminalReason: checkpoint.value.terminalReason }
          : {}),
      });
    }
    const loaded = deps.sessionStore.loadByRef({
      tenantId: producer.tenantId,
      agentId: producer.agentId,
    }, producer.conversationRef);
    if (!loaded.ok) return err(loaded.error);
    if (!loaded.value) return ok({ status: "absent" as const });
    const committed = loaded.value.messages.some((message) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        return false;
      }
      const record = message as Record<string, unknown>;
      return record.role === "toolResult" && record.toolCallId === producer.toolCallId;
    });
    const recoveryHandoffs = loaded.value.metadata.announcementToolResultRecoveryHandoffs;
    const handoffsRecord = typeof recoveryHandoffs === "object"
      && recoveryHandoffs !== null
      && !Array.isArray(recoveryHandoffs)
      ? recoveryHandoffs as Record<string, unknown>
      : undefined;
    if (committed) {
      if (handoffsRecord !== undefined && deps.sessionStore.save !== undefined) {
        const remaining = Object.fromEntries(
          Object.entries(handoffsRecord).filter(([key]) => key !== producer.operationId),
        );
        const saved = deps.sessionStore.save(
          loaded.value.conversationScope,
          loaded.value.messages,
          {
            ...loaded.value.metadata,
            announcementToolResultRecoveryHandoffs: remaining,
          },
        );
        if (!saved.ok) return err(saved.error);
      }
      return ok({ status: "terminal" as const });
    }
    const recoveryHandoff = handoffsRecord === undefined
      ? undefined
      : Object.entries(handoffsRecord).find(([key]) => key === producer.operationId)?.[1];
    const handoffRecord = typeof recoveryHandoff === "object"
      && recoveryHandoff !== null
      && !Array.isArray(recoveryHandoff)
      ? recoveryHandoff as Record<string, unknown>
      : undefined;
    const recoveryOutcome = handoffRecord?.operationId === producer.operationId
      && handoffRecord.toolCallId === producer.toolCallId
      ? handoffRecord.outcome
      : undefined;
    if (
      isAnnouncementProducerRecoveryOutcome(recoveryOutcome)
      && recoveryOutcome.kind === "tool_result"
    ) {
      return ok({
        status: "terminal" as const,
        terminalReason: recoveryOutcome.terminalReason,
        recoveryOutcome,
      });
    }
    return ok({ status: "active" as const });
  };
}
