// SPDX-License-Identifier: Apache-2.0
/**
 * Cron-delivery event listener registration. Hosts the two `scheduler:job_*`
 * event handlers: `scheduler:job_result` (cron-driven memory review,
 * agent_turn dispatch, raw delivery) and `scheduler:job_suspended`
 * (consecutive-failure suspension notification).
 *
 * Per-agent API-key resolution + cron operation-model resolution live here
 * because each cron tick re-derives credentials from the daemon container
 * (no per-cron-job cache); this leaf is the credentials-resolution + event
 * dispatch concern boundary that the registry orchestrates.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { Attachment, AppContainer, ChannelPort, ClockPort, MemoryPort, MemoryEntityStore, MemoryCausalStore, MemoryConsolidationStore, TripleStorePort, RelationshipStore, MemoryUsefulnessStore, MemoryLifecyclePort, OutcomeSignalPort, MentalModelStorePort, NormalizedMessage, SessionKey, TranscriptionPort, DeliveryService } from "@comis/core";
import { formatSessionKey, runWithContext, createDeliveryOrigin, systemNowMs } from "@comis/core";
import { resolveCronJobCredential, cronCredentialSkipHint, cronCustomModelOpt } from "./setup-channels-cron-credential.js";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor, createSessionLifecycle, ActiveRunRegistry, OperationModelResolution } from "@comis/agent";
import type { createSessionStore, MemoryApi } from "@comis/memory";
import { sanitizeAssistantResponse, resolveOperationModel, resolveProviderFamily, runMemoryReview, classifyError } from "@comis/agent";
import { applyToolPolicy } from "@comis/skills";
import { buildReviewSessionSource } from "./review-session-source.js";
import { filterResponse } from "@comis/channels";
import type { ExecutionLogEntry } from "@comis/scheduler";
import { handleMemoryCronSentinel } from "./setup-channels-memory-crons.js";
import { buildReflectionCronDeps } from "./setup-channels-skill-synthesis-deps.js";
import { resolveMemoryOpsCapability } from "./resolve-memory-ops-capability.js";

/** Closure-captured dependencies for the cron delivery listeners. */
// @optional-field-count: 19 optional fields — CronEventListenerDeps is a composition-root cron-deps bag
// that accretes the OFFLINE memory-cron sentinels' injected ports (consolidation/triple/userrep/skill
// stores) alongside the channel/media optionals. Each is an optional injected port (absent on a
// default-config agent => that sentinel short-circuits). Tightening to required would force every non-cron
// caller to fabricate stubs; the cap flags undermodeled types, NOT a well-bounded accumulator (mirror BootContext).
export interface CronEventListenerDeps {
  container: AppContainer;
  executors: Map<string, AgentExecutor>;
  defaultAgentId: string;
  sessionManager: ReturnType<typeof createSessionLifecycle>;
  sessionStore: ReturnType<typeof createSessionStore>;
  logger: ComisLogger;
  /** Composition-root clock — threaded to runMemoryReview for relative-date resolution. */
  clock: ClockPort;
  /** Per-agent auto-refreshing OAuth token resolver (wraps OAuthTokenManager); lets background memory/learning jobs run on an OAuth main provider instead of skipping "no API key" (LEARN-01). Undefined ⇒ static-key/keyless only. */
  resolveAccessToken?: (agentId: string, provider: string) => Promise<string | undefined>;
  adaptersByType: Map<string, ChannelPort>;
  deliveryService: DeliveryService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires complex type parameters from pi-ai SDK
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: SessionKey }) => Promise<any[]>;
  transcriber?: TranscriptionPort;
  workspaceDirs?: Map<string, string>;
  memoryAdapter?: MemoryPort;
  /** LCD read + browse for the review session source (live 2026-06-11: DAG transcripts live in LCD, not the near-empty daemon store). Absent ⇒ daemon-store-only review. */
  lcdStore?: import("@comis/core").ContextStorePort; contextBrowse?: import("@comis/core").ContextBrowsePort;
  /** Entity-associative store. Threaded into runMemoryReview so each
   *  successfully-stored memory's entity mentions are resolved + linked
   *  (memory_entities / memory_entity_links), scoped to the entry's (tenantId, agentId).
   *  Absent => entities emitted but not persisted. Built in
   *  setup-memory on the SAME db handle the memory adapter owns. */
  entityStore?: MemoryEntityStore;
  /** Causal store. Threaded into runMemoryReview so each
   *  successfully-stored memory's extracted cause->effect pairs are linked via linkCausal
   *  (memory_causal_edges), scoped to the entry's (tenantId, agentId) in SQL — load-bearing
   *  isolation. Absent => causes parsed but not persisted. Built
   *  in setup-memory on the SAME db handle the memory adapter owns; the port TYPE (agent↛memory cut). */
  causalStore?: MemoryCausalStore;
  /** Consolidation store. Threaded into runMemoryConsolidation by the
   *  opt-in `__MEMORY_CONSOLIDATION__` sentinel below. Built in setup-memory on the SAME db
   *  handle the memory adapter owns; injected as the port TYPE (agent↛memory cut). Absent =>
   *  the sentinel cannot run, but the cron is off-by-default so a default-config agent never
   *  reaches it. */
  consolidationStore?: MemoryConsolidationStore;
  /** Triple store — deductive current-truth write path, threaded into runMemoryReasoning via
   *  the opt-in `__MEMORY_REASONING__` sentinel below (port TYPE, agent↛memory cut; same db
   *  handle as the memory adapter). Absent ⇒ sentinel can't run; cron is off-by-default. */
  tripleStore?: TripleStorePort;
  /** Per-user representation store — the offline-builder
   *  upsert write path. Threaded into runUserRepresentationBuild by the opt-in
   *  `__USER_REPRESENTATION__` sentinel below. Built in setup-memory on the SAME db handle the
  /** Directional relationship store — the __SOCIAL_MODELING__ sentinel's
   *  per-(tenant, agent, channel) directional-edge upsert write path. Built in setup-memory on the
   *  shared db handle; injected as the port TYPE (agent↛memory cut). Threaded the full daemon →
   *  registry → credentials chain — a missing thread would make the offline-builder write a silent
   *  no-op. Absent => the relationship sentinel cannot run, but the cron is off-by-default
   *  AND sign-off-gated so a default-config agent never reaches it. */
  relationshipStore?: RelationshipStore;
  /** Memory-lifecycle sweep store — the KEYLESS
   *  __MEMORY_LIFECYCLE__ sentinel's per-(tenant, agent) DORMANT runLifecycleSweep. Built in
   *  setup-memory on the shared db handle; injected as the port TYPE (agent↛memory cut). Threaded
   *  the full daemon → registry → credentials chain — a missing thread would make the sweep a
   *  silent no-op (the field-plumbing lesson). Absent => the lifecycle sentinel cannot run, but the
   *  cron is off-by-default so a default-config agent never reaches it. */
  memoryLifecycleStore?: MemoryLifecyclePort;
  /** Recall-utility usefulness store — the __USEFULNESS_JUDGE__ sentinel records its
   *  verdict through it (`recordUsage`). Built in setup-memory on the shared db handle;
   *  injected as the port TYPE (agent↛memory cut). (The __ONLINE_TUNING__ bandit FEED read
   *  was deleted in Phase 224.) */
  usefulnessStore?: MemoryUsefulnessStore;
  outcomeStore?: OutcomeSignalPort; // v2.31 Reflection: the __REFLECT__ runReflection fail-closed success gate (agent↛memory)
  learnedSkillStore?: MentalModelStorePort; // v2.31 Reflection: the __REFLECT__ get/admit target (agent↛memory; off-by-default)
  /** Per-user representation read surface — the __USER_REPRESENTATION__
   *  sentinel scopes the per-(tenant, agent, user) high-trust source read over `inspect`.
   *  Built in setup-memory; daemon-side (the agent imports no memory package). The SAME `inspect`
   *  surface backs the __SOCIAL_MODELING__ sentinel (grouped by resolved channelId). */
  memoryApi?: MemoryApi;
  tenantId?: string;
  piSessionAdapters?: Map<string, {
    getSessionStats(key: SessionKey): { messageCount: number; createdAt?: number; tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; userMessages?: number; assistantMessages?: number; toolCalls?: number; toolResults?: number; cost?: number } | undefined;
    destroySession(key: SessionKey): Promise<void>;
  }>;
  cronExecutionTrackers?: Map<string, { record(entry: ExecutionLogEntry): Promise<void> }>;
  // ChannelsDeps fields that flow through from the registry caller — used by
  // the agent_turn execution branch for tool-policy application + execution-
  // tracker bookkeeping.
  activeRunRegistry?: ActiveRunRegistry;
}

