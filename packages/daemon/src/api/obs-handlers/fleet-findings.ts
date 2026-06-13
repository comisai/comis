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
]);

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
    findings.push({
      code: "config_posture",
      detail: `${configPosture.length} config-posture signal(s) (insecure or drifted config)`,
      count: configPosture.length,
      hint: "review the gateway TLS / token posture and the flagged config keys",
    });
    // KNOB-03: dedicated served-below-configured finding from the LATEST posture
    // row (max timestamp — scan, never assume query order). Posture is STANDING
    // STATE, not cumulative: an old under-served boot superseded by a healthy
    // one must not keep flagging the fleet.
    let latest = configPosture[0]!;
    for (const row of configPosture) {
      if (row.timestamp > latest.timestamp) latest = row;
    }
    const latestCount = servedBelowConfiguredFromRow(latest);
    if (latestCount > 0) {
      findings.push({
        code: "config_posture:served_below_configured",
        detail: `Ollama served context window below configured for ${latestCount} provider(s)`,
        count: latestCount,
        hint: "set OLLAMA_CONTEXT_LENGTH / Modelfile 'PARAMETER num_ctx' to the configured window (config-yaml served-window section); run `comis explain` on a served-bound session for the numbers",
      });
    }
  }
  // Deterministic order: highest-count first, then code asc (stable tie-break).
  return findings.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}
