// SPDX-License-Identifier: Apache-2.0
/**
 * Inbound Pipeline: Thin orchestrator for message reception and routing.
 *
 * Delegates to 4 focused phase modules (5 → 3 collapse in progress; Phase 59
 * REFACTOR-02 merged resolve + preprocess in Plan 59-04; setup + route
 * merge in Plan 59-05):
 *   1. resolve-and-preprocess — agent resolution, session key, audio preflight,
 *                                media preprocessing, compression
 *   2. inbound-gate           — auto-reply, slash commands, reset triggers, skills
 *   3. inbound-setup          — ack reaction, typing controller
 *   4. inbound-route          — debounce, group history, queue routing, execution
 *
 * @module
 */

import type { AgentExecutor } from "@comis/agent";
// Relative path used because orchestrator cannot import its own published name.
import type { MessageRouter } from "../routing/message-router.js";
import type { SessionLifecycle } from "@comis/agent";
// Relative path used because orchestrator cannot import its own published name.
import type { CommandQueue } from "../queue/command-queue.js";
import type { ActiveRunRegistry, BackgroundSessionResolver } from "@comis/agent";
import type { ChannelPort, DeliveryQueuePort, NormalizedMessage, SessionKey, TypedEventBus, DeliveryService } from "@comis/core";
import type { StreamingConfig } from "@comis/core";
import type { AutoReplyEngineConfig, SendPolicyConfig, QueueConfig, ElevatedReplyConfig } from "@comis/core";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";

import type {
  BlockPacer,
  ChannelRegistry,
  SendOverrideStore,
  PreflightResult,
  VoiceResponsePipelineDeps,
} from "@comis/channels";
import type { RetryEngine } from "@comis/core";
import { isRegexSafe } from "@comis/channels";

// Phase module imports
import { resolveAndPreprocess } from "./resolve-and-preprocess.js";
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
  queueConfig?: QueueConfig;
  getElevatedReplyConfig?: (agentId: string) => ElevatedReplyConfig | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: SessionKey }) => Promise<any[]>;
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

  // Phase 1: Resolve agent + preprocess (merged in Phase 59 REFACTOR-02)
  const resolved = await resolveAndPreprocess(deps, adapter, msg);
  if (!resolved) return; // No executor -- early exit
  const { agentId, executor, sessionKey, processedMsg } = resolved;

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
