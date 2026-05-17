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
  systemNowMs,
  systemSetTimeout,
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
      const isAsync = params.async === true;
      const maxSteps = params.max_steps;

      deps.logger?.info({
        method: "session.spawn",
        agentId: spawnAgentId,
        async: isAsync,
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
      const includeParentHistory = (params.include_parent_history === "summary" ? "summary" : "none") as "none" | "summary";

      if (isAsync) {
        // Non-blocking spawn
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
          includeParentHistory,
        });
        // Check if spawn was queued rather than immediately started
        const spawnStatus = deps.subAgentRunner.getRunStatus(runId);
        if (spawnStatus?.status === "queued") {
          return { runId, async: true, queued: true };
        }
        return { runId, async: true };
      }

      // Synchronous (backward compatible) -- delegate to sub-agent runner but await result
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
        includeParentHistory,
      });

      // For sync mode, poll until complete (up to waitTimeoutMs)
      const timeout = deps.securityConfig.agentToAgent!.waitTimeoutMs;
      const deadline = systemNowMs() + timeout;
      let run = deps.subAgentRunner.getRunStatus(runId);
      while ((run?.status === "running" || run?.status === "queued") && systemNowMs() < deadline) {
        await new Promise(r => systemSetTimeout(() => r(undefined), 100));
        run = deps.subAgentRunner.getRunStatus(runId);
      }

      if (!run || run.status === "running" || run.status === "queued") {
        return { runId, async: true, note: "Spawn timed out, check run_status later" };
      }

      if (run.status === "failed") {
        throw new Error(`Sub-agent failed: ${run.error}`);
      }

      return {
        sessionKey: run.sessionKey,
        response: run.result?.response,
        tokensUsed: run.result?.tokensUsed,
        finishReason: run.result?.finishReason,
        announced: true, // announce handled by runner
        taskDescription: task,
      };
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
