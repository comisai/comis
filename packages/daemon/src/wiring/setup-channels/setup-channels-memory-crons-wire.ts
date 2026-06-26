// SPDX-License-Identifier: Apache-2.0
/**
 * WS7 "dormant wiring" memory-cron sentinel handlers (v2.26 Verified Learning).
 *
 * Split out of setup-channels-memory-crons.ts (which is at the 600L setup-channels
 * cap) so the two newly-wired sentinels live in their own leaf. The original
 * `handleMemoryCronSentinel` delegates here at its fall-through, so the caller +
 * the existing test entry point are unchanged.
 *
 * Sentinels handled here:
 * - __USEFULNESS_JUDGE__ (WIRE-02): registered at setup-schedulers.ts:489 but had NO
 *   dispatch handler — it fired nightly as a NO-OP. Now it builds the cheap-model
 *   usefulness-judge seam and WRITES the verdict partition through
 *   usefulnessStore.recordUsage (the dormant seam goes live). Mirrors the
 *   __MEMORY_REASONING__ block 1:1 (agentId guard → cfg.enabled re-check → resolve a
 *   cheap "cron" model + key by NAME → build the seam → write → onComplete).
 * - __MEMORY_LIFECYCLE__ (FORGET-01/06, Phase 200 Plan 06): the KEYLESS soft-eviction sweep.
 *   Threads THIS agent's learningForgetting eviction policy onto the per-call sweep scope
 *   (the shared store is constructed once; the behavior is per-agent) and emits the
 *   daemon-side learning:memory_demoted/evicted counts (the store has no bus). OFF by
 *   default → DORMANT (byte-identical). Moved here for the 600L setup-channels dir cap.
 * - __MEMORY_TRIPLE_EXTRACTION__ (WIRE-01): dispatches the exported-but-never-scheduled
 *   runMemoryTripleExtraction behind the per-agent default-OFF flag.
 *
 * All re-check cfg.enabled (defence-in-depth — the scheduler already gates, a stale
 * persisted job must not run for a now-disabled agent), inject the segregated store(s)
 * as port TYPES only (the agent↛memory cut), and are NON-FATAL + counts/ids-only (§2.7).
 *
 * @module
 */

import { resolveCronJobCredential, cronCredentialSkipHint, cronCustomModelOpt } from "./setup-channels-cron-credential.js";
import { buildCustomJudgeModelSpec } from "../setup-learning-judge.js";
import {
  resolveOperationModel,
  resolveProviderFamily,
  createUsefulnessJudgeSeam,
  runMemoryTripleExtraction,
  runReflection,
  createLlmReflectionAdapter,
  REFLECT_PROMPT,
  PROFILE_REFLECT_PROMPT,
  TOPIC_REFLECT_PROMPT,
  type TripleCandidate,
  type ReflectionSourceTrajectory,
  type ReflectAdmissionOutcome,
} from "@comis/agent";
import type { MemoryCronContext, MemoryCronPayload } from "./setup-channels-memory-crons-types.js";

/** The cheap-model output bound for the offline usefulness-judge call (cost axis). */
const USEFULNESS_JUDGE_MAX_OUTPUT_TOKENS = 1024;

/**
 * Handle the sibling-hosted memory-cron sentinels (`__USEFULNESS_JUDGE__` /
 * `__MEMORY_LIFECYCLE__` / `__MEMORY_TRIPLE_EXTRACTION__`). Returns `true` when the sentinel
 * was recognized + handled (the caller then returns), `false` when it is neither (the
 * original handler falls through to the normal delivery path).
 */
