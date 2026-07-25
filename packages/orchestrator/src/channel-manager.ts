// SPDX-License-Identifier: Apache-2.0
/**
 * Channel Manager: Thin lifecycle coordinator for channel adapters.
 *
 * Delegates message processing to the inbound pipeline and execution
 * to the execution pipeline. This module only handles:
 * - Adapter lifecycle (startAll / stopAll)
 * - Closure state (activePacers, sendOverrides, adaptersByType)
 * - Session expiry cleanup
 *
 * Pipeline modules:
 * - execution-pipeline.ts: outbound delivery (executeAndDeliver)
 * - inbound-pipeline.ts: inbound message processing (processInboundMessage)
 *
 * @module
 */

import type { AgentExecutor, InboundMessageProvenancePlan } from "@comis/agent";
// MessageRouter lives in orchestrator. Relative path used because the
// orchestrator package cannot import its own published name.
import type { MessageRouter } from "./routing/message-router.js";
import type { SessionLifecycle } from "@comis/agent";
// Queue types live in orchestrator. Relative path used because the
// orchestrator package cannot import its own published name.
import type { CommandQueue } from "./queue/command-queue.js";
import type { ActiveRunRegistry, BackgroundSessionResolver } from "@comis/agent";
import type { InteractiveCallbackRouter } from "./approval/index.js";
import type { ApprovalGate, ChannelPort, ClockPort, DeliverToChannelOptions, DeliveryQueuePort, DmScopeConfig, EventMap, LocalizationPort, NormalizedMessage, NormalizedReaction, PrincipalResolverPort, RequestContext, SessionKey, TypedEventBus, DeliveryService } from "@comis/core";
// Orchestrator imports ONLY the @comis/core activity port + ctx type
// (never the observability impl — hexagonal boundary). The
// ActivityTurnCoordinator is a local execution type.
import type { ActivityStreamPort, TurnActivityContext } from "@comis/core";
import type { ActivityTurnCoordinator } from "./execution/activity-turn-coordinator.js";
import type { StreamingConfig } from "@comis/core";
import type { AutoReplyEngineConfig, SendPolicyConfig, QueueConfig, ElevatedReplyConfig } from "@comis/core";
import {
  createConversationRef,
  runWithContext,
  getMessageTraceId,
  systemNowMs,
  parseReaction,
  toSafeErrorLogString,
  tryGetContext,
} from "@comis/core";
import { randomUUID } from "node:crypto";
import type { ComisLogger } from "@comis/core";
import { tryCatch, type Result } from "@comis/shared";

// channel-manager.ts lives in @comis/orchestrator, so the six imports below
// reach into the @comis/channels public surface — block-pacer,
// channel-registry, send-policy, audio-preflight, group-history-buffer,
// voice-response-pipeline live in channels and are exported from
// packages/channels/src/index.ts for cross-package consumers like this one.
import type { BlockPacer } from "@comis/channels";
import type { ChannelRegistry } from "@comis/channels";
import { createSendOverrideStore } from "@comis/channels";
import type { SendOverrideStore } from "@comis/channels";
import type { PreflightResult } from "@comis/channels";
import type { RetryEngine } from "@comis/core";
import type { VoiceResponsePipelineDeps } from "@comis/channels";
import { createSourceTerminalScope } from "./source-message-terminal.js";
import type { TaskExtractionCaptureDeps } from "./execution/task-extraction-capture.js";

// inbound-pipeline.ts lives in @comis/orchestrator. Channels cannot import
// from orchestrator (forbidden direction — channels is downstream of
// orchestrator only via the daemon composition root). channel-manager
// receives `processInboundMessage` via an injected callback on
// ChannelManagerDeps to preserve that direction.

/**
 * Best-effort seed of `msg.metadata.traceId` for downstream consumers.
 * Context propagation does NOT depend on this — `runWithContext({ traceId })`
 * already carries the canonical id. The metadata write is a convenience; if the
 * caller passed a FROZEN/non-extensible metadata object, an in-place assignment
 * would throw a TypeError (strict mode) and abort the whole turn. Guard the write
 * so a frozen metadata is a silent no-op rather than a turn-killing throw. Only
 * seeds when the field is absent (never overwrites a caller-provided traceId).
 */
function seedMetadataTraceId(msg: NormalizedMessage, traceId: string): void {
  if (typeof msg.metadata.traceId === "string") return;
  if (Object.isFrozen(msg.metadata) || !Object.isExtensible(msg.metadata)) return;
  msg.metadata.traceId = traceId;
}

