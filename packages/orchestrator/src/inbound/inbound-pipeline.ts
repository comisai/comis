// SPDX-License-Identifier: Apache-2.0
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
// Relative path used because orchestrator cannot import its own published name.
import type { MessageRouter } from "../routing/message-router.js";
import type { SessionLifecycle } from "@comis/agent";
// Relative path used because orchestrator cannot import its own published name.
import type { CommandQueue } from "../queue/command-queue.js";
import type { DebounceBuffer } from "../queue/debounce-buffer.js";
import type { FollowupTrigger } from "../queue/followup-trigger.js";
import type { SessionLabelStore } from "@comis/agent";
import type { ActiveRunRegistry, BackgroundSessionResolver } from "@comis/agent";
import type { ChannelPort, DeliveryQueuePort, NormalizedMessage, SessionKey, TypedEventBus, DeliveryService } from "@comis/core";
import type { StreamingConfig } from "@comis/core";
import type { AutoReplyEngineConfig, SendPolicyConfig, QueueConfig, ElevatedReplyConfig, AckReactionConfig } from "@comis/core";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";

import type {
  BlockPacer,
  ChannelRegistry,
  SendOverrideStore,
  PreflightResult,
  GroupHistoryBuffer,
  VoiceResponsePipelineDeps,
} from "@comis/channels";
import type { RetryEngine } from "@comis/core";
import { isRegexSafe } from "@comis/channels";

// Phase module imports
import { resolveInboundAgent } from "./inbound-resolve.js";
import { preprocessInboundMessage } from "./inbound-preprocess.js";
import { evaluateInboundGate } from "./inbound-gate.js";
import { setupInboundExecution } from "./inbound-setup.js";
import { routeInboundMessage } from "./inbound-route.js";
import { systemNowMs } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Narrow deps interface for the inbound pipeline. */
export interface InboundPipelineDeps {
  eventBus: TypedEventBus;
  logger: ComisLogger;
  messageRouter: MessageRouter;
  sessionManager: SessionLifecycle;
  createExecutor: (agentId: string) => AgentExecutor | undefined;
  channelRegistry?: ChannelRegistry;
  preprocessMessage?: (msg: NormalizedMessage) => Promise<NormalizedMessage>;
  commandQueue?: CommandQueue;
  autoReplyEngineConfig?: AutoReplyEngineConfig;
  sendPolicyConfig?: SendPolicyConfig;
  getResetTriggers?: (agentId: string) => string[];
  identityResolver?: { resolve(provider: string, providerUserId: string): string | undefined };
  getDmScopeConfig?: (agentId: string) => { mode?: string; threadIsolation?: boolean } | undefined;
  debounceBuffer?: DebounceBuffer;
  groupHistoryBuffer?: GroupHistoryBuffer;
  followupTrigger?: FollowupTrigger;
  followupConfig?: { maxFollowupRuns: number };
  queueConfig?: QueueConfig;
  getElevatedReplyConfig?: (agentId: string) => ElevatedReplyConfig | undefined;
  sessionLabelStore?: SessionLabelStore;
  ackReactionConfig?: AckReactionConfig;
  loadPromptSkill?: (name: string, args?: string) => Promise<Result<{ content: string; allowedTools: string[]; skillName: string }, Error>>;
  getUserInvocableSkillNames?: () => Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: SessionKey }) => Promise<any[]>;
  greetingGenerator?: { generate(agentName: string): Promise<Result<string, Error>> };
  audioPreflight?: (msg: NormalizedMessage) => Promise<PreflightResult>;
  voiceResponsePipeline?: VoiceResponsePipelineDeps;
  parseOutboundMedia?: (text: string) => { text: string; mediaUrls: string[] };
  outboundMediaFetch?: (url: string) => Promise<Result<{ buffer: Buffer; mimeType?: string }, Error>>;
  streamingConfig?: StreamingConfig;
  retryEngine?: RetryEngine;
  /** Delivery queue for crash-safe message persistence. When present, agent responses are enqueued before send. */
  deliveryQueue?: DeliveryQueuePort;
  /** DeliveryService constructed once at the daemon composition root
   *  (setup-channels.ts). Threaded through the inbound pipeline so
   *  inbound-gate.ts and execution-deliver.ts use the method form instead
   *  of the free-standing standalone export. */
  deliveryService: DeliveryService;
  /**
   * Per-instance set of in-flight outbound sendMessage promises. Threaded
   * through ExecutionPipelineDeps -> DeliverToChannelDeps so deliver-to-channel
   * can register active sends. Drained in stopAll() with a 5s deadline so
   * SIGUSR2 cannot tear down adapters mid-send. Created by the channel-manager
   * factory; do not pass externally.
   */
  inFlightSends?: Set<Promise<unknown>>;
  /** Optional active run registry for SDK-native steer+followup. */
  activeRunRegistry?: ActiveRunRegistry;
  /**
   * Optional composite-key resolver for active-session lookup. When
   * present, supersedes `activeRunRegistry.has/.get` for production
   * lookups. Wired by the daemon as
   * `createBackgroundSessionResolver({ activeRunRegistry })`.
   */
  sessionResolver?: BackgroundSessionResolver;
  /** Handle /config command. Returns response text or undefined if not a config command. */
  handleConfigCommand?: (args: string[], channelType: string) => Promise<string | undefined>;
  /** When true, lifecycle reactor handles queued/thinking reactions -- skip ack reaction. */
  lifecycleReactionsEnabled?: boolean;
  /** Response prefix config for template-based prefix/suffix on agent responses. */
  responsePrefixConfig?: { template: string; position: "prepend" | "append" };
  /** Template context builder for response prefix variables. */
  buildTemplateContext?: (agentId: string, channelType: string, msg: NormalizedMessage) => Record<string, string>;
  /** Optional approval gate for resolving /approve and /deny chat commands. When absent, approval commands pass through as plain text. */
  approvalGate?: {
    resolveApproval(requestId: string, approved: boolean, approvedBy: string, reason?: string): void;
    pending(): Array<{ requestId: string; sessionKey: string; action: string; toolName: string }>;
    getRequest(requestId: string): { requestId: string; sessionKey: string } | undefined;
  };
  /** Handle general slash commands via command handler. Returns CommandResult or undefined if not a command. */
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
      timestamp: systemNowMs(),
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
