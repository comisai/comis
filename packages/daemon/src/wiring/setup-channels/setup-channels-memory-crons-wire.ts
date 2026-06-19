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

import { resolveCronJobCredential, cronCredentialSkipHint } from "./setup-channels-cron-credential.js";
import {
  resolveOperationModel,
  resolveProviderFamily,
  createUsefulnessJudgeSeam,
  createReasoningSeam,
  runMemoryTripleExtraction,
  runSkillSynthesis,
  createLlmSkillSynthesisAdapter,
  type TripleCandidate,
} from "@comis/agent";
import type { MemoryCronContext, MemoryCronPayload } from "./setup-channels-memory-crons-types.js";

/** The cheap-model output bound for the offline usefulness-judge call (cost axis). */
const USEFULNESS_JUDGE_MAX_OUTPUT_TOKENS = 1024;

/** The cheap-model output bound for the offline triple-extraction call (cost axis). */
const TRIPLE_EXTRACTION_MAX_OUTPUT_TOKENS = 1024;

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
  const { container, logger, clock, agents, tenantId, tripleStore, usefulnessStore, memoryApi, memoryLifecycleStore, skillSynthesis } = ctx;

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
    const judge = createUsefulnessJudgeSeam({
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey,
      maxOutputTokens: USEFULNESS_JUDGE_MAX_OUTPUT_TOKENS,
      clock,
      logger: judgeLogger,
      agentId,
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
    const evictionPolicy = lf?.enabled
      ? { evictionEnabled: lf.eviction?.enabled !== false, strengthThreshold: lf.eviction?.strengthThreshold, failurePenalty: lf.failurePenalty }
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

    // The OFFLINE extractor seam: a cheap-model completeSimple over the raw conversation
    // text (the createReasoningSeam cheap-model wrapper, reused). The job is the only LLM
    // use here and it is OFFLINE; a thrown extractor is non-fatal inside the job. The source
    // text is the bounded recent high-trust memory content (ids+content via memoryApi.inspect);
    // the trust-first upsertTriple seam caps every candidate's trust in CODE.
    const reasonSeam = createReasoningSeam({
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey,
      maxReasoningTokens: TRIPLE_EXTRACTION_MAX_OUTPUT_TOKENS,
      clock,
      logger: tripleLogger,
      agentId,
    });
    // Adapt the reasoning seam (deductive/inductive) into the triple-extraction `extract`
    // contract (text → TripleCandidate[]). The reasoning seam yields observation strings; the
    // job's own validateMemoryWrite + upsertTriple bound what is written. An empty/failed call
    // degrades to no candidates (the job stays non-fatal).
    const extract = async (_text: string): Promise<TripleCandidate[]> => [];
    const sourceText = memoryApi
      ? memoryApi
          .inspect({ tenantId: tripleTenantId, agentId, limit: cfg.maxCandidatesPerRun ?? 200 })
          .map((r) => r.content)
          .join("\n")
      : "";
    // reasonSeam is built so the cheap-model resolution is exercised + ready for the future
    // real extractor; the scaffold `extract` returns [] (no fabricated triples in P0).
    void reasonSeam;

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

  // -- Procedural skill-synthesis sentinel intercept (SKILL-08/09) --
  // The COMPOSITION ROOT for the shadow skill loop: this is where the @comis/agent job
  // (PORT TYPES only) meets the @comis/memory learned-skill store + the @comis/skills
  // validation adapter (both assembled daemon-side in credentials.ts, injected via the
  // `skillSynthesis` bundle — the agent↛memory/skills closed-graph cut). Re-checks
  // learningSkills.enabled (defence-in-depth — the scheduler already gates it; default
  // OFF → clean ok no-op, ZERO behavior change). Reads the LCD-merged source (NOT
  // sessionStore.listDetailed — DAG-empty), constructs the capability-routed synthesis
  // adapter on the skillSynthesis MID tier, runs runSkillSynthesis, and emits the
  // counts/coverage learning:skill_* events DAEMON-SIDE (the bridge entry lands with the
  // emit, so the agent-side trajectory gate is not triggered). Non-fatal + counts-only (§2.7).
  if (resultText === "__SKILL_SYNTHESIS__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Skill synthesis job fired without agentId", errorKind: "config" as const }, "Skipping skill synthesis -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for skill synthesis" });
      return true;
    }

    const agentConfig = agents[agentId];
    const cfg = agentConfig?.learningSkills;
    if (!cfg?.enabled) {
      // The opt-in gate (defence-in-depth re-check): a disabled (or default-config) agent does
      // NOTHING — short-circuit ok so the scheduler records a clean run. Byte-identical (shadow OFF).
      logger.debug({ agentId }, "Skill synthesis disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    // The closed-graph injectables MUST be present (assembled daemon-side). Absent => cannot run —
    // surface a clean error rather than silently no-op (the field-plumbing lesson).
    if (!skillSynthesis) {
      logger.warn({ agentId, hint: "skillSynthesis bundle not injected -- cannot run procedural synthesis", errorKind: "config" as const }, "Skipping skill synthesis -- store/validator/source surface not wired");
      payload.onComplete?.({ status: "error", error: "skill synthesis surface not wired" });
      return true;
    }

    // Resolve the capability-routed synthesis model (the skillSynthesis MID tier — a synthesis op,
    // not a fast classify) + API key by NAME (Pino auto-redacts). NOT the agent's primary.
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
      logger.warn({ agentId, provider: resolved.provider, hint: cronCredentialSkipHint(cred, resolved.provider, "skill synthesis"), errorKind: "config" as const }, "Skipping skill synthesis -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ` + resolved.provider });
      return true;
    }

    const skillTenantId = tenantId ?? container.config.tenantId ?? "default";
    const scope = { tenantId: skillTenantId, agentId };
    const skillLogger = logger.child({ agentId, submodule: "skill-synthesis" });
    const skillStartMs = clock.now();

    // CLOSED-GRAPH CUT: the @comis/agent synthesis adapter (wraps the UNTRUSTED trajectory) is built
    // HERE on the resolved model; the @comis/memory store + @comis/skills validation adapter + the
    // LCD-merged source come in via the daemon-assembled bundle. The job consumes PORT TYPES only.
    const synthesisAdapter = createLlmSkillSynthesisAdapter({ provider: resolved.provider, modelId: resolved.modelId, apiKey, clock, logger: skillLogger });
    const validationAdapter = await skillSynthesis.buildValidationAdapter(agentId);
    const sourceTrajectories = await skillSynthesis.buildSourceTrajectories(agentId, skillTenantId);

    const r = await runSkillSynthesis({
      agentId,
      tenantId: skillTenantId,
      scope,
      config: {
        enabled: cfg.enabled,
        autoAdmitReadOnly: cfg.autoAdmitReadOnly,
        minConfidence: cfg.minConfidence,
        requireForMutating: cfg.approval?.requireForMutating ?? true,
      },
      sourceTrajectories,
      synthesisAdapter,
      outcomeSignal: skillSynthesis.outcomeSignal,
      validationAdapter,
      learnedSkillStore: skillSynthesis.learnedSkillStore,
      approvalGate: skillSynthesis.approvalGate,
      clock,
      logger: skillLogger,
      eventBus: container.eventBus,
    });

    if (r.ok) {
      // OBS-01/SKILL-09: an INFO completion line (the real counts) + the DAEMON-SIDE telemetry emit.
      // Counts/coverage ONLY — NEVER a procedure body / script / finding (§2.7 / SEC-01). With the
      // disabled default this branch is unreachable (the no-op short-circuits above).
      const v = r.value;
      skillLogger.info({ agentId, synthesized: v.synthesized, admitted: v.admitted, validated: v.validated, approvalRequested: v.approvalRequested, abstained: v.abstained, durationMs: clock.now() - skillStartMs }, "Skill synthesis complete");
      // WR-02: the `learning:skill_synthesized.count` contract is "how many were
      // ADMITTED this run" (events-learning.ts) — emit v.admitted, NOT v.synthesized
      // (synthesized >= admitted; a synthesized candidate may fail validation/admission).
      container.eventBus.emit("learning:skill_synthesized", { agentId, count: v.admitted, timestamp: clock.now() });
      // WR-01: emit one learning:skill_validated per validated candidate (booleans +
      // coverage ONLY) so the learned_skill_failing validation-failure obs path is
      // reachable (it was consumed by the verdict but never emitted). DAEMON-SIDE,
      // plain emit (the trajectory-bridge entry lands with the emit).
      for (const verdict of v.validations) {
        container.eventBus.emit("learning:skill_validated", {
          agentId,
          staticOk: verdict.staticOk,
          dynamicOk: verdict.dynamicOk,
          coverage: verdict.coverage,
          timestamp: clock.now(),
        });
      }
    } else {
      skillLogger.error({ agentId, err: r.error, hint: "Skill synthesis failed -- will retry next cycle", errorKind: "internal" as const }, "Skill synthesis error");
    }
    payload.onComplete?.({ status: r.ok ? "ok" : "error", error: r.ok ? undefined : r.error?.message });
    return true;
  }

  return false;
}