/** Preserve adapter ingress time only when it belongs to the same trace. */
function resolveInboundStartedAt(traceId: string): number {
  const now = systemNowMs();
  const context = tryGetContext();
  return context?.traceId === traceId &&
    Number.isSafeInteger(context.startedAt) &&
    context.startedAt > 0
    ? Math.min(context.startedAt, now)
    : now;
}

/** True only for a channel-owned context that has not entered resolution. */
function isUnresolvedIngressContext(context: RequestContext): boolean {
  return (context.trustLevel === "user" || context.trustLevel === "guest")
    && typeof context.tenantId === "string"
    && context.tenantId.length > 0
    && Number.isSafeInteger(context.startedAt)
    && context.startedAt > 0
    && context.userId === undefined
    && context.sessionKey === undefined
    && context.agentId === undefined
    && context.clientId === undefined
    && context.contentDelimiter === undefined
    && context.deliveryOrigin === undefined
    && context.resolvedModel === undefined
    && context.resolvedLanguage === undefined;
}

/** Drop a malformed ingress before execution and publish its sole terminal. */
function rejectInboundDispatch(
  deps: Pick<ChannelManagerDeps, "eventBus" | "logger">,
  adapter: ChannelPort,
  msg: NormalizedMessage,
  hint: string,
): void {
  void tryCatch(() => deps.logger.error({
    channelId: msg.channelId,
    channelType: adapter.channelType,
    messageChannelType: msg.channelType,
    errorKind: "precondition" as const,
    hint,
  }, "Inbound adapter context does not match the dispatched message"));
  createSourceTerminalScope(
    deps,
    msg,
    msg.channelType,
  ).publish("error", "inbound_rejected", systemNowMs());
}

/**
 * Callback shape matching @comis/orchestrator.processInboundMessage.
 * Typed structurally so channels does not depend on orchestrator's type
 * exports. Parameter contravariance lets the daemon pass the real
 * `processInboundMessage` (which expects `InboundPipelineDeps`) into this
 * `ChannelManagerDeps`-typed callback slot — `ChannelManagerDeps` is the
 * narrower type containing every `InboundPipelineDeps` field.
 */
