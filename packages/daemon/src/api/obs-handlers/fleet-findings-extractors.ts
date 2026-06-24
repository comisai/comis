// SPDX-License-Identifier: Apache-2.0
/**
 * Fleet-findings row extractors: the defensive per-row `details`-JSON parsers
 * `buildFindings` (./fleet-findings.ts) folds into `{code, detail, count, hint}`
 * findings.
 *
 * Extracted from `fleet-findings.ts` to keep that module under the obs-handlers
 * per-subdirectory file-size cap (the ORCH-OBS three-signal additions pushed it
 * over). No behavior change — every parser relocates byte-identically.
 *
 * SECURITY INVARIANT (H1 + the 159 digest-only schema): each parser reads a
 * single untrusted `row.details` field DEFENSIVELY — malformed / missing folds
 * to a safe default, never throws, never echoes a raw `row.message`/`row.details`
 * body. Only closed enums + counts + short `key=` labels ever leave here.
 *
 * @module
 */
import type { DiagnosticRow } from "@comis/memory";

export function healthSignalLabel(row: DiagnosticRow): string {
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
export function servedBelowConfiguredFromRow(row: DiagnosticRow): number {
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
export function chimericModelFromRow(row: DiagnosticRow): number {
  if (row.details === undefined) return 0;
  try {
    const parsed = JSON.parse(row.details) as { chimericModelCount?: unknown };
    const n = parsed.chimericModelCount;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** SPEND-05: pricingGapCount from a config_posture row's details JSON — configured
 *  agents burning tokens on remote-unknown-priced models (resolvePricingState ==
 *  "unknown"). Defensive parse — malformed/missing folds to 0 (the chimericModelFromRow
 *  clone; counts only, never a model id / config value body). */
export function pricingGapFromRow(row: DiagnosticRow): number {
  if (row.details === undefined) return 0;
  try {
    const parsed = JSON.parse(row.details) as { pricingGapCount?: unknown };
    const n = parsed.pricingGapCount;
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
export function flaggedPostureKeys(row: DiagnosticRow): string[] {
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
export type MultilingualFlag = boolean | "unknown" | undefined;

/** EMB-01: the two advisory multilingual flags from a model_health row's details
 *  JSON. Defensive parse cloning servedBelowConfiguredFromRow — malformed/missing
 *  details folds to `{}` (soft-fail, never throws, NEVER echoes a body). A field
 *  is read only when it is a boolean or the exact string "unknown", else omitted
 *  (an old row that predates EMB-01 lacks the keys -> no advisory). */
export function multilingualFromRow(row: DiagnosticRow): {
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
export const DEDICATED_SCRIPT_SIGNALS: ReadonlySet<string> = new Set([
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
  // ORCH-OBS (orchestration-observability): the three previously-dark daemon-side
  // orchestration signals each get a dedicated finding below (named violated
  // dimensions / transient-vs-permanent split / dominant cap source). Excluded from
  // the generic rollup so they are not double-counted — each finding + its entry here
  // MOVE TOGETHER (listing without the dedicated branch silently drops it).
  "sandbox_downgrade_refused",
  "delivery_deadlettered",
  "node_budget_exceeded",
  // FLEET-01 (Phase 220-03): the four autonomy/durable-run signals Plan 01
  // persists are EXCLUDED from the generic `health_signal:<label>` rollup.
  // durable_orphaned / autonomy_revoked / autonomy_killed each get a dedicated
  // finding below (orphaned reason group / revoked count / killed count) — finding
  // + entry MOVE TOGETHER. durable_resumed is healthy crash-recovery, NOT
  // degradation (severity:info, the BENIGN_DAG_DEGRADED precedent), so it has NO
  // dedicated finding and must NOT surface as a generic finding either — it is
  // surfaced ONLY as the structured `autonomy.resumed` COUNT (fleet-health.ts),
  // never as an operator-facing degradation finding (mirrors how a healthy boot is
  // not a "provider degradation" finding). All four are excluded here.
  "durable_orphaned",
  "durable_resumed",
  "autonomy_revoked",
  "autonomy_killed",
]);

/** OBS-04 (Phase 196): the closed domain `errorKind` (an `SttErrorKind`) carried
 *  on a `voice_degraded` health_signal row's details JSON, parsed defensively
 *  (the `scriptZeroHitFromRow` clone). Returns `null` when the row is not a
 *  voice_degraded signal; returns `{ errorKind: undefined }` when it IS voice but
 *  carries no/blank/non-string errorKind (an honest absence — the finding then
 *  renders a count-only detail). Malformed/missing details JSON folds to `null`
 *  (the row is ignored; counts only, no body ever surfaces, never throws). */
export function voiceDegradedFromRow(row: DiagnosticRow): { errorKind: string | undefined } | null {
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
export function scriptZeroHitFromRow(row: DiagnosticRow): { scriptClass: string; lane: string } | null {
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
export function pipelineAuthoringFromRow(row: DiagnosticRow): { tier: string; schemaValid: boolean } | null {
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

/** ORCH-OBS: the closed violated-dimension labels from a `sandbox_downgrade_refused`
 *  row's details JSON. Defensive parse cloning `pipelineAuthoringFromRow` — a
 *  non-sandbox / malformed / missing row folds to `null` (ignored; counts only, no
 *  body, never throws). Returns ONLY the closed dimension enum strings — never a
 *  path/host/uid value (the row never carried them). */
export function sandboxDowngradeFromRow(row: DiagnosticRow): { dimensions: string[] } | null {
  if (row.details === undefined) return null;
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown; dimensions?: unknown };
    if (parsed.signal !== "sandbox_downgrade_refused") return null;
    const dimensions = Array.isArray(parsed.dimensions)
      ? parsed.dimensions.filter((d): d is string => typeof d === "string")
      : [];
    return { dimensions };
  } catch {
    return null;
  }
}

/** ORCH-OBS: `{transient}` from a `delivery_deadlettered` row's details JSON.
 *  Defensive parse — non-deadletter / malformed / missing folds to `null` (ignored).
 *  `transient` true = retries exhausted, false = immediate permanent. Never reads the
 *  runId or any body (the row never carried them). */
export function deliveryDeadletteredFromRow(row: DiagnosticRow): { transient: boolean } | null {
  if (row.details === undefined) return null;
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown; transient?: unknown };
    if (parsed.signal !== "delivery_deadlettered") return null;
    return { transient: parsed.transient === true };
  } catch {
    return null;
  }
}

/** ORCH-OBS: the closed `capSource` from a `node_budget_exceeded` row's details JSON.
 *  Defensive parse — non-budget / malformed / missing / unrecognized capSource folds
 *  to `null` (ignored). Returns the closed precedence enum verbatim (untrusted-row
 *  safe: only ever rendered into a count + a `capSource=` label). */
export function nodeBudgetExceededFromRow(row: DiagnosticRow): { capSource: string } | null {
  if (row.details === undefined) return null;
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown; capSource?: unknown };
    if (parsed.signal !== "node_budget_exceeded") return null;
    const capSource =
      typeof parsed.capSource === "string" && parsed.capSource.length > 0 ? parsed.capSource : "unknown";
    return { capSource };
  } catch {
    return null;
  }
}

/** FLEET-01 (Phase 220-03): the closed orphan `reason` enum + the `rootRunId` from a
 *  `durable_orphaned` health_signal row's details JSON (the Plan-01 obs-autonomy-rows
 *  shape). Defensive parse cloning `nodeBudgetExceededFromRow` — a non-orphaned /
 *  malformed / missing row folds to `null` (ignored; counts only, never throws). The
 *  `reason` is a CLOSED enum (not_resumable / reread_failed / invalid_caps /
 *  resume_failed) mapped at the source — NEVER the engine's free-text reason — so it
 *  is rendered only into a count + a closed-token detail. `rootRunId` is an id (the
 *  worst-run drill-down), not a body. */
export function durableOrphanedFromRow(row: DiagnosticRow): { reason: string; rootRunId?: string } | null {
  if (row.details === undefined) return null;
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown; reason?: unknown; rootRunId?: unknown };
    if (parsed.signal !== "durable_orphaned") return null;
    const reason = typeof parsed.reason === "string" && parsed.reason.length > 0 ? parsed.reason : "unknown";
    const rootRunId =
      typeof parsed.rootRunId === "string" && parsed.rootRunId.length > 0 ? parsed.rootRunId : undefined;
    return rootRunId !== undefined ? { reason, rootRunId } : { reason };
  } catch {
    return null;
  }
}

/** FLEET-01 (Phase 220-03): the resumed `stepIndex` + the `rootRunId` from a
 *  `durable_resumed` health_signal row's details JSON. Defensive parse (the
 *  durableOrphanedFromRow clone) — a non-resumed / malformed / missing row folds to
 *  `null`. A resumed run is healthy crash-recovery (it has NO finding); this extractor
 *  feeds ONLY the structured `autonomy.resumed` COUNT. Counts/ids only, never a body. */
export function durableResumedFromRow(row: DiagnosticRow): { rootRunId?: string } | null {
  if (row.details === undefined) return null;
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown; rootRunId?: unknown };
    if (parsed.signal !== "durable_resumed") return null;
    const rootRunId =
      typeof parsed.rootRunId === "string" && parsed.rootRunId.length > 0 ? parsed.rootRunId : undefined;
    return rootRunId !== undefined ? { rootRunId } : {};
  } catch {
    return null;
  }
}

/** FLEET-01 (Phase 220-03): the revoked COUNT + the `rootRunId` from an
 *  `autonomy_revoked` health_signal row's details JSON. Defensive parse (the
 *  durableOrphanedFromRow clone) — a non-revoked / malformed / missing row folds to
 *  `null`. The `revoked` count defaults to 0 when absent/non-finite. NEVER reads a
 *  lease bearer / selector / body (the Plan-01 row never carried them — T-220-02). */
export function autonomyRevokedFromRow(row: DiagnosticRow): { revoked: number; rootRunId?: string } | null {
  if (row.details === undefined) return null;
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown; revoked?: unknown; rootRunId?: unknown };
    if (parsed.signal !== "autonomy_revoked") return null;
    const revoked = typeof parsed.revoked === "number" && Number.isFinite(parsed.revoked) && parsed.revoked > 0 ? parsed.revoked : 0;
    const rootRunId =
      typeof parsed.rootRunId === "string" && parsed.rootRunId.length > 0 ? parsed.rootRunId : undefined;
    return rootRunId !== undefined ? { revoked, rootRunId } : { revoked };
  } catch {
    return null;
  }
}

/** FLEET-01 (Phase 220-03): the killed COUNT + the `rootRunId` from an
 *  `autonomy_killed` health_signal row's details JSON. Defensive parse (the
 *  autonomyRevokedFromRow clone). A hard kill (run.kill) flips durable status to
 *  'revoked' INDISTINGUISHABLY from a cooperative revoke in the table — so this
 *  DISTINCT signal label is the ONLY way the fleet lens separates killed from revoked
 *  counts (the Plan-01 kill≠revoke separation). Counts/ids only, never a body. */
export function autonomyKilledFromRow(row: DiagnosticRow): { killed: number; rootRunId?: string } | null {
  if (row.details === undefined) return null;
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown; killed?: unknown; rootRunId?: unknown };
    if (parsed.signal !== "autonomy_killed") return null;
    const killed = typeof parsed.killed === "number" && Number.isFinite(parsed.killed) && parsed.killed > 0 ? parsed.killed : 0;
    const rootRunId =
      typeof parsed.rootRunId === "string" && parsed.rootRunId.length > 0 ? parsed.rootRunId : undefined;
    return rootRunId !== undefined ? { killed, rootRunId } : { killed };
  } catch {
    return null;
  }
}
