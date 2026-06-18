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

import type { AgentExecutor } from "@comis/agent";
// MessageRouter lives in orchestrator. Relative path used because the
// orchestrator package cannot import its own published name.
import type { MessageRouter } from "./routing/message-router.js";
import type { SessionLifecycle } from "@comis/agent";
// Queue types live in orchestrator. Relative path used because the
// orchestrator package cannot import its own published name.
import type { CommandQueue } from "./queue/command-queue.js";
import type { ActiveRunRegistry, BackgroundSessionResolver } from "@comis/agent";
import type { InteractiveCallbackRouter } from "./approval/index.js";
import type { ChannelPort, DeliveryQueuePort, NormalizedMessage, NormalizedReaction, SessionKey, TypedEventBus, DeliveryService } from "@comis/core";
// Orchestrator imports ONLY the @comis/core activity port + ctx type
// (never the observability impl — hexagonal boundary). The
// ActivityTurnCoordinator is a local execution type.
import type { ActivityStreamPort, TurnActivityContext } from "@comis/core";
import type { ActivityTurnCoordinator } from "./execution/activity-turn-coordinator.js";
import type { StreamingConfig } from "@comis/core";
import type { AutoReplyEngineConfig, SendPolicyConfig, QueueConfig, ElevatedReplyConfig } from "@comis/core";
import { formatSessionKey, runWithContext, getMessageTraceId, systemNowMs, parseReaction } from "@comis/core";
import { randomUUID } from "node:crypto";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";

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
  eventBus: TypedEventBus;
  messageRouter: MessageRouter;
  sessionManager: SessionLifecycle;
  createExecutor: (agentId: string) => AgentExecutor | undefined;
  /** Direct adapter list. Optional when channelRegistry provides plugin-registered adapters. */
  adapters?: ChannelPort[];
  logger: ComisLogger;
  /** Optional media preprocessor -- transcribes voice and analyzes images before agent dispatch. */
  preprocessMessage?: (msg: NormalizedMessage) => Promise<NormalizedMessage>;
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
   * synthetic injected messages. Does NOT fire for early-return paths
   * (no-adapter warning, graph-report intercept).
   */
  onMessageReceived?: (msg: NormalizedMessage, channelType: string) => void;
  /** Optional callback fired AFTER each successful inbound message processing. Used by post-processing state (e.g. notification session activity recording). */
  onMessageProcessed?: (msg: NormalizedMessage, channelType: string) => void;
  /** When true, lifecycle reactor handles queued/thinking reactions -- skip ack reaction in inbound pipeline. */
  lifecycleReactionsEnabled?: boolean;
  /** Pre-agent intercept for graph report button callbacks. When present, "graph:report:{graphId}" callbacks bypass the agent and deliver the full report as a file attachment. */
  onGraphReportRequest?: (graphId: string, channelType: string, channelId: string, adapter: ChannelPort, threadId?: string) => Promise<void>;
  /** Response prefix config for template-based prefix/suffix on agent responses. */
  responsePrefixConfig?: { template: string; position: "prepend" | "append" };
  /** Template context builder for response prefix variables. */
  buildTemplateContext?: (agentId: string, channelType: string, msg: NormalizedMessage) => Record<string, string>;
  /** Optional approval gate for /approve and /deny chat commands. When absent, approval commands pass through as plain text. */
  approvalGate?: {
    resolveApproval(requestId: string, approved: boolean, approvedBy: string, reason?: string): void;
    pending(): Array<{ requestId: string; shortId: string; sessionKey: string; action: string; toolName: string }>;
    getRequest(requestId: string): { requestId: string; sessionKey: string } | undefined;
    /** Resolve a minted 12-char shortId to its pending request. Gate-internal; channels never call this. */
    getRequestByShortId(shortId: string): { requestId: string; shortId: string; sessionKey: string; action: string; toolName: string } | undefined;
    /** Pending requests scoped to a session (the plain-text/button resolution source). */
    pendingForSession(sessionKey: string): Array<{ requestId: string; shortId: string; sessionKey: string; action: string; toolName: string }>;
  };
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
   * inbound-gate.ts special-cases /export-trajectory with owner-gate + DM
   * routing before the generic handleSlashCommand block. When absent,
   * /export-trajectory falls through to generic slash command handling (no-op).
   * Injected by daemon wiring via ChannelManagerBuildDeps.
   */
  exportSessionBundle?: (sessionId: string) => Promise<{ bundlePath: string }>;
  /**
   * Credential-to-channelType mapping for targeted reconnect on secret rotation.
   * Maps credential name (e.g. "TELEGRAM_BOT_TOKEN") to channelType (e.g. "telegram").
   * When present, a secret:changed event with action="upserted" triggers stop()+start()
   * on the adapter whose channelType matches the mapped value.
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
  injectMessage(channelType: string, msg: NormalizedMessage): Promise<void>;
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
  let _activeCount = 0;

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
    sendOverrides.delete(formatSessionKey(ev.sessionKey));
  });

  // Targeted channel adapter reconnect on credential rotation.
  // When a channel credential is rotated (action="upserted"), stop() the specific
  // adapter and start() it again so it picks up the new credential value from the
  // live secretManager. Only fires when channelCredentialMap is configured.
  // action="removed" is NOT handled here — deletion is the responsibility of the
  // credential-deletion plan (the adapter stops, it does not restart with nothing).
  if (deps.channelCredentialMap && deps.channelCredentialMap.size > 0) {
    deps.eventBus.on("secret:changed", ({ name, action }) => {
      if (action !== "upserted") return;
      const channelType = deps.channelCredentialMap!.get(name);
      if (!channelType) return;
      const adapter = adaptersByType.get(channelType);
      if (!adapter) return;
      // Fire-and-forget with explicit error capture: the event bus is void-typed
      // and does not observe the returned Promise, so an unhandled async throw
      // would produce an unhandled rejection. The void-IIFE ensures rejections
      // are always caught here.
      void (async () => {
        try {
          await adapter.stop();
          await adapter.start();
          deps.logger.info(
            {
              submodule: "credential-rotation-reconnect",
              step: "credential-rotation-reconnect",
              channelType,
              credentialName: name,
            },
            "Channel adapter reconnected after credential rotation",
          );
        } catch (err) {
          deps.logger.warn(
            {
              submodule: "credential-rotation-reconnect",
              err: err instanceof Error ? err : new Error(String(err)),
              channelType,
              credentialName: name,
              hint: "Channel adapter reconnect failed after credential rotation; adapter may be in stopped state",
              errorKind: "platform" as const,
            },
            "Channel adapter reconnect failed after credential rotation",
          );
        }
      })();
    });
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
          // Defense-in-depth wrap. Reuse the traceId minted at adapter
          // ingress via getMessageTraceId; fall back to randomUUID() if a
          // future adapter bypasses ingress wrap (catches regressions —
          // channel→queue→agent correlation is preserved even without the
          // adapter-level wrap).
          const traceId = getMessageTraceId(msg) ?? randomUUID();
          seedMetadataTraceId(msg, traceId);
          await runWithContext(
            {
              traceId,
              startedAt: systemNowMs(),
              channelType: adapter.channelType,
              tenantId: "default",
              trustLevel: "admin",
            },
            async () => {
              try {
                // Pre-agent intercept: graph report button callbacks
                if (
                  deps.onGraphReportRequest
                  && msg.metadata?.isButtonCallback === true
                  && typeof msg.text === "string"
                  && msg.text.startsWith("graph:report:")
                ) {
                  const graphId = msg.text.slice("graph:report:".length);
                  if (graphId.length > 0) {
                    await deps.onGraphReportRequest(
                      graphId,
                      adapter.channelType,
                      msg.channelId,
                      adapter,
                      msg.metadata?.threadId as string | undefined,
                    );
                    return; // Handled -- do not forward to agent
                  }
                }
                // Fire onMessageReceived BEFORE await processInboundMessage so any
                // mid-processing SIGUSR2 still sees the session in continuation
                // tracker state. The graph-report intercept above must remain BEFORE
                // this call so control-plane callbacks bypass both hooks.
                deps.onMessageReceived?.(msg, adapter.channelType);
                await deps.processInboundMessage(pipelineDeps, adapter, msg, activePacers, sendOverrides);
                deps.onMessageProcessed?.(msg, adapter.channelType);
              } catch (error) {
                deps.logger.error(
                  {
                    err: error instanceof Error ? error : new Error(String(error)),
                    channelId: adapter.channelId,
                    hint: "Check inbound pipeline for unhandled errors in message processing",
                    errorKind: "internal" as const,
                  },
                  "Unhandled error in message handler",
                );
              }
            },
          );
        });

        // REACT-01: register the inbound-reaction fanout if the adapter exposes
        // it (Discord/Slack/Telegram). No-op adapters omit onReaction → the
        // optional-call form registers nothing (honest no-op, NOT a gap).
        adapter.onReaction?.((reaction: NormalizedReaction) => {
          // WR-02: validate the binder-built reaction at the trust boundary (the
          // single fanout chokepoint all three platform binders converge on)
          // through the domain `parseReaction` strictObject — it rejects an
          // empty/missing platform id or any smuggled field (V5) BEFORE the
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
          // Emit the capture event (ids/emoji only); the daemon (Plan 04)
          // resolves the messageId→trajectory and observes the outcome. PLAIN
          // emit (not ?.) so the architecture gate's regex + the type system
          // both see it (RESEARCH Pitfall 6).
          deps.eventBus.emit("channel:reaction_received", {
            messageId: parsed.value.messageId,
            reactorId: parsed.value.reactorId,
            emoji: parsed.value.emoji,
            channelType: parsed.value.channelType,
            channelId: parsed.value.channelId,
            timestamp: systemNowMs(),
          });
        });

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

        _activeCount++;
        deps.logger.info(
          { step: "channel-registry", adapterId: adapter.channelId, channelType: adapter.channelType },
          "Adapter registered",
        );
      }
    },

    async stopAll(): Promise<void> {
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
      _activeCount = 0;
    },

    get activeCount(): number {
      return _activeCount;
    },

    async injectMessage(channelType: string, msg: NormalizedMessage): Promise<void> {
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
      // Pre-agent intercept for injected messages too
      if (
        deps.onGraphReportRequest
        && msg.metadata?.isButtonCallback === true
        && typeof msg.text === "string"
        && msg.text.startsWith("graph:report:")
      ) {
        const graphId = msg.text.slice("graph:report:".length);
        if (graphId.length > 0) {
          await deps.onGraphReportRequest(graphId, channelType, msg.channelId, adapter, msg.metadata?.threadId as string | undefined);
          return;
        }
      }
      // Two-callback contract (symmetric with the normal inbound path):
      //   onMessageReceived fires BEFORE processInboundMessage so any
      //     mid-execution SIGUSR2 sees the session in continuation tracker
      //     state. Daemon wires this to continuationTracker.track(...).
      //   onMessageProcessed fires AFTER processing for post-processing state
      //     that depends on deferred refs (e.g. sessionTrackerRef.recordActivity).
      // Both early-return branches above (no-adapter warn, graph-report intercept)
      // intentionally bypass both callbacks because they represent control-plane
      // events, not real session activity.
      deps.onMessageReceived?.(msg, channelType);
      // Establish the per-turn request context (traceId) BEFORE processing, mirroring
      // the normal onMessage path (above). Without this wrap the injected turn runs
      // with no AsyncLocalStorage context, so the inbound activity coordinator
      // subscribes with `traceId = formatSessionKey(sessionKey)` (the pipeline fallback)
      // while the agent execution emits activity events under its OWN fresh traceId —
      // the ActivityStream's {agentId,sessionKey,traceId} turn filter never matches and
      // renderer.apply never fires. Sharing one traceId across the pipeline +
      // the agent run makes the coordinator's subscription observe the turn's tool:*/model:* events.
      const traceId = getMessageTraceId(msg) ?? randomUUID();
      seedMetadataTraceId(msg, traceId);
      await runWithContext(
        {
          traceId,
          startedAt: systemNowMs(),
          channelType: adapter.channelType,
          tenantId: "default",
          trustLevel: "admin",
        },
        async () => {
          await deps.processInboundMessage(pipelineDeps, adapter, msg, activePacers, sendOverrides);
        },
      );
      deps.onMessageProcessed?.(msg, channelType);
    },

    getRawHandlerCounts(): ReadonlyMap<string, number> {
      return rawHandlerCounts;
    },
  };
}