export async function handleWireMemoryCronSentinel(
  resultText: string | undefined,
  payload: MemoryCronPayload,
  ctx: MemoryCronContext,
): Promise<boolean> {
  const { container, logger, clock, agents, tenantId, tripleStore, usefulnessStore, memoryApi, memoryLifecycleStore, reflection } = ctx;

  // -- Usefulness-judge sentinel intercept (WIRE-02) --
  // Mirrors the __MEMORY_REASONING__ block: opt-in cost gate + cheap "cron" model/key,
  // then build the OFFLINE judge seam and WRITE its verdict through recordUsage. The
  // judge scores the recalled-memory candidate ids the agent had this cycle; the seam's
  // lenient parser + candidate allowlist bound the (untrusted) verdict. The per-turn
  // answer transcript is not threaded in this scaffold — a future plan supplies it; the
  // wire (seam → recordUsage) is what WIRE-02 makes live (it was a no-op before).
  if (resultText === "__USEFULNESS_JUDGE__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Usefulness judge job fired without agentId", errorKind: "config" as const }, "Skipping usefulness judge -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for usefulness judge" });
      return true;
    }

    const agentConfig = agents[agentId];
    const cfg = agentConfig?.memoryUsefulnessJudge;
    if (!cfg?.enabled) {
      // The opt-in cost gate (defence-in-depth re-check): a disabled agent does NO LLM work.
      logger.debug({ agentId }, "Usefulness judge disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    // The write surface MUST be present (injected from setup-memory). Absent => cannot
    // record the verdict — surface a clean error rather than silently no-op.
    if (!usefulnessStore) {
      logger.warn({ agentId, hint: "usefulnessStore not injected -- cannot record the usefulness verdict", errorKind: "config" as const }, "Skipping usefulness judge -- usefulness store not wired");
      payload.onComplete?.({ status: "error", error: "usefulness store not wired" });
      return true;
    }

    // Resolve the cheap "cron" model (never the agent's primary) + API key by NAME (Pino auto-redacts).
    const resolved = resolveOperationModel({
      operationType: "cron",
      agentProvider: agentConfig.provider ?? "anthropic",
      agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: agentConfig.operationModels ?? {},
      providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
    });
    const cred = await resolveCronJobCredential(container, agentId, resolved.provider, ctx.resolveAccessToken);
    const apiKey = cred.apiKey;
    if (!apiKey) {
      logger.warn({ agentId, provider: resolved.provider, hint: cronCredentialSkipHint(cred, resolved.provider, "usefulness judge"), errorKind: "config" as const }, "Skipping usefulness judge -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ` + resolved.provider });
      return true;
    }

    const startMs = clock.now();
    const judgeTenantId = tenantId ?? container.config.tenantId ?? "default";
    const judgeLogger = logger.child({ agentId, submodule: "usefulness-judge" });

    // The candidate ids the judge scores: the bounded recent recalled-memory set
    // (mirror the __ONLINE_TUNING__ block's memoryApi.inspect read). ids only — no bodies.
    const candidateIds = memoryApi
      ? memoryApi.inspect({ tenantId: judgeTenantId, agentId, limit: cfg.maxSourceMemories ?? 200 }).map((r) => r.id)
      : [];

    // Build the OFFLINE seam (prompt + lenient/allowlist parser stay agent-internal) and
    // run ONE verdict over the candidate ids. answer="" in this scaffold (no turn transcript
    // threaded yet); the seam short-circuits an empty candidate set with no cost.
    // Custom YAML providers (ollama/lm-studio/…) aren't in pi-ai's catalog → the
    // seam would skip; build a spec so usefulness judging runs locally too.
    const usefulnessCustomModel = buildCustomJudgeModelSpec(
      container.config.providers?.entries?.[resolved.provider],
      resolved.provider,
      resolved.modelId,
    );
    const judge = createUsefulnessJudgeSeam({
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey,
      maxOutputTokens: USEFULNESS_JUDGE_MAX_OUTPUT_TOKENS,
      clock,
      logger: judgeLogger,
      agentId,
      customModel: usefulnessCustomModel,
    });
    const verdict = await judge({ candidateIds, answer: "" });

    // WRITE the partition through recordUsage, scoped to (tenant, agent). A failed write is
    // non-fatal (WARN + onComplete error), never thrown out of the dispatcher.
    judgeLogger.debug({ agentId, step: "usefulness-judge" as const, candidateCount: candidateIds.length, usedCount: verdict.usedIds.length, ignoredCount: verdict.ignoredIds.length }, "Usefulness judge verdict resolved");
    const wrote = await usefulnessStore.recordUsage(verdict.usedIds, verdict.ignoredIds, { tenantId: judgeTenantId, agentId, now: clock.now() });
    if (!wrote.ok) {
      judgeLogger.warn({ agentId, err: wrote.error, hint: "usefulness verdict recordUsage failed -- will retry next cycle", errorKind: "dependency" as const }, "Usefulness judge recordUsage error");
      payload.onComplete?.({ status: "error", error: wrote.error?.message });
      return true;
    }
    judgeLogger.info({ agentId, usedCount: verdict.usedIds.length, ignoredCount: verdict.ignoredIds.length, durationMs: clock.now() - startMs }, "Usefulness judge complete");
    payload.onComplete?.({ status: "ok", error: undefined });
    return true;
  }

  // -- Memory lifecycle sentinel intercept (FORGET-01/06) --
  // KEYLESS: no model/key/build seam. Re-checks memoryLifecycle.enabled (defence-in-depth, the
  // cron gate) + threads THIS agent's learningForgetting eviction policy onto the sweep CALL
  // (the shared store is constructed once; the behavior is per-agent — resolved decision #3,
  // learningForgetting drives eviction while memoryLifecycle is the cron gate). OFF by default →
  // no override → DORMANT sweep (byte-identical). On the result it emits the daemon-side
  // learning:memory_demoted/evicted counts (the store has no bus). Non-fatal + counts-only (§2.7).
  if (resultText === "__MEMORY_LIFECYCLE__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Memory lifecycle job fired without agentId", errorKind: "config" as const }, "Skipping memory lifecycle -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for memory lifecycle" });
      return true;
    }

    const agentConfig = agents[agentId];
    const cfg = agentConfig?.memoryLifecycle;
    if (!cfg?.enabled) {
      // The opt-in gate (defence-in-depth re-check): a disabled agent does NOTHING (clean ok run).
      logger.debug({ agentId }, "Memory lifecycle disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    if (!memoryLifecycleStore) {
      logger.warn({ agentId, hint: "memoryLifecycleStore not injected -- cannot run the lifecycle sweep", errorKind: "config" as const }, "Skipping memory lifecycle -- lifecycle store not wired");
      payload.onComplete?.({ status: "error", error: "memory lifecycle store not wired" });
      return true;
    }

    const lifecycleTenantId = tenantId ?? container.config.tenantId ?? "default";
    const lifecycleStartMs = clock.now();
    // FORGET-06 per-call policy: thread THIS agent's learningForgetting eviction policy onto the
    // sweep CALL. OFF (the default) → no override → DORMANT sweep (byte-identical).
    const lf = agentConfig?.learningForgetting;
    // The eviction store consumes only the master gate + the corroborated-failure floor
    // (the FadeMem strength-decay disjunct + its strengthThreshold/failurePenalty knobs
    // were deleted in Phase 224-02 — the strength branch floored above its threshold and
    // never fired). The config keys still parse (their collapse is Phase 226); they are
    // simply no longer threaded into the sweep override.
    const evictionPolicy = lf?.enabled
      ? { evictionEnabled: lf.eviction?.enabled !== false, failureEvictionFloor: lf.eviction?.failureEvictionFloor }
      : undefined;
    const lifecycleResult = await memoryLifecycleStore.runLifecycleSweep({
      tenantId: lifecycleTenantId,
      agentId,
      now: clock.now(),
      ...(evictionPolicy !== undefined ? { policy: evictionPolicy } : {}),
    });

    if (!lifecycleResult.ok) {
      logger.error({ agentId, err: lifecycleResult.error, hint: "Memory lifecycle sweep failed -- will retry next cycle", errorKind: "internal" as const }, "Memory lifecycle sweep error");
    } else {
      // FORGET-06/OBS-01: an INFO completion line (durationMs + the real counts) + the daemon-side
      // learning:memory_* emits (counts-only convention). ids/bodies NEVER cross the bus (§2.7 /
      // SEC-01). With eviction OFF the counts are 0 (DORMANT).
      const r = lifecycleResult.value;
      logger.child({ agentId, submodule: "memory-lifecycle" }).info(
        { agentId, scanned: r.scanned, promoted: r.promoted, demoted: r.demoted, evicted: r.evicted, durationMs: clock.now() - lifecycleStartMs },
        "Memory lifecycle sweep complete",
      );
      container.eventBus.emit("learning:memory_demoted", { agentId, count: r.demoted, timestamp: clock.now() });
      container.eventBus.emit("learning:memory_evicted", { agentId, count: r.evicted, timestamp: clock.now() });
    }
    payload.onComplete?.({ status: lifecycleResult.ok ? "ok" : "error", error: lifecycleResult.ok ? undefined : lifecycleResult.error?.message });
    return true;
  }

  // -- Memory triple-extraction sentinel intercept (WIRE-01) --
  // Dispatches the exported-but-never-scheduled runMemoryTripleExtraction behind the
  // per-agent default-OFF flag. Complementary (higher-recall S/P/O from raw turns), NOT
  // redundant with __MEMORY_REASONING__. Mirrors the reasoning block: opt-in re-check +
  // cheap "cron" model/key, then build the OFFLINE extractor seam and run the job (the
  // trust-first upsertTriple parser-seam strips any model-asserted trust). Non-fatal.
  if (resultText === "__MEMORY_TRIPLE_EXTRACTION__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Triple extraction job fired without agentId", errorKind: "config" as const }, "Skipping triple extraction -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for triple extraction" });
      return true;
    }

    const agentConfig = agents[agentId];
    const cfg = agentConfig?.memoryTripleExtraction;
    if (!cfg?.enabled) {
      // The opt-in cost gate (defence-in-depth re-check): a disabled (or default-config) agent does NO work.
      logger.debug({ agentId }, "Triple extraction disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    if (!tripleStore) {
      logger.warn({ agentId, hint: "tripleStore not injected -- cannot run triple extraction", errorKind: "config" as const }, "Skipping triple extraction -- triple store not wired");
      payload.onComplete?.({ status: "error", error: "triple store not wired" });
      return true;
    }

    // Resolve the cheap "cron" model + API key by NAME (Pino auto-redacts).
    const resolved = resolveOperationModel({
      operationType: "cron",
      agentProvider: agentConfig.provider ?? "anthropic",
      agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: agentConfig.operationModels ?? {},
      providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
    });
    const cred = await resolveCronJobCredential(container, agentId, resolved.provider, ctx.resolveAccessToken);
    const apiKey = cred.apiKey;
    if (!apiKey) {
      logger.warn({ agentId, provider: resolved.provider, hint: cronCredentialSkipHint(cred, resolved.provider, "triple extraction"), errorKind: "config" as const }, "Skipping triple extraction -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ` + resolved.provider });
      return true;
    }

    const tripleTenantId = tenantId ?? container.config.tenantId ?? "default";
    const tripleLogger = logger.child({ agentId, submodule: "triple-extraction" });

    // The OFFLINE extractor `extract` contract (text → TripleCandidate[]). This is a P0
    // scaffold: it returns [] (no fabricated triples), so no cheap-model seam is built here.
    // (The reasoning-seam wrapper this scaffold formerly reused was deleted with the
    // memory-reasoning subsystem in v2.31 Phase 225-05; the real extractor a future plan
    // supplies will resolve its own seam.) The source text is the bounded recent high-trust
    // memory content (ids+content via memoryApi.inspect); the job's own validateMemoryWrite +
    // the trust-first upsertTriple seam cap every candidate's trust in CODE.
    const extract = async (_text: string): Promise<TripleCandidate[]> => [];
    const sourceText = memoryApi
      ? memoryApi
          .inspect({ tenantId: tripleTenantId, agentId, limit: cfg.maxCandidatesPerRun ?? 200 })
          .map((r) => r.content)
          .join("\n")
      : "";

    const result = await runMemoryTripleExtraction({
      tripleStore,
      config: { enabled: cfg.enabled, maxCandidatesPerRun: cfg.maxCandidatesPerRun ?? 200 },
      agentId,
      tenantId: tripleTenantId,
      clock,
      logger: tripleLogger,
      eventBus: container.eventBus,
      extract,
      sourceText,
    });
    payload.onComplete?.({ status: result.ok ? "ok" : "error", error: result.ok ? undefined : result.error?.message });
    return true;
  }

  // -- Reflection sentinel intercept (v2.31 Reflection, Phase 223, REFLECT-01/02) --
  // The COMPOSITION ROOT for the reflection loop — the reflect-engine replacement for the
  // dead procedural-synthesis clustering handler: this is where the @comis/agent reflection
  // job (PORT TYPES only) meets the @comis/memory mental-model store + the trusted-origin
  // LCD source (assembled daemon-side in credentials.ts, injected via the `reflection`
  // bundle — the agent↛memory closed-graph cut). Re-checks learningSkills.enabled
  // (defence-in-depth — the scheduler already gates it; default OFF → clean ok no-op, ZERO
  // behavior change). Reads the LCD-merged source (NOT sessionStore.listDetailed — DAG-empty),
  // builds the cheap-model reflect adapter (wraps the UNTRUSTED transcript, INV-5) on the MID
  // tier, runs runReflection, and RE-EMITS the counts-only learning:skill_* events DAEMON-SIDE
  // (the NAMES are kept so the A→B ground-truth read + `comis explain` still work; the reflect:*
  // rename is Phase 226). The bridge entry lands with the emit (no agent-side gate trip).
  // Non-fatal + counts-only (§2.7).
  if (resultText === "__REFLECT__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Reflection job fired without agentId", errorKind: "config" as const }, "Skipping reflection -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for reflection" });
      return true;
    }

    const agentConfig = agents[agentId];
    const cfg = agentConfig?.learningSkills;
    if (!cfg?.enabled) {
      // The opt-in gate (defence-in-depth re-check): a disabled (or default-config) agent does
      // NOTHING — short-circuit ok so the scheduler records a clean run. Byte-identical (OFF).
      logger.debug({ agentId }, "Reflection disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    // The closed-graph injectables MUST be present (assembled daemon-side). Absent => cannot run —
    // surface a clean error rather than silently no-op (the field-plumbing lesson).
    if (!reflection) {
      logger.warn({ agentId, hint: "reflection bundle not injected -- cannot run reflection", errorKind: "config" as const }, "Skipping reflection -- store/source surface not wired");
      payload.onComplete?.({ status: "error", error: "reflection surface not wired" });
      return true;
    }

    // Resolve the cheap reflect model (the MID tier — a generalization op, not a fast classify) +
    // API key by NAME (Pino auto-redacts). NOT the agent's primary. The "skillSynthesis"
    // operationType STRING is REUSED (the MID-tier routing the dead synthesis used); the
    // reflect:* operationType rename is Phase 226 — do not invent a new tier here.
    const resolved = resolveOperationModel({
      operationType: "skillSynthesis",
      agentProvider: agentConfig.provider ?? "anthropic",
      agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: agentConfig.operationModels ?? {},
      providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
    });
    const cred = await resolveCronJobCredential(container, agentId, resolved.provider, ctx.resolveAccessToken);
    const apiKey = cred.apiKey;
    if (!apiKey) {
      logger.warn({ agentId, provider: resolved.provider, hint: cronCredentialSkipHint(cred, resolved.provider, "reflection"), errorKind: "config" as const }, "Skipping reflection -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ` + resolved.provider });
      return true;
    }

    const reflectTenantId = tenantId ?? container.config.tenantId ?? "default";
    const scope = { tenantId: reflectTenantId, agentId };
    const reflectLogger = logger.child({ agentId, submodule: "reflection" });
    const reflectStartMs = clock.now();

    // Phase 225 FOLD §3.2: ONE __REFLECT__ cron reflects ALL THREE kinds in one pass
    // (the I1 model — ONE engine, LOOPED, not three engines). The model/cred resolution
    // above runs ONCE (the same MID-tier reflect model for all kinds); per kind we vary
    // only the adapter `systemPrompt` + `source` label and the per-kind source build +
    // `groupKey`. SKILL keys on the normalized opening-request signature (the default,
    // groupKey undefined); PROFILE groups by user (groupKey `t.sender` ⇒ topicKey ===
    // userId, which Plan 02's <user_profile> read selects on); TOPIC keys like skill.
    const reflectKinds: ReadonlyArray<{
      kind: "skill" | "profile" | "topic";
      systemPrompt: string;
      source: "learned_skill_reflection" | "learned_profile_reflection" | "learned_topic_reflection";
      groupKey?: (t: ReflectionSourceTrajectory) => string;
    }> = [
      { kind: "skill", systemPrompt: REFLECT_PROMPT, source: "learned_skill_reflection" },
      { kind: "profile", systemPrompt: PROFILE_REFLECT_PROMPT, source: "learned_profile_reflection", groupKey: (t) => t.sender },
      { kind: "topic", systemPrompt: TOPIC_REFLECT_PROMPT, source: "learned_topic_reflection" },
    ];

    // SUMMED counts across the 3 kinds for ONE daemon-side learning:skill_* emit (counts
    // only — INV-6 / §2.7; NEVER a doc body / finding crosses the bus, for ANY kind).
    let anyError = false;
    let firstError: Error | undefined;
    let sumSelected = 0;
    let sumAdmitted = 0;
    let sumSkipped = 0;
    let maxCardinality = 0;
    // The acute "why 0 admitted" verdict: prefer the FIRST kind that admitted nothing for a
    // non-benign reason, else "admitted" if any kind admitted (first-match telemetry, counts-only).
    let admissionOutcome: ReflectAdmissionOutcome = "no_successes";

    for (const { kind, systemPrompt, source, groupKey } of reflectKinds) {
      // CLOSED-GRAPH CUT: the per-kind @comis/agent reflect adapter (wraps the UNTRUSTED
      // transcript via the per-kind `source` label, INV-5) is built HERE on the resolved
      // model; the @comis/memory store + the per-kind source come in via the daemon-assembled
      // bundle. The job consumes PORT TYPES only. The base model/key/custom-model opts are
      // identical across kinds — only systemPrompt + source vary.
      const reflectionAdapter = createLlmReflectionAdapter({
        provider: resolved.provider,
        modelId: resolved.modelId,
        apiKey,
        clock,
        logger: reflectLogger,
        systemPrompt,
        source,
        ...cronCustomModelOpt(container.config.providers?.entries?.[resolved.provider], resolved.provider, resolved.modelId),
      });
      const sourceTrajectories = await reflection.buildSourceTrajectories(kind, agentId, reflectTenantId);

      const r = await runReflection({
        agentId,
        tenantId: reflectTenantId,
        scope,
        kind, // Phase 225 FOLD — the threaded doc family (skill default if omitted)
        ...(groupKey ? { groupKey } : {}),
        config: {
          enabled: cfg.enabled,
          minConfidence: cfg.minConfidence,
          // The per-run topic ceiling (the DoS bound — one LLM call each). No config key
          // (learningSkills has none); 10 mirrors the job's DEFAULT_MAX_DOCS_PER_RUN. Each
          // kind is bounded independently → a known 3×maxDocsPerRun per-run LLM ceiling.
          maxDocsPerRun: 10,
        },
        sourceTrajectories,
        reflectionAdapter,
        outcomeSignal: reflection.outcomeSignal,
        // FOLD-01: the store Pick now carries `supersede` — a profile/topic correction
        // routes through it (history-append); skill stays admit-only (engine-enforced).
        mentalModelStore: reflection.learnedSkillStore,
        clock,
        logger: reflectLogger.child({ submodule: "reflection", reflectKind: kind }),
        eventBus: container.eventBus,
      });

      if (r.ok) {
        const v = r.value;
        sumSelected += v.selected;
        sumAdmitted += v.admitted;
        sumSkipped += v.skipped;
        maxCardinality = Math.max(maxCardinality, v.maxTopicCardinality);
        // Per-kind INFO completion line (the real counts) so an operator sees each kind's
        // outcome; the SUMMED daemon emit follows the loop. Counts ONLY (§2.7 / SEC-01).
        reflectLogger.info({ agentId, reflectKind: kind, selected: v.selected, admitted: v.admitted, maxTopicCardinality: v.maxTopicCardinality, skipped: v.skipped, admissionOutcome: v.admissionOutcome }, "Reflection (kind) complete");
        // The acute verdict: "admitted" wins; otherwise keep the first non-benign reason.
        if (v.admissionOutcome === "admitted") admissionOutcome = "admitted";
        else if (admissionOutcome !== "admitted") admissionOutcome = v.admissionOutcome;
      } else {
        anyError = true;
        firstError ??= r.error;
        reflectLogger.error({ agentId, reflectKind: kind, err: r.error, hint: "Reflection failed for kind -- will retry next cycle", errorKind: "internal" as const }, "Reflection error");
      }
    }

    // OBS-01: ONE DAEMON-SIDE telemetry emit + completion line, SUMMED across the 3 kinds.
    // Counts ONLY — NEVER a doc body / finding (§2.7 / SEC-01). With the disabled default the
    // whole block is unreachable (the no-op short-circuits above). The learning:skill_* NAMES
    // are KEPT (Q2 — minimize blast radius; the reflect:* rename is Phase 226).
    reflectLogger.info({ agentId, selected: sumSelected, admitted: sumAdmitted, maxTopicCardinality: maxCardinality, skipped: sumSkipped, admissionOutcome, durationMs: clock.now() - reflectStartMs }, "Reflection complete (all kinds)");
    // The `learning:skill_synthesized.count` contract is "how many were ADMITTED this run"
    // (events-learning.ts) — emit the SUMMED admitted across skill+profile+topic.
    container.eventBus.emit("learning:skill_synthesized", { agentId, count: sumAdmitted, timestamp: clock.now() });
    // The whole reflection FUNNEL alongside the admitted-count event, so `comis explain` answers
    // "why was 0 admitted" from the trajectory (maxClusterCardinality:1 = single uncorroborated
    // topic → not admissible) instead of a DEBUG-log grep. Counts only. Mapped from the SUMMED
    // reflect result: synthesized = selected (trusted-origin successes entering reflection),
    // validated/admitted = admitted (cleared the static validateLearnedDocBody guard + the write),
    // maxClusterCardinality = maxTopicCardinality (the distinct (session,sender) corroboration
    // size — the load-bearing field), admissionOutcome = the reflect verdict enum (D5).
    container.eventBus.emit("learning:skill_synthesis_funnel", {
      agentId,
      synthesized: sumSelected,
      validated: sumAdmitted,
      admitted: sumAdmitted,
      maxClusterCardinality: maxCardinality,
      // RC-4: the acute "why 0 admitted" verdict — one readable field on the funnel (the reflect
      // enum: no_successes / uncorroborated / empty_reflection / rejected_validation / admitted).
      admissionOutcome,
      timestamp: clock.now(),
    });
    payload.onComplete?.({ status: anyError ? "error" : "ok", error: anyError ? (firstError?.message ?? "reflection failed for one or more kinds") : undefined });
    return true;
  }

  return false;
}
