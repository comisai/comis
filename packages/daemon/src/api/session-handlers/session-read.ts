// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Session read RPC handlers.
 *
 * Handlers covering single-session reads + agent/run inspection:
 *   - session.status: current session counters + agent config
 *   - agents.list: enumerate configured agents
 *   - session.history: messages, tokens, tool calls for a session
 *   - session.run_status: poll an async spawn run by runId
 *
 * @module
 */

import {
  parseFormattedSessionKey,
  AgentsListContract,
  SessionStatusContract,
  SessionHistoryContract,
  SessionRunStatusContract,
  stripInternalFields,
  systemNowMs,
} from "@comis/core";
import type { DeliveryQueueEntry, DeliveryQueuePort } from "@comis/core";
import type { RpcHandler } from "../types.js";
import {
  IS_DEV,
  type SessionHandlerDeps,
  scanWorkspaceSessions,
  loadJsonlSession,
  collectAvailableSessionKeys,
} from "./session-helpers.js";

/**
 * Bind the session read handlers. Object-spread compatible with
 * `Record<string, RpcHandler>`.
 */
export function bindSessionReadHandlers(deps: SessionHandlerDeps): Record<string, RpcHandler> {
  return {
    [SessionStatusContract.method]: async (rawParams) => {
      // Resolve which agent this session belongs to. _agentId is dispatcher-
      // injected (read BEFORE strip).
      const statusAgentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;

      const userParams = stripInternalFields(rawParams);
      SessionStatusContract.request.parse(userParams);

      const statusAgentConfig = deps.agents[statusAgentId] ?? deps.agents[deps.defaultAgentId];
      const agentCostTracker = deps.costTrackers.get(statusAgentId) ?? deps.costTrackers.get(deps.defaultAgentId)!;
      const agentStepCounter = deps.stepCounters.get(statusAgentId) ?? deps.stepCounters.get(deps.defaultAgentId)!;
      const allCosts = agentCostTracker.getAll();
      const totalTokens = allCosts.reduce((sum: number, r: { tokens: { total: number } }) => sum + r.tokens.total, 0);
      const totalCost = allCosts.reduce((sum: number, r: { cost: { total: number } }) => sum + r.cost.total, 0);
      const result = {
        model: statusAgentConfig?.model ?? "unknown",
        agentName: statusAgentConfig?.name ?? "unknown",
        tokensUsed: { totalTokens, totalCost },
        stepsExecuted: agentStepCounter.getCount(),
        maxSteps: statusAgentConfig?.maxSteps ?? 25,
      };
      if (IS_DEV) SessionStatusContract.response.parse(result);
      return result;
    },

    [AgentsListContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      AgentsListContract.request.parse(userParams);
      const result = { agents: Object.keys(deps.agents) };
      if (IS_DEV) AgentsListContract.response.parse(result);
      return result;
    },

    [SessionHistoryContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: missing session_key triggers the standard Zod error.
      // The session-not-found error message preserves the user-friendly hint
      // including the list of available keys — that path runs AFTER the
      // parse since session_key must be present to do the lookup.
      // Internal-field read BEFORE strip (caller-scoping). The
      // tool.invoke rpc route injects `_agentId = lease.agentId`; its PRESENCE
      // is the unforgeable agent-origin signal (inbound _agentId is stripped
      // from external callers at the gateway). Admin/operator/CLI calls arrive
      // with NO _agentId and keep full access.
      const callerAgentId = rawParams._agentId as string | undefined;

      const userParams = stripInternalFields(rawParams);
      const params = SessionHistoryContract.request.parse(userParams);

      const sessionKey = params.session_key;
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20;

      // Agent self-scope: an agent-origin caller may read ONLY its own
      // session. Mirror session.search's `_agentId` filter exactly
      // (session-list.ts:163-168) — the session belongs to the caller iff
      // `parseFormattedSessionKey(sessionKey)?.agentId === callerAgentId`.
      // Fail CLOSED with a content-free "not found" (do not confirm the
      // session exists for another agent) so a jailed orch:read script can
      // never exfiltrate another agent's/user's transcript. Because this gate
      // lives in the handler it closes the orchestrate path AND any other
      // agent-origin path. When `callerAgentId` is undefined (admin / operator
      // / CLI) the read is unrestricted, as before.
      if (callerAgentId) {
        const owner = parseFormattedSessionKey(sessionKey)?.agentId;
        if (owner !== callerAgentId) {
          throw new Error(`Session not found: ${sessionKey}`);
        }
      }

      // Snapshot the DeliveryQueuePort once per request and build the join
      // keyset BEFORE the message loop. The key is (channelId, text) -- the
      // queue exposes channelType + channelId + tenantId + text; we only need
      // channelId + text because two queue entries from different channel
      // adapters with the same channelId would be a deployment conflict the
      // operator must avoid. The sessionKey itself carries channelId at
      // parts[2] (after tenant + userId); we extract it once below.
      const pendingKeySet = await loadPendingKeySet(deps.deliveryQueue);

      let data = deps.sessionStore.loadByFormattedKey(sessionKey);

      // Fallback: check if this is a workspace JSONL session (metadata stores the path)
      if (!data && deps.defaultWorkspaceDir) {
        const wsSessions = scanWorkspaceSessions(deps.defaultWorkspaceDir);
        const match = wsSessions.find(ws => ws.sessionKey === sessionKey);
        if (match && match.metadata._workspaceJsonlPath) {
          data = loadJsonlSession(match.metadata._workspaceJsonlPath as string);
        }
      }

      if (!data) {
        const available = collectAvailableSessionKeys(deps);
        const hint = available.length > 0
          ? `. Available session keys: ${available.join(", ")}`
          : ". Use action 'list' to discover available session keys";
        throw new Error(`Session not found: ${sessionKey}${hint}`);
      }

      // Parse session key for metadata
      const parsed = parseFormattedSessionKey(sessionKey);
      const agentId = parsed?.agentId ?? "default";
      const isSubAgent = data.metadata.parentSessionKey !== undefined;
      const channelType = isSubAgent
        ? "sub-agent"
        : parsed?.guildId
          ? "group"
          : "dm";
      // ChannelId for the deliveryStatus join. The DeliveryQueueEntry carries
      // channelType + channelId + text; we match on (channelId, text) below
      // because two queue entries for distinct channel adapters with the same
      // channelId is a deployment conflict operators avoid by construction.
      const sessionChannelId = parsed?.channelId ?? "";

      // Pre-scan: resolve gateway attachment tool calls so we can inject
      // <!-- attachment:... --> markers into displayable assistant messages.
      // Attachment tool calls appear as toolCall/tool_use blocks with name "message"
      // and arguments.action "attach"; their results contain the media ID.
      const attachMeta = new Map<string, { type: string; mimeType: string; fileName: string; caption: string }>();
      const attachMedia = new Map<string, string>(); // toolCallId → /media/... URL
      for (const msg of data.messages) {
        const m = msg as Record<string, unknown>;
        const role = m.role as string | undefined;
        if (role === "assistant" && Array.isArray(m.content)) {
          for (const block of m.content as Array<Record<string, unknown>>) {
            const bt = block.type as string;
            if ((bt === "toolCall" || bt === "tool_use") && block.name === "message") {
              const args = (block.arguments ?? block.input) as Record<string, unknown> | undefined;
              if (args?.action === "attach") {
                attachMeta.set(block.id as string, {
                  type: (args.attachment_type as string) ?? "file",
                  mimeType: (args.mime_type as string) ?? "application/octet-stream",
                  fileName: (args.file_name as string) ?? "attachment",
                  caption: (args.caption as string) ?? "",
                });
              }
            }
          }
        }
        if ((role === "toolResult" || role === "tool") && attachMeta.has(m.tool_use_id as string)) {
          let resultText = "";
          if (typeof m.content === "string") {
            resultText = m.content;
          } else if (Array.isArray(m.content)) {
            for (const part of m.content as Array<Record<string, unknown>>) {
              if (part.type === "text" && typeof part.text === "string") resultText += part.text;
            }
          }
          try {
            const parsedResult = JSON.parse(resultText) as Record<string, unknown>;
            if (typeof parsedResult.messageId === "string") {
              attachMedia.set(m.tool_use_id as string, `/media/${parsedResult.messageId}`);
            }
          } catch { /* skip unparseable tool results */ }
        }
      }

      // Extract displayable messages and compute stats from raw message data.
      // Token usage may live in the `usage` field on API response messages,
      // or is estimated from content length (chars / 4) when not available.
      // Tool calls appear as `tool_use` content blocks or as separate tool-role messages.
      const messages: Array<{
        role: string;
        content: string;
        timestamp: number;
        deliveryStatus: "confirmed" | "pending";
      }> = [];
      let toolCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let hasApiUsage = false;
      for (const msg of data.messages) {
        const m = msg as Record<string, unknown>;
        const role = m.role as string | undefined;

        // Accumulate token usage from API response metadata (if present)
        const usage = m.usage as Record<string, number> | undefined;
        if (usage) {
          hasApiUsage = true;
          inputTokens += usage.input_tokens ?? 0;
          outputTokens += usage.output_tokens ?? 0;
        }

        // Count tool_use blocks in content arrays and tool-role messages
        if (role === "tool") { toolCalls++; }
        if (Array.isArray(m.content)) {
          for (const block of m.content as Array<Record<string, unknown>>) {
            if (block.type === "tool_use") toolCalls++;
          }
        }

        // Only render user/assistant as displayable conversation messages
        if (role !== "user" && role !== "assistant") continue;
        let text = "";
        if (typeof m.content === "string") {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          for (const part of m.content as Array<Record<string, unknown>>) {
            if (part.type === "text" && typeof part.text === "string") {
              text += part.text;
            }
          }
          // Inject resolved attachment markers for gateway media tool calls
          if (role === "assistant") {
            for (const block of m.content as Array<Record<string, unknown>>) {
              const bt = block.type as string;
              if ((bt === "toolCall" || bt === "tool_use") && block.name === "message") {
                const toolId = block.id as string;
                const url = attachMedia.get(toolId);
                if (url) {
                  const att = attachMeta.get(toolId)!;
                  const json = JSON.stringify({ url, type: att.type, mimeType: att.mimeType, fileName: att.fileName });
                  const marker = att.caption
                    ? `${att.caption}\n\n<!-- attachment:${json} -->`
                    : `<!-- attachment:${json} -->`;
                  text += (text ? "\n\n" : "") + marker;
                }
              }
            }
          }
        }
        if (text) {
          // DeliveryStatus computation. Inbound user messages were received
          // from the channel -- always confirmed. Outbound assistant messages
          // are confirmed unless the delivery queue still has a
          // pending/in_flight/failed entry for this text on the session's
          // channelId (queue's `pendingEntries()` returns only NON-delivered,
          // NON-expired rows scheduled <= now).
          const deliveryStatus: "confirmed" | "pending" =
            role === "user"
              ? "confirmed"
              : pendingKeySet.has(makePendingKey(sessionChannelId, text))
                ? "pending"
                : "confirmed";
          messages.push({
            role,
            content: text,
            timestamp: (m.timestamp as number) ?? data.updatedAt,
            deliveryStatus,
          });
        }
      }

      // If no API usage data was found, estimate tokens from message content
      if (!hasApiUsage) {
        for (const msg of data.messages) {
          const m = msg as Record<string, unknown>;
          const role = m.role as string | undefined;
          const contentLen = typeof m.content === "string"
            ? m.content.length
            : Array.isArray(m.content)
              ? JSON.stringify(m.content).length
              : 0;
          const estimated = Math.round(contentLen / 4);
          if (role === "user") inputTokens += estimated;
          else if (role === "assistant") outputTokens += estimated;
        }
      }

      // Build session metadata from computed stats + stored metadata
      const meta = data.metadata as Record<string, unknown>;
      const totalTokens = inputTokens + outputTokens;
      const session = {
        key: sessionKey,
        agentId,
        channelType,
        messageCount: data.messages.length,
        totalTokens,
        inputTokens,
        outputTokens,
        toolCalls,
        compactions: Number(meta.compactions ?? 0),
        resetCount: Number(meta.resetCount ?? 0),
        createdAt: data.createdAt,
        lastActiveAt: data.updatedAt,
        label: (meta.label as string) ?? undefined,
      };

      // Apply pagination
      const paginated = messages.slice(offset, offset + limit);
      const result = {
        session,
        messages: paginated,
        total: messages.length,
        offset,
        limit,
        hasMore: offset + limit < messages.length,
      };
      if (IS_DEV) SessionHistoryContract.response.parse(result);
      return result;
    },

    [SessionRunStatusContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = SessionRunStatusContract.request.parse(userParams);

      const runId = params.run_id;
      const run = deps.subAgentRunner.getRunStatus(runId);
      if (!run) throw new Error(`Unknown run ID: ${runId}`);
      const result = {
        runId: run.runId,
        status: run.status,
        agentId: run.agentId,
        task: run.task,
        sessionKey: run.sessionKey,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        runtimeMs: run.completedAt ? run.completedAt - run.startedAt : systemNowMs() - run.startedAt,
        response: run.result?.response,
        tokensUsed: run.result?.tokensUsed,
        cost: run.result?.cost,
        error: run.error,
      };
      if (IS_DEV) SessionRunStatusContract.response.parse(result);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// DeliveryStatus join helpers
// ---------------------------------------------------------------------------

/** Stable join key: `${channelId}::${text}`. The double-colon separator is
 *  safe because channelId is provider-supplied (no colons in practice for
 *  Telegram/Discord/Slack chat IDs); even if it ever included one, the
 *  worst-case is a missed match (some outbound message reported as
 *  confirmed when it is actually pending) -- safer fail-mode than the
 *  reverse. */
function makePendingKey(channelId: string, text: string): string {
  return `${channelId}::${text}`;
}

/**
 * Snapshot the DeliveryQueuePort's NOT-yet-delivered entries (pending /
 * in_flight / failed / expired) once per request and return a Set keyed by
 * `(channelId, text)`.
 *
 * Uses `unconfirmedEntries()`, NOT `pendingEntries()`: the latter is
 * drainer-scoped (status='pending' AND scheduled_at<=now) and hides in_flight
 * rows for race safety, so an outbound message the drainer has already claimed
 * (pending -> in_flight) would fall out of the set and be mis-reported as
 * confirmed -- leaking an undelivered message via MCP resources/read. The
 * confirmed-only filter needs the full unconfirmed set.
 *
 * Returns an empty Set when:
 *   - The dep is absent (deployments with no channel adapters / no queue).
 *   - The port's `unconfirmedEntries()` returns an `err()` Result (we degrade
 *     to "every outbound confirmed" rather than failing the whole
 *     session.history call -- the join is a defense-in-depth signal, not
 *     a correctness requirement of session.history itself).
 *
 * Note: if no message-id link exists, an indirect match (channelId + text)
 * is used; this limitation is documented so a future version can revisit if
 * a stable message id is added.
 */
async function loadPendingKeySet(
  queue: DeliveryQueuePort | undefined,
): Promise<ReadonlySet<string>> {
  if (!queue) return new Set();
  const r = await queue.unconfirmedEntries();
  if (!r.ok) return new Set();
  const set = new Set<string>();
  for (const entry of r.value as readonly DeliveryQueueEntry[]) {
    set.add(makePendingKey(entry.channelId, entry.text));
  }
  return set;
}
