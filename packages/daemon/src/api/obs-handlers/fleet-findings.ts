// SPDX-License-Identifier: Apache-2.0
/**
 * Fleet findings derivation: turn the I-track diagnostic rows (`health_signal` /
 * `model_health` / `config_posture`) into `{code, detail, count, hint}` findings.
 *
 * Extracted from `fleet-health.ts` to keep that module under the obs-handlers
 * per-subdirectory file-size cap (the OBS-01 Phase-180 script findings pushed it
 * over). No behavior change — `buildFindings` + the `Finding` shape + the
 * defensive details parsers relocate byte-identically; the assembler imports
 * them back.
 *
 * SECURITY INVARIANT (H1 + the 159 digest-only schema): findings carry counts +
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

/** One report finding. Shape-identical to `FleetHealthReport.findings[number]`. */
export interface Finding {
  code: string;
  detail: string;
  count: number;
  hint: string;
}

/**
 * The closed `signal` label a Phase-160 `health_signal` row carries in its
 * `details` JSON (`lcd_divergence` / `alert_budget` / `mcp_reconnect_failed`).
 * Parsed defensively from the untrusted row — a missing/malformed label folds
 * into the generic `unknown` bucket (soft-fail, never throw, never a raw body).
 */
function healthSignalLabel(row: DiagnosticRow): string {
  if (row.details === undefined) return "unknown";
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown };
    return typeof parsed.signal === "string" && parsed.signal.length > 0 ? parsed.signal : "unknown";
  } catch {
    return "unknown"; // malformed details JSON — counts only, no body.
  }
}

/** KNOB-03: servedBelowConfiguredCount from a config_posture row's details JSON.
 *  Defensive parse — malformed/missing folds to 0 (soft-fail, counts only;
 *  the healthSignalLabel clone, T-176-13). */
