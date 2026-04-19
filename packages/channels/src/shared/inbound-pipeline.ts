/**
 * Inbound Pipeline: Thin orchestrator for message reception and routing.
 *
 * Delegates to 5 focused phase modules:
 *   1. inbound-resolve  — agent resolution, identity, session key
 *   2. inbound-preprocess — audio preflight, media preprocessing, compression
 *   3. inbound-gate     — auto-reply, slash commands, reset triggers, skills
 *   4. inbound-setup    — ack reaction, typing controller
 *   5. inbound-route    — debounce, group history, queue routing, execution
 *
 * @module
 */

import type { AgentExecutor } from "@comis/agent";
import type { MessageRouter } from "@comis/agent";
import type { SessionManager } from "@comis/agent";
import type { CommandQueue } from "@comis/agent";
import type { DebounceBuffer } from "@comis/agent";
import type { FollowupTrigger } from "@comis/agent";
import type { PriorityScheduler } from "@comis/agent";
import type { SessionLabelStore } from "@comis/agent";
import type { ActiveRunRegistry } from "@comis/agent";
import type { ChannelPort, DeliveryQueuePort, NormalizedMessage, SessionKey, TypedEventBus } from "@comis/core";
import type { StreamingConfig } from "@comis/core";
import type { AutoReplyEngineConfig, SendPolicyConfig, QueueConfig, ElevatedReplyConfig, AckReactionConfig } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";

import type { BlockPacer } from "./block-pacer.js";
import type { ChannelRegistry } from "./channel-registry.js";
import type { SendOverrideStore } from "./send-policy.js";
import type { PreflightResult } from "./audio-preflight.js";
import type { RetryEngine } from "./retry-engine.js";
import type { GroupHistoryBuffer } from "./group-history-buffer.js";
import type { VoiceResponsePipelineDeps } from "./voice-response-pipeline.js";
import { isRegexSafe } from "./regex-guard.js";

// Phase module imports
import { resolveInboundAgent } from "./inbound-resolve.js";
import { preprocessInboundMessage } from "./inbound-preprocess.js";
import { evaluateInboundGate } from "./inbound-gate.js";
import { setupInboundExecution } from "./inbound-setup.js";
import { routeInboundMessage } from "./inbound-route.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Narrow deps interface for the inbound pipeline. */
export interface InboundPipelineDeps {
  eventBus: TypedEventBus;
  logger: ComisLogger;
  messageRouter: MessageRouter;
  sessionManager: SessionManager;
  createExecutor: (agentId: string) => AgentExecutor | undefined;
  channelRegistry?: ChannelRegistry;
  preprocessMessage?: (msg: NormalizedMessage) => Promise<NormalizedMessage>;
  commandQueue?: CommandQueue;
  autoReplyEngineConfig?: AutoReplyEngineConfig;
  sendPolicyConfig?: SendPolicyConfig;
  getResetTriggers?: (agentId: string) => string[];
  identityResolver?: { resolve(provider: string, providerUserId: string): string | undefined };
  getDmScopeConfig?: (agentId: string) => { mode?: string; agentPrefix?: boolean; threadIsolation?: boolean } | undefined;
  debounceBuffer?: DebounceBuffer;
  groupHistoryBuffer?: GroupHistoryBuffer;
  followupTrigger?: FollowupTrigger;
  followupConfig?: { maxFollowupRuns: number };
  priorityScheduler?: PriorityScheduler;
  queueConfig?: QueueConfig;
  getElevatedReplyConfig?: (agentId: string) => ElevatedReplyConfig | undefined;
  sessionLabelStore?: SessionLabelStore;
  ackReactionConfig?: AckReactionConfig;
  loadPromptSkill?: (name: string, args?: string) => Promise<Result<{ content: string; allowedTools: string[]; skillName: string }, Error>>;
  getUserInvocableSkillNames?: () => Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assembleToolsForAgent?: (agentId: string) => Promise<any[]>;
  greetingGenerator?: { generate(agentName: string): Promise<Result<string, Error>> };
  audioPreflight?: (msg: NormalizedMessage) => Promise<PreflightResult>;
  voiceResponsePipeline?: VoiceResponsePipelineDeps;
  parseOutboundMedia?: (text: string) => { text: string; mediaUrls: string[] };
  outboundMediaFetch?: (url: string) => Promise<Result<{ buffer: Buffer; mimeType?: string }, Error>>;
  streamingConfig?: StreamingConfig;
  retryEngine?: RetryEngine;
  /** Delivery queue for crash-safe message persistence. When present, agent responses are enqueued before send. */
  deliveryQueue?: DeliveryQueuePort;
  /** Optional active run registry for SDK-native steer+followup. */
  activeRunRegistry?: ActiveRunRegistry;
  /** Handle /config command. Returns response text or undefined if not a config command. */
  handleConfigCommand?: (args: string[], channelType: string) => Promise<string | undefined>;
  /** Optional callback for task extraction after successful agent execution. */
  onTaskExtraction?: (conversationText: string, sessionKey: string, agentId: string) => Promise<void>;
  /** When true, lifecycle reactor handles queued/thinking reactions -- skip ack reaction. */
  lifecycleReactionsEnabled?: boolean;
  /** Response prefix config for template-based prefix/suffix on agent responses. */
  responsePrefixConfig?: { template: string; position: "prepend" | "append" };
  /** Template context builder for response prefix variables. */
  buildTemplateContext?: (agentId: string, channelType: string, msg: NormalizedMessage) => Record<string, string>;
  /** Optional approval gate for resolving /approve and /deny chat commands (APPR-CHAT). When absent, approval commands pass through as plain text. */
  approvalGate?: {
    resolveApproval(requestId: string, approved: boolean, approvedBy: string, reason?: string): void;
    pending(): Array<{ requestId: string; sessionKey: string; action: string; toolName: string }>;
    getRequest(requestId: string): { requestId: string; sessionKey: string } | undefined;
  };
  /** Handle general slash commands via command handler (CMD-WIRE). Returns CommandResult or undefined if not a command. */
  handleSlashCommand?: (text: string, sessionKey: SessionKey, agentId: string) => Promise<{ handled: boolean; response?: string; directives?: Record<string, unknown>; cleanedText?: string } | undefined>;
  /** Per-agent enforceFinalTag config lookup. Returns boolean or undefined if agent not found. */
  getEnforceFinalTag?: (agentId: string) => boolean | undefined;
  /** Optional allowFrom sender filter lookup. Returns allowed sender IDs for a channel type. Empty array = allow all. */
  getAllowFrom?: (channelType: string) => string[];
}

