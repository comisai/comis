// SPDX-License-Identifier: Apache-2.0
/**
 * Inbound Pipeline: Thin orchestrator for message reception and routing.
 *
 * Coordinates sender authorization, resolve/preprocess, the message gate,
 * and setup/routing into execution.
 *
 * @module
 */

import type { AgentExecutor, InboundMessageProvenancePlan } from "@comis/agent";
// Relative path used because orchestrator cannot import its own published name.
import type { MessageRouter } from "../routing/message-router.js";
import type { SessionLifecycle } from "@comis/agent";
// Relative path used because orchestrator cannot import its own published name.
import type { CommandQueue } from "../queue/command-queue.js";
import type { ActiveRunRegistry, BackgroundSessionResolver } from "@comis/agent";
// Relative path used because orchestrator cannot import its own published name.
import type { InteractiveCallbackRouter } from "../approval/index.js";
import type { ApprovalRequest, ChannelPort, DeliveryQueuePort, EventMap, NormalizedMessage, RequestContext, SessionKey, TypedEventBus, DeliveryService } from "@comis/core";
// The orchestrator imports ONLY the @comis/core activity port + ctx type
// (never the observability impl — hexagonal boundary). The
// ActivityTurnCoordinator is a local execution type.
import type { ActivityStreamPort, TurnActivityContext } from "@comis/core";
import type { ActivityTurnCoordinator } from "../execution/activity-turn-coordinator.js";
import type { StreamingConfig } from "@comis/core";
import type { AutoReplyEngineConfig, SendPolicyConfig, QueueConfig, ElevatedReplyConfig } from "@comis/core";
import type { ComisLogger } from "@comis/core";
import { fromPromise, tryCatch, type Result } from "@comis/shared";

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
import { setupAndRoute } from "./setup-and-route.js";
import {
  createDeliveryOrigin,
  enrichCurrentContext,
  systemNowMs,
  tryGetContext,
} from "@comis/core";
import type { DedupDetector, DedupReservation } from "./dedup-detector.js";
import {
  createSourceTerminalScope,
} from "../source-message-terminal.js";
import { emitObservationalEvent } from "../execution/execution-event-emitter.js";
import { resolveExecutionTrustLevel } from "../execution/execution-policy.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Narrow deps interface for the inbound pipeline. */
export interface InboundPipelineDeps {
  /** Configured tenant authority for channel-originated session construction. */
  tenantId: string;
  eventBus: TypedEventBus;
  logger: ComisLogger;
  messageRouter: MessageRouter;
  sessionManager: SessionLifecycle;
  createExecutor: (agentId: string) => AgentExecutor | undefined;
  /**
   * Persist the original physical inbound occurrence in the resolved agent's
   * append-only ledger. This boundary runs before reception events, gates, or
   * queue ownership so every admitted channel message remains retrievable even
   * when no model execution starts.
   */
  persistInboundMessage: (
    agentId: string,
    message: NormalizedMessage,
    sessionKey: SessionKey,
  ) => Promise<Result<InboundMessageProvenancePlan, {
    error: Error;
    errorKind: "validation" | "precondition" | "resource" | "config";
  }>>;
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
    pending(): Array<{ requestId: string; shortId: string; sessionKey: string; action: string; toolName: string }>;
    getRequest(requestId: string): { requestId: string; sessionKey: string } | undefined;
    /** Resolve a minted 12-char shortId to its pending request. Gate-internal; channels never call this. */
    getRequestByShortId(shortId: string): { requestId: string; shortId: string; sessionKey: string; action: string; toolName: string } | undefined;
    /** Pending requests scoped to a session (the plain-text/button resolution source). */
    pendingForSession(sessionKey: string): ApprovalRequest[];
  };
  /**
   * Optional server-side interactive-callback router. When present, an inbound
   * `NormalizedMessage` carrying `metadata.isButtonCallback === true` is intercepted and
   * forwarded to `router.route()` (the verifier) BEFORE slash-command handling — the gate
   * is never called directly from the inbound button path. Injected by daemon wiring;
   * when absent, button callbacks fall through to the normal pipeline.
   */
  interactiveCallbackRouter?: InteractiveCallbackRouter;
  /** Deliver a graph report after the signed callback router validates its owner. */
  onGraphReportRequest?: (
    graphId: string,
    channelType: string,
    channelId: string,
    adapter: ChannelPort,
    threadId?: string,
  ) => Promise<void>;
  /** Handle general slash commands via command handler. Returns CommandResult or undefined if not a command. */
  handleSlashCommand?: (text: string, sessionKey: SessionKey, agentId: string) => Promise<{ handled: boolean; response?: string; directives?: Record<string, unknown>; cleanedText?: string } | undefined>;
  /** Per-agent enforceFinalTag config lookup. Returns boolean or undefined if agent not found. */
  getEnforceFinalTag?: (agentId: string) => boolean | undefined;
  /** See ChannelManagerDeps. */
  activityStreamPort?: ActivityStreamPort;
  /** See ChannelManagerDeps. */
  coordinatorFactory?: (ctx: TurnActivityContext) => ActivityTurnCoordinator;
  /** Optional allowFrom sender filter lookup. Returns allowed sender IDs for a channel type. Empty array = allow all. */
  getAllowFrom?: (channelType: string) => string[];
  /** Optional duplicate-inbound detector. The exact channel/source tuple is
   * checked before resolve/preprocess. A duplicate is observed and suppressed
   * so one physical source owns one execution and terminal outcome. */
  dedupDetector?: DedupDetector;
  /**
   * Bundle export DI for the /export-trajectory slash command.
   * When present, inbound-gate.ts handles /export-trajectory with owner-gate + DM routing.
   * When absent, /export-trajectory falls through to generic handleSlashCommand (no-op).
   * Injected by daemon wiring (packages/daemon/src/wiring/).
   */
  exportSessionBundle?: (sessionId: string) => Promise<{ bundlePath: string }>;
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