function servedBelowConfiguredFromRow(row: DiagnosticRow): number {
  if (row.details === undefined) return 0;
  try {
    const parsed = JSON.parse(row.details) as { servedBelowConfiguredCount?: unknown };
    const n = parsed.servedBelowConfiguredCount;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** RESOLVE-01: chimericModelCount from a config_posture row's details JSON.
 *  Defensive parse — malformed/missing folds to 0 (the servedBelowConfigured clone). */
function chimericModelFromRow(row: DiagnosticRow): number {
  if (row.details === undefined) return 0;
  try {
    const parsed = JSON.parse(row.details) as { chimericModelCount?: unknown };
    const n = parsed.chimericModelCount;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** T1.3 (F6): the SPECIFIC flagged config keys from a config_posture row — CLOSED labels
 *  only (never raw details / secret values, per the H1 no-body rule), so a fleet finding
 *  NAMES which knob is off instead of "the flagged config keys" (the live friction was
 *  grepping daemon.log to learn it was gateway.tls + CANARY_SECRET). served-below +
 *  chimeric have dedicated findings, so they are NOT repeated here. Malformed folds to []. */
function flaggedPostureKeys(row: DiagnosticRow): string[] {
  if (row.details === undefined) return [];
  try {
    const d = JSON.parse(row.details) as {
      tlsOff?: unknown;
      canaryFallbackActive?: unknown;
      strandedFindings?: unknown;
    };
    const keys: string[] = [];
    if (d.tlsOff === true) keys.push("gateway.tls (off)");
    if (d.canaryFallbackActive === true) keys.push("CANARY_SECRET (unset)");
    if (Array.isArray(d.strandedFindings) && d.strandedFindings.length > 0) {
      keys.push(`stranded secrets (${d.strandedFindings.length})`);
    }
    return keys;
  } catch {
    return [];
  }
}

/** A single advisory multilingual flag from a model_health row. `undefined`
 *  means the key was absent or not a recognized value (omitted, no advisory). */
type MultilingualFlag = boolean | "unknown" | undefined;

/** EMB-01: the two advisory multilingual flags from a model_health row's details
 *  JSON. Defensive parse cloning servedBelowConfiguredFromRow — malformed/missing
 *  details folds to `{}` (soft-fail, never throws, NEVER echoes a body). A field
 *  is read only when it is a boolean or the exact string "unknown", else omitted
 *  (an old row that predates EMB-01 lacks the keys -> no advisory). */
function multilingualFromRow(row: DiagnosticRow): {
  embedding: MultilingualFlag;
  reranker: MultilingualFlag;
} {
  if (row.details === undefined) return { embedding: undefined, reranker: undefined };
  try {
    const parsed = JSON.parse(row.details) as {
      embeddingMultilingual?: unknown;
      rerankerMultilingual?: unknown;
    };
    const coerce = (v: unknown): MultilingualFlag =>
      typeof v === "boolean" || v === "unknown" ? v : undefined;
    return {
      embedding: coerce(parsed.embeddingMultilingual),
      reranker: coerce(parsed.rerankerMultilingual),
    };
  } catch {
    return { embedding: undefined, reranker: undefined };
  }
}

/** OBS-01 (Phase 180): health_signal labels that get a DEDICATED fleet finding
 *  (the KNOB-03 precedent) and are therefore EXCLUDED from the generic
 *  `health_signal:<label>` rollup below — listing one here without adding its
 *  dedicated branch would silently drop it, so the two move together. */
const DEDICATED_SCRIPT_SIGNALS: ReadonlySet<string> = new Set([
  "script_zero_hit",
  "summary_language_mismatch",
  "generation_quality",
  // OBS-04 (Phase 196): voice_degraded gets the dedicated `voice_health` finding
  // below — excluded here so it is not ALSO counted in the generic
  // `health_signal:voice_degraded` rollup (the double-report KNOB-03 guards against).
  "voice_degraded",
  // TELEM-01 (Plan 173-03): pipeline_authoring gets the dedicated finding below
  // (the small-tier invalid rate). Excluded here so it is NOT also rolled into the
  // generic `health_signal:pipeline_authoring` count — the finding + this entry
  // MOVE TOGETHER (listing it here without the dedicated branch silently drops it).
  "pipeline_authoring",
]);

/** OBS-04 (Phase 196): the closed domain `errorKind` (an `SttErrorKind`) carried
 *  on a `voice_degraded` health_signal row's details JSON, parsed defensively
 *  (the `scriptZeroHitFromRow` clone). Returns `null` when the row is not a
 *  voice_degraded signal; returns `{ errorKind: undefined }` when it IS voice but
 *  carries no/blank/non-string errorKind (an honest absence — the finding then
 *  renders a count-only detail). Malformed/missing details JSON folds to `null`
 *  (the row is ignored; counts only, no body ever surfaces, never throws). */
function voiceDegradedFromRow(row: DiagnosticRow): { errorKind: string | undefined } | null {
  if (row.details === undefined) return null;
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown; errorKind?: unknown };
    if (parsed.signal !== "voice_degraded") return null;
    const errorKind =
      typeof parsed.errorKind === "string" && parsed.errorKind.length > 0 ? parsed.errorKind : undefined;
    return { errorKind };
  } catch {
    return null; // malformed details JSON — counts only, no body.
  }
}

/** OBS-01: `{scriptClass, lane}` from a script_zero_hit row's details JSON.
 *  Defensive parse cloning healthSignalLabel's style — malformed/missing folds
 *  to null (the row is then ignored by the dedicated grouping; counts only, no
 *  body ever surfaces). Returns the closed enums verbatim (untrusted-row safe:
 *  they are only ever rendered into a count + a script=/lane= label). */
function scriptZeroHitFromRow(row: DiagnosticRow): { scriptClass: string; lane: string } | null {
  if (row.details === undefined) return null;
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown; scriptClass?: unknown; lane?: unknown };
    if (parsed.signal !== "script_zero_hit") return null;
    const scriptClass = typeof parsed.scriptClass === "string" && parsed.scriptClass.length > 0 ? parsed.scriptClass : "unknown";
    const lane = typeof parsed.lane === "string" && parsed.lane.length > 0 ? parsed.lane : "unknown";
    return { scriptClass, lane };
  } catch {
    return null;
  }
}