/**
 * Register the cron-driven event listeners on the daemon event bus.
 *
 * Two listeners are attached:
 *   1. `scheduler:job_result` — delivers cron job output back to the
 *      originating channel. Supports three payload kinds:
 *      - `__MEMORY_REVIEW__` sentinel → run memory review for the agent
 *      - `payloadKind === "agent_turn"` → execute the agent and deliver the
 *        sanitized response (with rolling/fresh/accumulate session strategy)
 *      - else (systemEvent) → deliver raw text
 *   2. `scheduler:job_suspended` — notify the channel when a cron job is
 *      auto-suspended after consecutive failures.
 */
export function registerCronEventListeners(deps: CronEventListenerDeps): void {
  const {
    container,
    executors,
    defaultAgentId,
    sessionManager,
    logger,
    adaptersByType,
    deliveryService,
  } = deps;

  const agents = container.config.agents;

  container.eventBus.on("scheduler:job_result", async (payload) => {
    // -- Memory review sentinel intercept --
    const resultText = payload.result;
    if (resultText === "__MEMORY_REVIEW__") {
      const { agentId } = payload;
      if (!agentId) {
        logger.warn({ hint: "Memory review job fired without agentId", errorKind: "config" as const }, "Skipping memory review -- no agentId");
        payload.onComplete?.({ status: "error", error: "No agentId for memory review" });
        return;
      }

      const agentConfig = agents[agentId];
      const memReviewConfig = agentConfig?.memoryReview;
      if (!memReviewConfig?.enabled) {
        logger.debug({ agentId }, "Memory review disabled for agent, skipping");
        payload.onComplete?.({ status: "ok" });
        return;
      }

      // Resolve cheap "cron" model for review + the provider API key (by name).
      const resolved = resolveOperationModel({
        operationType: "cron",
        agentProvider: agentConfig.provider ?? "anthropic",
        agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
        operationModels: agentConfig.operationModels ?? {},
        providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
      });
      const providerEntry = container.config.providers?.entries?.[resolved.provider];
      const cred = await resolveCronJobCredential(container, agentId, resolved.provider, deps.resolveAccessToken);
      const apiKey = cred.apiKey;
      if (!apiKey) {
        logger.warn({ agentId, provider: resolved.provider, hint: cronCredentialSkipHint(cred, resolved.provider, "memory review"), errorKind: "config" as const }, "Skipping memory review -- no API key");
        payload.onComplete?.({ status: "error", error: `No API key for ` + resolved.provider });
        return;
      }

      const workspacePath = deps.workspaceDirs?.get(agentId) ?? "";
      const reviewLogger = logger.child({ agentId, submodule: "memory-review" });
      const reviewResult = await runMemoryReview({
        agentId,
        tenantId: deps.tenantId ?? container.config.tenantId ?? "default",
        agentName: agentConfig.name ?? agentId,
        config: memReviewConfig,
        memoryPort: deps.memoryAdapter!,
        // R6 (CR-01): small/nano cron model abstains via resolve-memory-ops-capability.ts (never fabricates into trusted storage).
        ...resolveMemoryOpsCapability(resolved, providerEntry?.capabilities),
        sessionStore: buildReviewSessionSource({ sessionStore: deps.sessionStore as unknown as Parameters<typeof buildReviewSessionSource>[0]["sessionStore"], lcdStore: deps.lcdStore, contextBrowse: deps.contextBrowse, agentId, tenantId: deps.tenantId ?? container.config.tenantId ?? "default" }),
        eventBus: container.eventBus,
        workspacePath,
        provider: resolved.provider,
        modelId: resolved.modelId,
        apiKey,
        ...cronCustomModelOpt(providerEntry, resolved.provider, resolved.modelId),
        clock: deps.clock,
        // Persist each stored memory's entity mentions; scoped to (tenantId, agentId) in SQL. Absent => emit-only.
        entityStore: deps.entityStore,
        // Link each stored memory's extracted cause->effect pairs via
        // linkCausal. Scoped to (tenantId, agentId) in SQL. Absent =>
        // emit-only behaviour (causes parsed, no edge written).
        causalStore: deps.causalStore,
        logger: reviewLogger,
      });

      if (!reviewResult.ok) {
        logger.error({ agentId, err: reviewResult.error, hint: "Memory review failed -- will retry next cycle", errorKind: "internal" as const }, "Memory review error");
      }
      payload.onComplete?.({ status: reviewResult.ok ? "ok" : "error", error: reviewResult.ok ? undefined : reviewResult.error?.message });
      return;
    }

    // -- LLM-backed memory-cron sentinels (__MEMORY_CONSOLIDATION__ +
    //    __MEMORY_REASONING__) — extracted to setup-channels-memory-crons.ts
    //    to keep this leaf under the 600L cap. Both re-check cfg.enabled (the opt-in
    //    cost gate, defence-in-depth) and inject the segregated stores as port TYPES
    //    (the agent↛memory cut). Returns true when handled → we return here.
    const handledMemoryCron = await handleMemoryCronSentinel(resultText, payload, {
      container,
      logger,
      clock: deps.clock,
      agents,
      tenantId: deps.tenantId,
      consolidationStore: deps.consolidationStore,
      tripleStore: deps.tripleStore,
      relationshipStore: deps.relationshipStore,
      memoryLifecycleStore: deps.memoryLifecycleStore,
      usefulnessStore: deps.usefulnessStore,
      memoryApi: deps.memoryApi,
      reflection: buildReflectionCronDeps(deps), // v2.31 Reflection closed-graph bundle; undefined ⇒ off
      resolveAccessToken: deps.resolveAccessToken, // LEARN-01: OAuth-provider background jobs
    });
    if (handledMemoryCron) return;

    const { deliveryTarget, jobName, payloadKind } = payload;
    if (!deliveryTarget?.channelType) {
      logger.warn(
        { jobName, hint: "Delivery target missing channelType — ensure cron job was created from a channel context", errorKind: "config" as const },
        "Cron job result has no delivery target channel type, skipping delivery",
      );
      payload.onComplete?.({ status: "error", error: "No delivery target channel type" });
      return;
    }
    const adapter = adaptersByType.get(deliveryTarget.channelType);
    if (!adapter) {
      logger.warn(
        { channelType: deliveryTarget.channelType, jobName, hint: "Ensure the target channel adapter is started and registered", errorKind: "config" as const },
        "No adapter found for cron delivery target",
      );
      payload.onComplete?.({ status: "error", error: `No adapter for ${deliveryTarget.channelType}` });
      return;
    }

    // --- agentTurn: execute agent and deliver response ---
    if (payloadKind === "agent_turn") {
      const executor = executors.get(payload.agentId) ?? executors.get(defaultAgentId);
      if (!executor) {
        logger.error(
          { agentId: payload.agentId, jobName, hint: "Ensure executor is created for the agent referenced by the cron job", errorKind: "config" as const },
          "No executor found for cron agentTurn",
        );
        // Fallback: send raw text so the user at least gets something
        await deliveryService.deliverToChannel(adapter, deliveryTarget.channelId, resultText, undefined);
        payload.onComplete?.({ status: "error", error: "No executor found for agent" });
        return;
      }

      // Extract session strategy from event payload (defaults: fresh, 3 turns)
      const sessionStrategy = payload.sessionStrategy ?? "fresh";
      const maxHistoryTurns = payload.maxHistoryTurns ?? 3;

      // Cadence-aware cache-waste guard: rolling/accumulate strategies on long cadences
      // guarantee cache-write waste because the prompt cache TTL is short (5 min for "cron"
      // operations — see OPERATION_CACHE_DEFAULTS.cron in @comis/agent). Threshold = 2x TTL
      // so we don't warn on borderline-useful 6-9 min cadences. Operator intent is preserved
      // (no auto-downgrade) — this is informational only. Scoped to schedule.kind === "every"
      // because cron-expression cadence is not threaded through the event payload.
      const CRON_CACHE_TTL_2X_MS = 600_000;
      if (
        sessionStrategy !== "fresh" &&
        payload.cadenceMs !== undefined &&
        payload.cadenceMs > CRON_CACHE_TTL_2X_MS
      ) {
        logger.warn(
          {
            jobName,
            agentId: payload.agentId,
            sessionStrategy,
            cadenceMs: payload.cadenceMs,
            hint: "Cadence exceeds cache TTL by 2x; rolling/accumulate guarantees per-tick cache-write waste. Set sessionStrategy:'fresh' unless cross-tick session memory is essential.",
            errorKind: "config" as const,
          },
          "Cron sessionStrategy may waste cache writes at this cadence",
        );
      }

      // Resolve cron operation model via 5-level priority chain. LAT-01: cronOverrides.promptTimeout is materialized UNCONDITIONALLY, so it must carry resolution.timeoutSource — without the label, decode would treat the 150s cron default as an explicit operator override (the provenance-collapse trap).
      const agentConfig = agents[payload.agentId];
      let cronOverrides: { model: string; operationType: "cron"; promptTimeout: { promptTimeoutMs: number; source: OperationModelResolution["timeoutSource"] }; cacheRetention?: "none" | "short" | "long" } | undefined;
      if (agentConfig) {
        const resolution = resolveOperationModel({
          operationType: "cron",
          agentProvider: agentConfig.provider,
          agentModel: agentConfig.model,
          operationModels: agentConfig.operationModels ?? {},
          providerFamily: resolveProviderFamily(agentConfig.provider),
          invocationOverride: payload.cronJobModel,
          agentPromptTimeoutMs: agentConfig.promptTimeout?.promptTimeoutMs,
        });
        cronOverrides = {
          model: resolution.model,
          operationType: "cron",
          promptTimeout: { promptTimeoutMs: resolution.timeoutMs, source: resolution.timeoutSource },
          cacheRetention: payload.cacheRetention ?? resolution.cacheRetention,
        };
        logger.info(
          { jobName, model: resolution.model, source: resolution.source, agentId: payload.agentId },
          "Cron model resolved",
        );
      }

      const sessionKey: SessionKey = {
        tenantId: deliveryTarget.tenantId,
        userId: deliveryTarget.userId,
        channelId: `cron:${payload.jobId}`,
      };

      // Fresh strategy — expire existing session before each execution
      if (sessionStrategy === "fresh") {
        sessionManager.expire(sessionKey);

        const piAdapter = deps.piSessionAdapters?.get(payload.agentId)
                       ?? deps.piSessionAdapters?.get(defaultAgentId);
        if (piAdapter) {
          await piAdapter.destroySession(sessionKey);
        } else {
          logger.warn(
            { agentId: payload.agentId, jobName, hint: "No piSessionAdapter found — JSONL may accumulate", errorKind: "config" as const },
            "Cron fresh strategy could not destroy JSONL",
          );
        }

        container.eventBus.emit("session:expired", { sessionKey, reason: "cron-fresh" });
      }

      const syntheticMsg: NormalizedMessage = {
        id: `cron-${payload.jobId}-${systemNowMs()}`,
        channelId: deliveryTarget.channelId,
        channelType: deliveryTarget.channelType,
        senderId: "system",
        text: resultText,
        timestamp: systemNowMs(),
        attachments: [],
        metadata: { isCronAgentTurn: true, jobId: payload.jobId, jobName },
      };

      const execStartTs = systemNowMs();
      try {
        const allTools = deps.assembleToolsForAgent
          ? await deps.assembleToolsForAgent(payload.agentId)
          : [];
        // Resolve effective tool policy: job > agent > passthrough `{ profile: "full" }`.
        // Opt-in per job — omitting payload.toolPolicy preserves the agent's interactive
        // tool set. The explicit "full" fallback makes the no-silent-default contract
        // readable in the call site.
        const effectivePolicy =
          payload.toolPolicy ??
          agentConfig?.skills?.toolPolicy ??
          { profile: "full" as const, allow: [] as string[], deny: [] as string[] };
        const { tools, filtered: policyFiltered } = applyToolPolicy(
          allTools as Parameters<typeof applyToolPolicy>[0],
          effectivePolicy,
        );
        if (policyFiltered.length > 0) {
          logger.debug(
            {
              jobName,
              agentId: payload.agentId,
              profile: effectivePolicy.profile,
              filteredCount: policyFiltered.length,
              filtered: policyFiltered.map((f) => ({ tool: f.toolName, reason: f.reason.kind })),
            },
            "Cron tool policy applied",
          );
        }
        logger.info(
          { jobName, agentId: payload.agentId, channelType: deliveryTarget.channelType, toolCount: Array.isArray(tools) ? tools.length : 0 },
          "Executing cron agentTurn",
        );
        const execResult = await runWithContext({
          traceId: randomUUID(),
          tenantId: sessionKey.tenantId,
          userId: sessionKey.userId,
          sessionKey: formatSessionKey(sessionKey),
          startedAt: systemNowMs(),
          trustLevel: "user",
          channelType: deliveryTarget.channelType,
          deliveryOrigin: deliveryTarget ? createDeliveryOrigin({
            channelType: deliveryTarget.channelType,
            channelId: deliveryTarget.channelId,
            userId: deliveryTarget.userId,
            tenantId: deliveryTarget.tenantId,
          }) : undefined,
        }, () => executor.execute(syntheticMsg, sessionKey, tools, undefined, payload.agentId,
          undefined, undefined, cronOverrides));

        // Sanitize raw executor response: strip thinking tags, provider artifacts, unwrap <final>
        const rawResponse = execResult.response;
        const cleaned = sanitizeAssistantResponse(rawResponse);

        // Rolling strategy — prune to last N turns after execution
        if (sessionStrategy === "rolling") {
          const messages = sessionManager.loadOrCreate(sessionKey);
          if (messages.length > 0) {
            // Find the start index of the last N turns.
            // A "turn" starts at a user message and includes all following non-user messages.
            // Walk backwards, counting user messages as turn boundaries.
            let turnCount = 0;
            let keepFromIndex = 0; // default: keep all
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i] as { role?: string };
              if (msg.role === "user") {
                turnCount++;
                if (turnCount <= maxHistoryTurns) {
                  keepFromIndex = i; // this user message starts a turn we want to keep
                } else {
                  break; // found more turns than maxHistoryTurns, stop
                }
              }
            }
            if (turnCount > maxHistoryTurns) {
              const pruned = messages.slice(keepFromIndex);
              sessionManager.save(sessionKey, pruned);
            }
          }
        }

        // Enriched completion log with token/cost/tool metrics
        logger.info(
          {
            jobName,
            agentId: payload.agentId,
            durationMs: systemNowMs() - execStartTs,
            responseLen: cleaned.length,
            totalTokens: execResult.tokensUsed.total,
            costUsd: execResult.cost.total,
            toolCalls: execResult.stepsExecuted,
            llmCalls: execResult.llmCalls,
          },
          "Cron agentTurn execution complete",
        );

        // Record enriched execution entry with token/cost metrics
        const execTracker = deps.cronExecutionTrackers?.get(payload.agentId);
        if (execTracker) {
          await execTracker.record({
            ts: systemNowMs(),
            jobId: payload.jobId,
            status: "ok",
            durationMs: systemNowMs() - execStartTs,
            summary: cleaned.slice(0, 200),
            totalTokens: execResult.tokensUsed.total,
            costUsd: execResult.cost.total,
            toolCalls: execResult.stepsExecuted,
            llmCalls: execResult.llmCalls,
          });
        }

        // Report execution result back to scheduler for consecutiveErrors tracking.
        // errorContext is set when the executor caught a classified error (overloaded, auth, etc.)
        // and returned the user-friendly message as the response instead of throwing.
        if (execResult.errorContext) {
          payload.onComplete?.({ status: "error", error: execResult.errorContext.originalError ?? execResult.errorContext.errorType });
        } else {
          payload.onComplete?.({ status: "ok" });
        }

        // Suppress error message delivery for cron jobs.
        // When errorContext is set, the executor caught a classified error
        // (timeout, overloaded, auth, etc.) and set result.response to a
        // user-facing error message. For cron jobs this is nonsensical.
        // The error is already reported via onComplete above.
        if (execResult.errorContext) {
          logger.info(
            { jobName, errorType: execResult.errorContext.errorType, hint: "Error already reported to scheduler — suppressing channel delivery" },
            "Cron agentTurn error response suppressed",
          );
          return;
        }

        // Filter out NO_REPLY / HEARTBEAT_OK / empty responses
        const filtered = filterResponse(cleaned);
        if (!filtered.shouldDeliver) {
          logger.debug({ jobName, suppressedBy: filtered.suppressedBy }, "Cron agentTurn response suppressed");
          return;
        }

        const sendResult = await deliveryService.deliverToChannel(adapter, deliveryTarget.channelId, filtered.cleanedText, undefined);
        if (!sendResult.ok || !sendResult.value.ok) {
          logger.error(
            { err: sendResult.ok ? undefined : sendResult.error, jobName, hint: "Verify channel adapter is running and channel ID is valid", errorKind: "platform" as const },
            "Cron agentTurn delivery failed",
          );
        }
      } catch (err) {
        logger.error(
          { err, jobName, hint: "Agent execution failed, delivering raw text as fallback", errorKind: "internal" as const },
          "Cron agentTurn execution failed",
        );
        // Record error execution entry
        const execTracker = deps.cronExecutionTrackers?.get(payload.agentId);
        if (execTracker) {
          await execTracker.record({
            ts: systemNowMs(),
            jobId: payload.jobId,
            status: "error",
            durationMs: systemNowMs() - execStartTs,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        await deliveryService.deliverToChannel(adapter, deliveryTarget.channelId, resultText, undefined);
        payload.onComplete?.({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // --- systemEvent (or undefined): send raw text (existing behavior) ---
    const sendResult = await deliveryService.deliverToChannel(adapter, deliveryTarget.channelId, resultText, undefined);
    if (!sendResult.ok || !sendResult.value.ok) {
      logger.error(
        { err: sendResult.ok ? undefined : sendResult.error, target: deliveryTarget, jobName, hint: "Verify channel adapter is running and channel ID is valid", errorKind: "platform" as const },
        "Cron delivery failed",
      );
    } else {
      logger.debug({ jobName, channelId: deliveryTarget.channelId }, "Cron result delivered");
    }
  });

  // Notify user when a cron job is auto-suspended
  container.eventBus.on("scheduler:job_suspended", async (payload) => {
    const { deliveryTarget, jobName, jobId, consecutiveErrors, lastError } = payload;
    if (!deliveryTarget?.channelType) {
      logger.warn(
        { jobName, hint: "Suspended job has no delivery target for notification", errorKind: "config" as const },
        "Cannot notify user of job suspension — no delivery target",
      );
      return;
    }
    const adapter = adaptersByType.get(deliveryTarget.channelType);
    if (!adapter) {
      logger.warn(
        { channelType: deliveryTarget.channelType, jobName, hint: "Ensure the target channel adapter is started", errorKind: "config" as const },
        "No adapter found for job suspension notification",
      );
      return;
    }

    const classified = classifyError(lastError);
    const message = [
      `Scheduled task "${jobName}" was suspended after ${consecutiveErrors} consecutive failures.`,
      `Reason: ${classified.userMessage}`,
      `Re-enable with /cron enable ${jobId}`,
    ].join("\n");

    try {
      await deliveryService.deliverToChannel(adapter, deliveryTarget.channelId, message, undefined);
      logger.info({ jobName, jobId, channelType: deliveryTarget.channelType }, "Job suspension notification delivered");
    } catch (err: unknown) {
      logger.error(
        { jobName, jobId, err, hint: "Failed to deliver job suspension notification", errorKind: "internal" as const },
        "Job suspension notification delivery failed",
      );
    }
  });
}

// Re-export the unused Attachment type to silence lint and document the
// public-surface boundary: the registry caller consumes the same node:crypto
// and core attachment types when constructing synthetic messages.
export type { Attachment };