function enrichResolvedInboundContext(
  deps: InboundPipelineDeps,
  adapter: ChannelPort,
  processedMsg: NormalizedMessage,
  sessionKey: SessionKey,
  agentId: string,
): Result<RequestContext, Error> {
  const elevatedConfig = tryCatch(
    () => deps.getElevatedReplyConfig?.(agentId),
  );
  if (!elevatedConfig.ok) return elevatedConfig;

  const deliveryOrigin = tryCatch(() => createDeliveryOrigin({
    channelType: adapter.channelType,
    channelId: processedMsg.channelId,
    userId: sessionKey.userId,
    threadId: processedMsg.metadata?.threadId as string | undefined,
    tenantId: sessionKey.tenantId,
  }));
  if (!deliveryOrigin.ok) return deliveryOrigin;

  return enrichCurrentContext({
    tenantId: sessionKey.tenantId,
    userId: sessionKey.userId,
    sessionKey,
    agentId,
    trustLevel: resolveExecutionTrustLevel(
      elevatedConfig.value,
      processedMsg.senderId,
    ),
    deliveryOrigin: deliveryOrigin.value,
  });
}

// ---------------------------------------------------------------------------
// Main inbound pipeline (thin orchestrator)
// ---------------------------------------------------------------------------

/**
 * Process an inbound message through the full pipeline.
 *
 * Coordinates sender authorization, resolve/preprocess, gate evaluation, and
 * setup/routing while retaining one terminal authority for the ingress.
 */
