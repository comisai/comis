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
 * - __MEMORY_LIFECYCLE__: the KEYLESS soft-eviction sweep.
 *   Threads THIS agent's collapsed `learning.forget` eviction policy onto the per-call sweep
 *   scope (the shared store is constructed once; the behavior is per-agent) and emits the
 *   daemon-side learning:memory_demoted/evicted counts (the store has no bus). OFF by
 *   default → DORMANT (byte-identical). Moved here for the 600L setup-channels dir cap.
 * - __REFLECT__: the composition root for the reflection loop
 *   — injects the @comis/memory mental-model store + the trusted-origin LCD source into
 *   runReflection and re-emits the counts-only learning:skill_* funnel daemon-side.
 *
 * (The __USEFULNESS_JUDGE__ + __MEMORY_TRIPLE_EXTRACTION__ dormant crons were DELETED —
 * their dispatch branches are gone; an unrecognized sentinel returns false.)
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
  classifyReflectOutcome,
  createLlmReflectionAdapter,
  REFLECT_PROMPT,
  PROFILE_REFLECT_PROMPT,
  TOPIC_REFLECT_PROMPT,
  PROCEDURE_REFLECT_PROMPT,
  type ReflectionSourceTrajectory,
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

  // (The __USEFULNESS_JUDGE__ sentinel dispatch was DELETED.
  // It built a cheap-model usefulness-judge seam and WROTE its verdict through
  // usefulnessStore.recordUsage — a dormant cost-gated cron. The reward write
  // (success→recordUsage / failure→recordFailure) lives in setup-learning.ts (a separate
  // reward seam) and is untouched; the MemoryUsefulnessStore + its sqlite adapter survive.
  // An unrecognized sentinel falls through to `return false` below — the benign
  // no-op for any persisted stale judge job row.)

  // -- Memory lifecycle sentinel intercept --
  // KEYLESS: no model/key/build seam. Re-checks memoryLifecycle.enabled (defence-in-depth, the
  // cron gate) + threads THIS agent's learningForgetting eviction policy onto the sweep CALL
  // (the shared store is constructed once; the behavior is per-agent —
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
    // Per-call policy: thread THIS agent's collapsed learning forget policy onto the
    // sweep CALL. OFF (memory.enabled / learning.enabled) → no override → DORMANT sweep (byte-identical).
    // The former `learningForgetting` block collapsed into `learning.forget`:
    // the eviction store consumes only the master gate + the corroborated-failure floor (the FadeMem
    // strength-decay disjunct + its strengthThreshold/failurePenalty knobs were removed
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
      // An INFO completion line (durationMs + the real counts) + the daemon-side
      // learning:memory_* emits (counts-only convention). ids/bodies NEVER cross the bus (§2.7).
      // With eviction OFF the counts are 0 (DORMANT).
      const r = lifecycleResult.value;
      logger.child({ agentId, submodule: "memory-lifecycle" }).info(
        { agentId, scanned: r.scanned, promoted: r.promoted, demoted: r.demoted, evicted: r.evicted, durationMs: clock.now() - lifecycleStartMs },
        "Memory lifecycle sweep complete",
      );
      container.eventBus.emit("learning:memory_demoted", { agentId, count: r.demoted, timestamp: clock.now() });
      container.eventBus.emit("learning:memory_evicted", { agentId, count: r.evicted, timestamp: clock.now() });
      // The once-per-run forget-sweep SUMMARY — parity with reflect:funnel
      // so `cron.runs jobName "Memory lifecycle"` + the fleet lens answer "what did forget do" in one call
      // (was a db.mjs evicted_at poll). Counts ONLY (§2.7).
      container.eventBus.emit("learning:lifecycle_swept", { agentId, scanned: r.scanned, promoted: r.promoted, demoted: r.demoted, evicted: r.evicted, timestamp: clock.now() });
    }
    payload.onComplete?.({ status: lifecycleResult.ok ? "ok" : "error", error: lifecycleResult.ok ? undefined : lifecycleResult.error?.message });
    return true;
  }

  // (The __MEMORY_TRIPLE_EXTRACTION__ sentinel dispatch was DELETED.
  // It ran runMemoryTripleExtraction — a no-op scaffold whose `extract` returned []
  // (no triples were ever written), gated default-OFF. The TripleStorePort + its sqlite adapter
  // + the graphSpread recall lane (recall-graph-spread-lane.ts, gated rag.lanes.graphSpread)
  // SURVIVE — only the dormant extraction JOB + its cron-context `tripleStore` field went, not
  // the read lane. An unrecognized sentinel falls through to `return false` below — the
  // benign no-op for any persisted stale triple-extraction job row.)

  // -- Reflection sentinel intercept --
  // The COMPOSITION ROOT for the reflection loop — the reflect-engine replacement for the
  // dead procedural-synthesis clustering handler: this is where the @comis/agent reflection
  // job (PORT TYPES only) meets the @comis/memory mental-model store + the trusted-origin
  // LCD source (assembled daemon-side in credentials.ts, injected via the `reflection`
  // bundle — the agent↛memory closed-graph cut). Re-checks learningSkills.enabled
  // (defence-in-depth — the scheduler already gates it; default OFF → clean ok no-op, ZERO
  // behavior change). Reads the LCD-merged source (NOT sessionStore.listDetailed — DAG-empty),
  // builds the cheap-model reflect adapter (wraps the UNTRUSTED transcript on the per-kind source label) on the MID
  // tier, runs runReflection, and RE-EMITS the counts-only reflect:admitted/reflect:funnel events DAEMON-SIDE
  // so the A→B ground-truth read + `comis explain` still work. The bridge entry lands with the
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
    // reflect:* naming is only for events — do not invent a new operationType tier here.
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

    // ONE __REFLECT__ cron runs ALL FOUR reflect passes in one loop
    // (ONE engine, LOOPED, not four engines). The model/cred resolution
    // above runs ONCE (the same MID-tier reflect model for all passes); per pass we vary
    // only the adapter `systemPrompt` + `source` label and the per-kind source build +
    // `groupKey`. SKILL keys on the normalized opening-request signature (the default,
    // groupKey undefined); PROFILE groups by user (groupKey `t.sender` ⇒ topicKey ===
    // userId, which the <user_profile> read selects on); TOPIC keys like skill. The 4th
    // PROCEDURE pass is a kind:"skill" entry that groups by the audited descriptor KEY
    // instead of the user intent (two kind:"skill" passes → DIFFERENT topicKeys → different
    // doc names → no collision) and sets `populateProcedureMetadata` so its admit binds the
    // DETERMINISTIC required_tools (and its reflect input carries the ordered tool sequence).
    const reflectKinds: ReadonlyArray<{
      kind: "skill" | "profile" | "topic";
      systemPrompt: string;
      source:
        | "learned_skill_reflection"
        | "learned_profile_reflection"
        | "learned_topic_reflection"
        | "learned_procedure_reflection";
      groupKey?: (t: ReflectionSourceTrajectory) => string;
      populateProcedureMetadata?: boolean;
    }> = [
      { kind: "skill", systemPrompt: REFLECT_PROMPT, source: "learned_skill_reflection" },
      { kind: "profile", systemPrompt: PROFILE_REFLECT_PROMPT, source: "learned_profile_reflection", groupKey: (t) => t.sender },
      { kind: "topic", systemPrompt: TOPIC_REFLECT_PROMPT, source: "learned_topic_reflection" },
      // The PROCEDURE pass: kind:"skill" (surfaces through the shipped skill path) but grouped
      // by the content-free descriptor key (a defined groupKey ⇒ the Jaccard signature-merge is
      // bypassed; "" ⇒ ungroupable singleton, skipped). populateProcedureMetadata gates the
      // deterministic required_tools bind + the ordered-sequence thread into the reflect input.
      {
        kind: "skill",
        systemPrompt: PROCEDURE_REFLECT_PROMPT,
        source: "learned_procedure_reflection",
        groupKey: (t) => t.procedureDescriptor?.key ?? "",
        populateProcedureMetadata: true,
      },
    ];

    // SUMMED counts across the 3 kinds for ONE daemon-side reflect:* emit (counts
    // only — §2.7; NEVER a doc body / finding crosses the bus, for ANY kind).
    let anyError = false;
    let firstError: Error | undefined;
    let sumSelected = 0;
    let sumAdmitted = 0;
    let sumSkipped = 0;
    let maxCardinality = 0;
    // The 2 new funnel counts SUMMED across the
    // kinds for the once-per-run INFO line (the per-kind verdict already encodes them — see below).
    let sumUntrustedDrops = 0;
    let sumNameLengthRejections = 0;
    // Content-free source telemetry summed across kinds for the funnel emit.
    let sumSourceTrajectoryCount = 0;
    let sumSourceChars = 0;
    // The aggregate "why 0 admitted" verdict is RE-CLASSIFIED from the
    // SUMMED counts AFTER the loop (classifyReflectOutcome) — NOT last-kind-wins. A last-kind-wins fold would let a
    // later kind's `no_successes` overwrite an earlier kind's meaningful `uncorroborated`, surfacing a
    // verdict that contradicted its own `selected` count (selected:2 alongside no_successes) and
    // misdirected the operator to "nothing to learn from" instead of "successes under-merged →
    // investigate the topicKey". Re-classifying from the same summed counts the funnel emits makes the
    // verdict consistent-by-construction with its counts (the funnel's documented "Mapped from the
    // SUMMED reflect result" intent). `emptyReflections` is summed so a corroborated-but-empty kind
    // aggregates to `empty_reflection`, not a mis-attributed `rejected_validation`.
    let sumEmptyReflections = 0;
    // Distinct topicKey groups across the kinds — the under-merge
    // discriminator (selected>1 + distinctTopicKeys>1 + maxCardinality<2 = successes that didn't merge).
    let sumDistinctTopicKeys = 0;
    // Topics corroborated via the single_owner repetition path, summed across kinds (obs).
    let sumSingleOwnerCorroborated = 0;

    for (const { kind, systemPrompt, source, groupKey, populateProcedureMetadata } of reflectKinds) {
      // CLOSED-GRAPH CUT: the per-kind @comis/agent reflect adapter (wraps the UNTRUSTED
      // transcript via the per-kind `source` label) is built HERE on the resolved
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
        kind, // the threaded doc family (skill default if omitted)
        ...(groupKey ? { groupKey } : {}),
        // Procedure pass ONLY — gates the deterministic required_tools bind + the
        // ordered-descriptor thread into the reflect input (absent on the other passes).
        ...(populateProcedureMetadata ? { populateProcedureMetadata } : {}),
        config: {
          enabled: cfg.enabled,
          minConfidence: cfg.reflect.minConfidence,
          // The per-run topic ceiling (the DoS bound — one LLM call each). Wired
          // from `learning.reflect.maxDocsPerRun` (default 25). Each kind is
          // bounded independently → a known 3×maxDocsPerRun per-run LLM ceiling.
          maxDocsPerRun: cfg.reflect.maxDocsPerRun,
          // The corroboration policy — single_owner (default) or distinct_sessions.
          // Threaded so a single-owner box learns from the owner's repeated successes
          // (distinct_sessions is structurally unreachable for one stable DM).
          corroboration: cfg.reflect.corroboration,
        },
        sourceTrajectories,
        reflectionAdapter,
        outcomeSignal: reflection.outcomeSignal,
        // The store Pick carries `supersede` — a profile/topic correction
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
        sumSourceTrajectoryCount += v.sourceTrajectoryCount;
        sumSourceChars += v.totalSourceChars;
        sumEmptyReflections += v.emptyReflections;
        sumDistinctTopicKeys += v.distinctTopicKeys;
        sumSingleOwnerCorroborated += v.singleOwnerCorroborated;
        maxCardinality = Math.max(maxCardinality, v.maxTopicCardinality);
        // Per-kind INFO completion line (the real counts) so an operator sees each kind's
        // outcome; the SUMMED daemon emit follows the loop. Counts ONLY (§2.7).
        reflectLogger.info({ agentId, reflectKind: kind, selected: v.selected, admitted: v.admitted, maxTopicCardinality: v.maxTopicCardinality, skipped: v.skipped, admissionOutcome: v.admissionOutcome }, "Reflection (kind) complete");
      } else {
        anyError = true;
        firstError ??= r.error;
        reflectLogger.error({ agentId, reflectKind: kind, err: r.error, hint: "Reflection failed for kind -- will retry next cycle", errorKind: "internal" as const }, "Reflection error");
      }
    }

    // The aggregate verdict, re-classified from the SUMMED counts (consistent-by-construction
    // with the counts the funnel emits below) — `admitted` if any kind admitted, else the most-acute
    // count-derived reason (uncorroborated / untrusted_origin / empty_reflection / … / no_successes).
    const admissionOutcome = classifyReflectOutcome({
      selected: sumSelected,
      maxTopicCardinality: maxCardinality,
      admitted: sumAdmitted,
      emptyReflections: sumEmptyReflections,
      untrustedDrops: sumUntrustedDrops,
      nameLengthRejections: sumNameLengthRejections,
    });

    // ONE DAEMON-SIDE telemetry emit + completion line, SUMMED across the 3 kinds.
    // Counts ONLY — NEVER a doc body / finding (§2.7). With the disabled default the
    // whole block is unreachable (the no-op short-circuits above). The funnel events are
    // reflect:* (reflect:admitted/reflect:funnel; the forget/outcome events
    // KEEP their learning:* names). untrustedDrops /
    // nameLengthRejections / skipped + the source counts ALSO ride the content-free bus payload (they
    // are COUNTS, like admitted/synthesized — bodies are forbidden on the bus, not counts), so `comis explain`
    // answers "HOW MANY untrusted dropped / was the source empty" without a daemon.log grep.
    reflectLogger.info({ agentId, selected: sumSelected, admitted: sumAdmitted, maxTopicCardinality: maxCardinality, singleOwnerCorroborated: sumSingleOwnerCorroborated, distinctTopicKeys: sumDistinctTopicKeys, skipped: sumSkipped, untrustedDrops: sumUntrustedDrops, nameLengthRejections: sumNameLengthRejections, sourceTrajectoryCount: sumSourceTrajectoryCount, totalSourceChars: sumSourceChars, admissionOutcome, durationMs: clock.now() - reflectStartMs }, "Reflection complete (all kinds)");
    // The `reflect:admitted.count` contract is "how many were ADMITTED this run"
    // (events-learning.ts) — emit the SUMMED admitted across skill+profile+topic.
    container.eventBus.emit("reflect:admitted", { agentId, count: sumAdmitted, timestamp: clock.now() });
    // The whole reflection FUNNEL alongside the admitted-count event, so `comis explain` answers
    // "why was 0 admitted" from the trajectory (maxClusterCardinality:1 = single uncorroborated
    // topic → not admissible) instead of a DEBUG-log grep. Counts only. Mapped from the SUMMED
    // reflect result: synthesized = selected (trusted-origin successes entering reflection),
    // validated/admitted = admitted (cleared the static validateLearnedDocBody guard + the write),
    // maxClusterCardinality = maxTopicCardinality (the distinct (session,sender) corroboration
    // size — the load-bearing field), admissionOutcome = the reflect verdict enum (including the
    // untrusted_origin / rejected_name_length values).
    container.eventBus.emit("reflect:funnel", {
      agentId,
      synthesized: sumSelected,
      validated: sumAdmitted,
      admitted: sumAdmitted,
      maxClusterCardinality: maxCardinality,
      // Topics corroborated via the single_owner repetition path (0 in distinct_sessions mode) —
      // so a maxClusterCardinality:1 run that STILL admitted reads as single-owner, not a bug.
      singleOwnerCorroborated: sumSingleOwnerCorroborated,
      // Distinct topicKey groups — the under-merge discriminator (paired with synthesized +
      // maxClusterCardinality: synthesized>1 & distinctTopicKeys>1 & maxClusterCardinality<2 = under-merge).
      distinctTopicKeys: sumDistinctTopicKeys,
      // The funnel MAGNITUDES alongside the verdict (counts only). untrustedDrops is the
      // count behind an `untrusted_origin` verdict; sourceTrajectoryCount/totalSourceChars
      // distinguish an empty-source wiring gap from an LLM-yield (real text in, junk doc out).
      untrustedDrops: sumUntrustedDrops,
      nameLengthRejections: sumNameLengthRejections,
      skipped: sumSkipped,
      sourceTrajectoryCount: sumSourceTrajectoryCount,
      totalSourceChars: sumSourceChars,
      // The acute "why 0 admitted" verdict — one readable field on the funnel (the reflect
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
