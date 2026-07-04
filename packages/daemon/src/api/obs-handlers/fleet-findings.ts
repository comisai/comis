// SPDX-License-Identifier: Apache-2.0
/**
 * Fleet findings derivation: turn the ingested diagnostic rows (`health_signal` /
 * `model_health` / `config_posture`) into `{code, detail, count, hint}` findings.
 *
 * Lives separately from `fleet-health.ts` to keep that module under the
 * obs-handlers per-subdirectory file-size cap; the assembler there imports
 * `buildFindings`, the `Finding` shape, and the defensive details parsers
 * from here.
 *
 * SECURITY INVARIANT (the digest-only report schema): findings carry counts +
 * short codes + hints ONLY — NEVER concatenate the raw `row.message`/`row.details`
 * body. Every `details` JSON field read here is parsed defensively (malformed /
 * missing folds to a safe default, never throws, never echoes a body). The
 * closed ScriptClass/lane enums forwarded into the script findings are rendered
 * only into a count + a `script=`/`lane=` label.
 *
 * @module
 */
import type { DiagnosticRow } from "@comis/memory";
import type { PipelineAuthoringAggregate } from "@comis/observability";
import {
  chimericModelFromRow,
  DEDICATED_SCRIPT_SIGNALS,
  deliveryDeadletteredFromRow,
  flaggedPostureKeys,
  healthSignalLabel,
  multilingualFromRow,
  nodeBudgetExceededFromRow,
  pipelineAuthoringFromRow,
  pricingGapFromRow,
  sandboxDowngradeFromRow,
  scriptZeroHitFromRow,
  servedBelowConfiguredFromRow,
  voiceDegradedFromRow,
  type Finding,
} from "./fleet-findings-extractors.js";
import { buildAutonomyFindings } from "./fleet-autonomy.js";

// `Finding` is declared in the leaf `fleet-findings-extractors.ts` (so the
// `fleet-autonomy.ts` sibling can import it without a cycle) and re-exported here
// for this module's existing consumers (fleet-health.ts imports `type Finding`).
export type { Finding };

/**
 * The pipeline-authoring aggregate the authoring gate
 * (`pipelineAuthoringGate`) consumes — computed compute-on-read over the windowed
 * `health_signal` rows (no persisted rollup).
 *
 * The `PipelineAuthoringAggregate` type is SINGLE-SOURCED in
 * `@comis/observability` — this file imports the
 * canonical type (see the top-of-file `import type`) rather than declaring a
 * local duplicate.
 *
 * The small/local tier = capabilityClass "small" OR "nano"; frontier =
 * "frontier". "mid" and "unknown" rows are in NEITHER cohort (they are not the
 * comparison tiers). Rates are 0 (never NaN) when the cohort is empty.
 *
 * Reduce the windowed `health_signal` rows to the `PipelineAuthoringAggregate`.
 * PURE — no I/O, no globals, no Date.now(); malformed / non-pipeline rows fold out
 * (counted in neither cohort, never throws). Exported so fleet-health.ts
 * can feed the gate.
 */
export function pipelineAuthoringAggregateFromRows(
  rows: readonly DiagnosticRow[],
): PipelineAuthoringAggregate {
  let smallTotal = 0;
  let smallValid = 0;
  let frontierTotal = 0;
  let frontierValid = 0;
  for (const row of rows) {
    const parsed = pipelineAuthoringFromRow(row);
    if (parsed === null) continue;
    if (parsed.tier === "small" || parsed.tier === "nano") {
      smallTotal += 1;
      if (parsed.schemaValid) smallValid += 1;
    } else if (parsed.tier === "frontier") {
      frontierTotal += 1;
      if (parsed.schemaValid) frontierValid += 1;
    }
    // "mid" / "unknown": counted in neither cohort (not comparison tiers).
  }
  return {
    smallTierInvocations: smallTotal,
    smallTierValidRate: smallTotal > 0 ? smallValid / smallTotal : 0,
    frontierValidRate: frontierTotal > 0 ? frontierValid / frontierTotal : 0,
  };
}

