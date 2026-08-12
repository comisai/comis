// SPDX-License-Identifier: Apache-2.0

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { err, fromPromise, ok, suppressError, tryCatch, type Result } from "@comis/shared";
import {
  createDeliveryOrigin,
  createResolvedRequestContext,
  RequestContextSchema,
  runWithContext,
  systemNowMs,
  type ComisLogger,
  type DeliveryOrigin,
  type EventMap,
  type NormalizedMessage,
  type RequestContext,
  type ResolvedRequestContextSeed,
  type ResolvedTurnScope,
  type ResponseLocalePolicy,
  type SessionKey,
  type TurnActivityContext,
  type TurnOutcome,
  type TypedEventBus,
  type UserTrustLevel,
  type WorkspacePolicySnapshot,
} from "@comis/core";
import type { AgentExecutor, ExecutionResult } from "../executor/types.js";

export interface ContinuationOriginAuthority {
  readonly turnScope: ResolvedTurnScope;
  readonly deliveryOrigin: DeliveryOrigin;
  readonly traceId: string | null;
  readonly rootRunId?: string;
  readonly trustLevel: UserTrustLevel;
  readonly responseLocalePolicy: ResponseLocalePolicy;
}

export interface ContinuationActivityCoordinator {
  start(ctx: TurnActivityContext): void;
  finalize(outcome: TurnOutcome): Promise<void>;
  dispose(): void;
}

export type ContinuationActivityCoordinatorFactory = (
  ctx: TurnActivityContext,
) => ContinuationActivityCoordinator;

export interface ContinuationExecutionEngineDeps {
  readonly eventBus: TypedEventBus;
  readonly getExecutor: (agentId: string) => AgentExecutor;
  readonly assembleToolsForAgent: (
    agentId: string,
    options?: { sessionKey?: SessionKey },
  ) => Promise<AgentTool[]>;
  readonly activityCoordinatorFactory?: ContinuationActivityCoordinatorFactory;
  readonly logger: ComisLogger;
}

export interface ContinuationExecutionHooks<TFinalized> {
  readonly onProviderStart: () => Result<void, Error>;
  readonly onJournalFinalizedResult: (result: ExecutionResult) => Promise<void>;
  readonly onFinalizedResult: (
    result: ExecutionResult,
    phase: "cleanup_pending" | "ready",
  ) => Promise<TFinalized | undefined>;
}

export interface ContinuationExecutionInput<TFinalized> {
  readonly continuationId: string;
  readonly source: "background_task" | "managed_run";
  readonly sourceId: string;
  readonly agentId: string;
  readonly authority: ContinuationOriginAuthority;
  readonly requestContext: RequestContext;
  readonly sessionKey: SessionKey;
  readonly formattedSessionKey: string;
  readonly message: NormalizedMessage;
  readonly journalKey: string;
  readonly workspacePolicyHash: string;
  readonly workspacePolicySnapshot: WorkspacePolicySnapshot;
  readonly capturedCapabilityCeiling: {
    readonly toolIds: readonly string[];
    readonly viewHash: string;
  };
  readonly beforeExecute: () => void;
  readonly hooks: ContinuationExecutionHooks<TFinalized>;
}

export interface ContinuationExecutionOutcome<TFinalized> {
  readonly result: ExecutionResult;
  readonly finalizedValue?: TFinalized;
  readonly tools: readonly AgentTool[] | undefined;
}

export interface ContinuationExecutionEngine {
  execute<TFinalized>(
    input: ContinuationExecutionInput<TFinalized>,
  ): Promise<Result<ContinuationExecutionOutcome<TFinalized>, Error>>;
  shutdown(): Promise<void>;
}

export function createContinuationRequestContext(
  authority: ContinuationOriginAuthority,
  sessionKey: SessionKey,
  workspacePolicyHash: string,
): Result<RequestContext, Error> {
  const built = tryCatch(() => {
    const persistedTrace = RequestContextSchema.shape.traceId.safeParse(authority.traceId);
    const traceId = persistedTrace.success ? persistedTrace.data : randomUUID();
    const deliveryOrigin = createDeliveryOrigin(authority.deliveryOrigin);
    const seed: ResolvedRequestContextSeed = {
      tenantId: authority.turnScope.conversation.tenantId,
      userId: sessionKey.userId,
      sessionKey,
      agentId: authority.turnScope.conversation.agentId,
      traceId,
      startedAt: systemNowMs(),
      trustLevel: authority.trustLevel,
      learningEligible: false,
      channelType: deliveryOrigin.channelType,
      deliveryOrigin,
      workspacePolicyHash,
      turnScope: authority.turnScope,
      ...(authority.rootRunId === undefined ? {} : { rootRunId: authority.rootRunId }),
    };
    return seed;
  });
  if (!built.ok) return built;
  return createResolvedRequestContext(built.value);
}

