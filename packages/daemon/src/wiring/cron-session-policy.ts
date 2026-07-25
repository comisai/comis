// SPDX-License-Identifier: Apache-2.0
/** Storage-owning fresh and bounded-rolling policy for synthetic cron sessions. */
import {
  createConversationRef,
  formatSessionKey,
  type ClockPort,
  type ComisLogger,
  type ContextStorePort,
  type ContextStoreScope,
  type ErrorKind,
  type SessionKey,
} from "@comis/core";
import {
  replaceContextStoreHistory,
  retainLastCompleteUserTurns,
  type ComisSessionManager,
} from "@comis/agent";
import type { CronRuntimeError, CronRuntimeExecutionInput } from "@comis/scheduler";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import { resolveCronTurnIdentity } from "./cron-root-registrar.js";

type AgentTurnInput = Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }>;

export interface CronSessionPolicyRequest {
  input: AgentTurnInput;
  sessionKey: SessionKey;
  signal: AbortSignal;
}

export interface CronSessionPolicy {
  before(request: CronSessionPolicyRequest): Promise<Result<void, CronRuntimeError>>;
  after(request: CronSessionPolicyRequest): Promise<Result<void, CronRuntimeError>>;
}

export interface CronSessionPolicyDeps {
  tenantId: string;
  clock: ClockPort;
  contextStore: ContextStorePort;
  piSessionAdapters: ReadonlyMap<
    string,
    Pick<ComisSessionManager, "withSession" | "destroySession">
  >;
  logger: ComisLogger;
}

export function createCronSessionPolicy(deps: CronSessionPolicyDeps): CronSessionPolicy {
  return {
    before(request) {
      return reconcile(request, "before");
    },
    after(request) {
      return request.input.job.sessionPolicy.strategy === "fresh"
        ? Promise.resolve(ok(undefined))
        : reconcile(request, "after");
    },
  };

  async function reconcile(
    request: CronSessionPolicyRequest,
    phase: "before" | "after",
  ): Promise<Result<void, CronRuntimeError>> {
    const adapter = deps.piSessionAdapters.get(request.input.job.agentId);
    if (adapter === undefined) {
      return err(runtimeError(
        "precondition_failed",
        "precondition",
        "Cron synthetic SDK session adapter is not bound",
      ));
    }
    const scope = resolveScope(request.input, request.sessionKey);
    if (!scope.ok) return scope;
    const startedAt = deps.clock.now();

    if (request.input.job.sessionPolicy.strategy === "fresh") {
      const destroyed = await fromPromise(adapter.destroySession(request.sessionKey));
      if (!destroyed.ok) {
        return fail(request, phase, startedAt, "resource", "Cron fresh SDK session reset failed");
      }
      const canonical = await replaceContextStoreHistory(
        deps.contextStore,
        scope.value,
        [],
        deps.clock.now(),
        deps.logger,
      );
      if (!canonical.ok) {
        return fail(request, phase, startedAt, canonical.error.errorKind, canonical.error.message);
      }
      complete(request, phase, startedAt, 0);
      return ok(undefined);
    }

    const maxHistoryTurns = request.input.job.sessionPolicy.maxHistoryTurns;
    const locked = await adapter.withSession(request.sessionKey, async (sessionManager) => {
      const bounded = retainLastCompleteUserTurns(sessionManager, maxHistoryTurns);
      if (!bounded.ok) {
        return err(runtimeError(
          "precondition_failed",
          bounded.error.errorKind,
          bounded.error.message,
        ));
      }
      const history = sessionManager.buildSessionContext().messages;
      const canonical = await replaceContextStoreHistory(
        deps.contextStore,
        scope.value,
        history,
        deps.clock.now(),
        deps.logger,
      );
      if (!canonical.ok) {
        return err(runtimeError(
          "precondition_failed",
          canonical.error.errorKind,
          canonical.error.message,
        ));
      }
      return ok({ retainedTurns: bounded.value.retainedTurns });
    });
    if (!locked.ok) {
      return fail(request, phase, startedAt, "resource", "Cron rolling SDK session lock failed");
    }
    if (!locked.value.ok) {
      return fail(
        request,
        phase,
        startedAt,
        locked.value.error.errorKind,
        locked.value.error.message,
      );
    }
    complete(request, phase, startedAt, locked.value.value.retainedTurns);
    return ok(undefined);
  }

  function resolveScope(
    input: AgentTurnInput,
    sessionKey: SessionKey,
  ): Result<ContextStoreScope, CronRuntimeError> {
    const identity = resolveCronTurnIdentity(deps.tenantId, input.job);
    if (!identity.ok) {
      return err(runtimeError("invalid_input", "validation", identity.error.message));
    }
    if (formatSessionKey(identity.value.displaySessionKey) !== formatSessionKey(sessionKey)) {
      return err(runtimeError(
        "invalid_input",
        "precondition",
        "Cron synthetic session identity changed before reconciliation",
      ));
    }
    const conversationRef = createConversationRef(identity.value.turnScope.conversation);
    if (!conversationRef.ok) {
      return err(runtimeError("invalid_input", "validation", conversationRef.error.message));
    }
    return ok({
      conversationRef: conversationRef.value,
      tenantId: deps.tenantId,
      agentId: input.job.agentId,
      sessionKey: formatSessionKey(sessionKey),
    });
  }

  function fail(
    request: CronSessionPolicyRequest,
    phase: "before" | "after",
    startedAt: number,
    errorKind: ErrorKind,
    message: string,
  ): Result<never, CronRuntimeError> {
    deps.logger.error({
      executionId: request.input.executionId,
      jobId: request.input.job.id,
      agentId: request.input.job.agentId,
      sessionPolicy: request.input.job.sessionPolicy.strategy,
      phase,
      step: "cron_session_reconcile",
      durationMs: Math.max(0, deps.clock.now() - startedAt),
      errorKind,
      hint: "Inspect the synthetic SDK session and canonical LCD storage before running the occurrence again",
    }, "Cron synthetic session reconciliation failed");
    return err(runtimeError("precondition_failed", errorKind, message));
  }

  function complete(
    request: CronSessionPolicyRequest,
    phase: "before" | "after",
    startedAt: number,
    retainedTurns: number,
  ): void {
    deps.logger.info({
      executionId: request.input.executionId,
      jobId: request.input.job.id,
      agentId: request.input.job.agentId,
      sessionPolicy: request.input.job.sessionPolicy.strategy,
      phase,
      retainedTurns,
      durationMs: Math.max(0, deps.clock.now() - startedAt),
    }, "Cron synthetic session reconciliation complete");
  }
}

function runtimeError(
  code: CronRuntimeError["code"],
  errorKind: ErrorKind,
  message: string,
): CronRuntimeError {
  return { code, errorKind, message };
}
