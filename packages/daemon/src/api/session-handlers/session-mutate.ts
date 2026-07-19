// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Session mutation RPC handlers.
 *
 * Handlers that route or trigger work on behalf of a session:
 *   - session.send: cross-session message routing (fire-and-forget / wait / ping-pong)
 *   - session.spawn: spawn a sub-agent (async or sync awaited)
 *   - session.compact: trigger compaction for an existing session
 *
 * @module
 */
import {
  type DeliveryOrigin,
  SessionSendContract,
  SessionSpawnContract,
  SessionCompactContract,
  stripInternalFields,
  requireCapability,
  computeReachableToolNames,
  tryGetContext,
  ConversationRefSchema,
  conversationScopeToSessionKey,
  createConversationRef,
} from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, loadAuthorizedSession, type SessionHandlerDeps } from "./session-helpers.js";
import { resolveSessionSpawnAuthority } from "./session-spawn-authority.js";
import type {
  CallerContextMismatchField,
  SessionSendAuthorizationFailure,
} from "./session-authority.js";
/**
 * Bind the session mutation handlers. Object-spread compatible with
 * `Record<string, RpcHandler>`.
 */
export function bindSessionMutateHandlers(deps: SessionHandlerDeps): Record<string, RpcHandler> {
  return {
    [SessionSendContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: agent-to-agent policy check FIRST (preserves the
      // user-friendly error message AND prevents Zod from filtering useful
      // diagnostics).
      if (!deps.securityConfig.agentToAgent?.enabled) {
        throw new Error("Agent-to-agent messaging is disabled by policy. Enable security.agentToAgent.enabled in config.");
      }

      // Internal-field reads BEFORE strip
      const callerSessionKey = rawParams._callerSessionKey as string | undefined;
      const callerChannelType = rawParams._callerChannelType as string | undefined;
      const callerChannelId = rawParams._callerChannelId as string | undefined;
      const callerAgentId = rawParams._agentId as string | undefined;
      const announceOperationId = rawParams._outwardOperationId as string | undefined;

      const userParams = stripInternalFields(rawParams);
      const params = SessionSendContract.request.parse(userParams);

      const targetRef = ConversationRefSchema.safeParse(params.conversation_ref);
      if (!targetRef.success) throw new Error("Invalid target conversation reference");
      const target = {
        tenantId: params.tenant_id,
        agentId: params.agent_id,
        conversationRef: targetRef.data,
      };
      let callerAuthority: typeof target | undefined;
      let callerConversation: import("@comis/core").ConversationLocator | undefined;
      if (callerAgentId !== undefined) {
        const rejectAuthorization = (
          failure: SessionSendAuthorizationFailure,
        ): never => {
          deps.logger?.audit?.({
            kind: "capability_denied",
            outcome: "denied",
            actionType: "session.send",
            agentId: callerAgentId,
            authorizationFailure: failure,
          }, "session.send target principal denied");
          deps.logger?.warn({
            method: "session.send",
            authorizationFailure: failure,
            hint: "Reject the send and verify the active request principal, target session owner, and parent-child delegation metadata",
            errorKind: "auth" as const,
          }, "session.send target principal authorization failed");
          throw new Error(`session.send ${failure}`);
        };

        // `_agentId` is injected only on the model-facing in-process path. That
        // path must have an independently-resolved ALS principal and caller
        // session; otherwise stale or incomplete async state could authorize an
        // arbitrary target. Calls without `_agentId` are the explicit
        // authenticated control-plane path and remain governed by gateway scope.
        const callerContext = tryGetContext()
          ?? rejectAuthorization("request context is required for an agent-origin call");
        if (callerContext.agentId !== callerAgentId) {
          rejectAuthorization("caller agent does not match the request principal");
        }
        if (callerSessionKey !== callerContext.sessionKey) {
          rejectAuthorization("caller session does not match the request principal");
        }
        const callerTurnScope = callerContext.turnScope
          ?? rejectAuthorization("caller session identity does not match the request principal");
        const callerRef = createConversationRef(callerTurnScope.conversation);
        if (!callerRef.ok) {
          rejectAuthorization("caller session identity does not match the request principal");
        }
        callerAuthority = {
          tenantId: callerTurnScope.conversation.tenantId,
          agentId: callerTurnScope.conversation.agentId,
          conversationRef: callerRef.ok
            ? callerRef.value
            : rejectAuthorization("caller session identity does not match the request principal"),
        };
        callerConversation = {
          conversationScope: callerTurnScope.conversation,
          conversationRef: callerAuthority.conversationRef,
        };
        if (target.tenantId !== callerContext.tenantId) {
          rejectAuthorization("target tenant does not match the request principal");
        }
        const loadedTarget = deps.sessionStore.loadByRef(target, target.conversationRef);
        if (!loadedTarget.ok) throw loadedTarget.error;
        const targetSession = loadedTarget.value
          ?? rejectAuthorization("target session metadata is required");
        const targetPartition = targetSession.conversationScope.partition;
        const targetPrincipalId = targetPartition.kind === "principal"
          || targetPartition.kind === "channel-principal"
          || targetPartition.kind === "endpoint-conversation-principal"
          ? targetPartition.principalId
          : undefined;
        if (
          targetPrincipalId !== undefined
          && targetPrincipalId !== callerTurnScope.principal.principalId
        ) {
          rejectAuthorization("target user does not match the request principal");
        }
        const delegatedChild = target.agentId !== callerAgentId
          && targetSession.metadata.spawnedByAgent === callerAgentId
          && targetSession.metadata.parentConversationRef === callerAuthority.conversationRef;
        if (target.agentId !== callerAgentId && !delegatedChild) {
          rejectAuthorization("target agent does not match the request principal");
        }
      }

      const mode = params.mode ?? "fire-and-forget";
      const result = await deps.crossSessionSender.send({
        target,
        text: params.text,
        mode: mode as "fire-and-forget" | "wait" | "ping-pong",
        timeoutMs: params.timeout_ms,
        maxTurns: params.max_turns,
        callerSessionKey,
        ...(callerAuthority ? { caller: callerAuthority } : {}),
        ...(callerConversation ? { callerConversation } : {}),
        ...(callerAgentId !== undefined ? { callerAgentId } : {}),
        ...(announceOperationId !== undefined ? { announceOperationId } : {}),
        announceChannelType: callerChannelType,
        announceChannelId: callerChannelId,
      });
      return result;
    },

    [SessionSpawnContract.method]: async (rawParams) => {
      // The capability gate lives HERE because the agent
      // loop reaches handlers without passing checkScope (the in-process
      // bypass). Read the injected _capabilities from raw params BEFORE the
      // strip; throws CapabilityDeniedError when orch:spawn is not held.
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:spawn");

      // Bespoke pre-Zod: agent-to-agent policy check.
      if (!deps.securityConfig.agentToAgent?.enabled) {
        throw new Error("Agent-to-agent messaging is disabled by policy.");
      }

      // Internal-field reads BEFORE strip (caller-routing + audit trail).
      const hasInjectedCallerIdentity = rawParams._callerSessionKey !== undefined
        || rawParams._callerChannelType !== undefined
        || rawParams._callerChannelId !== undefined
        || rawParams._agentId !== undefined;
      const callerSessionKey = typeof rawParams._callerSessionKey === "string"
        ? rawParams._callerSessionKey
        : undefined;
      const callerChannelType = typeof rawParams._callerChannelType === "string"
        ? rawParams._callerChannelType
        : undefined;
      const callerChannelId = typeof rawParams._callerChannelId === "string"
        ? rawParams._callerChannelId
        : undefined;
      const callerAgentIdInternal = typeof rawParams._agentId === "string"
        ? rawParams._agentId
        : undefined;
      const ambientCallerContext = tryGetContext();

      const rejectCallerContextMismatch = (
        field: CallerContextMismatchField,
      ): never => {
        deps.logger?.audit?.({
          kind: "capability_denied",
          outcome: "denied",
          actionType: "session.spawn",
          mismatchField: field,
        }, "session.spawn caller principal denied");
        deps.logger?.warn({
          method: "session.spawn",
          mismatchField: field,
          hint: "Reject the spawn and verify the in-process RPC injector preserves the active request principal",
          errorKind: "auth" as const,
        }, "session.spawn caller context mismatch");
        throw new Error(`session.spawn caller ${field} does not match the request context`);
      };

      // The model-facing injector supplies one complete principal. Any one of
      // its identity fields switches this call onto that path, where ALS is an
      // independent authority and every field must agree. A call with none of
      // these fields is the authenticated RPC control plane and intentionally
      // does not inherit an ambient agent or delivery route.
      let callerContext = undefined as typeof ambientCallerContext;
      if (hasInjectedCallerIdentity) {
        const resolvedContext = ambientCallerContext
          ?? rejectCallerContextMismatch("request context");
        const resolvedCallerSessionKey = callerSessionKey
          ?? rejectCallerContextMismatch("resolved principal");
        const resolvedCallerAgentId = callerAgentIdInternal
          ?? rejectCallerContextMismatch("resolved principal");
        const resolvedCallerChannelType = callerChannelType
          ?? rejectCallerContextMismatch("resolved principal");
        const resolvedCallerChannelId = callerChannelId
          ?? rejectCallerContextMismatch("resolved principal");
        const resolvedUserId = resolvedContext.userId
          ?? rejectCallerContextMismatch("resolved principal");
        const resolvedSessionKey = resolvedContext.sessionKey
          ?? rejectCallerContextMismatch("resolved principal");
        const resolvedAgentId = resolvedContext.agentId
          ?? rejectCallerContextMismatch("resolved principal");
        if (resolvedSessionKey !== resolvedCallerSessionKey) {
          rejectCallerContextMismatch("session");
        }
        if (resolvedAgentId !== resolvedCallerAgentId) {
          rejectCallerContextMismatch("agent");
        }
        const contextOrigin = resolvedContext.deliveryOrigin
          ?? rejectCallerContextMismatch("resolved principal");

        const resolvedTurnScope = resolvedContext.turnScope
          ?? rejectCallerContextMismatch("session identity");
        if (
          resolvedTurnScope.conversation.tenantId !== resolvedContext.tenantId
          || resolvedTurnScope.conversation.agentId !== resolvedAgentId
        ) {
          rejectCallerContextMismatch("session identity");
        }
        if (contextOrigin.tenantId !== resolvedContext.tenantId) {
          rejectCallerContextMismatch("delivery origin tenant");
        }
        if (contextOrigin.userId !== resolvedUserId) {
          rejectCallerContextMismatch("delivery origin user");
        }
        if (
          contextOrigin.channelType !== resolvedCallerChannelType
          || (
            resolvedContext.channelType !== undefined
            && resolvedContext.channelType !== resolvedCallerChannelType
          )
        ) {
          rejectCallerContextMismatch("delivery origin channel type");
        }
        if (contextOrigin.channelId !== resolvedCallerChannelId) {
          rejectCallerContextMismatch("delivery origin channel id");
        }
        callerContext = resolvedContext;
      }

      const userParams = stripInternalFields(rawParams);
      const params = SessionSpawnContract.request.parse(userParams);

      const task = params.task;
      const spawnAgentId = params.agent ?? deps.defaultAgentId;
      const maxSteps = params.max_steps;

      // session.spawn is async-only and returns the running response immediately.
      deps.logger?.info({
        method: "session.spawn",
        agentId: spawnAgentId,
        async: true,
        taskLength: task.length,
      }, "session.spawn request received");

      const expectedOutputs = params.expected_outputs;

      // Model-facing route fields are hints only. They must match the immutable
      // requester route exactly and never select a different destination.
      const explicitAnnounceType = params.announce_channel_type;
      const explicitAnnounceId = params.announce_channel_id;

      // Agent-origin calls use only the immutable route resolved on ALS. The
      // authenticated control-plane path has no requester principal and may
      // explicitly select an announcement route.
      const contextOrigin = callerContext?.deliveryOrigin;
      const requesterOrigin: DeliveryOrigin | undefined = contextOrigin;
      const hasExplicitAnnouncementRoute = explicitAnnounceType !== undefined
        || explicitAnnounceId !== undefined;
      if (
        hasExplicitAnnouncementRoute
        && (
          explicitAnnounceType === undefined
          || explicitAnnounceId === undefined
          || (
            requesterOrigin !== undefined
            && (
              explicitAnnounceType !== requesterOrigin.channelType
              || explicitAnnounceId !== requesterOrigin.channelId
            )
          )
        )
      ) {
        rejectCallerContextMismatch("announcement route");
      }
      const announceChannelType = requesterOrigin?.channelType ?? explicitAnnounceType;
      const announceChannelId = requesterOrigin?.channelId ?? explicitAnnounceId;

      // Read caller's spawn depth from session metadata for depth propagation
      let callerSession: import("@comis/core").SessionData | undefined;
      if (callerContext?.turnScope) {
        const callerRef = createConversationRef(callerContext.turnScope.conversation);
        if (callerRef.ok) {
          const loaded = deps.sessionStore.loadByRef(
            {
              tenantId: callerContext.turnScope.conversation.tenantId,
              agentId: callerContext.turnScope.conversation.agentId,
            },
            callerRef.value,
          );
          if (loaded.ok) callerSession = loaded.value;
        }
      }
      const callerDepth = typeof callerSession?.metadata?.spawnDepth === "number"
        ? callerSession.metadata.spawnDepth as number
        : 0;
      const maxSpawnDepth = typeof callerSession?.metadata?.maxSpawnDepth === "number"
        ? callerSession.metadata.maxSpawnDepth as number
        : undefined;

      // Read spawn packet fields from RPC params
      const artifactRefs = params.artifact_refs;
      const objective = params.objective;
      const domainKnowledge = params.domain_knowledge;
      const toolGroups = params.tool_groups;
      const requiredTools = params.required_tools;
      const includeParentHistory = (params.include_parent_history === "summary" ? "summary" : "none") as "none" | "summary";

      // Compute the effective reachable tool set for the spawn gate.
      // Apply the config default tool_groups when the caller omitted tool_groups (the common case),
      // then expand both TOOL_PROFILES and TOOL_GROUPS — same logic as setup-tools.ts:588-607.
      // This gives the spawn gate a single source of truth (no duplication of runtime logic).
      const configToolGroups = deps.securityConfig.agentToAgent?.subAgentToolGroups ?? ["coding"];
      const effectiveToolGroups = (toolGroups && toolGroups.length > 0) ? toolGroups : configToolGroups;
      // computeReachableToolNames returns null for "full" (unconstrained — gate skips ceiling check)
      const reachableToolNamesSet = computeReachableToolNames(effectiveToolGroups);
      // null ("full") → pass ReadonlySet<never> sentinel so gate still checks denylist;
      // non-null → pass the computed set for membership checks.
      const reachableToolNames: ReadonlySet<string> | undefined =
        reachableToolNamesSet !== null ? reachableToolNamesSet : undefined;

      const parentRun = callerSessionKey
        ? deps.subAgentRunner.getRunBySessionKey?.(callerSessionKey)
        : undefined;
      if (parentRun !== undefined) {
        requireCapability(parentRun.caps, "orch:spawn");
      }
      const projectedCallerKey = callerContext?.turnScope
        ? conversationScopeToSessionKey(callerContext.turnScope.conversation)
        : undefined;
      if (projectedCallerKey !== undefined && !projectedCallerKey.ok) {
        throw projectedCallerKey.error;
      }
      const callerConversationRef = callerContext?.turnScope
        ? createConversationRef(callerContext.turnScope.conversation)
        : undefined;
      if (callerConversationRef !== undefined && !callerConversationRef.ok) {
        throw callerConversationRef.error;
      }
      const inheritedAuthority = resolveSessionSpawnAuthority({
        rawParams,
        ...(parentRun !== undefined ? { parentRun } : {}),
        ...(projectedCallerKey?.ok ? { callerSession: projectedCallerKey.value } : {}),
        ...(callerAgentIdInternal !== undefined ? { callerAgentId: callerAgentIdInternal } : {}),
        ...(deps.resolveRootRunId !== undefined ? { resolveRootRunId: deps.resolveRootRunId } : {}),
      });

      // Async (only path): non-blocking spawn.
      const runId = deps.subAgentRunner.spawn({
        task,
        agentId: spawnAgentId,
        callerType: hasInjectedCallerIdentity ? "agent" : "control-plane",
        callerSessionKey,
        callerAgentId: callerAgentIdInternal,
        ...(callerContext?.turnScope !== undefined && callerConversationRef?.ok === true
          ? {
              callerConversation: {
                conversationScope: callerContext.turnScope.conversation,
                conversationRef: callerConversationRef.value,
              },
            }
          : {}),
        ...inheritedAuthority,
        announceChannelType,
        announceChannelId,
        model: params.model,
        requesterOrigin,
        max_steps: maxSteps,
        expected_outputs: expectedOutputs,
        depth: callerDepth,
        maxDepth: maxSpawnDepth,
        artifactRefs,
        objective,
        domainKnowledge,
        toolGroups,
        requiredTools,
        includeParentHistory,
        reachableToolNames,
        // Ride the parent's resolved reply language into child session
        // metadata (same channel as objective/toolGroups); read off the live ALS.
        resolvedLanguage: callerContext?.resolvedLanguage,
        // Thread the `worktree?` request from the RPC param so the runner
        // persists it onto the child session metadata; executeSubAgent then runs
        // the child in an isolated git worktree (auto-clean-if-unchanged). Omit
        // when absent so the no-worktree spawn stays byte-identical.
        ...(params.worktree !== undefined ? { worktree: params.worktree } : {}),
      });
      // Capture dedup signal from this spawn so the response carries
      // structured `deduped`/`existingRunId`/`dedupAgeMs` if the runner
      // short-circuited against an in-flight run.
      const asyncDedupInfo = deps.subAgentRunner.lastSpawnDedupInfo?.();
      // Check if spawn was queued rather than immediately started.
      const spawnStatus = deps.subAgentRunner.getRunStatus(runId);
      const baseAsyncResponse: Record<string, unknown> = {
        runId,
        async: true,
        inProgress: true,
        noteType: "background_running",
      };
      if (asyncDedupInfo?.deduped) {
        baseAsyncResponse.deduped = true;
        baseAsyncResponse.existingRunId = asyncDedupInfo.existingRunId;
        baseAsyncResponse.dedupAgeMs = asyncDedupInfo.ageMs;
      }
      if (spawnStatus?.status === "queued") {
        return { ...baseAsyncResponse, queued: true };
      }
      return baseAsyncResponse;
    },

    [SessionCompactContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = SessionCompactContract.request.parse(userParams);
      const conversationRef = ConversationRefSchema.safeParse(params.conversation_ref);
      if (!conversationRef.success) throw new Error("Invalid conversation reference");
      const authority = { tenantId: params.tenant_id, agentId: params.agent_id };
      const callerAgentId = rawParams._agentId as string | undefined;
      if (callerAgentId !== undefined && callerAgentId !== authority.agentId) {
        throw new Error("Session compaction agent does not match the authenticated caller");
      }

      const instructions = params.instructions;

      // Read from EITHER store — a live channel
      // chat is file-JSONL-only (the SQLite sessions table is empty for it), so a
      // SQLite-only read threw "Session not found" for the active session.
      const data = loadAuthorizedSession(deps, authority, conversationRef.data);
      if (!data) throw new Error(`Conversation not found: ${params.conversation_ref}`);

      const messageCount = data.messages.length;
      const estimatedTokens = Math.round(
        data.messages.reduce<number>(
          (sum, m) => sum + JSON.stringify(m).length / 4,
          0,
        ),
      );

      const result = {
        conversationRef: conversationRef.data,
        messageCount,
        estimatedTokens,
        compactionTriggered: true as const,
        instructions: instructions ?? null,
      };
      if (IS_DEV) SessionCompactContract.response.parse(result);
      return result;
    },
  };
}
