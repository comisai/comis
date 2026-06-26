// SPDX-License-Identifier: Apache-2.0
/**
 * Sibling-hosted memory-cron sentinel handlers.
 *
 * Split out of setup-channels-memory-crons.ts (which is at the 600L setup-channels
 * cap) so these sentinels live in their own leaf. The original
 * `handleMemoryCronSentinel` delegates here at its fall-through, so the caller +
 * the existing test entry point are unchanged.
 *
 * Sentinels handled here:
 * - __MEMORY_LIFECYCLE__ (FORGET-01/06, Phase 200 Plan 06): the KEYLESS soft-eviction sweep.
 *   Threads THIS agent's collapsed `learning.forget` eviction policy onto the per-call sweep
 *   scope (the shared store is constructed once; the behavior is per-agent) and emits the
 *   daemon-side learning:memory_demoted/evicted counts (the store has no bus). OFF by
 *   default → DORMANT (byte-identical). Moved here for the 600L setup-channels dir cap.
 * - __REFLECT__ (v2.31 Reflection, Phase 223): the composition root for the reflection loop
 *   — injects the @comis/memory mental-model store + the trusted-origin LCD source into
 *   runReflection and re-emits the counts-only learning:skill_* funnel daemon-side.
 *
 * (The __USEFULNESS_JUDGE__ + __MEMORY_TRIPLE_EXTRACTION__ dormant crons were DELETED in
 * Phase 226-03 — their dispatch branches are gone; an unrecognized sentinel returns false.)
 *
 * Both re-check cfg.enabled (defence-in-depth — the scheduler already gates, a stale
 * persisted job must not run for a now-disabled agent), inject the segregated store(s)
 * as port TYPES only (the agent↛memory cut), and are NON-FATAL + counts/ids-only (§2.7).
 *
 * @module
 */

import { resolveCronJobCredential, cronCredentialSkipHint, cronCustomModelOpt } from "./setup-channels-cron-credential.js";
import {
  resolveOperationModel,
  resolveProviderFamily,
  runReflection,
  createLlmReflectionAdapter,
  REFLECT_PROMPT,
  PROFILE_REFLECT_PROMPT,
  TOPIC_REFLECT_PROMPT,
  type ReflectionSourceTrajectory,
  type ReflectAdmissionOutcome,
} from "@comis/agent";
import type { MemoryCronContext, MemoryCronPayload } from "./setup-channels-memory-crons-types.js";

/**
 * Handle the sibling-hosted memory-cron sentinels (the KEYLESS `__MEMORY_LIFECYCLE__`
 * forget sweep + the `__REFLECT__` engine). Returns `true` when the sentinel was
 * recognized + handled (the caller then returns), `false` when it is neither (the
 * original handler falls through to the normal delivery path — see the deletion note below).
 */