/**
 * Derive `{code, detail, count, hint}` findings from the ingested diagnostic rows. Counts +
 * short codes + hints ONLY — NEVER the raw `row.message`/`row.details` body (the
 * report schema is digest-only). `health_signal` rows are grouped by their
 * closed `signal` label (so distinct signal classes are distinct findings);
 * `model_health` / `config_posture` are category-level rollups. The
 * script signals get DEDICATED findings (script=/lane= grouping + named knob
 * hints) and are excluded from the generic rollup so they are not double-reported
 * (mirrors how the served-below-configured dedicated finding sits beside the
 * config_posture rollup).
 */
/** Defensive `details` JSON parse: malformed / missing → `{}` (digest-only, never throws, never echoes a body). */
function parseDetailsObject(details: string | undefined): Record<string, unknown> {
  try {
    return details ? (JSON.parse(details) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The closed reflection admission-outcome vocabulary — off-vocabulary folds to "unknown". */
const REFLECT_ADMISSION_OUTCOMES: ReadonlySet<string> = new Set([
  "admitted", "uncorroborated", "rejected_validation", "rejected_name_length",
  "untrusted_origin", "empty_reflection", "no_successes",
]);

export function buildFindings(
  healthSignals: readonly DiagnosticRow[],
  modelHealth: readonly DiagnosticRow[],
  configPosture: readonly DiagnosticRow[],
  // The windowed `learning_health` rows (the reflection
  // funnel). Defaulted `[]` so callers that do not read this category stay unchanged.
  learningHealth: readonly DiagnosticRow[] = [],
  // The windowed `memory_lifecycle` rows (the forget sweep). Defaulted
  // `[]` so callers that do not read this category stay unchanged.
  memoryLifecycle: readonly DiagnosticRow[] = [],
): Finding[] {
  const findings: Finding[] = [];

  // health_signal — one finding per closed `signal` label (counts only). The
  // dedicated-signal labels are EXCLUDED here (they get dedicated findings below).
  // Severity-info rows are EXCLUDED too: the ingest layer stamps benign
  // reasons (session_rebase / serialized_wait — BENIGN_DAG_DEGRADED_REASONS)
  // severity "info" precisely so they do not read as degradation; folding them
  // here anyway surfaced a fresh session's once-per-start rebase as an
  // actionable lcd_divergence finding with a dead-end hint. Only warning+
  // rows are findings (the model_health rollup's established discipline).
  const bySignal = new Map<string, number>();
  for (const row of healthSignals) {
    if (row.severity === "info") continue;
    const label = healthSignalLabel(row);
    if (DEDICATED_SCRIPT_SIGNALS.has(label)) continue;
    bySignal.set(label, (bySignal.get(label) ?? 0) + 1);
  }
  for (const [label, count] of bySignal) {
    findings.push({
      code: `health_signal:${label}`,
      detail: `${count} ${label} health signal(s) in the window`,
      count,
      hint: "run `comis explain` on an affected session; inspect the recurring health WARNs",
    });
  }

  // Dedicated script_zero_hit finding — one per
  // (scriptClass, lane) group, reading "N non-Latin zero-hit searches
  // (script=X, lane=Y)". Counts + closed enums only; the hint names the repair
  // that backfills the normalized trigram twins (history backfill).
  const byScriptLane = new Map<string, number>();
  for (const row of healthSignals) {
    const parsed = scriptZeroHitFromRow(row);
    if (parsed === null) continue;
    const key = `${parsed.scriptClass} ${parsed.lane}`;
    byScriptLane.set(key, (byScriptLane.get(key) ?? 0) + 1);
  }
  for (const [key, count] of byScriptLane) {
    const [scriptClass, lane] = key.split(" ") as [string, string];
    findings.push({
      code: "script_zero_hit",
      detail: `${count} non-Latin zero-hit searches (script=${scriptClass}, lane=${lane})`,
      count,
      hint: "non-Latin search found nothing on a cleanly-executed lane; rebuild the normalized trigram twins with `comis doctor --repair` (history backfill), then `comis explain` an affected session",
    });
  }

  // Dedicated summary_language_mismatch finding — a single
  // rollup count whose hint names the exact knob (a non-Latin chunk summarized in
  // Latin; visibility only, never gated). Counts only, no source/summary body.
  const mismatchCount = healthSignals.filter(
    (row) => healthSignalLabel(row) === "summary_language_mismatch",
  ).length;
  if (mismatchCount > 0) {
    findings.push({
      code: "summary_language_mismatch",
      detail: `${mismatchCount} summary(ies) whose dominant script diverged from the source (non-Latin source → Latin summary)`,
      count: mismatchCount,
      hint: "summaries are drifting to Latin for non-Latin sources; set contextEngine.compaction.strongerSummarizerModel to a model that preserves the source language (visibility only — not gated)",
    });
  }

  // Dedicated generation_quality finding — the memory-generation analog of
  // summary_language_mismatch over the consolidation/reasoning/user-representation
  // passes (a regression class surfaced as a fleet count instead of an offline
  // probe). Counts only, no source/generated body; visibility only, never gated.
  const genQualityCount = healthSignals.filter(
    (row) => healthSignalLabel(row) === "generation_quality",
  ).length;
  if (genQualityCount > 0) {
    findings.push({
      code: "generation_quality",
      detail: `${genQualityCount} memory-generation pass(es) whose output diverged from the source (non-Latin source → Latin output, empty, or unparseable)`,
      count: genQualityCount,
      hint: "a memory-generation pass (consolidation/reasoning/user-representation) is producing low-quality output for non-Latin sources; the memory-pipeline model is too weak — configure a stronger memory model or pin providers.entries.<id>.capabilities.capabilityClass to frontier/mid (the R6 memory-ops override). Visibility only — not gated",
    });
  }

  // Dedicated pipeline_authoring finding — the HEADLINE
  // metric is the small-model pipeline-authoring failure rate = (small-tier rows
  // where schemaValid===false) / (small-tier rows total) over the window
  // (small|nano = the small tier). Counts + a static hint ONLY (no source/generated
  // graph body — the pipelineAuthoringFromRow parser reads only the closed tier +
  // the schemaValid boolean). Fires only when smallTotal > 0 (no finding on zero
  // small-tier traffic — mirrors the generation-quality/voice if-guards). The reducer
  // above is the same compute-on-read fold; here we re-walk for the invalid COUNT the
  // finding names.
  //
  // METRIC BOUNDARY: the denominator counts every
  // CONTRACT-PARSE-REACHABLE authoring invocation. graph.define emits
  // schemaValid:false on BOTH a strict-contract (GraphDefineContract) parse
  // rejection AND a buildGraphInput parse/validate throw; graph.execute (a loose
  // z.record contract that never rejects) emits on the buildGraphInput throw.
  // EXCLUDED — and so NOT in either cohort — are the bespoke pre-Zod guards
  // (graph.define's "Missing required parameter: nodes" empty-call check and
  // graph.execute's agent-to-agent-disabled policy gate): an empty/garbage call
  // or a policy rejection is not an "authoring attempt." This is a deliberate,
  // documented boundary, not a silent undercount.
  let smallTotal = 0;
  let smallInvalid = 0;
  for (const row of healthSignals) {
    const parsed = pipelineAuthoringFromRow(row);
    if (parsed === null) continue;
    if (parsed.tier === "small" || parsed.tier === "nano") {
      smallTotal += 1;
      if (!parsed.schemaValid) smallInvalid += 1;
    }
  }
  if (smallTotal > 0) {
    const pct = ((smallInvalid / smallTotal) * 100).toFixed(1);
    findings.push({
      code: "pipeline_authoring",
      detail: `${smallInvalid}/${smallTotal} small-tier pipeline authorings invalid (rate ${pct}%)`,
      count: smallInvalid,
      hint: "small/local models are failing to author valid pipeline DAGs; this is the small-model-authorable-DAGs gate metric — review before enabling orchestration.authoring.*",
    });
  }

  // Dedicated sandbox_downgrade_refused
  // finding — the count of fail-closed sub-agent spawn refusals + the violated
  // sandbox dimensions (closed enum labels). A spawn refusal is fail-closed working,
  // but it means an agent was configured to spawn a LESS-confined child (a
  // misconfiguration or an escalation attempt) — an operator must see it. Counts +
  // closed dimension labels + a STATIC hint ONLY (never a path/host/uid value — the
  // row never carried them). Zero-traffic guard (the voice_health if-pattern).
  let sandboxRefusedCount = 0;
  const sandboxDimCounts = new Map<string, number>();
  for (const row of healthSignals) {
    const parsed = sandboxDowngradeFromRow(row);
    if (parsed === null) continue;
    sandboxRefusedCount += 1;
    for (const dim of parsed.dimensions) {
      sandboxDimCounts.set(dim, (sandboxDimCounts.get(dim) ?? 0) + 1);
    }
  }
  if (sandboxRefusedCount > 0) {
    const dims = [...sandboxDimCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([d]) => d);
    findings.push({
      code: "sandbox_downgrade_refused",
      detail:
        dims.length > 0
          ? `${sandboxRefusedCount} sub-agent spawn(s) refused for sandbox downgrade (dimension(s): ${dims.join(", ")})`
          : `${sandboxRefusedCount} sub-agent spawn(s) refused for sandbox downgrade`,
      count: sandboxRefusedCount,
      hint: "a sub-agent was configured LESS confined than its spawner on the named dimension(s); align the child's skills.execSandbox posture with (or stricter than) the parent's, or remove the offending agent-to-agent spawn. run `comis explain` on the spawner's session",
    });
  }

  // Dedicated delivery_deadlettered finding — the count of sub-agent
  // completions PERMANENTLY DROPPED (self-healing delivery exhausted retries, or an
  // immediate permanent failure). This is a SILENT degradation today (the graph
  // reports completed while a node's result never reached the parent). Counts + the
  // transient/permanent split ONLY — never a runId, an announcement body, or an error
  // string. Zero-traffic guard.
  let deadletterCount = 0;
  let deadletterTransient = 0;
  for (const row of healthSignals) {
    const parsed = deliveryDeadletteredFromRow(row);
    if (parsed === null) continue;
    deadletterCount += 1;
    if (parsed.transient) deadletterTransient += 1;
  }
  if (deadletterCount > 0) {
    const permanent = deadletterCount - deadletterTransient;
    findings.push({
      code: "delivery_deadlettered",
      detail: `${deadletterCount} sub-agent completion(s) dead-lettered (dropped): ${deadletterTransient} after retries, ${permanent} permanent`,
      count: deadletterCount,
      hint: "a sub-agent result was permanently dropped before reaching its parent (the graph still reports completed); run `comis explain` on the affected session and check the delivery channel health / retry budget (security.agentToAgent.delivery)",
    });
  }

  // Dedicated node_budget_exceeded finding — the count of per-node token
  // budget breaches + the DOMINANT cap source (which knob bound the node). Counts +
  // the closed capSource label + a hint NAMING all three knobs ONLY (the per-node
  // token numbers are per-incident — on the node error string + the WARN + `comis
  // explain`). Zero-traffic guard.
  let budgetCount = 0;
  const capSourceCounts = new Map<string, number>();
  for (const row of healthSignals) {
    const parsed = nodeBudgetExceededFromRow(row);
    if (parsed === null) continue;
    budgetCount += 1;
    capSourceCounts.set(parsed.capSource, (capSourceCounts.get(parsed.capSource) ?? 0) + 1);
  }
  if (budgetCount > 0) {
    const topSource = [...capSourceCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    findings.push({
      code: "node_budget_exceeded",
      detail:
        topSource !== undefined
          ? `${budgetCount} node(s) exceeded their token budget (dominant cap source: ${topSource})`
          : `${budgetCount} node(s) exceeded their token budget`,
      count: budgetCount,
      hint: "graph nodes are being cut off by their token budget; raise the binding knob — the node's own `tokenBudget`, the operator default `security.agentToAgent.tokenBudget`, or the graph `budget.maxTokens` (inherit-share). run `comis explain` for the per-node numbers",
    });
  }

  // The three dedicated autonomy findings (durable_orphaned
  // / autonomy_revoked / autonomy_killed; kill separable from revoke) — extracted to
  // the `fleet-autonomy.ts` sibling (the obs-handlers 500-line subdir cap). Each has
  // its own zero-traffic guard inside the helper; the returned findings inherit the
  // FLEET_FINDINGS_CAP bound + the highest-count-first sort below.
  findings.push(...buildAutonomyFindings(healthSignals));

  // Dedicated voice_health finding — the degraded STT/TTS
  // turn count + the DOMINANT voice errorKind (the closed domain SttErrorKind),
  // rolled up from the `voice_degraded` health_signal rows the daemon voice obs
  // emits on a transcription/synthesis failure. Counts + a closed errorKind label
  // + a STATIC hint ONLY — NEVER a raw provider message body or a secret (the
  // no-body rule; safe to paste). Mirrors the `model_health` if-guard + the
  // script-signal dedicated-grouping pattern. Beside model_health/config_posture.
  let voiceDegradedCount = 0;
  const voiceKindCounts = new Map<string, number>();
  for (const row of healthSignals) {
    const parsed = voiceDegradedFromRow(row);
    if (parsed === null) continue;
    voiceDegradedCount += 1;
    if (parsed.errorKind !== undefined) {
      voiceKindCounts.set(parsed.errorKind, (voiceKindCounts.get(parsed.errorKind) ?? 0) + 1);
    }
  }
  if (voiceDegradedCount > 0) {
    // The dominant errorKind: highest count, lexicographic tie-break (deterministic).
    const topKind = [...voiceKindCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    findings.push({
      code: "voice_health",
      detail:
        topKind !== undefined
          ? `${voiceDegradedCount} degraded STT/TTS turn(s); top errorKind ${topKind}`
          : `${voiceDegradedCount} degraded STT/TTS turn(s)`,
      count: voiceDegradedCount,
      hint: "run `comis explain` on an affected voice session; for model_load_failed/model_download_failed check the whisper model cache + disk + the local engine probe (a keyless engine), or set the provider's audio API key for auth_required",
    });
  }

  // The generic "provider degradation" rollup counts ONLY degraded rows
  // (severity "warning" — recordModelHealth marks a row "warning" exactly when
  // the embedding provider is absent at boot, the primary degraded-recall
  // cause). The once-per-boot HEALTHY snapshot (severity "info", embedding
  // present) is NOT degradation; counting every row inflated the fleet view —
  // a keyless daemon that had rebooted N times showed "N provider-degradation
  // signal(s)" from N healthy boots (BENIGN_*_REASONS: routine events must not
  // inflate warning counts). The multilingual advisory below is STANDING STATE
  // read from the latest row and stays severity-independent.
  const degradedModelHealth = modelHealth.filter((r) => r.severity === "warning");
  if (degradedModelHealth.length > 0) {
    findings.push({
      code: "model_health",
      detail: `${degradedModelHealth.length} model-health signal(s) (provider degradation)`,
      count: degradedModelHealth.length,
      hint: "check provider status + rate-limit headroom; confirm the model/provider config (a 'warning' row means the embedding provider was absent at boot — recall falls back to the FTS floor)",
    });
  }

  if (modelHealth.length > 0) {
    // Multilingual advisory read from the LATEST model_health row
    // (STANDING STATE, not a reboot count — mirror the served-below latest-row
    // pattern below, NOT the generic count above). Counts/codes/hints only; the
    // hint names the recommended multilingual models + the FTS trigram floor that
    // still carries recall. Advisory ONLY — no recall/search behavior gates on
    // these flags anywhere.
    let latestModelHealth = modelHealth[0]!;
    for (const row of modelHealth) {
      if (row.timestamp > latestModelHealth.timestamp) latestModelHealth = row;
    }
    const ml = multilingualFromRow(latestModelHealth);
    if (ml.embedding === false || ml.embedding === "unknown") {
      findings.push({
        code: "model_health:embedder_not_multilingual",
        detail: `embedder not multilingual (${ml.embedding === "unknown" ? "id-inferred unknown" : "declared/known English"}): non-Latin semantic recall coverage degraded`,
        count: 1,
        hint: "set embedding.multilingual or switch to bge-m3 / multilingual-e5 / LaBSE; the FTS trigram floor still carries recall (advisory only, not gated)",
      });
    }
    if (ml.reranker === false || ml.reranker === "unknown") {
      findings.push({
        code: "model_health:reranker_not_multilingual",
        detail: `reranker not multilingual (${ml.reranker === "unknown" ? "id-inferred unknown" : "known English"}): non-Latin recall ORDERING degraded`,
        count: 1,
        hint: "switch the reranker to bge-reranker-v2-m3 (the default); the FTS trigram floor still carries recall (advisory only, not gated)",
      });
    }
  }
  if (configPosture.length > 0) {
    // The LATEST posture row (max timestamp — scan, never assume query order). Posture is
    // STANDING STATE, not cumulative: an old insecure/under-served boot superseded by a
    // healthy one must not keep flagging the fleet. Used for BOTH the named-keys rollup and
    // the dedicated served-below / chimeric findings below.
    let latest = configPosture[0]!;
    for (const row of configPosture) {
      if (row.timestamp > latest.timestamp) latest = row;
    }
    // Name the SPECIFIC flagged keys (closed labels only) so an operator does
    // not have to grep daemon.log to learn WHICH knob is off (gateway.tls, CANARY_SECRET…).
    const flaggedKeys = flaggedPostureKeys(latest);
    findings.push({
      code: "config_posture",
      detail:
        flaggedKeys.length > 0
          ? `${configPosture.length} config-posture signal(s) (insecure or drifted config) — flagged: ${flaggedKeys.join(", ")}`
          : `${configPosture.length} config-posture signal(s) (insecure or drifted config)`,
      count: configPosture.length,
      hint: "reconcile the named flagged keys against the secure baseline (served-below + chimeric model have their own findings)",
    });
    // Dedicated served-below-configured finding from the latest posture row.
    const latestCount = servedBelowConfiguredFromRow(latest);
    if (latestCount > 0) {
      findings.push({
        code: "config_posture:served_below_configured",
        detail: `Ollama served context window below configured for ${latestCount} provider(s)`,
        count: latestCount,
        hint: "set OLLAMA_CONTEXT_LENGTH / Modelfile 'PARAMETER num_ctx' to the configured window (config-yaml served-window section); run `comis explain` on a served-bound session for the numbers",
      });
    }
    // Dedicated chimeric-provider/model finding from the SAME latest
    // posture row. A NATIVE provider (anthropic/openai/google) paired with a foreign
    // model family resolves a phantom ModelProfile (observed live) — name it.
    const chimeraCount = chimericModelFromRow(latest);
    if (chimeraCount > 0) {
      findings.push({
        code: "config_posture:chimeric_model",
        detail: `${chimeraCount} agent(s) configured with a native provider + a foreign model family (chimera — resolves a phantom capability profile)`,
        count: chimeraCount,
        hint: "align agents.<id>.provider with the model family (e.g. provider:anthropic ⇒ a claude model; for a qwen/llama model use an ollama/openrouter provider), or set the model id explicitly under the right provider",
      });
    }
    // Dedicated pricing-gap finding from the SAME latest posture row.
    // Configured agents burning tokens on remote-unknown-priced models (a NATIVE
    // provider with no catalog rate — the fail-open where spend is silently
    // under-counted as $0). Surfaces the kill-switch's pricing coverage so an operator
    // sees how much spend the ceiling cannot account for. Counts + remediation only.
    const pricingGapCount = pricingGapFromRow(latest);
    if (pricingGapCount > 0) {
      findings.push({
        code: "config_posture:pricing_gap",
        detail: `${pricingGapCount} agent(s) burning tokens on remote-unknown-priced models — spend is under-counted for these (honest $0 only applies to local/free providers)`,
        count: pricingGapCount,
        hint: "set the model id under a priced provider, or use a local/free provider where $0 is correct; run `comis explain` on an unknown-priced session for the pricing_state",
      });
    }
  }
  // Dedicated learning_health finding — the reflection funnel
  // rolled up over the window. The daemon-wide "is reflection learning / why-0-admitted" posture, beside
  // model_health / config_posture. Counts + the LATEST closed admissionOutcome verdict (standing state,
  // max-timestamp scan — never assume query order) + summed admitted/untrustedDrops ONLY (the
  // reflect:funnel event is content-free — never a doc body; every details field parsed defensively). A
  // non-admit window is NOT a fault (the anti-poison gates working), so the hint says so explicitly.
  if (learningHealth.length > 0) {
    let latest = learningHealth[0]!;
    for (const row of learningHealth) {
      if (row.timestamp > latest.timestamp) latest = row;
    }
    let admittedSum = 0;
    let untrustedSum = 0;
    for (const row of learningHealth) {
      const d = parseDetailsObject(row.details);
      if (typeof d.admitted === "number") admittedSum += d.admitted;
      if (typeof d.untrustedDrops === "number") untrustedSum += d.untrustedDrops;
    }
    const ld = parseDetailsObject(latest.details);
    const latestOutcome =
      typeof ld.admissionOutcome === "string" && REFLECT_ADMISSION_OUTCOMES.has(ld.admissionOutcome)
        ? ld.admissionOutcome
        : "unknown";
    findings.push({
      code: "learning_health",
      detail: `${learningHealth.length} reflection run(s) in the window; latest outcome=${latestOutcome}, admitted=${admittedSum}, untrustedDrops=${untrustedSum}`,
      count: learningHealth.length,
      hint: 'run `cron.runs jobName "Reflection"` for the per-run funnel; admitted=0 with untrustedDrops/uncorroborated is the anti-poison gates WORKING (not a fault); admitted=0 DESPITE genuine corroboration ⇒ a topicKey under-merge — `comis explain` the reflection run',
    });
  }

  // The dedicated memory_lifecycle finding — the forget sweep rolled up
  // over the window (the parity of learning_health for the forget half). Counts ONLY (summed evicted/
  // demoted across the window's sweeps; every details field parsed defensively). A sweep that evicted
  // nothing (no eviction-candidates) is NOT a fault — healthy maintenance — so the hint says so.
  if (memoryLifecycle.length > 0) {
    let evictedSum = 0;
    let demotedSum = 0;
    for (const row of memoryLifecycle) {
      const d = parseDetailsObject(row.details);
      if (typeof d.evicted === "number") evictedSum += d.evicted;
      if (typeof d.demoted === "number") demotedSum += d.demoted;
    }
    findings.push({
      code: "memory_lifecycle",
      detail: `${memoryLifecycle.length} forget sweep(s) in the window; evicted=${evictedSum}, demoted=${demotedSum}`,
      count: memoryLifecycle.length,
      hint: 'run `cron.runs jobName "Memory lifecycle"` for the per-sweep counts; evicted=0 is usually healthy (no corroborated-wrong / dormant candidates) — NOT a fault. Eviction is gated by learning.forget + the anti-induced-eviction exemptions (pinned/high-proof/system survive).',
    });
  }

  // Deterministic order: highest-count first, then code asc (stable tie-break).
  return findings.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}