export type ProcessInboundMessageFn = (
  deps: ChannelManagerDeps,
  adapter: ChannelPort,
  msg: NormalizedMessage,
  activePacers: Set<BlockPacer>,
  sendOverrides: SendOverrideStore,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChannelManagerDeps {
  /** Configured tenant authority for every channel-originated turn. */
  tenantId: string;
  eventBus: TypedEventBus;
  /** Authoritative clock for settled interactive delivery. */
  clock: ClockPort;
  messageRouter: MessageRouter;
  sessionManager: SessionLifecycle;
  principalResolver: PrincipalResolverPort;
  localization: LocalizationPort;
  getDmScope: (agentId: string) => DmScopeConfig;
  createExecutor: (agentId: string) => AgentExecutor | undefined;
  /** Durable physical-inbound ledger boundary used before gates and queues. */
  persistInboundMessage: (
    agentId: string,
    message: NormalizedMessage,
    sessionKey: SessionKey,
  ) => Promise<Result<InboundMessageProvenancePlan, {
    error: Error;
    errorKind: "validation" | "precondition" | "resource" | "config";
  }>>;
  /** Direct adapter list. Optional when channelRegistry provides plugin-registered adapters. */
  adapters?: ChannelPort[];
  logger: ComisLogger;
  /** Optional media preprocessor -- transcribes voice and analyzes images before agent dispatch. */
  preprocessMessage?: (
    msg: NormalizedMessage,
    turnScope: import("@comis/core").ResolvedTurnScope,
  ) => Promise<NormalizedMessage>;
  /** Optional channel registry for capability-driven behavior. Falls back to hardcoded maps if not provided. */
  channelRegistry?: ChannelRegistry;
  /** Optional command queue for per-session serialization and mode-aware handling. Falls back to direct execution if not provided. */
  commandQueue?: CommandQueue;
  /** Optional streaming config for block-based delivery and typing indicators. When absent, block streaming uses hardcoded defaults (enabled). */
  streamingConfig?: StreamingConfig;
  /** Optional auto-reply engine config for inbound message activation gating. When absent, all messages activate the agent. */
  autoReplyEngineConfig?: AutoReplyEngineConfig;
  /** Optional send policy config for outbound message gating. When absent, all sends are allowed. */
  sendPolicyConfig?: SendPolicyConfig;
  /** Optional reset trigger phrases per agent. When absent, no trigger phrase detection. */
  getResetTriggers?: (agentId: string) => string[];
  /** Optional retry engine for resilient message delivery. When absent, sends use adapter.sendMessage directly. */
  retryEngine?: RetryEngine;
  /** Delivery queue for crash-safe message persistence. Optional -- when absent, agent responses skip queue. */
  deliveryQueue?: DeliveryQueuePort;
  /** DeliveryService constructed once at the daemon composition root
   *  (setup-channels.ts). Threaded into the inbound pipeline via
   *  pipelineDeps spread. */
  deliveryService: DeliveryService;
  /** Optional queue config. When absent, default queue behavior used. */
  queueConfig?: QueueConfig;
  /** Optional callback to get elevated reply config for an agent. When absent, no elevated routing. */
  getElevatedReplyConfig?: (agentId: string) => ElevatedReplyConfig | undefined;
  /** Optional tool assembler for resolving agent tools before execution. When absent, executor receives no tools (undefined).
   *  The optional `options` object carries per-call wiring -- currently used to thread the inbound session's
   *  structural SessionKey so the assembled tools resolve the session-lifetime FileStateTracker via
   *  SessionTrackerRegistry (see setup-tools.ts). Shape is intentionally structural (not imported from @comis/daemon)
   *  to preserve the channels -> daemon dependency direction. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: SessionKey }) => Promise<any[]>;
  /** Optional audio preflight for transcribing voice before mention gate. */
  audioPreflight?: (msg: NormalizedMessage) => Promise<PreflightResult>;
  /** Optional voice response pipeline deps for auto-TTS voice reply. When absent, voice response is disabled. */
  voiceResponsePipeline?: VoiceResponsePipelineDeps;
  /** Optional outbound media parser. Injected from @comis/skills via setup-channels.ts. When provided alongside outboundMediaFetch, MEDIA: directives are parsed from agent responses. */
  parseOutboundMedia?: (text: string) => { text: string; mediaUrls: string[] };
  /** Optional SSRF-safe fetch function for downloading outbound media URLs. When absent, outbound media delivery is disabled. Field uses mimeType (matching SsrfGuardedFetcher.FetchedMedia). */
  outboundMediaFetch?: (url: string) => Promise<Result<{ buffer: Buffer; mimeType?: string }, Error>>;
  /** Optional active run registry for SDK-native steer+followup message routing. When absent, all messages route through CommandQueue. */
  activeRunRegistry?: ActiveRunRegistry;
  /**
   * Optional composite-key resolver. When present, supersedes
   * `activeRunRegistry.has/.get` for production lookups in the inbound
   * pipeline.
   */
  sessionResolver?: BackgroundSessionResolver;
  /** Handle /config command. Returns response text or undefined if not a config command. */
  handleConfigCommand?: (args: string[], channelType: string) => Promise<string | undefined>;
  /**
   * Optional hook fired BEFORE the inbound message is dispatched to the executor.
   * Use this for state that must be visible during processing (e.g. continuation
   * tracker for SIGUSR2 capture). Fires for both real adapter inbounds and
   * synthetic injected messages. Does NOT fire for the no-adapter early return.
   */
  onMessageReceived?: (msg: NormalizedMessage, channelType: string) => void;
  /** Optional callback fired AFTER each successful inbound message processing. Used by post-processing state (e.g. notification session activity recording). */
  onMessageProcessed?: (msg: NormalizedMessage, channelType: string) => void;
  /** When true, lifecycle reactor handles queued/thinking reactions -- skip ack reaction in inbound pipeline. */
  lifecycleReactionsEnabled?: boolean;
  /** Deliver a graph report only after the inbound signed-callback router validates its owner. */
  onGraphReportRequest?: (graphId: string, channelType: string, channelId: string, adapter: ChannelPort, options: DeliverToChannelOptions, sessionKey: SessionKey) => Promise<void>;
  /** Response prefix config for template-based prefix/suffix on agent responses. */
  responsePrefixConfig?: { template: string; position: "prepend" | "append" };
  /** Template context builder for response prefix variables. */
  buildTemplateContext?: (agentId: string, channelType: string, msg: NormalizedMessage) => Record<string, string>;
  /** Optional approval gate for /approve and /deny chat commands. When absent, approval commands pass through as plain text. */
  approvalGate?: Pick<ApprovalGate, "resolveApproval" | "pending" | "getRequest" | "getRequestByShortId" | "pendingForAuthority">;
  /**
   * Optional server-side interactive-callback router. When present, an inbound
   * button-callback (`metadata.isButtonCallback`) is forwarded to `router.route()` (the
   * verifier) BEFORE slash-command handling. Injected by daemon wiring; when absent,
   * button callbacks fall through to the normal pipeline.
   */
  interactiveCallbackRouter?: InteractiveCallbackRouter;
  /** Handle general slash commands via command handler. */
  handleSlashCommand?: (
    text: string,
    sessionKey: SessionKey,
    agentId: string,
  ) => Promise<
    | {
        handled: boolean;
        response?: string;
        directives?: Record<string, unknown>;
        cleanedText?: string;
      }
    | undefined
  >;
  /** Per-agent enforceFinalTag config lookup. */
  getEnforceFinalTag?: (agentId: string) => boolean | undefined;
  /** Orchestrator-facing redacted activity stream port. Daemon injects
   *  setupObservability's `activityStream`. Absent ⇒ activity pipe inert. */
  activityStreamPort?: ActivityStreamPort;
  /** Per-turn coordinator factory built at the daemon composition root
   *  (setup-channels-runtime.ts). The pipeline calls it once both this and
   *  `activityStreamPort` are present (execution-pipeline.ts:395). */
  coordinatorFactory?: (ctx: TurnActivityContext) => ActivityTurnCoordinator;
  /** Stable scheduler capture proxy plus immutable policy lookup. */
  taskCapture?: TaskExtractionCaptureDeps;
  /**
   * REQUIRED. Inbound message processor — injected at composition root from
   * `@comis/orchestrator.processInboundMessage`. Lives on deps so the
   * channels package can call it without importing from orchestrator
   * (channels cannot import from orchestrator).
   */
  processInboundMessage: ProcessInboundMessageFn;
  /** Optional allowFrom sender filter lookup. Returns allowed sender IDs for a channel type. Empty array = allow all. */
  getAllowFrom?: (channelType: string) => string[];
  /**
   * Bundle export DI for the /export-trajectory slash command. When present,
   * inbound-gate.ts special-cases /export-trajectory with an owner gate and
   * direct-message-only delivery before the generic handleSlashCommand block. When absent,
   * /export-trajectory falls through to generic slash command handling (no-op).
   * Injected by daemon wiring via ChannelManagerBuildDeps.
   */
  exportSessionBundle?: (sessionId: string) => Promise<{ bundlePath: string }>;
  /**
   * Credential-to-channelType mapping for targeted adapter lifecycle updates.
   * Maps credential name (e.g. "TELEGRAM_BOT_TOKEN") to channelType (e.g. "telegram").
   * An upserted credential restarts its adapter; a removed credential stops its
   * adapter and immediately removes it from the active set.
   * When absent, no channel reconnect is attempted on credential rotation.
   */
  channelCredentialMap?: Map<string, string>;
  /**
   * The daemon's LIVE boot adapter registry (`adaptersByType`, exposed as
   * `DaemonInstance.adapterRegistry`). `injectMessage` consults it as a fallback
   * when an adapter for the requested channelType was not registered in
   * `startAll()` — adapters added to this map AFTER boot (the activation
   * test registers a test Echo adapter post-boot via `adapterRegistry.set`) are
   * reachable for a synthetic inbound turn. Absent ⇒ only `startAll()`-registered
   * adapters drive `injectMessage` (production unaffected — the daemon registers
   * every real adapter at boot).
   */
  adapterRegistry?: Map<string, ChannelPort>;
}

export interface ChannelManager {
  /** Start all registered channel adapters and wire message handlers. */
  startAll(): Promise<void>;
  /** Stop all adapters gracefully. */
  stopAll(): Promise<void>;
  /** Get running adapter count. */
  readonly activeCount: number;
  /** Inject a synthetic inbound message through the normal processing pipeline. Used for restart continuation replay. */
  injectMessage(
    channelType: string,
    msg: NormalizedMessage,
    context?: Pick<RequestContext, "resolvedLanguage">,
  ): Promise<void>;
  /**
   * Raw onMessage-registration count per channelType, captured pre-dedup in startAll().
   * Used by the boot invariant collector to detect duplicate-adapter wiring.
   * Post-dedup (normal wiring) = 1; regression wiring (same adapter in both slots) = 2.
   */
  getRawHandlerCounts(): ReadonlyMap<string, number>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a channel manager that coordinates adapter lifecycle,
 * message routing, agent execution, and real-time streaming.
 */
export function createChannelManager(deps: ChannelManagerDeps): ChannelManager {
  const activeChannelTypes = new Set<string>();

  /** Active block pacers tracked for graceful shutdown cancellation. */
  const activePacers = new Set<BlockPacer>();

  /** Ephemeral per-session send overrides (/send on|off|inherit). */
  const sendOverrides: SendOverrideStore = createSendOverrideStore();

  /** Adapter lookup map: channelType -> ChannelPort. Populated in startAll(). */
  const adaptersByType = new Map<string, ChannelPort>();

  /**
   * Raw pre-dedup registration count per channelType.
   * Incremented once for every adapter seen in the merged list (deps.adapters +
   * channelRegistry) BEFORE deduplication logic runs. This goes to 2 in the
   * regression where the same adapter appears in both slots, while adaptersByType
   * still holds only one entry (silent same-instance dedup). Used by the boot
   * invariant collector to detect duplicate-adapter wiring.
   */
  const rawHandlerCounts = new Map<string, number>();

  /** Per-channel reconnect tail prevents overlapping stop/start pairs. */
  const credentialReconnectTails = new Map<string, Promise<void>>();
  /** A removed credential makes its adapter unavailable even while stop is pending. */
  const credentialRemovedChannelTypes = new Set<string>();
  let stopping = false;
  let secretChangedListener: ((event: EventMap["secret:changed"]) => void) | undefined;

  /**
   * Pipeline deps for processInboundMessage at all three call sites
   * (debounce flush handler, normal onMessage handler, injectMessage).
   * In-flight outbound `Promise` tracking lives INSIDE DeliveryService —
   * drainInFlight() replaces the inline Promise.race in stopAll() below;
   * the seam no longer threads through pipelineDeps.
   */
  const pipelineDeps: ChannelManagerDeps = deps;

  // Clean up stale send overrides when sessions expire
  deps.eventBus.on("session:expired", (ev) => {
    const reference = createConversationRef(ev.conversationScope);
    if (reference.ok) sendOverrides.delete(reference.value);
  });

  // Targeted channel adapter lifecycle updates when credentials change.
  if (deps.channelCredentialMap && deps.channelCredentialMap.size > 0) {
    secretChangedListener = ({ name, action }) => {
      if (stopping) return;
      const channelType = deps.channelCredentialMap!.get(name);
      if (!channelType) return;
      if (action === "removed") {
        credentialRemovedChannelTypes.add(channelType);
        activeChannelTypes.delete(channelType);
      } else {
        credentialRemovedChannelTypes.delete(channelType);
      }
      const adapter = adaptersByType.get(channelType);
      if (!adapter) return;
      const prior = credentialReconnectTails.get(channelType) ?? Promise.resolve();
      const reconnect = prior.then(async () => {
        if (stopping) return;
        const startedAt = systemNowMs();
        try {
          const stopped = await adapter.stop();
          if (!stopped.ok) {
            deps.logger.warn(
              {
                submodule: "credential-rotation-reconnect",
                err: toSafeErrorLogString(stopped.error),
                channelType,
                credentialName: name,
                hint: action === "removed"
                  ? "Resolve the adapter shutdown failure and retry credential removal"
                  : "Resolve the adapter shutdown failure before retrying credential rotation",
                errorKind: "platform" as const,
              },
              action === "removed"
                ? "Channel adapter stop failed after credential removal"
                : "Channel adapter reconnect failed after credential rotation",
            );
            return;
          }
          activeChannelTypes.delete(channelType);
          if (action === "removed") {
            deps.logger.info(
              {
                submodule: "credential-rotation-reconnect",
                step: "credential-removal-stop",
                channelType,
                credentialName: name,
                durationMs: systemNowMs() - startedAt,
              },
              "Channel adapter stopped after credential removal",
            );
            return;
          }
          if (stopping || credentialRemovedChannelTypes.has(channelType)) return;
          const started = await adapter.start();
          if (!started.ok) {
            deps.logger.warn(
              {
                submodule: "credential-rotation-reconnect",
                err: toSafeErrorLogString(started.error),
                channelType,
                credentialName: name,
                hint: "Verify the rotated credential and restart the channel adapter",
                errorKind: "platform" as const,
              },
              "Channel adapter reconnect failed after credential rotation",
            );
            return;
          }
          if (stopping || credentialRemovedChannelTypes.has(channelType)) return;
          activeChannelTypes.add(channelType);
          deps.logger.info(
            {
              submodule: "credential-rotation-reconnect",
              step: "credential-rotation-reconnect",
              channelType,
              credentialName: name,
              durationMs: systemNowMs() - startedAt,
            },
            "Channel adapter reconnected after credential rotation",
          );
        } catch (err) {
          deps.logger.warn(
            {
              submodule: "credential-rotation-reconnect",
              err: toSafeErrorLogString(err),
              channelType,
              credentialName: name,
              hint: action === "removed"
                ? "Retry credential removal after resolving the adapter shutdown failure"
                : "Channel adapter reconnect failed after credential rotation; adapter may be in stopped state",
              errorKind: "platform" as const,
            },
            action === "removed"
              ? "Channel adapter stop failed after credential removal"
              : "Channel adapter reconnect failed after credential rotation",
          );
        }
      });
      credentialReconnectTails.set(channelType, reconnect);
      void reconnect.then(() => {
        if (credentialReconnectTails.get(channelType) === reconnect) {
          credentialReconnectTails.delete(channelType);
        }
      });
    };
    deps.eventBus.on("secret:changed", secretChangedListener);
  }

  return {
    async startAll(): Promise<void> {
      // Dedup adapters by channelType. Both deps.adapters and
      // deps.channelRegistry.getChannelPlugins() may reference the same
      // adapter instance (the daemon composition root historically fed
      // both — see fix in setup-channels-runtime.ts). Iterating a
      // channelType-keyed Map ensures adapter.onMessage / adapter.start
      // fire exactly once per channelType even if a future caller
      // re-introduces a duplicate source. Collision between DISTINCT
      // adapter objects claiming the same channelType is logged as a
      // structured WARN — first-wins because deps.adapters enumerates
      // before channelRegistry in source order.
      const registryAdapters = deps.channelRegistry
        ? deps.channelRegistry.getChannelPlugins().map((p) => p.adapter)
        : [];
      for (const adapter of [...(deps.adapters ?? []), ...registryAdapters]) {
        // Count raw registrations before dedup (seam — goes to 2 in regression).
        rawHandlerCounts.set(adapter.channelType, (rawHandlerCounts.get(adapter.channelType) ?? 0) + 1);

        const existing = adaptersByType.get(adapter.channelType);
        if (existing === undefined) {
          adaptersByType.set(adapter.channelType, adapter);
          continue;
        }
        if (existing === adapter) {
          // Same instance from both sources — silent dedup (the documented
          // pre-fix daemon wiring). No warn; this is benign.
          continue;
        }
        // Distinct adapter object collision — wiring mistake.
        deps.logger.warn(
          {
            channelType: adapter.channelType,
            firstAdapterId: existing.channelId,
            skippedAdapterId: adapter.channelId,
            hint: "Two distinct adapter objects claim the same channelType; check setup-channels-adapters.ts for duplicate plugin registration.",
            errorKind: "config" as const,
          },
          "Duplicate channelType registered; keeping first adapter, skipping subsequent",
        );
      }

      for (const adapter of adaptersByType.values()) {
        // Register message handler before starting
        adapter.onMessage(async (msg: NormalizedMessage) => {
          const processMessage = async (): Promise<void> => {
            try {
              // Fire onMessageReceived BEFORE await processInboundMessage so any
              // mid-processing SIGUSR2 still sees the session in continuation
              // tracker state.
              deps.onMessageReceived?.(msg, adapter.channelType);
              await deps.processInboundMessage(pipelineDeps, adapter, msg, activePacers, sendOverrides);
              deps.onMessageProcessed?.(msg, adapter.channelType);
            } catch (error) {
              deps.logger.error(
                {
                  err: toSafeErrorLogString(error),
                  channelId: adapter.channelId,
                  hint: "Check inbound pipeline for unhandled errors in message processing",
                  errorKind: "internal" as const,
                },
                "Unhandled error in message handler",
              );
              return Promise.reject(error);
            }
          };

          if (msg.channelType !== adapter.channelType) {
            rejectInboundDispatch(
              deps,
              adapter,
              msg,
              "Ensure normalized message channelType matches the receiving adapter before dispatch",
            );
            return;
          }

          const ingressContext = tryGetContext();
          const messageTraceId = getMessageTraceId(msg);
          if (ingressContext !== undefined && messageTraceId !== undefined) {
            const matchesAdapterScope = ingressContext.channelType === adapter.channelType
              && messageTraceId === ingressContext.traceId
              && isUnresolvedIngressContext(ingressContext);
            if (!matchesAdapterScope) {
              rejectInboundDispatch(
                deps,
                adapter,
                msg,
                "Ensure each traced message is dispatched inside its matching unresolved adapter ingress context",
              );
              return;
            }
            seedMetadataTraceId(msg, ingressContext.traceId);
            await processMessage();
            return;
          }

          // A custom adapter may invoke the handler without an ingress scope.
          // Establish one fallback boundary for that entire turn.
          const traceId = messageTraceId ?? randomUUID();
          const startedAt = resolveInboundStartedAt(traceId);
          seedMetadataTraceId(msg, traceId);
          await runWithContext({
            traceId,
            startedAt,
            channelType: adapter.channelType,
            tenantId: deps.tenantId,
            trustLevel: "user",
          }, processMessage);
        });

        // Register the inbound-reaction fanout if the adapter exposes
        // it (Discord/Slack/Telegram). No-op adapters omit onReaction → the
        // optional-call form registers nothing (honest no-op, NOT a gap).
        adapter.onReaction?.((reaction: NormalizedReaction) => {
          // Validate the binder-built reaction at the trust boundary (the
          // single fanout chokepoint all three platform binders converge on)
          // through the domain `parseReaction` strictObject — it rejects an
          // empty/missing platform id or any smuggled field BEFORE the
          // content-free event reaches the bus. A reaction is UNTRUSTED inbound;
          // an invalid one is a fail-closed DROP (WARN, non-fatal), never an emit.
          const parsed = parseReaction(reaction);
          if (!parsed.ok) {
            deps.logger.warn(
              {
                channelType: reaction.channelType,
                errorKind: "validation" as const,
                hint: "An inbound reaction failed NormalizedReaction validation at the fanout boundary; the reaction was dropped (it never reached the outcome wiring)",
              },
              "Dropped malformed inbound reaction",
            );
            return;
          }
          // A reaction is NOT an inbound turn — do NOT mint a request context.
          // Emit the capture event (ids/emoji only); the daemon
          // resolves the messageId→trajectory and observes the outcome. PLAIN
          // emit (not ?.) so the architecture gate's regex + the type system
          // both see it.
          deps.eventBus.emit("channel:reaction_received", {
            messageId: parsed.value.messageId,
            reactorId: parsed.value.reactorId,
            emoji: parsed.value.emoji,
            channelType: parsed.value.channelType,
            channelId: parsed.value.channelId,
            timestamp: systemNowMs(),
          });
        });

        if (credentialRemovedChannelTypes.has(adapter.channelType)) {
          deps.logger.warn(
            {
              adapterId: adapter.channelId,
              channelType: adapter.channelType,
              hint: "Restore the channel credential before starting this adapter",
              errorKind: "config" as const,
            },
            "Skipped adapter start because its credential was removed",
          );
          continue;
        }

        // Start the adapter
        const result = await adapter.start();
        if (!result.ok) {
          deps.logger.error(
            {
              err: result.error,
              adapterId: adapter.channelId,
              hint: "Check adapter configuration and platform credentials",
              errorKind: "config" as const,
            },
            "Failed to start adapter",
          );
          continue;
        }

        if (!credentialRemovedChannelTypes.has(adapter.channelType)) {
          activeChannelTypes.add(adapter.channelType);
        }
        deps.logger.info(
          { step: "channel-registry", adapterId: adapter.channelId, channelType: adapter.channelType },
          "Adapter registered",
        );
      }
    },

    async stopAll(): Promise<void> {
      stopping = true;
      if (secretChangedListener) {
        deps.eventBus.off("secret:changed", secretChangedListener);
      }
      await Promise.all([...credentialReconnectTails.values()]);
      // Drain command queue before stopping adapters (if queue is provided)
      if (deps.commandQueue) {
        await deps.commandQueue.shutdown();
      }

      // Cancel all active block pacers for graceful shutdown
      for (const pacer of activePacers) {
        pacer.cancel();
      }

      // Await in-flight outbound sends with a 5s deadline so SIGUSR2 cannot
      // tear down adapters mid-HTTP-response (which would orphan the SQLite
      // delivery-queue ack and trigger a duplicate retry on the next instance).
      // Drain logic lives inside DeliveryService; empty-Set fast path inside
      // `drainInFlight` returns `{drained: 0, remaining: 0, durationMs: 0}`
      // with no setTimeout/Promise.race so shutdown latency is preserved when
      // nothing is in flight.
      const drainResult = await deps.deliveryService.drainInFlight(5000);
      if (drainResult.drained > 0 || drainResult.remaining > 0) {
        deps.logger.info(
          {
            inFlightCount: drainResult.drained + drainResult.remaining,
            drainMs: drainResult.durationMs,
            remaining: drainResult.remaining,
            hint: "Outbound sends drained before adapter teardown to avoid duplicate-message risk on SIGUSR2 hot-reload",
          },
          "Channel manager: in-flight outbound sends drained",
        );
      }

      // Iterate the channelType-keyed Map populated in startAll(). This
      // matches startAll's iteration and ensures adapter.stop() fires
      // exactly once per channelType.
      for (const adapter of adaptersByType.values()) {
        const result = await adapter.stop();
        if (!result.ok) {
          deps.logger.error(
            {
              err: result.error,
              adapterId: adapter.channelId,
              hint: "Adapter cleanup failed; resources may not be freed",
              errorKind: "internal" as const,
            },
            "Failed to stop adapter",
          );
        }
      }
      activeChannelTypes.clear();
    },

    get activeCount(): number {
      return activeChannelTypes.size;
    },

    async injectMessage(
      channelType: string,
      msg: NormalizedMessage,
      context?: Pick<RequestContext, "resolvedLanguage">,
    ): Promise<void> {
      // Prefer the startAll()-registered adapter; fall back to the daemon's live
      // boot registry for adapters added after boot (activation test).
      const adapter = adaptersByType.get(channelType) ?? deps.adapterRegistry?.get(channelType);
      if (!adapter) {
        deps.logger.warn(
          { channelType, hint: "No adapter registered for this channel type; continuation skipped", errorKind: "config" as const },
          "Cannot inject message: adapter not found",
        );
        return;
      }
      if (adapter.channelType !== channelType || msg.channelType !== channelType) {
        rejectInboundDispatch(
          deps,
          adapter,
          msg,
          "Ensure injected channelType, adapter channelType, and message channelType are identical",
        );
        return;
      }
      // Two-callback contract (symmetric with the normal inbound path):
      //   onMessageReceived fires BEFORE processInboundMessage so any
      //     mid-execution SIGUSR2 sees the session in continuation tracker
      //     state. Daemon wires this to continuationTracker.track(...).
      //   onMessageProcessed fires AFTER processing for post-processing state
      //     that depends on deferred refs (e.g. sessionTrackerRef.recordActivity).
      // Adapter-missing paths intentionally bypass both callbacks.
      // Establish the per-turn request context (traceId) BEFORE processing, mirroring
      // the normal onMessage path (above). Without this wrap the injected turn runs
      // with no AsyncLocalStorage context, so the inbound activity coordinator
      // subscribes with `traceId = formatSessionKey(sessionKey)` (the pipeline fallback)
      // while the agent execution emits activity events under its OWN fresh traceId —
      // the ActivityStream's {agentId,sessionKey,traceId} turn filter never matches and
      // renderer.apply never fires. Sharing one traceId across the pipeline +
      // the agent run makes the coordinator's subscription observe the turn's tool:*/model:* events.
      const traceId = getMessageTraceId(msg) ?? randomUUID();
      const startedAt = resolveInboundStartedAt(traceId);
      seedMetadataTraceId(msg, traceId);
      await runWithContext(
        {
          traceId,
          startedAt,
          channelType: adapter.channelType,
          tenantId: deps.tenantId,
          trustLevel: "user",
          resolvedLanguage: context?.resolvedLanguage,
        },
        async () => {
          deps.onMessageReceived?.(msg, channelType);
          await deps.processInboundMessage(pipelineDeps, adapter, msg, activePacers, sendOverrides);
          deps.onMessageProcessed?.(msg, channelType);
        },
      );
    },

    getRawHandlerCounts(): ReadonlyMap<string, number> {
      return rawHandlerCounts;
    },
  };
}