/** TELEM-01 (Plan 173-03): `{tier, schemaValid}` from a pipeline_authoring row's
 *  details JSON. Defensive parse cloning `scriptZeroHitFromRow` — a non-pipeline /
 *  malformed / missing row folds to `null` (the row is then ignored by both the
 *  reducer and the dedicated finding; counts only, no body ever surfaces, never
 *  throws). Returns the closed `tier` enum verbatim (untrusted-row safe: it is only
 *  rendered into a count, never echoed as a body). */
function pipelineAuthoringFromRow(row: DiagnosticRow): { tier: string; schemaValid: boolean } | null {
  if (row.details === undefined) return null;
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown; tier?: unknown; schemaValid?: unknown };
    if (parsed.signal !== "pipeline_authoring") return null;
    const tier = typeof parsed.tier === "string" && parsed.tier.length > 0 ? parsed.tier : "unknown";
    const schemaValid = parsed.schemaValid === true;
    return { tier, schemaValid };
  } catch {
    return null; // malformed details JSON — counts only, no body.
  }
}

/**
 * TELEM-01 (Plan 173-03): the pipeline-authoring aggregate the Phase-174 gate
 * (`pipelineAuthoringGate`) consumes — computed compute-on-read over the windowed
 * `health_signal` rows (no persisted rollup; Open Q2 / D-AGGREGATE).
 *
 * The `PipelineAuthoringAggregate` type is now SINGLE-SOURCED in
 * `@comis/observability` (Plan 173-04, MEDIUM-4) — the provisional local
 * interface declared here at Plan 03 was deleted and this file imports the
 * canonical type (see the top-of-file `import type`). The field NAMES + ORDER
 * (`smallTierInvocations`, `smallTierValidRate`, `frontierValidRate`) are
 * unchanged — the swap is structural.
 *
 * The small/local tier = capabilityClass "small" OR "nano" (D-TIER); frontier =
 * "frontier". "mid" and "unknown" rows are in NEITHER cohort (they are not the
 * comparison tiers). Rates are 0 (never NaN) when the cohort is empty.
 *
 * Reduce the windowed `health_signal` rows to the `PipelineAuthoringAggregate`.
 * PURE — no I/O, no globals, no Date.now(); malformed / non-pipeline rows fold out
 * (counted in neither cohort, never throws). Exported so Plan 04 / fleet-health.ts
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
    // "mid" / "unknown": counted in neither cohort (D-TIER).
  }
  return {
    smallTierInvocations: smallTotal,
    smallTierValidRate: smallTotal > 0 ? smallValid / smallTotal : 0,
    frontierValidRate: frontierTotal > 0 ? frontierValid / frontierTotal : 0,
  };
}

/**
 * Derive `{code, detail, count, hint}` findings from the I-track rows. Counts +
 * short codes + hints ONLY — NEVER the raw `row.message`/`row.details` body (H1 +
 * the 159 schema is digest-only). `health_signal` rows are grouped by their
 * closed `signal` label (so distinct signal classes are distinct findings);
 * `model_health` / `config_posture` are category-level rollups. The OBS-01
 * script signals get DEDICATED findings (script=/lane= grouping + named knob
 * hints) and are excluded from the generic rollup so they are not double-reported
 * (mirrors how KNOB-03's dedicated finding sits beside the config_posture rollup).
 */
