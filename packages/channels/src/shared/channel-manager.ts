// SPDX-License-Identifier: Apache-2.0
/**
 * Channel Manager: Thin lifecycle coordinator for channel adapters.
 *
 * Delegates message processing to the inbound pipeline and execution
 * to the execution pipeline. This module only handles:
 * - Adapter lifecycle (startAll / stopAll)
 * - Closure state (activePacers, sendOverrides, adaptersByType)
 * - Session expiry cleanup
 * - Debounce flush handler registration
 *
 * Pipeline modules:
 * - execution-pipeline.ts: outbound delivery (executeAndDeliver)
 * - inbound-pipeline.ts: inbound message processing (processInboundMessage)
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
import { formatSessionKey } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";

import type { BlockPacer } from "./block-pacer.js";
import type { ChannelRegistry } from "./channel-registry.js";
import { createSendOverrideStore } from "./send-policy.js";
import type { SendOverrideStore } from "./send-policy.js";
import type { PreflightResult } from "./audio-preflight.js";
import type { RetryEngine } from "./retry-engine.js";
import type { GroupHistoryBuffer } from "./group-history-buffer.js";
import type { VoiceResponsePipelineDeps } from "./voice-response-pipeline.js";
import type { InboundPipelineDeps } from "./inbound-pipeline.js";
import { processInboundMessage } from "./inbound-pipeline.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChannelManagerDeps {
  eventBus: TypedEventBus;
  messageRouter: MessageRouter;
  sessionManager: SessionManager;
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
  /** Optional identity link resolver for cross-platform user recognition. When absent, senderId is used directly. */
  identityResolver?: { resolve(provider: string, providerUserId: string): string | undefined };
  /** Optional DM scope config callback per agent. When absent, defaults to per-channel-peer (current behavior). */
  getDmScopeConfig?: (agentId: string) => { mode?: string; agentPrefix?: boolean; threadIsolation?: boolean } | undefined;
  /** Optional retry engine for resilient message delivery. When absent, sends use adapter.sendMessage directly. */
  retryEngine?: RetryEngine;
  /** Delivery queue for crash-safe message persistence. Optional -- when absent, agent responses skip queue. */
  deliveryQueue?: DeliveryQueuePort;
  /** Optional ingress debounce buffer for coalescing rapid messages before queue entry. When absent, messages go directly to CommandQueue. */
  debounceBuffer?: DebounceBuffer;
  /** Optional group history buffer for context injection in group chats. When absent, group history injection is disabled. */
  groupHistoryBuffer?: GroupHistoryBuffer;
  /** Optional follow-up trigger for re-enqueueing after tool/compaction results. When absent, no follow-up runs are triggered. */
  followupTrigger?: FollowupTrigger;
  /** Optional follow-up config for depth limits. When absent, defaults used from FollowupTrigger. */
  followupConfig?: { maxFollowupRuns: number };
  /** Optional priority scheduler for multi-lane queue processing. When absent, single global gate is used. */
  priorityScheduler?: PriorityScheduler;
  /** Optional queue config for lane assignment rules and priority scheduling. When absent, default lane assignment used. */
  queueConfig?: QueueConfig;
  /** Optional callback to get elevated reply config for an agent. When absent, no elevated routing. */
  getElevatedReplyConfig?: (agentId: string) => ElevatedReplyConfig | undefined;
  /** Optional session label store for label-aware group history. When absent, labels are not included in group history output. */
  sessionLabelStore?: SessionLabelStore;
  /** Optional ack reaction config for sending emoji reactions when processing starts. When absent, no ack reactions are sent. */
  ackReactionConfig?: AckReactionConfig;
  /** Optional prompt skill loader for /skill:name detection. Returns pre-expanded skill content string and allowed tools. When absent, skill commands pass through as plain text. */
  loadPromptSkill?: (name: string, args?: string) => Promise<Result<{ content: string; allowedTools: string[]; skillName: string }, Error>>;
  /** Optional callback to get user-invocable skill names for command matching. When absent, no skill command matching occurs. */
  getUserInvocableSkillNames?: () => Set<string>;
  /** Optional tool assembler for resolving agent tools before execution. When absent, executor receives no tools (undefined).
   *  The optional `options` object carries per-call wiring -- currently used to thread the inbound session's
   *  structural SessionKey so the assembled tools resolve the session-lifetime FileStateTracker via
   *  SessionTrackerRegistry (see setup-tools.ts). Shape is intentionally structural (not imported from @comis/daemon)
   *  to preserve the channels -> daemon dependency direction. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: SessionKey }) => Promise<any[]>;
  /** Optional greeting generator for persona-appropriate session reset messages. When absent, static "Session reset." is sent. */
  greetingGenerator?: { generate(agentName: string): Promise<Result<string, Error>> };
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
  /** Handle /config command. Returns response text or undefined if not a config command. */
  handleConfigCommand?: (args: string[], channelType: string) => Promise<string | undefined>;
  /** Optional callback for task extraction after successful agent execution. */
  onTaskExtraction?: (conversationText: string, sessionKey: string, agentId: string) => Promise<void>;
  /** Optional callback fired after each successful inbound message processing. Used by restart continuation tracker. */
  onMessageProcessed?: (msg: NormalizedMessage, channelType: string) => void;
  /** When true, lifecycle reactor handles queued/thinking reactions -- skip ack reaction in inbound pipeline. */
  lifecycleReactionsEnabled?: boolean;
  /** Pre-agent intercept for graph report button callbacks. When present, "graph:report:{graphId}" callbacks bypass the agent and deliver the full report as a file attachment. */
  onGraphReportRequest?: (graphId: string, channelType: string, channelId: string, adapter: ChannelPort, threadId?: string) => Promise<void>;
  /** Response prefix config for template-based prefix/suffix on agent responses. */
  responsePrefixConfig?: { template: string; position: "prepend" | "append" };
  /** Template context builder for response prefix variables. */
  buildTemplateContext?: (agentId: string, channelType: string, msg: NormalizedMessage) => Record<string, string>;
  /** Optional approval gate for /approve and /deny chat commands (APPR-CHAT). When absent, approval commands pass through as plain text. */
  approvalGate?: InboundPipelineDeps["approvalGate"];
  /** Handle general slash commands via command handler (CMD-WIRE). */
  handleSlashCommand?: InboundPipelineDeps["handleSlashCommand"];
  /** Per-agent enforceFinalTag config lookup. */
  getEnforceFinalTag?: InboundPipelineDeps["getEnforceFinalTag"];
  /**
   * Optional in-flight outbound sendMessage promise tracker. PRODUCTION
   * callers (daemon) MUST NOT pass this -- the factory creates its own
   * per-instance Set. Exposed via deps strictly to allow unit tests to
   * inject a controllable Set for drain-ordering and deadline assertions.
   * Drained in stopAll() with a 5s deadline so SIGUSR2 cannot tear down
   * adapters mid-send (which would orphan the SQLite delivery-queue ack
   * and trigger a duplicate retry on the next instance).
   */
  inFlightSends?: Set<Promise<unknown>>;
  /** Optional allowFrom sender filter lookup. Returns allowed sender IDs for a channel type. Empty array = allow all. */
  getAllowFrom?: (channelType: string) => string[];
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
   * Per-instance in-flight outbound sendMessage promises. Used by
   * deliver-to-channel.ts to register active sends; drained in stopAll() with
   * a 5s deadline so SIGUSR2 cannot tear down adapters mid-send (which would
   * orphan the SQLite delivery-queue ack and trigger a duplicate retry on the
   * next instance).
   *
   * Tests may inject a Set via deps.inFlightSends to seed controllable
   * promises for drain-ordering and deadline assertions; production callers
   * (daemon) must NOT pass this -- the factory creates its own.
   */
  const inFlightSends = deps.inFlightSends ?? new Set<Promise<unknown>>();

  /**
   * Pipeline deps with inFlightSends threaded in. Spread once so the Set is
   * visible to processInboundMessage at all three call sites (debounce flush
   * handler, normal onMessage handler, injectMessage). The original deps
   * object is left untouched -- callbacks like onMessageProcessed and
   * onGraphReportRequest live on the same reference (spread copies the
   * function references, not the underlying behavior).
   */
  const pipelineDeps: ChannelManagerDeps = { ...deps, inFlightSends };

  // Clean up stale overrides, debounce entries, and group history when sessions expire
  deps.eventBus.on("session:expired", (ev) => {
    sendOverrides.delete(formatSessionKey(ev.sessionKey));
    deps.debounceBuffer?.clear(ev.sessionKey);
    deps.groupHistoryBuffer?.clear(formatSessionKey(ev.sessionKey));
  });

  return {
    async startAll(): Promise<void> {
      // Build combined adapter list: direct adapters + plugin-registered adapters
      const registryAdapters = deps.channelRegistry
        ? deps.channelRegistry.getChannelPlugins().map((p) => p.adapter)
        : [];
      const allAdapters = [...(deps.adapters ?? []), ...registryAdapters];

      // Populate adapter lookup map for debounce flush handler routing
      for (const adapter of allAdapters) {
        adaptersByType.set(adapter.channelType, adapter);
      }

      // Register debounce flush handler (one-time, before adapter message handlers)
      if (deps.debounceBuffer) {
        deps.debounceBuffer.onFlush((sessionKey, messages, channelType) => {
          const adapter = adaptersByType.get(channelType);
          if (!adapter) return;
          // Create a synthetic message from the coalesced result with isDebounced flag
          // to skip the debounce buffer on re-entry into processInboundMessage.
          const coalesced = messages[0]!;
          const syntheticMsg: NormalizedMessage = {
            ...coalesced,
            metadata: { ...coalesced.metadata, isDebounced: true },
          };
          // Fire-and-forget: processInboundMessage is async but the flush callback is sync.
          // Errors are caught by the onMessage error handler.
          void processInboundMessage(pipelineDeps, adapter, syntheticMsg, activePacers, sendOverrides).catch((error) => {
            deps.logger.error(
              {
                err: error instanceof Error ? error : new Error(String(error)),
                channelType,
                hint: "Check debounce flush handler and inbound pipeline for unhandled errors",
                errorKind: "internal" as const,
              },
              "Debounce flush handler error",
            );
          });
        });
      }

      for (const adapter of allAdapters) {
        // Register message handler before starting
        adapter.onMessage(async (msg: NormalizedMessage) => {
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
            await processInboundMessage(pipelineDeps, adapter, msg, activePacers, sendOverrides);
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
          { adapterId: adapter.channelId, channelType: adapter.channelType },
          "Adapter registered",
        );
      }
    },

    async stopAll(): Promise<void> {
      // Flush and shutdown debounce buffer before draining queue
      if (deps.debounceBuffer) {
        deps.debounceBuffer.shutdown();
      }

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
      // Empty-Set fast path takes no log line, no setTimeout, no Promise.race --
      // existing shutdown latency is preserved when nothing is in flight.
      if (inFlightSends.size > 0) {
        const drainStart = Date.now();
        const inFlightCount = inFlightSends.size;
        await Promise.race([
          Promise.allSettled([...inFlightSends]),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
        deps.logger.info(
          {
            inFlightCount,
            drainMs: Date.now() - drainStart,
            remaining: inFlightSends.size,
            hint: "Outbound sends drained before adapter teardown to avoid duplicate-message risk on SIGUSR2 hot-reload",
          },
          "Channel manager: in-flight outbound sends drained",
        );
      }

      // Build combined adapter list: direct adapters + plugin-registered adapters
      const registryAdapters = deps.channelRegistry
        ? deps.channelRegistry.getChannelPlugins().map((p) => p.adapter)
        : [];
      const allAdapters = [...(deps.adapters ?? []), ...registryAdapters];

      for (const adapter of allAdapters) {
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
      const adapter = adaptersByType.get(channelType);
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
      await processInboundMessage(pipelineDeps, adapter, msg, activePacers, sendOverrides);
      // Symmetric with the normal inbound path (line 248): the synthetic
      // recovery user-message represents real session activity, so notify
      // the continuation tracker. Without this call, multi-restart chains
      // see an empty tracker on the second SIGUSR2 -> 0 captured -> the
      // next instance has nothing to replay (silent bot).
      deps.onMessageProcessed?.(msg, channelType);
    },
  };
}
