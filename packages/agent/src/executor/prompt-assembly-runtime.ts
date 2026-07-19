// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt assembly helper for PiExecutor.
 *
 * Extracts the system prompt assembly sequence from execute() into a
 * focused async function. Handles immutable workspace policy projection, RAG
 * retrieval, inbound metadata construction, typed system
 * prompt assembly, hook execution, and API-provided overrides.
 *
 * @module
 */

import type { TypedEventBus, WorkspaceFileName } from "@comis/core";
import {
  formatSessionKey,
  createMemoryRecallScope,
  scriptTokenFactor,
  tryGetContext,
  systemNowMs,
} from "@comis/core";
import { err } from "@comis/shared";
import type { PromptMode, InboundMetadata, BootstrapContextFile } from "../bootstrap/types.js";
import {
  buildBootstrapContextFiles,
  assembleRichSystemPrompt,
  assembleRichSystemPromptBlocks,
  compileRichSystemPrompt,
  filterBootstrapFilesForLightContext,
  filterBootstrapFilesForCron,
  filterBootstrapFilesForGroupChat,
  resolveSenderDisplay,
  type BootstrapFile,
  type SubagentRoleParams,
  type SenderTrustEntry,
  type TrustDisplayMode,
} from "../bootstrap/index.js";
import { topicMatchScores } from "../memory/topic-key.js";
import { createHybridMemoryInjector } from "../rag/hybrid-memory-injector.js";
import { createMemoryRecall } from "../rag/memory-recall.js";
import type { RecallEventSink } from "../rag/recall-types.js";
import { formatMemorySection } from "../rag/rag-retriever.js";
import { buildTemporalGuidanceBlock } from "../rag/temporal-guidance.js";
import { buildProfileBlock } from "./user-representation-block.js";
import { CHARS_PER_TOKEN_RATIO } from "../context-engine/index.js";
import { FAIL_CLOSED_PROFILE } from "./model-profile.js";
import { resolveScaffoldDefaults } from "./scaffold-defaults.js";
import { economiseForReadOnlyChild } from "../spawn/child-prompt-economy.js";
import { resolveResponseLocalePolicy } from "./resolve-response-locale-policy.js";
import { buildDynamicPreamble } from "./prompt-dynamic-preamble.js";
import { persistPromptReport } from "./prompt-reporting.js";
import { assembleParentCachePrompt } from "./prompt-parent-cache.js";
import {
  buildMessageFlags,
  buildRecallTrace,
  isGroupContext,
  resolveChatType,
  resolvePromptModeForProfile,
  sessionBootstrapFileSnapshots,
  sessionCacheSafeParams,
  sessionPromptMemoryInjected,
  sessionPromptRecallEvents,
  sessionPromptSkillLocations,
  sessionPromptSkillsXmlSnapshots,
  sessionPromptSkillSurfacedCensus,
  sessionPromptTopicMatchedSkills,
  sessionToolNameSnapshots,
  workspacePolicyContent,
  workspacePolicySnapshotToBootstrapFiles,
  wr02SenderTrustWarnedAgents,
  type ExecutionPromptResult,
  type PromptAssemblyParams,
} from "./prompt-assembly-shared.js";
export async function assembleExecutionPrompt(params: PromptAssemblyParams): Promise<ExecutionPromptResult> {
  const { config, deps, msg, sessionKey, agentId, mergedCustomTools, logger } = params;

  function resolveWorkspacePolicyContent(fileName: WorkspaceFileName): string | undefined {
    return workspacePolicyContent(deps.workspacePolicySnapshot, fileName);
  }

  // Consolidated lightContext flag: heartbeat implies light-context regardless
  // of the explicit msg.metadata.lightContext flag. Callers that only set the
  // metadata flag OR only set operationType="heartbeat" produce identical
  // prompt output. Hoisted above the parent-cache reuse branch so BOTH paths
  // share the same bootstrap filter dispatch.
  const effectiveLightContext =
    msg.metadata?.lightContext === true || params.operationType === "heartbeat";

  // Capability-gated bootstrap.maxChars.
  // resolveScaffoldDefaults handles the === 20_000 sentinel check internally.
  // Fail-closed: absent modelProfile → FAIL_CLOSED_PROFILE (nano) → 3_500 (conservative).
  const { bootstrapMaxChars, bootstrapTotalMaxChars } = resolveScaffoldDefaults(
    params.modelProfile ?? FAIL_CLOSED_PROFILE,
    config,
  );

  // Snapshot projection + per-turn filter dispatch + char-budget
  // build. The immutable policy hash keeps the system-prompt prefix stable
  // across turns while per-turn privacy filters remain explicit.
  async function resolveBootstrapContextFiles(
    mode: PromptMode,
  ): Promise<{ bootstrapContextFiles: BootstrapContextFile[]; bootstrapFilesForReport: BootstrapFile[] }> {
    if (mode === "none") {
      return { bootstrapContextFiles: [], bootstrapFilesForReport: [] };
    }
    const bsSnapKey = formatSessionKey(sessionKey);
    const cached = sessionBootstrapFileSnapshots.get(bsSnapKey);
    let bootstrapFiles: BootstrapFile[];
    if (cached?.policyHash === deps.workspacePolicySnapshot.combinedHash) {
      bootstrapFiles = cached.files;
    } else {
      bootstrapFiles = workspacePolicySnapshotToBootstrapFiles(
        deps.workspacePolicySnapshot,
        deps.workspaceDir,
      );
      sessionBootstrapFileSnapshots.set(bsSnapKey, {
        policyHash: deps.workspacePolicySnapshot.combinedHash,
        files: bootstrapFiles,
      });
    }

    // Bootstrap filter dispatch:
    //  - effectiveLightContext (heartbeat / explicit flag) -> HEARTBEAT.md only
    //  - operationType === "cron" -> SOUL.md + ROLE.md only
    //  - group chat context -> strip USER.md for privacy
    if (effectiveLightContext) {
      bootstrapFiles = filterBootstrapFilesForLightContext(bootstrapFiles);
    } else if (params.operationType === "cron") {
      bootstrapFiles = filterBootstrapFilesForCron(bootstrapFiles);
    } else if (
      config.bootstrap?.groupChatFiltering !== false &&
      isGroupContext(msg)
    ) {
      bootstrapFiles = filterBootstrapFilesForGroupChat(bootstrapFiles);
    }

    return {
      bootstrapContextFiles: buildBootstrapContextFiles(bootstrapFiles, {
        maxChars: bootstrapMaxChars,
        totalMaxChars: bootstrapTotalMaxChars,
      }),
      bootstrapFilesForReport: bootstrapFiles,
    };
  }

  const parentPrompt = await assembleParentCachePrompt(params);
  if (parentPrompt !== undefined) return parentPrompt;

  // 1. Resolve promptMode
  // Priority: cron/heartbeat → operational; small/nano + compactPrompt.enabled → compact-secure;
  // operator override wins over compact-secure (only baseMode="full" gets auto-downgraded).
  // An explicit `config.bootstrap?.promptMode` wins for all modes including "minimal"/"none".
  const baseMode: PromptMode = (config.bootstrap?.promptMode as PromptMode) ?? "full";
  const promptMode: PromptMode = resolvePromptModeForProfile(
    baseMode,
    params.operationType,
    params.modelProfile,
    config.contextEngine?.compactPrompt,
  );

  // Warn when compact-secure is active but senderTrustDisplayConfig is disabled.
  // The sender-trust section wiring is correct (MODES_FULL_MIN_COMPACT includes it), but
  // the data it receives is always an empty array when the feature is not configured —
  // producing a structurally-satisfied but content-empty section. Operators should
  // configure senderTrustDisplayConfig to get meaningful anti-injection trust display.
  // The trigger is STATIC per agent (capabilityClass-derived promptMode +
  // per-agent senderTrustDisplayConfig), so warn ONCE per agent — not per
  // prompt assembly — to keep the log readable (per-turn repetition would fire
  // on every turn of a small-model session, which is pure noise).
  if (promptMode === "compact-secure" && !deps.senderTrustDisplayConfig?.enabled) {
    const wr02Key = agentId ?? config.name;
    if (!wr02SenderTrustWarnedAgents.has(wr02Key)) {
      wr02SenderTrustWarnedAgents.add(wr02Key);
      logger.warn(
        {
          submodule: "prompt-assembly",
          hint: "compact-secure mode active but senderTrustDisplayConfig is disabled — sender-trust section will be empty. Configure senderTrustDisplayConfig.enabled=true for S1 anti-injection trust display.",
          errorKind: "config" as const,
        },
        "S1: sender-trust not injected in compact-secure (feature disabled)",
      );
    }
  }

  // 2. Load workspace bootstrap files (skip for "none" mode) via the shared
  // snapshot-aware helper. `bootstrapFilesForReport` tracks the raw post-filter
  // shape so the SystemPromptReport can populate injectedWorkspaceFiles[] with
  // missing/truncated/rawChars/injectedChars accounting. The same helper feeds
  // the parent-cache reuse path's tier-2 language resolution, so the filter
  // dispatch can never drift between the two paths.
  const { bootstrapContextFiles, bootstrapFilesForReport } =
    await resolveBootstrapContextFiles(promptMode);

  // 3. RAG recall via createMemoryRecall + hybrid memory injector (non-fatal).
  // `memorySections` = prompt content (retrieved sections + the temporal-guidance
  // block when present); the `retrieved*` accumulators are telemetry truth —
  // retrieved memory only, excluding the fixed guidance block.
  let memorySections: string[] = [];
  let inlineMemory: string | undefined;
  // id + content of the recalled memories, surfaced on the result so the
  // turn-end hook (executor-post-execution.ts) can attribute used-vs-ignored from
  // the agent response. Stays in-process — only ids/counts ever leave the agent.
  let recalledMemories: ReadonlyArray<{ id: string; content: string }> | undefined;
  let retrievedSectionsChars = 0;
  let retrievedRagHits = 0;
  if (deps.memoryPort && config.rag?.enabled && !params.skipRag) {
    const ragStart = deps.clock.now();
    // Deferring sink for recall's bus events (memory:recalled / reranked /
    // recall_degraded): assembly runs BEFORE the per-turn trajectory bridge
    // subscribes, so an inline emit is lost to the trajectory on every turn —
    // the same pre-bridge timing bug fixed for memory:injected. The sink
    // buffers typed emit closures; the buffer is stored per session below
    // (success AND failure paths) and postExecution flushes it to the real bus.
    const deferredRecallEvents: Array<(bus: TypedEventBus) => void> = [];
    const recallEventSink: RecallEventSink = {
      emit(event, payload) {
        deferredRecallEvents.push((bus) => void bus.emit(event, payload));
        return true;
      },
    };
    try {
      // Recall-trace recorder, null-when-disabled (default-off). Constructed
      // per assembly but shares a daemon-wide queued writer by path (the recorder's
      // registry contract), so recordRecall is fire-and-forget — no per-recall
      // flushAndClose (that would tear down the shared writer; mirrors the cacheTrace
      // daemon-wide lifecycle). `eventBus` is the already-in-scope bus (used for
      // memory:injected below) — threading both here keeps memory:recalled/reranked at
      // the canonical one-per-recall site inside createMemoryRecall.
      // Pass the authoritative scope envelope so on-disk records carry
      // `sessionKey` (the formatted key the CLI's recall-trace <session> selector
      // compares against) AND `tenantId` (the read-side cross-tenant filter).
      // tenantId comes from the per-agent config tenant, falling back to the
      // SessionKey's tenant.
      const recallTraceSessionKey = formatSessionKey(sessionKey);
      const recallTrace = buildRecallTrace(
        deps.recallTraceConfig,
        agentId ?? config.name,
        recallTraceSessionKey,
        deps.dataDir,
        { sessionKey: recallTraceSessionKey, tenantId: deps.tenantId ?? sessionKey.tenantId },
      );
      // Single recall orchestrator: search->fuse->rerank->score->trust-filter
      // ->dedup. Rerank opt-in/default-OFF -> fusion order. Non-fatal.
      // The recall-utility feedback toggle: the `rag.feedback` schema field is added
      // later, so read it through a structural widening that compiles against today's
      // strict RagConfig (optional-chaining → off when absent; correct once the field exists).
      // The boost MAGNITUDE is the single canonical `rag.scoring.usefulnessAlpha` (passed via
      // `scoring` below) — there is NO alpha on `feedback`.
      const ragFeedback = (config.rag as typeof config.rag & { feedback?: { enabled: boolean } })
        .feedback;
      // Recall scoring is the FIXED config.rag.scoring alphas: there is no
      // online-tuning bandit or per-intent tuned-alpha overlay, so
      // there is no learned-weight read on the recall hot path — ranking is fused RRF + the
      // cross-encoder reranker over the config-sourced alphas only. Deterministic + LLM-free.
      const recall = createMemoryRecall(
        {
          memoryPort: deps.memoryPort,
          reranker: deps.reranker,
          entityStore: deps.entityStore,
          temporalStore: deps.temporalStore,
          causalStore: deps.causalStore,
          tripleStore: deps.tripleStore,
          embeddingStore: deps.embeddingStore,
          usefulnessStore: deps.usefulnessStore,
          // Wire the pinned-first lane store so Step 0 of the recall pipeline
          // (`if (cfg_pinned?.enabled === true && deps.pinnedStore !== undefined)`) can fire
          // at runtime. The same `memoryAdapter` already passed as `memoryPort` implements
          // `MemoryPinnedStore`; the daemon composition root threads it here through
          // PiExecutorDeps.pinnedStore → PromptAssemblyParams.deps.pinnedStore. Default-OFF
          // byte-identity: with `rag.pinned.enabled=false` (the default) no query runs.
          ...(deps.pinnedStore !== undefined ? { pinnedStore: deps.pinnedStore } : {}),
          // Thread the provenance read store so createMemoryRecall's
          // post-fusion down-weighting pass can fire
          // live. The daemon composition root threads it here through
          // PiExecutorDeps.provenanceStore → PromptAssemblyParams.deps.provenanceStore.
          // DEFAULT-OFF byte-identity: absent OR no lcd_distilled result → no read.
          ...(deps.provenanceStore !== undefined ? { provenanceStore: deps.provenanceStore } : {}),
          timers: deps.timers,
          clock: deps.clock,
          logger,
          ...(recallTrace !== null ? { recallTrace } : {}),
          // The DEFERRING sink, never the real bus: see deferredRecallEvents above.
          eventBus: recallEventSink,
        },
        {
          maxResults: config.rag.maxResults,
          minScore: config.rag.minScore,
          includeTrustLevels: config.rag.includeTrustLevels,
          rerank: config.rag.rerank,
          // Fixed config-sourced scoring alphas — no learned overlay.
          scoring: config.rag.scoring,
          lanes: config.rag.lanes,
          entityLane: config.rag.entityLane,
          // MMR diversity re-rank + query understanding. Both are
          // fully-defaulted RagConfig fields (.strictObject + .default() on every
          // field), so they pass DIRECTLY — no optional-chaining / structural widening like
          // `feedback` above (which predates its config landing). Default-OFF ⇒ recall is
          // byte-identical until an operator opts in (rag.mmr.enabled / rag.queryUnderstanding.*).
          mmr: config.rag.mmr,
          queryUnderstanding: config.rag.queryUnderstanding,
          // The FadeMem per-type decay gate. A fully-defaulted RagConfig field
          // (.strictObject + .default()), so it passes DIRECTLY — same as mmr/
          // queryUnderstanding, no optional-chaining / structural widening. Default-OFF ⇒
          // score.ts forces forgetFactor to exactly 1.0 ⇒ byte-identical recall until an
          // operator opts in (rag.forget.enabled); the neutral byte-identity holds even when on.
          forget: config.rag.forget,
          // Forward the pinned-memory injection config so Step 0 knows the cap.
          // A fully-defaulted RagConfig field (same posture as mmr/forget), so it passes DIRECTLY.
          // Default-OFF (`enabled:false`) ⇒ the pinned lane is skipped (byte-identical).
          pinned: config.rag.pinned,
          // Forward the base-score floor gate — capability-gated baseFloor.
          // Resolved: explicit config.rag.baseFloor (>0) wins; for small/nano with
          // baseFloor===0 (schema default/"unset"), applies SMALL_NANO_DEFAULT_BASE_FLOOR=0.15.
          // frontier/mid with no config: effective floor remains 0 (byte-identical).
          // Fail-closed when modelProfile absent → 0 floor (frontier-equivalent behavior).
          // Poison resistance: boosts cannot resurrect a low-base memory (floor gates pre-boost).
          baseFloor: params.modelProfile !== undefined
            ? resolveScaffoldDefaults(params.modelProfile, config).baseFloor
            : (config.rag as typeof config.rag & { baseFloor?: number }).baseFloor,
          // Thread the unified-arbiter-active signal so the
          // recall baseFloor gate is FAIL-CLOSED under the arbiter (an unconfigured floor
          // resolves to the class default instead of silently skipping) AND the trust gate
          // runs upstream of fusion. relevanceFirst=true only for small/nano non-caching
          // models (resolveScaffoldDefaults); frontier/mid → false → recall byte-identical.
          // Absent modelProfile → undefined → off (recency-first, byte-identical).
          ...(params.modelProfile !== undefined
            ? { relevanceFirst: resolveScaffoldDefaults(params.modelProfile, config).relevanceFirst }
            : {}),
          ...(ragFeedback !== undefined ? { feedback: ragFeedback } : {}),
        },
      );
      const turnScope = tryGetContext()?.turnScope;
      const memoryScope = turnScope === undefined
        ? err(new Error("RAG recall requires resolved turn authority"))
        : createMemoryRecallScope(turnScope, true);
      if (!memoryScope.ok) {
        logger.warn(
          {
            agentId,
            errorKind: "precondition" as const,
            hint: "Resolve the inbound turn scope before prompt assembly; recall was skipped",
          },
          "RAG recall skipped because authority was unavailable",
        );
      }
      const recalled = memoryScope.ok
        ? await recall.recall(msg.text, memoryScope.value, sessionKey)
        : memoryScope;

      if (recalled.ok && recalled.value.length > 0) {
        // Hybrid split: a same-sender top hit may be inline; unknown-sender,
        // cross-sender, and remaining recall stays in the dynamic preamble.
        const ranked = recalled.value;
        // Capture id + content for turn-end attribution (in-process only).
        recalledMemories = ranked.map((r) => ({ id: r.entry.id, content: r.entry.content }));
        const injector = createHybridMemoryInjector({
          onSuspiciousContent: deps.onSuspiciousContent,
          requesterUserId: sessionKey.userId,
        });

        // Budget accounting: subtract pinnedChars from maxContextChars BEFORE sizing
        // fused recall. Pinned entries are identified by entry.pinned===true (set by
        // rowToEntry from the DB column; the recall pipeline's Step-0 lane prepends them).
        // Use entry.pinned to identify actual pinned entries rather than a positional
        // slice(0, maxPinnedInjection). When real pins < cap, the positional slice over-counts
        // and incorrectly measures fused entries in pinnedChars, silently dropping them from
        // injector.split. The entry.pinned filter deducts only real-pin chars.
        // pinnedChars is 0 when pinning is disabled (default-off — byte-identical behavior).
        const pinnedSet =
          config.rag.pinned?.enabled === true
            ? ranked.filter((r) => r.entry.pinned === true)
            : [];
        let fusedSet = ranked.filter((r) => r.entry.pinned !== true);
        let pinnedChars = 0;
        if (pinnedSet.length > 0) {
          const pinnedSection = formatMemorySection(
            pinnedSet,
            config.rag.maxContextChars,
            undefined,
            sessionKey.userId,
          );
          pinnedChars = pinnedSection ? pinnedSection.length : 0;
        }

        // Small/nano profile count cap (3 items max) and chars cap (2000/1000).
        // Applied AFTER the base-floor filter in the recall pipeline, at the injection site.
        // Caps are conservative but generous for small models; frontier/mid are uncapped.
        // Accepted DoS risk: caps are well above typical useful recall sets.
        const maxRecallItems =
          params.modelProfile?.capabilityClass === "small" || params.modelProfile?.capabilityClass === "nano"
            ? 3
            : undefined;
        const maxRecallChars =
          params.modelProfile?.capabilityClass === "small"
            ? 2000
            : params.modelProfile?.capabilityClass === "nano"
              ? 1000
              : undefined;
        if (maxRecallItems !== undefined && fusedSet.length > maxRecallItems) {
          fusedSet = fusedSet.slice(0, maxRecallItems);
        }

        const remainingChars = Math.max(
          0,
          Math.min(
            config.rag.maxContextChars - pinnedChars,
            maxRecallChars !== undefined ? maxRecallChars : Infinity,
          ),
        );
        const injection = injector.split(fusedSet, remainingChars);

        inlineMemory = injection.inlineMemory;
        // Own the array — `injection.systemPromptSections` is what telemetry
        // reads, so pushing the guidance block into an alias of it would inflate
        // retrieved-memory metrics. Snapshot RETRIEVED-only char + RAG-hit counts
        // BEFORE the push so charsInjected/ragHits stay consistent with hitCount.
        memorySections = [...injection.systemPromptSections];
        retrievedSectionsChars = memorySections.reduce((sum, s) => sum + s.length, 0);
        retrievedRagHits = memorySections.length + (inlineMemory ? 1 : 0);

        // Read-time contradiction guidance: inject the temporal-guidance block when
        // >=2 surfaced memories are co-retrieved for the same query. Pure formatter; no
        // deletion, no content echo. The >=2 gate is tightened with entity overlap.
        // FIXED guidance text, NOT a retrieved memory — excluded from telemetry above.
        const temporalGuidance = buildTemporalGuidanceBlock(ranked);
        if (temporalGuidance) memorySections.push(temporalGuidance);

        // STORE the memory-injection summary (do NOT emit here): postExecution emits memory:injected
        // AFTER the trajectory bridge has subscribed. The inline assembly runs inside assembleTools,
        // BEFORE attachTrajectoryToEventBus (pi-executor), so an inline emit fired to NO listener and
        // the trajectory missed the RAG record on every turn — the same pre-bridge timing bug fixed
        // for memory:skill_surfaced. Fires only on turns where the injector produced
        // content (this block is reached only then). Retrieved memory ONLY (inline + retrieved
        // sections), never the guidance block — keeps charsInjected consistent with hitCount.
        sessionPromptMemoryInjected.set(formatSessionKey(sessionKey), {
          hitCount: ranked.length,
          charsInjected: (injection.inlineMemory?.length ?? 0) + retrievedSectionsChars,
          trustTags: Array.from(new Set(ranked.map((r) => r.entry.trustLevel))),
          pinnedCount: pinnedSet.length,
        });
      }
      logger.debug({ agentId, resultCount: recalled.ok ? recalled.value.length : 0, durationMs: deps.clock.now() - ragStart }, "RAG recall complete");
    } catch (err) {
      logger.warn({ agentId, err, durationMs: deps.clock.now() - ragStart, hint: "RAG recall failed — agent will proceed without memory context", errorKind: "dependency" as const }, "RAG recall failed (non-fatal)");
    } finally {
      // Store the deferred recall events on BOTH the success and the failure
      // path (a failed recall is exactly when memory:recall_degraded must
      // still reach the trajectory + system). postExecution drains + flushes.
      if (deferredRecallEvents.length > 0) {
        const key = formatSessionKey(sessionKey);
        const existing = sessionPromptRecallEvents.get(key);
        if (existing !== undefined) existing.push(...deferredRecallEvents);
        else sessionPromptRecallEvents.set(key, deferredRecallEvents);
      }
    }
  }

  // USER-PROFILE STANDING BLOCK: the LLM-free per-user-profile block is a DURABLE
  // standing block ("what we know about this user"), NOT a per-recall-conditional one.
  // The source is the mental-model store — a `kind:"profile"`
  // Mental Model doc (`mentalModelStore.list(scope,"profile")` → `buildProfileBlock`).
  //
  // It is injected on its OWN gate — `config.learning.enabled` (the single
  // collapsed learning flag)
  // AND the optional store dep — INDEPENDENT of whether RAG ran, whether recall hit,
  // and independent of `rag.enabled`. This is why it lives OUTSIDE the
  // `if (deps.memoryPort && config.rag?.enabled ...)` recall block above: nesting it
  // there silently dropped the profile on every zero-recall turn (greetings/off-topic/
  // sparse store) and gave RAG-off deployments ZERO injection.
  //
  // Default-OFF byte-identity (the cost gate): with the gate off OR no store dep,
  // list() is NEVER called and the prompt is byte-identical. When ON, a DETERMINISTIC
  // `list(scope,"profile")` scoped to THIS prompt's own (tenant, agent) + the pure
  // buildProfileBlock formatter (NO model call — the recall hot path stays LLM-free).
  // The profile groupKey is the userId, carried on the doc's `topicKey` (LearningScope
  // has only (tenant, agent)), so the CURRENT user's doc is selected by
  // `topicKey === sessionKey.userId` — cross-user isolation at read. The
  // formatter returns undefined on an empty/absent profile ⇒ nothing pushed ⇒
  // byte-identity. Non-fatal: a list err is swallowed so the agent proceeds without the
  // profile. The profile content was redaction-checked + validateLearnedDocBody-clean +
  // high-trust at WRITE time. memorySections is seeded by the recall block (or empty),
  // so the profile appends after any retrieved sections + temporal guidance.
  if (config.learning?.enabled && deps.mentalModelStore) {
    try {
      // ONE list of ALL learning docs (kind omitted) — partitioned below for the
      // user-profile standing block (kind=profile) AND the reuse-attribution topic-match
      // (kind=skill). A single list keeps the per-turn store cost to ONE read (the
      // "list runs once" contract) while serving both consumers.
      const docs = await deps.mentalModelStore.list({
        tenantId: deps.tenantId ?? sessionKey.tenantId,
        agentId: agentId ?? config.name,
      });
      if (docs.ok) {
        // --- user-profile standing block (kind=profile) ---
        // The per-user doc: the profile groupKey is the userId on the doc's topicKey.
        // Select THIS user's doc by `topicKey === userId`. A doc with an EMPTY topicKey
        // is user-agnostic (a single-user agent whose builder set no per-user groupKey)
        // and is shown to any user; a doc carrying a DIFFERENT user's topicKey is NEVER
        // shown (cross-user isolation — no sole-doc fallback that could leak A's profile
        // to B). When userId is itself absent, only an empty-topicKey doc qualifies.
        const profiles = docs.value.filter((d) => d.kind === "profile");
        const userId = sessionKey.userId;
        const mine =
          (userId !== undefined ? profiles.find((d) => d.topicKey === userId) : undefined) ??
          profiles.find((d) => d.topicKey === "");
        if (mine) {
          const profileBlock = buildProfileBlock(mine);
          if (profileBlock) memorySections.push(profileBlock);
        }

        // --- reuse-attribution by TOPIC MATCH (kind=skill).
        // Credit any learned skill whose stored common-core (topicTokens) THIS turn instantiates,
        // so a skill APPLIED from the surfaced `<available_skills>` summary / recall — without an
        // explicit `read` of its SKILL.md (the read-attribution path) — still enters `usedSkillIds` and
        // promotes on success. Per-turn (the match depends on the turn's request text); the carrier
        // is unioned into the turn's usedSkillIds by the pi-event-bridge.
        const skills = docs.value.filter((d) => d.kind === "skill");
        const scores = topicMatchScores(
          msg.text,
          skills.map((s) => ({ name: s.name, topicTokens: s.structuredBody?.topicTokens })),
        );
        const matched = [...new Set(scores.filter((s) => s.credited).map((s) => s.name))];
        sessionPromptTopicMatchedSkills.set(formatSessionKey(sessionKey), matched);
        // One DEBUG line when a turn TOPIC-CREDITS ≥1 learned skill WITHOUT an explicit read —
        // otherwise the credit is invisible until a downstream proof bump, so confirming "did
        // reuse-attribution fire this turn" meant grepping outcome_events. Gated on a non-empty
        // match (the meaningful, low-volume signal — a no-match turn logs nothing). Counts only,
        // never the skill body.
        if (matched.length > 0) {
          logger.debug(
            { agentId, step: "skill-topic-match", skillsConsidered: skills.length, matchedCount: matched.length },
            "reuse-attribution: turn topic-credited learned skill(s) without an explicit read",
          );
        }
        // memory:skill_surfaced: the full reuse-attribution census. memory:skill_used
        // (post-execution) fires only when ≥1 skill is CREDITED, so a NEAR-MISS — a skill that
        // overlapped the turn but missed the credit bar, or a doc with no topicTokens — was
        // silent ("why wasn't my skill reused?" needed a debugger). Emit per turn when ≥1 learned
        // skill has ANY token overlap (sharedCount>0) or is credited; carry a content-free score
        // (name=id, rest=numbers; zero-overlap skills omitted as noise; capped). Best-effort.
        // STORE the census (do NOT emit here): postExecution emits memory:skill_surfaced after the
        // trajectory bridge has subscribed. Keep only the skills with token overlap (credited +
        // near-misses); zero-overlap skills are noise. Capped at 25 (coverage desc).
        if (skills.length > 0) {
          const relevant = scores
            .filter((s) => s.sharedCount > 0 || s.credited)
            .sort((a, b) => b.coverage - a.coverage || b.sharedCount - a.sharedCount)
            .slice(0, 25);
          if (relevant.length > 0) {
            sessionPromptSkillSurfacedCensus.set(formatSessionKey(sessionKey), {
              surfacedCount: skills.length,
              creditedCount: matched.length,
              scores: relevant,
            });
          }
        }
      }
    } catch (learningErr) {
      logger.debug(
        {
          agentId,
          err: learningErr,
          hint: "learning standing-block / skill topic-match read failed; proceeding without",
          errorKind: "dependency" as const,
        },
        "Learning standing-block read failed (non-fatal)",
      );
    }
  }

  // Build inbound metadata
  let inboundMeta: InboundMetadata = {
    messageId: msg.id,
    senderId: msg.senderId,
    chatId: msg.channelId,
    channel: msg.channelType,
    chatType: resolveChatType(msg),
    flags: buildMessageFlags(msg),
  };

  // Sender trust resolution
  const trustDisplayConfig = deps.senderTrustDisplayConfig;
  let senderTrustEntries: SenderTrustEntry[] = [];
  let senderTrustDisplayMode: TrustDisplayMode = "raw";

  if (trustDisplayConfig?.enabled) {
    const trustMap = config.elevatedReply?.senderTrustMap ?? {};
    const defaultLevel = config.elevatedReply?.defaultTrustLevel ?? "external";
    senderTrustDisplayMode = trustDisplayConfig.displayMode;

    // Resolve HMAC secret: use SecretManager ref, fallback to agentId
    let hmacSecret: string | undefined;
    if (senderTrustDisplayMode === "hash") {
      const ref = trustDisplayConfig.hashSecretRef;
      hmacSecret = ref ? deps.secretManager?.get(ref) : undefined;
      if (!hmacSecret) {
        hmacSecret = agentId ?? config.name;
        logger.debug("Sender trust HMAC using agentId fallback (no hashSecretRef configured)");
      }
    }

    // Resolve current sender's trust for metadata injection
    const currentSenderTrust = trustMap[msg.senderId] ?? defaultLevel;
    inboundMeta = { ...inboundMeta, senderTrust: currentSenderTrust };

    // Build display entries for ALL known senders
    const allSenders = new Map<string, string>(); // senderId -> trustLevel
    for (const [sid, level] of Object.entries(trustMap)) {
      allSenders.set(sid, level);
    }
    // Include current sender if not in map
    if (!allSenders.has(msg.senderId)) {
      allSenders.set(msg.senderId, defaultLevel);
    }

    senderTrustEntries = Array.from(allSenders.entries()).map(([sid, level]) => ({
      senderId: sid,
      trustLevel: level,
      displayId: resolveSenderDisplay(sid, senderTrustDisplayMode, {
        hmacSecret,
        hashPrefix: trustDisplayConfig.hashPrefix,
        aliases: trustDisplayConfig.aliases,
      }),
    }));

    // Emit audit event
    if (deps.eventBus) {
      deps.eventBus.emit("sender:trust_resolved", {
        agentId: agentId ?? config.name,
        senderId: msg.senderId,
        trustLevel: currentSenderTrust,
        displayMode: senderTrustDisplayMode,
        sessionKey: formatSessionKey(sessionKey),
        timestamp: deps.clock.now(),
      });
    }
  }

  // 5. Assemble the full system prompt
  const toolNames = mergedCustomTools.map(t => t.name);

  // Snapshot tool names on first turn to keep system prompt stable.
  // Tool count can vary between turns (57 vs 77) when MCP tools connect/disconnect
  // or tool deferral context changes. The snapshot ensures assembleRichSystemPrompt
  // receives the same toolNames on every turn, preserving the cache prefix.
  // Note: actual available tools for execution are unaffected -- only system prompt assembly uses the snapshot.
  const snapshotKey = formatSessionKey(sessionKey);
  let stableToolNames = sessionToolNameSnapshots.get(snapshotKey);
  if (!stableToolNames) {
    stableToolNames = toolNames;
    sessionToolNameSnapshots.set(snapshotKey, toolNames);
  }

  // Snapshot promptSkillsXml on first turn to keep system prompt stable.
  // Skills created mid-session grow the XML (~540 chars per skill), invalidating
  // the entire system prompt cache prefix on every subsequent turn.
  let promptSkillsXml = sessionPromptSkillsXmlSnapshots.get(snapshotKey);
  if (promptSkillsXml === undefined && !sessionPromptSkillsXmlSnapshots.has(snapshotKey)) {
    promptSkillsXml = deps.getPromptSkillsXml?.() ?? undefined;
    sessionPromptSkillsXmlSnapshots.set(snapshotKey, promptSkillsXml);
    sessionPromptSkillLocations.set(
      snapshotKey,
      new Map(deps.getPromptSkillLocations?.() ?? []),
    );
  }
  const activePromptSkillContent = msg.metadata?.promptSkillContent as string | undefined;

  const responseLocalePolicy = resolveResponseLocalePolicy({
    explicitLocale: config.language ?? deps.spawnPacket?.language,
    requestLocale: typeof msg.metadata?.locale === "string" ? msg.metadata.locale : undefined,
    requestText: msg.originalMessages?.map(message => message.text).join("\n") ?? msg.text,
  });

  // Build subagentRole from SpawnPacket when present.
  // Previously subagentRole was accepted by assembleRichSystemPrompt but never wired
  // through from prompt-assembly; spawnPacket now provides the structured data.
  let subagentRole: SubagentRoleParams | undefined;
  if (deps.spawnPacket) {
    subagentRole = {
      task: deps.spawnPacket.task,
      depth: deps.spawnPacket.depth,
      maxSpawnDepth: deps.spawnPacket.maxDepth,
      artifactRefs: deps.spawnPacket.artifactRefs,
      objective: deps.spawnPacket.objective,
      domainKnowledge: deps.spawnPacket.domainKnowledge,
      workspaceDir: deps.spawnPacket.workspaceDir,
      parentSummary: deps.spawnPacket.parentSummary,
      agentWorkspaces: deps.spawnPacket.agentWorkspaces,
      language: deps.spawnPacket.language,
    };
  }

  // One typed compiler input feeds the monolithic and cache-block views.
  const assemblerParams: import("../bootstrap/index.js").AssemblerParams = {
    promptMode,
    instructionSections: deps.workspacePolicySnapshot.sections,
    bootstrapFiles: bootstrapContextFiles,
    promptSkillsXml, // skills XML in semiStableBody for 1h cache
    reasoningTagHint: config.provider !== "anthropic"
      && !params.resolvedModelReasoning
      && !(config.thinkingLevel && config.thinkingLevel !== "off"),
  };

  let promptCompileReport = compileRichSystemPrompt(assemblerParams).report;
  let systemPrompt = assembleRichSystemPrompt(assemblerParams);

  // Build structured blocks for multi-block cache_control injection.
  // Uses the same assemblerParams as assembleRichSystemPrompt() -- identity guaranteed
  // by shared buildAllSections().
  let systemPromptBlocks = assembleRichSystemPromptBlocks(assemblerParams);

  // ROOT-CAUSE context-exhaustion guard — degenerate-window compact fallback.
  // The window-aware tool-budget fit pass (executor-tool-assembly)
  // defers tools to fit, but the system prompt itself is non-evictable: a model
  // whose effective window is SMALLER than its full prompt (e.g. an ~8K window
  // mid-class model with a ~10K prompt — compact-secure never fires for mid/
  // frontier) still overflows even with zero tools, and the pre-flight throws
  // fixed_overhead_exceeds_window. The user's hard requirement is that the agent
  // NEVER context-exhausts. So when the resolved-mode prompt cannot fit —
  // systemPromptOnlyTokens + outputHeadroom + messageFloorTokens > effectiveWindow —
  // re-assemble in the existing compact-secure mode (security floor intact,
  // ~700 tok), a CHEAP pure re-call (no RAG re-run). This only fires in the
  // genuinely-degenerate case, so normal windows stay byte-identical (the
  // window-agnostic baseline when windowFitBudget is absent). compact-secure and
  // none are already minimal — never re-shrunk.
  const fitBudget = params.windowFitBudget;
  if (
    fitBudget !== undefined &&
    promptMode !== "compact-secure" &&
    promptMode !== "none"
  ) {
    // Factor the prompt's own script (dense non-Latin prompts carry more
    // tokens/char), matching estimateSystemTokensFactored at toolOverheadChars=0.
    const promptTokensFor = (prompt: string): number => Math.ceil(
      prompt.length / (CHARS_PER_TOKEN_RATIO * scriptTokenFactor(prompt)),
    );
    const fixedBeyondPrompt = fitBudget.outputHeadroom + fitBudget.messageFloorTokens;
    const fitsWindow = (promptTokens: number): boolean =>
      promptTokens + fixedBeyondPrompt <= fitBudget.effectiveWindow;
    const systemPromptOnlyTokens = promptTokensFor(systemPrompt);
    if (!fitsWindow(systemPromptOnlyTokens)) {
      // Escalation ladder, VERIFIED at each rung — never assumed. At
      // mid/frontier the operator bootstrap sections ride into compact-secure
      // at full size, so the "compact" prompt can itself exceed a degenerate
      // window: measure it, and when it still cannot fit, escalate to
      // promptMode "none" (engine kernel only — the minimal secure floor).
      // When even that overflows, keep the smallest prompt and say so — the
      // context preflight then fails honestly instead of this WARN claiming
      // "the agent still runs" over an oversized prompt.
      let fallbackMode: PromptMode = "compact-secure";
      let fallbackParams: typeof assemblerParams = { ...assemblerParams, promptMode: fallbackMode };
      let fallbackPrompt = assembleRichSystemPrompt(fallbackParams);
      let fallbackTokens = promptTokensFor(fallbackPrompt);
      if (!fitsWindow(fallbackTokens)) {
        const kernelParams = { ...assemblerParams, promptMode: "none" as PromptMode };
        const kernelPrompt = assembleRichSystemPrompt(kernelParams);
        const kernelTokens = promptTokensFor(kernelPrompt);
        if (fitsWindow(kernelTokens) || kernelTokens < fallbackTokens) {
          fallbackMode = "none";
          fallbackParams = kernelParams;
          fallbackPrompt = kernelPrompt;
          fallbackTokens = kernelTokens;
        }
      }
      const fallbackFits = fitsWindow(fallbackTokens);
      const fallbackLabel = fallbackMode === "none" ? "engine-kernel-only" : "compact-secure";
      const overflowContext =
        `System prompt (~${systemPromptOnlyTokens} tok) + output headroom (${fitBudget.outputHeadroom}) ` +
        `+ message floor (${fitBudget.messageFloorTokens}) exceeds the effective window ` +
        `(${fitBudget.effectiveWindow})`;
      logger.warn(
        {
          step: "prompt-compact-fallback",
          errorKind: "resource" as const,
          hint: fallbackFits
            ? `${overflowContext}; fell back to the ${fallbackLabel} prompt (~${fallbackTokens} tok) so ` +
              `the agent still runs. Raise the model's context window or use a larger model to restore the full prompt.`
            : `${overflowContext}, and even the ${fallbackLabel} prompt (~${fallbackTokens} tok) does not fit — ` +
              `the context preflight will fail this turn. Raise the model's context window or use a larger model.`,
          agentId: agentId ?? config.name,
          fromPromptMode: promptMode,
          fallbackPromptMode: fallbackMode,
          fallbackFits,
          effectiveWindow: fitBudget.effectiveWindow,
          fullPromptTokens: systemPromptOnlyTokens,
          compactPromptTokens: fallbackTokens,
          outputHeadroom: fitBudget.outputHeadroom,
          messageFloorTokens: fitBudget.messageFloorTokens,
        },
        fallbackFits
          ? `prompt compact-fallback: full prompt too large for window, using ${fallbackLabel}`
          : "prompt compact-fallback: no prompt mode fits the effective window; context preflight will fail",
      );
      deps.eventBus?.emit("context:overflow", {
        agentId: agentId ?? config.name,
        sessionKey: formatSessionKey(sessionKey),
        contextTokens: systemPromptOnlyTokens + fixedBeyondPrompt,
        budgetTokens: fitBudget.effectiveWindow,
        // compact-secure strips the optional runtime (skills) sections; the
        // kernel-only rung additionally strips the operator workspace files.
        recoveryAction: fallbackMode === "none" ? "strip_files" : "strip_skills",
        timestamp: deps.clock?.now() ?? systemNowMs(),
      });
      systemPrompt = fallbackPrompt;
      systemPromptBlocks = assembleRichSystemPromptBlocks(fallbackParams);
      promptCompileReport = compileRichSystemPrompt(fallbackParams).report;
    }
  }

  // Read-only-child input economy. Gating + drop logic all live in
  // spawn/child-prompt-economy.ts (blocks are always defined on this path).
  if (deps.spawnPacket) {
    const economised = economiseForReadOnlyChild(systemPrompt, systemPromptBlocks, stableToolNames);
    systemPrompt = economised.systemPrompt;
    if (economised.systemPromptBlocks) systemPromptBlocks = economised.systemPromptBlocks;
  }

  // 6. Run before_agent_start hook
  const hookResult = await deps.hookRunner?.runBeforeAgentStart(
    { systemPrompt, messages: [] },
    {
      agentId: agentId ?? config.name,
      sessionKey,
      workspaceDir: deps.workspaceDir,
      isFirstMessageInSession: deps.isFirstMessageInSession,
    },
  );
  if (hookResult?.systemPrompt) systemPrompt = hookResult.systemPrompt;
  // If hook modifies systemPrompt, blocks become inconsistent.
  // This is acceptable: hooks are session-stable, so blocks only
  // matter for the cache prefix split which is unaffected by hook prepends.
  // The frozenSystemPrompt (string) remains the source of truth for content.

  await persistPromptReport({
    params,
    systemPrompt,
    bootstrapMaxChars,
    bootstrapFilesForReport,
    bootstrapContextFiles,
    inlineMemory,
    memorySections,
    retrievedRagHits,
    retrievedSectionsChars,
  });

  // prependContext relocated to dynamic preamble to preserve cache prefix stability.
  // Hooks may return turn-varying content (timestamps, user state) which would invalidate
  // the cache prefix if injected into the system prompt.
  const hookPrependContext = hookResult?.prependContext;

  // BOOT.md, BOOTSTRAP.md, and safety reinforcement relocated
  // from system prompt to dynamic preamble below (see dynamicPreambleParts section).

  const dynamicPreamble = await buildDynamicPreamble({
    params,
    systemPrompt,
    promptMode,
    bootstrapContextFiles,
    memorySections,
    activePromptSkillContent,
    senderTrustEntries,
    senderTrustDisplayMode,
    subagentRole,
    inboundMeta,
    responseLocalePolicy,
    hookPrependContext,
    resolveWorkspacePolicyContent,
    promptCompileReport,
  });

  // Capture frozen prompt state on first turn for sub-agent cache prefix sharing.
  // Captured AFTER hook execution so frozenSystemPrompt includes hook modifications.
  // Sub-agents should only READ parent params, never populate their own.
  // Compute toolHash from actual toolNames (not stableToolNames) on every turn.
  // When tools change mid-session (e.g., MCP server connects), refresh CacheSafeParams
  // so sub-agents spawned after the change get updated tool lists.
  // Uses actual toolNames for hash comparison but stableToolNames for the snapshot,
  // because stableToolNames is what the prompt assembly and cache prefix use.
  if (!deps.spawnPacket) {
    const currentToolHash = toolNames.slice().sort().join(",");
    const existing = sessionCacheSafeParams.get(snapshotKey);
    if (!existing || existing.toolHash !== currentToolHash) {
      sessionCacheSafeParams.set(snapshotKey, {
        frozenSystemPrompt: systemPrompt,
        frozenSystemPromptBlocks: systemPromptBlocks,
        toolNames: stableToolNames,
        model: config.model,
        provider: config.provider,
        cacheRetention: config.cacheRetention,
        cacheWriteTimestamp: deps.clock.now(),
        toolHash: currentToolHash,
      });
    }
  }

  return {
    systemPrompt,
    systemPromptBlocks,
    dynamicPreamble,
    inlineMemory,
    recalledMemories,
    responseLocalePolicy,
    promptCompileReport,
  };
}
