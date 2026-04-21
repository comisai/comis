// SPDX-License-Identifier: Apache-2.0
/**
 * Inbound Pipeline Phase 1: Agent Resolution.
 *
 * Resolves which agent handles the message, maps identity,
 * constructs the scoped session key, and loads or creates the session.
 *
 * @module
 */

import type { NormalizedMessage, SessionKey, ChannelPort } from "@comis/core";
import { buildScopedSessionKey, extractThreadId } from "@comis/agent";
import type { DmScopeMode } from "@comis/agent";
import type { AgentExecutor } from "@comis/agent";

import type { InboundPipelineDeps } from "./inbound-pipeline.js";

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/** Minimal deps needed for agent resolution phase. */
export type ResolveDeps = Pick<
  InboundPipelineDeps,
  "logger" | "eventBus" | "messageRouter" | "sessionManager" | "createExecutor" | "identityResolver" | "getDmScopeConfig"
>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Resolved agent context from Phase 1. */
export interface ResolvedAgent {
  agentId: string;
  executor: AgentExecutor;
  sessionKey: SessionKey;
  /** Message with canonical identity applied (senderId may differ from original). */
  effectiveMsg: NormalizedMessage;
}

// ---------------------------------------------------------------------------
// Phase function
// ---------------------------------------------------------------------------

/**
 * Resolve the agent, identity, and session key for an inbound message.
 *
 * Returns undefined if no executor is configured for the resolved agent
 * (early exit — message should be dropped).
 */
export function resolveInboundAgent(
  deps: ResolveDeps,
  adapter: ChannelPort,
  msg: NormalizedMessage,
): ResolvedAgent | undefined {
  // 1. Resolve agent FIRST (only needs RoutableMessage, not SessionKey)
  const agentId = deps.messageRouter.resolve({
    channelType: msg.channelType,
    channelId: msg.channelId,
    senderId: msg.senderId,
    guildId: msg.metadata?.guildId as string | undefined,
  });

  // 2. Get executor (early exit if none)
  const executor = deps.createExecutor(agentId);
  if (!executor) {
    deps.logger.warn({ agentId, channelId: msg.channelId, hint: "Ensure agent executor is registered before processing messages", errorKind: "config" as const }, "No executor configured for agent");
    return undefined;
  }

  // 3. Resolve canonical identity (if identityResolver provided)
  const canonicalId = deps.identityResolver?.resolve(msg.channelType, msg.senderId);
  const effectiveMsg = canonicalId ? { ...msg, senderId: canonicalId } : msg;

  // 4. Extract thread ID from platform metadata
  const threadId = extractThreadId(msg);

  // 5. Get DM scope config for this agent
  const dmScopeConfig = deps.getDmScopeConfig?.(agentId);

  // 6. Build scoped session key
  const sessionKey = buildScopedSessionKey({
    msg: effectiveMsg,
    agentId,
    adapterChannelId: adapter.channelId,
    dmScopeMode: (dmScopeConfig?.mode as DmScopeMode) ?? undefined,
    agentPrefixEnabled: dmScopeConfig?.agentPrefix,
    threadId: dmScopeConfig?.threadIsolation ? threadId : undefined,
  });

  // 7. Emit message:received with the scoped session key
  deps.eventBus.emit("message:received", { message: msg, sessionKey });

  // Load or create session
  deps.sessionManager.loadOrCreate(sessionKey);

  return { agentId, executor, sessionKey, effectiveMsg };
}