function validateImmutableInputs(
  input: ContinuationExecutionInput<unknown>,
): Result<void, Error> {
  if (
    input.workspacePolicySnapshot.agentId !== input.agentId
    || input.workspacePolicySnapshot.combinedHash !== input.workspacePolicyHash
  ) {
    return err(new Error("Continuation workspace policy does not match its recorded authority"));
  }
  if (!/^[a-f0-9]{64}$/.test(input.capturedCapabilityCeiling.viewHash)) {
    return err(new Error("Continuation capability view hash is invalid"));
  }
  const toolIds = input.capturedCapabilityCeiling.toolIds;
  let previousToolId: string | undefined;
  for (const toolId of toolIds) {
    if (
      typeof toolId !== "string"
      || toolId.length === 0
      || (previousToolId !== undefined && previousToolId.localeCompare(toolId) >= 0)
    ) {
      return err(new Error("Continuation captured tool IDs must be unique and sorted"));
    }
    previousToolId = toolId;
  }
  return ok(undefined);
}

function intersectTools(
  currentTools: readonly AgentTool[],
  capturedToolIds: readonly string[],
): Result<AgentTool[], Error> {
  const byName = new Map<string, AgentTool>();
  for (const tool of currentTools) {
    if (byName.has(tool.name)) {
      return err(new Error("Current continuation tool surface contains duplicate names"));
    }
    byName.set(tool.name, tool);
  }
  return ok(capturedToolIds.flatMap((toolId) => {
    const tool = byName.get(toolId);
    return tool === undefined ? [] : [tool];
  }));
}

export function createContinuationActivityContext(
  authority: ContinuationOriginAuthority,
  sessionKey: string,
  traceId: string,
  inboundMessageId: string,
): TurnActivityContext {
  const endpoint = authority.turnScope.endpoint;
  return {
    agentId: authority.turnScope.conversation.agentId,
    sessionKey,
    traceId,
    channelType: endpoint.channelType,
    channelKey: endpoint.conversationId,
    chatType: endpoint.conversationKind === "direct" ? "direct" : "group",
    inboundMessageId,
    ...(endpoint.threadId === undefined ? {} : { threadId: endpoint.threadId }),
    rendererKey: `${authority.turnScope.conversation.agentId}:${endpoint.channelType}:${endpoint.conversationId}`,
  };
}