export async function handleWireMemoryCronSentinel(
  resultText: string | undefined,
  payload: MemoryCronPayload,
  ctx: MemoryCronContext,
): Promise<boolean> {
  const { container, logger, clock, agents, tenantId, memoryLifecycleStore, reflection } = ctx;

  // (The __USEFULNESS_JUDGE__ sentinel dispatch was DELETED in Phase 226 SIMPLIFY-03 (D-03).
  // It built a cheap-model usefulness-judge seam and WROTE its verdict through
  // usefulnessStore.recordUsage — a dormant cost-gated cron. The FORGET-02 reward write
  // (success→recordUsage / failure→recordFailure) lives in setup-learning.ts (a separate
  // reward seam) and is untouched; the MemoryUsefulnessStore + its sqlite adapter survive.
  // An unrecognized sentinel falls through to `return false` below — the T-226-08 benign
  // no-op for any persisted stale judge job row.)

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
    // FORGET-06 per-call policy: thread THIS agent's collapsed learning forget policy onto the
    // sweep CALL. OFF (memory.enabled / learning.enabled) → no override → DORMANT sweep (byte-identical).
    // Phase 226 (SIMPLIFY-01) collapsed the former `learningForgetting` block into `learning.forget`:
    // the eviction store consumes only the master gate + the corroborated-failure floor (the FadeMem
    // strength-decay disjunct + its strengthThreshold/failurePenalty knobs were deleted in Phase 224-02
    // — the strength branch floored above its threshold and never fired). With the per-loop block gone,
    // `evictionEnabled` folds into the single `learning.enabled` gate; the floor reads learning.forget.failureEvictionFloor.
    const learningCfg = agentConfig?.learning;
    const evictionPolicy = learningCfg?.enabled
      ? { evictionEnabled: true, failureEvictionFloor: learningCfg.forget?.failureEvictionFloor }
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

  // (The __MEMORY_TRIPLE_EXTRACTION__ sentinel dispatch was DELETED in Phase 226 SIMPLIFY-03
  // (D-03). It ran runMemoryTripleExtraction — a no-op scaffold whose `extract` returned []
  // (no triples were ever written), gated default-OFF. The TripleStorePort + its sqlite adapter
  // + the graphSpread recall lane (recall-graph-spread-lane.ts, gated rag.lanes.graphSpread)
  // SURVIVE — only the dormant extraction JOB + its cron-context `tripleStore` field went, not
  // the read lane. An unrecognized sentinel falls through to `return false` below — the
  // T-226-08 benign no-op for any persisted stale triple-extraction job row.)

  // -- Reflection sentinel intercept (v2.31 Reflection, Phase 223, REFLECT-01/02) --
  // The COMPOSITION ROOT for the reflection loop — the reflect-engine replacement for the
  // dead procedural-synthesis clustering handler: this is where the @comis/agent reflection
  // job (PORT TYPES only) meets the @comis/memory mental-model store + the trusted-origin
  // LCD source (assembled daemon-side in credentials.ts, injected via the `reflection`
  // bundle — the agent↛memory closed-graph cut). Re-checks learningSkills.enabled
  // (defence-in-depth — the scheduler already gates it; default OFF → clean ok no-op, ZERO
  // behavior change). Reads the LCD-merged source (NOT sessionStore.listDetailed — DAG-empty),
  // builds the cheap-model reflect adapter (wraps the UNTRUSTED transcript, INV-5) on the MID
  // tier, runs runReflection, and RE-EMITS the counts-only reflect:* funnel events DAEMON-SIDE
  // (Phase 226 SIMPLIFY-04 renamed the old synthesis-funnel events to reflect:admitted/reflect:funnel
  // so the A→B ground-truth read + `comis explain` still work). The bridge entry lands with the
  // emit (no agent-side gate trip). Non-fatal + counts-only (§2.7).
  if (resultText === "__REFLECT__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Reflection job fired without agentId", errorKind: "config" as const }, "Skipping reflection -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for reflection" });
      return true;
    }

    const agentConfig = agents[agentId];
    const cfg = agentConfig?.learning;
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

    // SUMMED counts across the 3 kinds for ONE daemon-side reflect:* emit (counts
    // only — INV-6 / §2.7; NEVER a doc body / finding crosses the bus, for ANY kind).
    let anyError = false;
    let firstError: Error | undefined;
    let sumSelected = 0;
    let sumAdmitted = 0;
    let sumSkipped = 0;
    let maxCardinality = 0;
    // Phase 226 (D5 salvage + the 225 WR-01 gap): the 2 new funnel counts SUMMED across the
    // kinds for the once-per-run INFO line (the per-kind verdict already encodes them — see below).
    let sumUntrustedDrops = 0;
    let sumNameLengthRejections = 0;
    // The acute "why 0 admitted" verdict: prefer the FIRST kind that admitted nothing for a
    // non-benign reason, else "admitted" if any kind admitted (first-match telemetry, counts-only).
    // Each kind's runReflection already computes untrusted_origin / rejected_name_length from its
    // own SELECT/admit counts, so a kind that drops everything for untrusted origin (or rejects a
    // name over-cap) propagates that verdict here without a summed re-classify.
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
          minConfidence: cfg.reflect.minConfidence,
          // The per-run topic ceiling (the DoS bound — one LLM call each). Phase 226 wires this
          // from `learning.reflect.maxDocsPerRun` (default 25; was a hardcoded 10). Each kind is
          // bounded independently → a known 3×maxDocsPerRun per-run LLM ceiling.
          maxDocsPerRun: cfg.reflect.maxDocsPerRun,
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
        sumUntrustedDrops += v.untrustedDrops;
        sumNameLengthRejections += v.nameLengthRejections;
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
    // whole block is unreachable (the no-op short-circuits above). The funnel events are now
    // reflect:* (Phase 226 SIMPLIFY-04 — the synthesis-funnel rename; the forget/outcome events
    // KEEP their learning:* names, Pitfall 6). untrustedDrops + nameLengthRejections ride the
    // INFO line (operator grep) — NOT the content-free bus payload (the admissionOutcome enum
    // encodes them; INV-6 keeps the funnel payload counts + one closed enum only).
    reflectLogger.info({ agentId, selected: sumSelected, admitted: sumAdmitted, maxTopicCardinality: maxCardinality, skipped: sumSkipped, untrustedDrops: sumUntrustedDrops, nameLengthRejections: sumNameLengthRejections, admissionOutcome, durationMs: clock.now() - reflectStartMs }, "Reflection complete (all kinds)");
    // The `reflect:admitted.count` contract is "how many were ADMITTED this run"
    // (events-learning.ts) — emit the SUMMED admitted across skill+profile+topic.
    container.eventBus.emit("reflect:admitted", { agentId, count: sumAdmitted, timestamp: clock.now() });
    // The whole reflection FUNNEL alongside the admitted-count event, so `comis explain` answers
    // "why was 0 admitted" from the trajectory (maxClusterCardinality:1 = single uncorroborated
    // topic → not admissible) instead of a DEBUG-log grep. Counts only. Mapped from the SUMMED
    // reflect result: synthesized = selected (trusted-origin successes entering reflection),
    // validated/admitted = admitted (cleared the static validateLearnedDocBody guard + the write),
    // maxClusterCardinality = maxTopicCardinality (the distinct (session,sender) corroboration
    // size — the load-bearing field), admissionOutcome = the reflect verdict enum (D5 + the 226
    // untrusted_origin / rejected_name_length values).
    container.eventBus.emit("reflect:funnel", {
      agentId,
      synthesized: sumSelected,
      validated: sumAdmitted,
      admitted: sumAdmitted,
      maxClusterCardinality: maxCardinality,
      // RC-4: the acute "why 0 admitted" verdict — one readable field on the funnel (the reflect
      // enum: no_successes / untrusted_origin / uncorroborated / empty_reflection /
      // rejected_name_length / rejected_validation / admitted).
      admissionOutcome,
      timestamp: clock.now(),
    });
    payload.onComplete?.({ status: anyError ? "error" : "ok", error: anyError ? (firstError?.message ?? "reflection failed for one or more kinds") : undefined });
    return true;
  }

  return false;
}
