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
  computeReachableToolNames,
  tryGetContext,
} from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type SessionHandlerDeps } from "./session-helpers.js";

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

      const userParams = stripInternalFields(rawParams);
      const params = SessionSendContract.request.parse(userParams);

      const mode = params.mode ?? "fire-and-forget";
      const result = await deps.crossSessionSender.send({
        targetSessionKey: params.session_key,
        text: params.text,
        mode: mode as "fire-and-forget" | "wait" | "ping-pong",
        timeoutMs: params.timeout_ms,
        maxTurns: params.max_turns,
        callerSessionKey,
        announceChannelType: callerChannelType,
        announceChannelId: callerChannelId,
        agentId: params.agent_id,
      });
      return result;
    },

    [SessionSpawnContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: agent-to-agent policy check FIRST.
      if (!deps.securityConfig.agentToAgent?.enabled) {
        throw new Error("Agent-to-agent messaging is disabled by policy.");
      }

      // Internal-field reads BEFORE strip (caller-routing + audit trail).
      const callerSessionKey = rawParams._callerSessionKey as string | undefined;
      const callerChannelType = rawParams._callerChannelType as string | undefined;
      const callerChannelId = rawParams._callerChannelId as string | undefined;
      const callerAgentIdInternal = rawParams._agentId as string | undefined;

      const userParams = stripInternalFields(rawParams);
      const params = SessionSpawnContract.request.parse(userParams);

      const task = params.task;
      const spawnAgentId = params.agent ?? deps.defaultAgentId;
      const maxSteps = params.max_steps;

      // session.spawn is async-only. The poll-until-complete branch was
      // deleted (CHANGELOG: callers passing `async: false` are now
      // treated as async; such callers must update to expect the
      // async-running response shape immediately). Pre-deletion grep
      // gates verified 0 callers in packages/*/src/ or
      // packages/skills/src/ pass `async: false`.
      deps.logger?.info({
        method: "session.spawn",
        agentId: spawnAgentId,
        async: true,
        taskLength: task.length,
      }, "session.spawn request received");

      const expectedOutputs = params.expected_outputs;

      // DeliveryOrigin provides defaults for announce routing
      // LLM-supplied explicit params take precedence over DeliveryOrigin defaults
      const explicitAnnounceType = params.announce_channel_type;
      const explicitAnnounceId = params.announce_channel_id;

      // Build requesterOrigin from caller context (already validated DeliveryOrigin, serialized through RPC)
      const requesterOrigin: DeliveryOrigin | undefined = callerChannelType && callerChannelId
        ? { channelType: callerChannelType, channelId: callerChannelId, userId: "system", tenantId: "default" } as DeliveryOrigin
        : undefined;

      // Read caller's spawn depth from session metadata for depth propagation
      const callerSession = callerSessionKey
        ? deps.sessionStore.loadByFormattedKey(callerSessionKey)
        : undefined;
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

      // Async (only path): non-blocking spawn.
      const runId = deps.subAgentRunner.spawn({
        task,
        agentId: spawnAgentId,
        callerSessionKey,
        callerAgentId: callerAgentIdInternal,
        announceChannelType: explicitAnnounceType ?? callerChannelType,
        announceChannelId: explicitAnnounceId ?? callerChannelId,
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
        // GEN-03: ride the parent's resolved reply language into child session
        // metadata (same channel as objective/toolGroups); read off the live ALS.
        resolvedLanguage: tryGetContext()?.resolvedLanguage,
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
      // Bespoke pre-Zod: missing-key + not-found guards FIRST.
      const sessionKey = rawParams.session_key as string;
      if (!sessionKey) throw new Error("Missing required parameter: session_key");

      const userParams = stripInternalFields(rawParams);
      const params = SessionCompactContract.request.parse(userParams);

      const instructions = params.instructions;

      const data = deps.sessionStore.loadByFormattedKey(sessionKey);
      if (!data) throw new Error(`Session not found: ${sessionKey}`);

      const messageCount = data.messages.length;
      const estimatedTokens = Math.round(
        data.messages.reduce<number>(
          (sum, m) => sum + JSON.stringify(m).length / 4,
          0,
        ),
      );

      const result = {
        sessionKey,
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
