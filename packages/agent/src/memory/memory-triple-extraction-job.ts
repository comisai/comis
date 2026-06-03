// SPDX-License-Identifier: Apache-2.0
/**
 * Offline triple-extraction job handler.
 *
 * Runs OFF the recall hot path (a background cron seam, mirroring
 * {@link runMemoryConsolidation}). Turns conversation text → S/P/O candidates via
 * an INJECTED offline LLM extractor (`deps.extract`), then writes each candidate
 * into the trust-first bi-temporal knowledge graph via `tripleStore.upsertTriple`
 * — where the trust-first single-current-truth invalidation decides
 * whether a low-trust extracted claim may supersede an incumbent fact.
 *
 * Security posture (the same anti-poisoning discipline as the
 * consolidation job):
 * - Trust is CAPPED in CODE at the candidate's own `sourceTrust` (the ceiling).
 *   The writer can NEVER RAISE trust: an `external`-sourced
 *   extraction can never mint a `learned`/`system` triple. A claim that
 *   `validateMemoryWrite` flags as `warn` is further DOWNGRADED to `external`.
 * - Every stored object string runs through `validateMemoryWrite` (the secret /
 *   prompt-injection firewall, AGENTS.md §2.2): `critical` → skip (never stored);
 *   `warn` → trust downgraded to `external`; `clean` → the source-trust ceiling.
 * - DEFAULT-OFF cost gate: with `config.enabled === false` the
 *   extractor is NEVER called and nothing is written (no LLM spend, no write).
 * - The run is BOUNDED (`maxCandidatesPerRun`) and emits a MINIMAL,
 *   counts-only `memory:triples_extracted` event + counts-only logs — NEVER the
 *   S/P/O bodies (AGENTS.md §2.7).
 * - The scope `{ tenantId, agentId, now }` is passed to every upsert so the
 *   adapter filters every statement on it (cross-tenant isolation).
 *
 * The `extract` LLM call is INJECTED (the offline seam) — it is the caller's
 * responsibility to build it from a cheap model; it is NEVER invoked on the recall
 * path. The agent consumes the store as a port TYPE from `@comis/core` (the
 * agent↛memory build cut); the daemon injects the concrete
 * memory-package adapter. NO memory-package import here, NO wall-clock global
 * (the injected `clock`).
 *
 * @module
 */

