// SPDX-License-Identifier: Apache-2.0
/**
 * Execution Pipeline Phase 1: Send Policy and Trust Routing.
 *
 * Evaluates the send policy gate, resolves sender trust level,
 * and applies elevated reply model/prompt routing.
 *
 * @module
 */

import type { ChannelPort, NormalizedMessage, SessionKey } from "@comis/core";
import { formatSessionKey } from "@comis/core";

import type { ExecutionPipelineDeps } from "./execution-pipeline.js";
import { isGroupMessage } from "./auto-reply-engine.js";
import { evaluateSendPolicy, applySessionOverride } from "./send-policy.js";
import type { SendOverrideStore, SendPolicyContext } from "./send-policy.js";
import { REPLY_TO_META_KEY } from "./execution-pipeline.js";

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/** Minimal deps needed for the policy phase. */
export type PolicyDeps = Pick<
  ExecutionPipelineDeps,
  "eventBus" | "logger" | "sendPolicyConfig" | "getElevatedReplyConfig" | "channelRegistry"
>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Result of policy evaluation. */
export interface PolicyResult {
  /** Whether the message should proceed to execution+delivery. */
  allowed: boolean;
  /** Resolved sender trust level. */
  trustLevel: "guest" | "user" | "admin";
  /** Message with elevated reply metadata injected (model route, prompt override). */
  effectiveMsg: NormalizedMessage;
  /** Metadata key for reply-to. */
  replyToMetaKey: string | undefined;
  /** Message ID for reply-to (group only). */
  replyTo: string | undefined;
}

// ---------------------------------------------------------------------------
// Phase function
// ---------------------------------------------------------------------------

/**
 * Evaluate send policy, resolve trust level, and apply elevated reply routing.
 *
 * When `allowed` is false, the caller should still run execution (for session
 * history) but skip delivery. The caller is responsible for running the
 * silent execution in that case.
 */
export function evaluateExecutionPolicy(
  deps: PolicyDeps,
  adapter: ChannelPort,
  effectiveMsg: NormalizedMessage,
  originalMsg: NormalizedMessage,
  sessionKey: SessionKey,
  agentId: string,
  sendOverrides: SendOverrideStore,
): PolicyResult {
  // Capability-driven config lookup (falls back to hardcoded maps)
  const caps = deps.channelRegistry?.getCapabilities(adapter.channelType);
  const metaKey = caps?.replyToMetaKey ?? REPLY_TO_META_KEY[adapter.channelType];
  // In DMs, skip reply-to -- quoting the user's own message adds noise in 1-on-1 chats.
  const replyTo =
    isGroupMessage(originalMsg) && metaKey && originalMsg.metadata?.[metaKey]
      ? String(originalMsg.metadata[metaKey])
      : undefined;

  // Resolve sender trust level from elevatedReply config (defaults to "user")
  let resolvedTrustLevel: "guest" | "user" | "admin" = "user";
  if (deps.getElevatedReplyConfig) {
    const elevCfg = deps.getElevatedReplyConfig(agentId);
    if (elevCfg?.enabled) {
      const senderId = effectiveMsg.senderId;
      const mapped = elevCfg.senderTrustMap[senderId] ?? elevCfg.defaultTrustLevel;
      if (mapped === "admin" || mapped === "user" || mapped === "guest") {
        resolvedTrustLevel = mapped;
      }
    }
  }

  // -------------------------------------------------------------------
  // SEND POLICY GATE (checked once before any delivery path)
  // -------------------------------------------------------------------
  if (deps.sendPolicyConfig?.enabled) {
    const policyCtx: SendPolicyContext = {
      channelId: adapter.channelId,
      channelType: adapter.channelType,
      chatType: originalMsg.chatType ?? "dm",
    };
    let policyDecision = evaluateSendPolicy(policyCtx, deps.sendPolicyConfig);

    // Apply per-session override
    const overrideKey = formatSessionKey(sessionKey);
    const override = sendOverrides.get(overrideKey);
    policyDecision = applySessionOverride(policyDecision, override);

    if (!policyDecision.allowed) {
      deps.eventBus.emit("sendpolicy:denied", {
        channelId: adapter.channelId,
        channelType: adapter.channelType,
        chatType: policyCtx.chatType,
        reason: policyDecision.reason,
        timestamp: Date.now(),
      });
      deps.logger.info(
        { channelId: adapter.channelId, reason: policyDecision.reason },
        "Send policy denied outbound message",
      );
      return {
        allowed: false,
        trustLevel: resolvedTrustLevel,
        effectiveMsg,
        replyToMetaKey: metaKey,
        replyTo,
      };
    }

    deps.eventBus.emit("sendpolicy:allowed", {
      channelId: adapter.channelId,
      channelType: adapter.channelType,
      chatType: policyCtx.chatType,
      reason: policyDecision.reason,
      timestamp: Date.now(),
    });
  }

  // -------------------------------------------------------------------
  // ELEVATED REPLY MODE
  // -------------------------------------------------------------------
  let msg = effectiveMsg;
  if (deps.getElevatedReplyConfig) {
    const elevConfig = deps.getElevatedReplyConfig(agentId);
    if (elevConfig?.enabled) {
      const senderId = msg.senderId;
      const trustLevel = elevConfig.senderTrustMap[senderId] ?? elevConfig.defaultTrustLevel;
      const modelRoute = elevConfig.trustModelRoutes[trustLevel];
      if (modelRoute) {
        deps.eventBus.emit("elevated:model_routed", {
          sessionKey: formatSessionKey(sessionKey),
          senderTrustLevel: trustLevel,
          modelRoute,
          agentId,
          timestamp: Date.now(),
        });
        msg = {
          ...msg,
          metadata: {
            ...(msg.metadata ?? {}),
            modelRoute,
          },
        };
      }
      const promptOverride = elevConfig.trustPromptOverrides[trustLevel];
      if (promptOverride) {
        msg = {
          ...msg,
          metadata: {
            ...(msg.metadata ?? {}),
            systemPromptOverride: promptOverride,
          },
        };
      }
    }
  }

  return {
    allowed: true,
    trustLevel: resolvedTrustLevel,
    effectiveMsg: msg,
    replyToMetaKey: metaKey,
    replyTo,
  };
}