export async function processInboundMessage(
  deps: InboundPipelineDeps,
  adapter: ChannelPort,
  msg: NormalizedMessage,
  activePacers: Set<BlockPacer>,
  sendOverrides: SendOverrideStore,
): Promise<void> {
  const sourceTerminalScope = createSourceTerminalScope(
    deps,
    msg,
    adapter.channelType,
  );
  const emitInboundTerminal = (
    outcome: EventMap["message:terminal"]["outcome"],
    reason: EventMap["message:terminal"]["reason"],
  ): void => {
    sourceTerminalScope.publish(outcome, reason, systemNowMs());
  };

    // Adapter dispatch is the request boundary. Continuing without its ALS
    // scope would skip authoritative identity/trust enrichment and let the
    // executor observe an incomplete authorization context.
    if (tryGetContext() === undefined) {
      const missingContext = new Error(
        "Inbound message requires an unresolved request context",
      );
      void tryCatch(() => deps.logger.error({
        step: "context-enrichment",
        channelType: adapter.channelType,
        hint: "Dispatch inbound messages through the channel manager so the adapter request scope exists before routing",
        errorKind: "precondition" as const,
      }, "Inbound request context is missing"));
      emitInboundTerminal("error", "inbound_rejected");
      return Promise.reject(missingContext);
    }

    // Sender authorization.
    const allowFromResult = tryCatch(
      () => deps.getAllowFrom?.(adapter.channelType) ?? [],
    );
    if (!allowFromResult.ok) {
      emitInboundTerminal("error", "inbound_rejected");
      return Promise.reject(allowFromResult.error);
    }
    const allowFrom = allowFromResult.value;
    if (allowFrom.length > 0 && !allowFrom.includes(msg.senderId)) {
      void tryCatch(() => deps.logger.info(
        { channelType: adapter.channelType, senderId: msg.senderId, hint: "Sender not in allowFrom list", errorKind: "auth" as const },
        "Sender blocked by allowFrom filter",
      ));
      emitObservationalEvent(deps, "sender:blocked", {
        channelType: adapter.channelType,
        senderId: msg.senderId,
        channelId: msg.channelId,
        timestamp: systemNowMs(),
      });
      emitInboundTerminal("filtered", "gate_skipped");
      return;
    }

    // Detect duplicate physical sources before any processing. The first
    // ingress owns the eventual terminal tuple; later deliveries are observed
    // but do not start a second execution.
    const dedupDetector = deps.dedupDetector;
    let dedupReservation: DedupReservation | undefined;
    if (dedupDetector) {
      const sourceTupleKey = JSON.stringify([
        adapter.channelType,
        msg.channelId,
        msg.id,
      ]);
      const reserved = tryCatch(() => dedupDetector.reserve(sourceTupleKey));
      if (!reserved.ok) {
        emitInboundTerminal("error", "inbound_rejected");
        return Promise.reject(reserved.error);
      }
      const dedupResult = reserved.value;
      if (dedupResult.isDuplicate) {
        const duplicateAt = systemNowMs();
        emitObservationalEvent(deps, "dedup:duplicate_inbound", {
          messageId: msg.id,
          channelType: adapter.channelType,
          chatId: msg.channelId,
          firstSeenAt: dedupResult.firstSeenAt ?? duplicateAt,
          duplicateAt,
          deltaMs: dedupResult.deltaMs ?? 0,
          source: "pipeline",
        });
        void tryCatch(() => deps.logger.warn(
          {
            step: "dedup",
            messageId: msg.id,
            channelType: adapter.channelType,
            chatId: msg.channelId,
            deltaMs: dedupResult.deltaMs ?? 0,
            hint: "Same messageId processed twice; check channel adapter handler list and queue mode",
            errorKind: "internal" as const,
          },
          "Duplicate inbound message detected",
        ));
        // One physical source tuple has one processing owner. The original
        // ingress remains responsible for its eventual terminal publication.
        return;
      }
      dedupReservation = dedupResult.reservation;
    }

    // Resolve the agent and preprocess the message.
    const resolvedResult = await fromPromise(resolveAndPreprocess(deps, adapter, msg));
    if (!resolvedResult.ok) {
      dedupReservation?.rollback();
      emitInboundTerminal("error", "inbound_rejected");
      return Promise.reject(resolvedResult.error);
    }
    const resolved = resolvedResult.value;
    if (resolved.kind === "no_executor") {
      dedupReservation?.rollback();
      emitInboundTerminal("error", "inbound_rejected");
      return Promise.reject(new Error(`No executor configured for agent '${resolved.agentId}'`));
    }
    const {
      agentId,
      executor,
      sessionKey,
      processedMsg,
      inboundProvenancePlan,
    } = resolved;

    // Agent, session, and sender trust become authoritative at resolution.
    // Fill them on the ingress scope before gate handling and queue capture so
    // every remaining stage observes the same trace and context object.
    const enrichedContext = enrichResolvedInboundContext(
      deps,
      adapter,
      processedMsg,
      sessionKey,
      agentId,
    );
    if (!enrichedContext.ok) {
      dedupReservation?.rollback();
      void tryCatch(() => deps.logger.error({
        step: "context-enrichment",
        agentId,
        channelType: adapter.channelType,
        hint: "Validate resolved agent, session, trust, and delivery-origin fields before routing the inbound turn",
        errorKind: "internal" as const,
      }, "Resolved inbound request context enrichment failed"));
      emitInboundTerminal("error", "inbound_rejected");
      return Promise.reject(enrichedContext.error);
    }

    // Evaluate auto-reply, commands, reset triggers, and prompt skills.
    const gateResult = await fromPromise(
      evaluateInboundGate(
        deps,
        adapter,
        processedMsg,
        sessionKey,
        agentId,
        sendOverrides,
        sourceTerminalScope,
      ),
    );
    if (!gateResult.ok) {
      dedupReservation?.rollback();
      emitInboundTerminal("error", "inbound_rejected");
      return Promise.reject(gateResult.error);
    }
    const gate = gateResult.value;
    if (gate.action === "handled") {
      dedupReservation?.commit();
      emitInboundTerminal("success", "gate_handled");
      return;
    }
    if (gate.action === "skip") {
      dedupReservation?.commit();
      emitInboundTerminal("filtered", "gate_skipped");
      return;
    }

    // Set up execution and route through the configured queue mode.
    const routed = await fromPromise(setupAndRoute(
      deps, adapter, gate.processedMsg, msg, sessionKey, agentId,
      executor, activePacers, sendOverrides, gate.directives,
      inboundProvenancePlan,
      sourceTerminalScope,
    ));
    if (!routed.ok) {
      dedupReservation?.rollback();
      emitInboundTerminal("error", "inbound_rejected");
      return Promise.reject(routed.error);
    }
    dedupReservation?.commit();
}