import { ok, fromPromise, type Result } from "@comis/shared";
import { validateMemoryWrite } from "@comis/core";
import type {
  TripleInput,
  TripleStorePort,
  TripleTrust,
  ClockPort,
  ComisLogger,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The trust ladder rank, reused verbatim from the adapter / `score.ts`
 * (`system` 2 > `learned` 1 > `external` 0). The trust CAP picks the LOWER rank
 * — the writer can only ever lower trust, never raise it.
 */
const TRUST_RANK: Record<TripleTrust, number> = { system: 2, learned: 1, external: 0 } as const;

/** Pick the lower-trust of two ladder levels (the anti-laundering ceiling). */
function minTrust(a: TripleTrust, b: TripleTrust): TripleTrust {
  return TRUST_RANK[a] <= TRUST_RANK[b] ? a : b;
}

/**
 * One extracted S/P/O candidate (the offline LLM extractor's output shape). The
 * subject/predicate/object are conversation-derived (untrusted) text — DATA, never
 * SQL; the adapter binds every value as a `?` parameter. `sourceTrust` is the trust
 * of the originating memory/message — the CEILING the writer caps at.
 */
export interface TripleCandidate {
  subject: string;
  predicate: string;
  object: string;
  /** Trust of the source the claim was extracted from — the cap (never raised). */
  sourceTrust: TripleTrust;
  /** Valid-time start (epoch ms when the fact became true); defaults to clock.now(). */
  tValidStart?: number;
  /** Occurred range start (world time, epoch ms; optional). */
  tOccurred?: number;
  /** Occurred range end (epoch ms; optional). */
  tOccurredEnd?: number;
  /** Provenance: the originating memory id (ON DELETE CASCADE in the table). */
  sourceMemoryId?: string;
  /** Optional corroboration confidence in 0..1. */
  confidence?: number;
}

/** Configuration for the offline triple-extraction run. */
export interface MemoryTripleExtractionConfig {
  /** DEFAULT-OFF cost gate. When false: no extractor call, no write. */
  enabled: boolean;
  /** Upper bound on candidates written per run (the DoS cost bound). */
  maxCandidatesPerRun: number;
}

/** Dependencies injected into the offline triple-extraction handler. */
export interface MemoryTripleExtractionDeps {
  /**
   * The SEGREGATED triple store (port TYPE from `@comis/core`). The concrete
   * adapter lives in the memory package; the daemon injects it. The
   * agent cannot import that package (the agent↛memory build cut).
   */
  tripleStore: TripleStorePort;
  config: MemoryTripleExtractionConfig;
  agentId: string;
  tenantId: string;
  /** Wall-clock reads — the t_valid_start fallback + the scope `now`. NEVER a wall-clock global. */
  clock: ClockPort;
  logger: ComisLogger;
  /** Minimal counts-only event sink (mirrors the consolidation job). */
  eventBus?: { emit(event: string, payload: unknown): void };
  /**
   * The INJECTED offline LLM extractor: conversation text → S/P/O candidates. This
   * is the OFFLINE seam — it is NEVER called on the recall hot path, and it is the
   * caller's job to build it from a cheap model. A thrown call is non-fatal.
   */
  extract: (text: string) => Promise<TripleCandidate[]>;
  /** The conversation text to extract triples from. */
  sourceText: string;
}

/** Counts-only outcome of one extraction run (never carries S/P/O bodies). */
export interface MemoryTripleExtractionStats {
  /** Candidates returned by the extractor. */
  extracted: number;
  /** Triples written via upsertTriple. */
  written: number;
  /** Candidates blocked by validateMemoryWrite (critical). */
  blocked: number;
  /** Candidates whose trust was downgraded to external (warn). */
  downgraded: number;
  /** Candidates skipped because they exceeded maxCandidatesPerRun. */
  skippedOverCap: number;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Run one offline triple-extraction pass for a single agent.
 *
 * Gate on `config.enabled` (default-OFF → return early, no extractor, no write) →
 * `extract(sourceText)` (non-fatal: a thrown call → WARN + return ok with 0
 * written) → for each candidate (bounded by `maxCandidatesPerRun`): cap
 * `trust = min(sourceTrust)` in CODE, run `validateMemoryWrite` on the object
 * (`critical` → skip; `warn` → downgrade to `external`; `clean` → the ceiling),
 * then `upsertTriple` with the `{ tenantId, agentId, now }` scope (a rejecting
 * store → WARN + continue). Emit a counts-only `memory:triples_extracted` event.
 *
 * @returns `ok(stats)` on success (even with 0 written); the run is non-fatal —
 *   it never throws and never returns `err` for a per-candidate failure.
 */
export async function runMemoryTripleExtraction(
  deps: MemoryTripleExtractionDeps,
): Promise<Result<MemoryTripleExtractionStats, Error>> {
  const { config, agentId, tenantId, tripleStore, eventBus, logger, clock } = deps;
  const startMs = clock.now();

  const emit = (stats: MemoryTripleExtractionStats): void => {
    eventBus?.emit("memory:triples_extracted", {
      agentId,
      extracted: stats.extracted,
      written: stats.written,
      blocked: stats.blocked,
      downgraded: stats.downgraded,
      skippedOverCap: stats.skippedOverCap,
      durationMs: clock.now() - startMs,
      timestamp: clock.now(),
    });
  };

  // The DEFAULT-OFF cost gate. No extractor call, no write, no spend.
  if (!config.enabled) {
    logger.debug({ agentId, step: "extract" as const }, "Triple extraction disabled (enabled=false) — skipping");
    const stats: MemoryTripleExtractionStats = { extracted: 0, written: 0, blocked: 0, downgraded: 0, skippedOverCap: 0 };
    emit(stats);
    return ok(stats);
  }

  // Offline LLM extraction (INJECTED seam). Non-fatal: a thrown/aborted extractor
  // → WARN + return ok with nothing written (mirrors the consolidation posture).
  const extracted = await fromPromise(deps.extract(deps.sourceText));
  if (!extracted.ok) {
    logger.warn(
      {
        agentId,
        err: extracted.error,
        errorKind: "dependency" as const,
        hint: "offline triple extractor failed/aborted — no triples written this run",
      },
      "Triple extraction LLM call failed (non-fatal)",
    );
    const stats: MemoryTripleExtractionStats = { extracted: 0, written: 0, blocked: 0, downgraded: 0, skippedOverCap: 0 };
    emit(stats);
    return ok(stats);
  }
  const candidates = extracted.value;

  let written = 0;
  let blocked = 0;
  let downgraded = 0;
  let skippedOverCap = 0;

  for (const candidate of candidates) {
    // The bounded run. Count the overflow for observability,
    // then stop writing once the cap is reached (the DoS cost bound).
    if (written >= config.maxCandidatesPerRun) {
      skippedOverCap = candidates.length - written - blocked - downgraded;
      break;
    }

    // Trust CEILING — the candidate's own source trust IS the cap.
    // The writer can never RAISE trust (an external source can never mint a
    // learned/system triple); the LLM has no say in the trust field.
    let trust: TripleTrust = candidate.sourceTrust;

    // Defense-in-depth on the LLM-produced object text (AGENTS.md §2.2): scan
    // BEFORE store. `critical` → skip (never stored); `warn` → downgrade trust
    // toward external (`minTrust` can only LOWER, never raise above the ceiling);
    // `clean` → the source-trust ceiling.
    const verdict = validateMemoryWrite(candidate.object);
    if (verdict.severity === "critical") {
      blocked++;
      logger.warn(
        {
          agentId,
          errorKind: "validation" as const,
          patterns: verdict.patterns,
          criticalPatterns: verdict.criticalPatterns,
          hint: "extracted triple object matched a dangerous/secret pattern — blocked from the store",
        },
        "Skipping extracted triple that failed the memory-write security scan",
      );
      continue;
    }
    if (verdict.severity === "warn") {
      // The downgrade is itself a min against the ceiling — external is the floor.
      trust = minTrust(trust, "external");
      downgraded++;
    }

    const now = clock.now();
    const triple: TripleInput = {
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      trust, // CODE-computed ceiling (or downgrade) — NOT chosen by the LLM
      tValidStart: candidate.tValidStart ?? now,
      ...(candidate.tOccurred !== undefined ? { tOccurred: candidate.tOccurred } : {}),
      ...(candidate.tOccurredEnd !== undefined ? { tOccurredEnd: candidate.tOccurredEnd } : {}),
      ...(candidate.sourceMemoryId !== undefined ? { sourceMemoryId: candidate.sourceMemoryId } : {}),
      ...(candidate.confidence !== undefined ? { confidence: candidate.confidence } : {}),
    };

    // The adapter filters every statement on this scope. Non-fatal:
    // a rejecting/erroring store → WARN + continue to the next candidate.
    const upserted = await fromPromise(
      tripleStore.upsertTriple(triple, { tenantId, agentId, now }),
    );
    if (!upserted.ok || !upserted.value.ok) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          hint: "upsertTriple failed/rejected — candidate skipped, run continues",
        },
        "Failed to upsert extracted triple (non-fatal)",
      );
      continue;
    }
    written++;
  }

  const stats: MemoryTripleExtractionStats = {
    extracted: candidates.length,
    written,
    blocked,
    downgraded,
    skippedOverCap,
  };

  logger.info(
    { agentId, step: "extract" as const, ...stats, durationMs: clock.now() - startMs },
    "Memory triple extraction completed",
  );
  emit(stats);

  return ok(stats);
}