export function buildFindings(
  healthSignals: readonly DiagnosticRow[],
  modelHealth: readonly DiagnosticRow[],
  configPosture: readonly DiagnosticRow[],
): Finding[] {
  const findings: Finding[] = [];

  // health_signal — one finding per closed `signal` label (counts only). The
  // OBS-01 script labels are EXCLUDED here (they get dedicated findings below).
  const bySignal = new Map<string, number>();
  for (const row of healthSignals) {
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

  // OBS-01 (Phase 180): dedicated script_zero_hit finding — one per
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

  // OBS-01 (Phase 180): dedicated summary_language_mismatch finding — a single
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

  // GENQ-01: dedicated generation_quality finding — the memory-generation analog of
  // summary_language_mismatch over the consolidation/reasoning/user-representation
  // passes (the F-ML1 regression class made a fleet count instead of an offline
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

  // TELEM-01 (Plan 173-03): dedicated pipeline_authoring finding — the HEADLINE
  // metric is the small-model pipeline-authoring failure rate = (small-tier rows
  // where schemaValid===false) / (small-tier rows total) over the window (D-TIER:
  // small|nano = the small tier). Counts + a static hint ONLY (no source/generated
  // graph body — the pipelineAuthoringFromRow parser reads only the closed tier +
  // the schemaValid boolean). Fires only when smallTotal > 0 (no finding on zero
  // small-tier traffic — mirrors the GENQ-01/voice if-guards). The reducer above is
  // the same compute-on-read fold; here we re-walk for the invalid COUNT the finding
  // names.
  //
  // METRIC BOUNDARY (Phase 173 review WR-02): the denominator counts every
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
      hint: "small/local models are failing to author valid pipeline DAGs; this is the Phase-174 (small-model-authorable DAGs) gate metric — review before enabling orchestration.authoring.*",
    });
  }

  // OBS-04 (Phase 196): dedicated voice_health finding — the degraded STT/TTS
  // turn count + the DOMINANT voice errorKind (the closed domain SttErrorKind),
  // rolled up from the `voice_degraded` health_signal rows the daemon voice obs
  // emits on a transcription/synthesis failure. Counts + a closed errorKind label
  // + a STATIC hint ONLY — NEVER a raw provider message body or a secret (the H1
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

  if (modelHealth.length > 0) {
    findings.push({
      code: "model_health",
      detail: `${modelHealth.length} model-health signal(s) (provider degradation)`,
      count: modelHealth.length,
      hint: "check provider status + rate-limit headroom; confirm the model/provider config",
    });

    // EMB-01: multilingual advisory read from the LATEST model_health row
    // (STANDING STATE, not a reboot count — mirror the KNOB-03 latest-row pattern
    // below, NOT the generic count above; Pitfall 4). Counts/codes/hints only; the
    // hint names the DOC-01 recommendation + the I4 FTS floor. Advisory ONLY — no
    // recall/search behavior gates on these flags anywhere (I4).
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
    // T1.3 (F6): name the SPECIFIC flagged keys (closed labels only) so an operator does
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
    // KNOB-03: dedicated served-below-configured finding from the latest posture row.
    const latestCount = servedBelowConfiguredFromRow(latest);
    if (latestCount > 0) {
      findings.push({
        code: "config_posture:served_below_configured",
        detail: `Ollama served context window below configured for ${latestCount} provider(s)`,
        count: latestCount,
        hint: "set OLLAMA_CONTEXT_LENGTH / Modelfile 'PARAMETER num_ctx' to the configured window (config-yaml served-window section); run `comis explain` on a served-bound session for the numbers",
      });
    }
    // RESOLVE-01: dedicated chimeric-provider/model finding from the SAME latest
    // posture row. A NATIVE provider (anthropic/openai/google) paired with a foreign
    // model family resolves a phantom ModelProfile (incident ffe11736) — name it.
    const chimeraCount = chimericModelFromRow(latest);
    if (chimeraCount > 0) {
      findings.push({
        code: "config_posture:chimeric_model",
        detail: `${chimeraCount} agent(s) configured with a native provider + a foreign model family (chimera — resolves a phantom capability profile)`,
        count: chimeraCount,
        hint: "align agents.<id>.provider with the model family (e.g. provider:anthropic ⇒ a claude model; for a qwen/llama model use an ollama/openrouter provider), or set the model id explicitly under the right provider",
      });
    }
  }
  // Deterministic order: highest-count first, then code asc (stable tie-break).
  return findings.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}