// ---------------------------------------------------------------------------
// Trigger phrase matching
// ---------------------------------------------------------------------------

/**
 * Test message text against configured reset trigger phrases.
 * Supports literal string matching (case-insensitive) and /regex/ patterns.
 * Each pattern is wrapped in try/catch to prevent ReDoS from user-configured patterns.
 */
export function matchesResetTrigger(text: string, triggers: string[]): boolean {
  const lowerText = text.toLowerCase().trim();
  for (const trigger of triggers) {
    try {
      if (trigger.startsWith("/") && trigger.endsWith("/") && trigger.length > 2) {
        const body = trigger.slice(1, -1);
        const check = isRegexSafe(body);
        if (!check.safe) continue; // Skip overly complex patterns
        const re = new RegExp(body, "i");
        if (re.test(lowerText)) return true;
      } else {
        if (lowerText === trigger.toLowerCase()) return true;
      }
    } catch {
      // Invalid regex -- skip silently (ReDoS prevention)
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main inbound pipeline (thin orchestrator)
// ---------------------------------------------------------------------------

/**
 * Process an inbound message through the full pipeline.
 *
 * Orchestrates 5 phases: resolve -> preprocess -> gate -> setup -> route.
 */
export async function processInboundMessage(
  deps: InboundPipelineDeps,
  adapter: ChannelPort,
  msg: NormalizedMessage,
  activePacers: Set<BlockPacer>,
  sendOverrides: SendOverrideStore,
): Promise<void> {
  // Phase 0: Sender allowFrom filtering
  const allowFrom = deps.getAllowFrom?.(adapter.channelType) ?? [];
  if (allowFrom.length > 0 && !allowFrom.includes(msg.senderId)) {
    deps.logger.info(
      { channelType: adapter.channelType, senderId: msg.senderId, hint: "Sender not in allowFrom list", errorKind: "auth" as const },
      "Sender blocked by allowFrom filter",
    );
    deps.eventBus.emit("sender:blocked", {
      channelType: adapter.channelType,
      senderId: msg.senderId,
      channelId: msg.channelId,
      timestamp: Date.now(),
    });
    return;
  }

  // Phase 1: Resolve agent, identity, session key
  const resolved = resolveInboundAgent(deps, adapter, msg);
  if (!resolved) return; // No executor -- early exit
  const { agentId, executor, sessionKey } = resolved;

  // Phase 2: Audio preflight, media preprocessing, compression
  const processedMsg = await preprocessInboundMessage(deps, msg, adapter.channelType);

  // Phase 3: Auto-reply gate, slash commands, reset triggers, prompt skills
  const gate = await evaluateInboundGate(deps, adapter, processedMsg, sessionKey, agentId, sendOverrides);
  if (gate.action === "handled" || gate.action === "skip") return;

  // Phase 4: Ack reaction, typing controller, streaming config
  const { typingLifecycle, streamCfg } = setupInboundExecution(
    deps, adapter, gate.processedMsg, msg, sessionKey,
  );

  // Phase 5: Debounce, group history, steer+followup, queue routing, execution
  await routeInboundMessage(
    deps, adapter, gate.processedMsg, msg, sessionKey, agentId,
    executor, streamCfg, activePacers, sendOverrides,
    typingLifecycle, gate.directives,
  );
}