/** Execute one continuation turn under exact reconstructed authority. */
export function createContinuationExecutionEngine(
  deps: ContinuationExecutionEngineDeps,
): ContinuationExecutionEngine {
  const log = deps.logger.child({ submodule: "continuation-engine" });
  const retainedActivity = new Set<{ dispose(): void }>();
  let activityInflight: Promise<void> = Promise.resolve();
  let stopped = false;

  function startActivity(
    ctx: TurnActivityContext,
  ): { executionSettled(): Promise<void>; dispose(): void } | undefined {
    if (deps.activityCoordinatorFactory === undefined) return undefined;
    const built = tryCatch(() => {
      const coordinator = deps.activityCoordinatorFactory?.(ctx);
      if (coordinator === undefined) return undefined;
      coordinator.start(ctx);
      return coordinator;
    });
    if (!built.ok || built.value === undefined) {
      log.warn({
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        traceId: ctx.traceId,
        hint: "Inspect the continuation activity coordinator factory; execution proceeds without live activity rendering",
        errorKind: "internal" as const,
      }, "Continuation activity subscription failed");
      return undefined;
    }

    const coordinator = built.value;
    const pendingApprovals = new Set<string>();
    let executionHasSettled = false;
    let finalized = false;
    let finalizePromise: Promise<void> | undefined;
    const removeListeners = (): void => {
      deps.eventBus.off("approval:requested", onApprovalRequested);
      deps.eventBus.off("approval:resolved", onApprovalResolved);
    };
    const dispose = (): void => {
      if (finalized) return;
      finalized = true;
      removeListeners();
      retainedActivity.delete(lease);
      coordinator.dispose();
    };
    const finalize = async (): Promise<void> => {
      if (finalizePromise !== undefined) return finalizePromise;
      finalized = true;
      removeListeners();
      retainedActivity.delete(lease);
      const invoked = tryCatch(() => coordinator.finalize({ kind: "silent", reason: "NO_REPLY" }));
      if (!invoked.ok) {
        coordinator.dispose();
        log.warn({
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          traceId: ctx.traceId,
          hint: "Inspect the originating channel activity renderer; continuation approval controls may require manual cleanup",
          errorKind: "platform" as const,
        }, "Continuation activity finalization failed");
        return;
      }
      finalizePromise = fromPromise(invoked.value).then((settled) => {
        if (settled.ok) return;
        coordinator.dispose();
        log.warn({
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          traceId: ctx.traceId,
          hint: "Inspect the originating channel activity renderer; continuation approval controls may require manual cleanup",
          errorKind: "platform" as const,
        }, "Continuation activity finalization failed");
      });
      return finalizePromise;
    };
    const onApprovalRequested = (request: EventMap["approval:requested"]): void => {
      if (
        request.agentId === ctx.agentId
        && request.sessionKey === ctx.sessionKey
        && request.traceId === ctx.traceId
      ) {
        pendingApprovals.add(request.requestId);
      }
    };
    const onApprovalResolved = (resolution: EventMap["approval:resolved"]): void => {
      if (!pendingApprovals.delete(resolution.requestId)) return;
      if (executionHasSettled && pendingApprovals.size === 0) {
        const closing = finalize();
        activityInflight = activityInflight.then(() => closing).catch(() => undefined);
        suppressError(closing, "continuation approval activity finalization");
      }
    };
    const lease = {
      async executionSettled(): Promise<void> {
        executionHasSettled = true;
        if (pendingApprovals.size === 0) {
          await finalize();
          return;
        }
        retainedActivity.add(lease);
      },
      dispose,
    };
    deps.eventBus.on("approval:requested", onApprovalRequested);
    deps.eventBus.on("approval:resolved", onApprovalResolved);
    return lease;
  }

  return Object.freeze({
    execute: async <TFinalized>(
      input: ContinuationExecutionInput<TFinalized>,
    ): Promise<Result<ContinuationExecutionOutcome<TFinalized>, Error>> => {
      if (stopped) return err(new Error("Continuation engine is stopped"));
      const validated = validateImmutableInputs(input);
      if (!validated.ok) return validated;
      const activity = startActivity(createContinuationActivityContext(
        input.authority,
        input.formattedSessionKey,
        input.requestContext.traceId,
        input.message.id,
      ));
      const scopedInvocation = tryCatch(() => runWithContext(
        input.requestContext,
        async () => {
          input.beforeExecute();
          const executor = tryCatch(() => deps.getExecutor(input.agentId));
          if (!executor.ok) return executor;
          const toolAssembly = await fromPromise(
            deps.assembleToolsForAgent(input.agentId, { sessionKey: input.sessionKey }),
          );
          if (!toolAssembly.ok) return toolAssembly;
          const intersectedTools = intersectTools(
            toolAssembly.value,
            input.capturedCapabilityCeiling.toolIds,
          );
          if (!intersectedTools.ok) return intersectedTools;
          let finalizedValue: TFinalized | undefined;
          const execution = tryCatch(() => executor.value.execute(
            input.message,
            input.sessionKey,
            intersectedTools.value,
            undefined,
            input.agentId,
            undefined,
            undefined,
            {
              operationType: "interactive",
              workspacePolicySnapshot: input.workspacePolicySnapshot,
              responseLocalePolicy: input.authority.responseLocalePolicy,
              suppressFinalResponseAfterOutboundDelivery: {
                channelType: input.authority.deliveryOrigin.channelType,
                channelId: input.authority.deliveryOrigin.channelId,
              },
              finalizedResultJournalKey: input.journalKey,
              onJournalFinalizedResult: input.hooks.onJournalFinalizedResult,
              onProviderStart: input.hooks.onProviderStart,
              onFinalizedResult: async (result, phase) => {
                const value = await input.hooks.onFinalizedResult(result, phase);
                if (value !== undefined) finalizedValue = value;
              },
            },
          ));
          if (!execution.ok) return execution;
          const settled = await fromPromise(execution.value);
          if (!settled.ok) return settled;
          return ok({
            result: settled.value,
            ...(finalizedValue === undefined ? {} : { finalizedValue }),
            tools: intersectedTools.value,
          });
        },
      ));
      const scopedResult = scopedInvocation.ok
        ? await fromPromise(scopedInvocation.value)
        : scopedInvocation;
      await activity?.executionSettled();
      return scopedResult.ok ? scopedResult.value : scopedResult;
    },
    shutdown: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await activityInflight;
      for (const activity of retainedActivity) activity.dispose();
      retainedActivity.clear();
    },
  });
}
