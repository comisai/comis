// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user representation offline builder job.
 *
 * The WRITE path of the per-user profile. Mirrors {@link runMemoryReasoning} 1:1
 * (the canonical offline-job template): a background cron seam OFF the recall hot
 * path. It refreshes a single user's profile from their HIGH-TRUST source
 * memories: default-OFF gate → read sources → EXCLUDE `external`-trust
 * (anti-poisoning) → bound → INJECTED `build()` seam → `validateMemoryWrite` on
 * every candidate → `revise()` via the port (REVISE-01, the trust-first bi-temporal
 * soft-close — NOT a blind insert), which RESOLVES the slot (contradict → supersede /
 * corroborate → bump / topic-distinct → coexist) and RETURNS the decided outcome →
 * count the ADAPTER's authoritative outcome (WR-01 — never a divergent job-side
 * re-classification) → counts-only event (superseded/corroborated/inserted) → idempotent.
 *
 * Security posture (design §9 — the same anti-poisoning discipline as the
 * reasoning + triple-extraction jobs, with the USER hardening):
 * - Anti-poisoning: `external`-trust source memories are filtered out BEFORE the
 *   build — UNCONDITIONALLY (there is no `reasonExternal` escape hatch). An
 *   `external` claim can NEVER enter the profile (layer 2 of the 3-layer defense;
 *   the DB CHECK + write-time reject are layers 1+3).
 * - The redaction firewall: every build() candidate runs through
 *   `validateMemoryWrite` (the secret-egress guard FIRST) BEFORE upsert. A
 *   non-`clean` verdict (`warn` OR `critical`) is SKIPPED (`blocked++`) — NOT
 *   downgraded-and-stored. This is the USER delta from the KG path (Pitfall 2):
 *   the high-trust floor + the DB CHECK forbid `external`, so the reasoning job's
 *   `warn → downgrade-to-external → store` branch is INVALID here; a `warn` entry
 *   cannot be a valid high-trust row, so it is skipped exactly like `critical`.
 * - Trust is computed in CODE at the source ceiling, NEVER chosen by the LLM (the
 *   parser STRIPS any smuggled trust field). The writer can only lower trust toward
 *   the surviving sources' floor — it can never raise it.
 * - DEFAULT-OFF cost gate: with `config.enabled === false` the build() seam is
 *   NEVER called and nothing is written (no LLM spend, no write).
 * - The run is BOUNDED by `maxEntriesPerRun` (caps writes; overflow counted as
 *   `skippedOverCap`). It emits a MINIMAL, counts-only
 *   `memory:user_representation_built` event + counts-only logs — NEVER the
 *   profile `content` (AGENTS.md §2.7).
 * - Idempotent: a re-run over unchanged sources writes 0 new — an EXACT
 *   current-truth duplicate is pre-skipped (the cheap `(entryType, content)` set),
 *   and revise() itself corroborates (bumps confidence in place) rather than
 *   appending, so re-distilling the same sources does not grow the profile.
 *
 * The `build` LLM call is INJECTED (the offline seam) — the daemon builds it from a
 * cheap model; it is NEVER invoked on the recall path. The agent consumes
 * the store as a port TYPE from `@comis/core` (the agent↛memory build cut); the
 * daemon injects the concrete memory-package adapter. NO memory-package import
 * here, NO wall-clock global (the injected `clock`).
 *
 * @module
 */

import { ok, err, fromPromise, type Result } from "@comis/shared";
import { validateMemoryWrite } from "@comis/core";
import type {
  UserRepresentationStore,
  UserRepresentationInput,
  UserRepresentationTrust,
  ClockPort,
  ComisLogger,
} from "@comis/core";
import {
  parseUserRepresentationOutput,
  type UserRepresentationBuildOutput,
} from "./memory-user-representation-prompt.js";
import { emitGenerationQuality } from "./emit-generation-quality.js";

// ---------------------------------------------------------------------------
// Trust ceiling helper
// ---------------------------------------------------------------------------

/**
 * The HIGH-TRUST ladder rank for the source-trust ceiling (`system` 2 >
 * `learned` 1). `external` is structurally excluded BEFORE this is consulted
 * (the anti-poisoning filter removes it), so the ceiling is only ever taken over
 * the high-trust floor — the writer can never mint a trust above its sources.
 */
const TRUST_RANK: Record<UserRepresentationTrust, number> = { system: 2, learned: 1 } as const;

/** Pick the lower-trust of two high-trust levels (the source-trust ceiling). */
function minTrust(a: UserRepresentationTrust, b: UserRepresentationTrust): UserRepresentationTrust {
  return TRUST_RANK[a] <= TRUST_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// REVISE-01: the counts-only revision outcomes (the ADAPTER is authoritative)
//
// The job's `superseded`/`corroborated`/`inserted` counts (telemetry for the Plan-05
// `learning:user_model_revised` event) are NOT re-derived by the job. The
// AUTHORITATIVE per-slot resolution happens INSIDE `revise()` in the @comis/memory
// adapter (Plan 02), and `revise()` RETURNS the `ReviseOutcome` (@comis/core) it
// took. The job counts EXACTLY that returned outcome, so the emitted counts match
// what was PERSISTED by construction (WR-01) — there is no second, divergent
// similarity heuristic on the job side (the prior `contentSimilarity`/0.6 classifier
// disagreed with the adapter's `bigramDice`/0.5 + 0.9-corroborate-floor in the
// [0.5,0.6) and [0.9,1.0) bands, so the counts mis-reported the action).
//
// The adapter's `recorded-not-believed` branch (a lower-trust contradiction the
// anti-poison control dropped) persists nothing and is counted in NONE of the three
// tallies. The job's ONLY local same-slot judgement is the cheap BYTE-identical
// exact-dup pre-skip (an unchanged re-distillation), counted as a `corroborated`
// no-op without a `revise()` txn.
// ---------------------------------------------------------------------------

/**
 * One high-trust source memory the builder distills the profile from. The builder
 * reads these via the INJECTED `readSources` seam (so the job stays free of any
 * memory-package import — the agent↛memory build cut); the daemon wires a scoped
 * `memories` read. `trustLevel` is the FULL ladder (`system`/`learned`/
 * `external`) so the job can EXCLUDE `external` before the build (anti-poisoning).
 */
export interface UserRepresentationSourceMemory {
  /** The source memory id (provenance + the idempotency key set). */
  id: string;
  /** The source text the build seam distills (conversation-derived). */
  content: string;
  /** The source's trust — `external` is filtered out BEFORE the build. */
  trustLevel: "system" | "learned" | "external";
}

/** Configuration for one offline representation-build run. */
export interface MemoryUserRepresentationConfig {
  /** DEFAULT-OFF cost gate. When false: no build() call, no write, no spend. */
  enabled: boolean;
  /** Upper bound on entries WRITTEN per run (the DoS cost bound on the write side). */
  maxEntriesPerRun: number;
  /**
   * INPUT bound: the max number of source memories fed into ONE build() prompt. The
   * sources arrive newest-first (the cron's `inspect` orders `created_at DESC`), so
   * the cap keeps the NEWEST `maxSourceMemories` and drops the older tail — the
   * build prompt can never grow unbounded with a chatty user's full history (an
   * over-context prompt silently fails the build → no profile). Optional: absent ⇒
   * {@link DEFAULT_MAX_SOURCE_MEMORIES}.
   */
  maxSourceMemories?: number;
  /**
   * INPUT bound: the max total characters of the concatenated `sourceText` fed into
   * ONE build() prompt. Applied AFTER the count cap — sources are admitted
   * newest-first until the next one would exceed the budget. Optional: absent ⇒
   * {@link DEFAULT_MAX_SOURCE_CHARS}.
   */
  maxSourceChars?: number;
}

/**
 * Default input bounds. Conservative caps that keep ONE distillation prompt well
 * within a cheap model's context window while admitting a rich profile's worth
 * of recent high-trust sources. An operator can widen/narrow them via config; they
 * mirror `maxEntriesPerRun`'s DoS-bound intent on the INPUT axis.
 */
const DEFAULT_MAX_SOURCE_MEMORIES = 200;
const DEFAULT_MAX_SOURCE_CHARS = 24_000;

/** Dependencies injected into the offline representation-build handler. */
export interface MemoryUserRepresentationDeps {
  agentId: string;
  tenantId: string;
  userId: string;
  config: MemoryUserRepresentationConfig;
  /**
   * The SEGREGATED representation store (port TYPE from `@comis/core`) — the
   * `upsert` write path. The daemon injects the concrete adapter; the agent cannot
   * import that package (the agent↛memory build cut).
   */
  userRepresentationStore: UserRepresentationStore;
  /**
   * The INJECTED scoped source read: the high-trust source memories for
   * `(tenantId, agentId, userId)`. Abstracted so the job imports no memory package.
   * A READ failure is FATAL (the job cannot safely proceed over an unknown source set).
   */
  readSources: () => Promise<Result<UserRepresentationSourceMemory[], Error>>;
  /** Wall-clock reads — the scope `now`. NEVER a wall-clock global. */
  clock: ClockPort;
  logger: ComisLogger;
  /** Minimal counts-only event sink (mirrors the reasoning/extraction jobs). */
  eventBus?: { emit(event: string, payload: unknown): void };
  /**
   * The INJECTED offline build() seam: the source-memory text → typed
   * representation candidates. The OFFLINE seam — NEVER on the recall hot path; the
   * caller (the daemon) builds it from a cheap model. A thrown call is non-fatal.
   */
  build: (sourceText: string) => Promise<UserRepresentationBuildOutput>;
}

/** Counts-only outcome of one build run (never carries the profile content). */
export interface MemoryUserRepresentationStats {
  /** Candidates returned by the build seam (the pre-filter input count). */
  built: number;
  /**
   * Current-truth ROWS written by revise() — the `superseded` + `inserted` outcomes
   * ONLY (IN-02). An in-place `corroborated` confidence bump writes no row and is
   * NOT counted here (it is tallied under {@link corroborated}); a
   * `recorded-not-believed` (lower-trust contradiction) persists nothing.
   */
  written: number;
  /** Candidates blocked by validateMemoryWrite (warn OR critical — Pitfall 2). */
  blocked: number;
  /** Candidates skipped because they exceeded maxEntriesPerRun. */
  skippedOverCap: number;
  /** Surviving (post-external-exclude) high-trust sources for this user. */
  sourcesConsidered: number;
  /** Sources actually fed into the bounded build() prompt. */
  sourcesUsed: number;
  /** True when the input bound dropped one or more sources from the prompt. */
  sourcesTruncated: boolean;
  /**
   * REVISE-01 (counts only): revise() calls the adapter RESOLVED as a `superseded`
   * outcome — a higher/equal-trust contradiction that soft-closed the incumbent and
   * wrote the candidate as the new current-truth. The AUTHORITATIVE adapter outcome
   * (WR-01), never a job-side re-derivation; telemetry for the Plan-05 daemon event.
   */
  superseded: number;
  /**
   * REVISE-01 (counts only): revise() calls the adapter RESOLVED as a `corroborated`
   * outcome — a same-belief near-restatement that bumped the incumbent's confidence
   * in place (NO new row), PLUS the cheap byte-identical exact-dup pre-skips (a no-op
   * re-distillation, counted here without a revise() txn). Not counted in
   * {@link written} (no row was written).
   */
  corroborated: number;
  /**
   * REVISE-01 (counts only): revise() calls the adapter RESOLVED as an `inserted`
   * outcome — no same-slot incumbent (a different `entryType`, or a topic-distinct
   * same-type fact that COEXISTS): a new current-truth row.
   */
  inserted: number;
}

/** The job's Result alias (exported for the test + the daemon onComplete mapping). */
export type MemoryUserRepresentationResult = Result<MemoryUserRepresentationStats, Error>;

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Run one offline representation-build pass for a single (tenant, agent, user).
 *
 * Gate on `config.enabled` (default-OFF → return early, no build seam, no write) →
 * read the high-trust source memories (READ failure is fatal → `err`) → EXCLUDE
 * `external`-trust sources (anti-poisoning) → call the INJECTED `build` seam over
 * the surviving source text (non-fatal via `fromPromise`) → for each candidate
 * (bounded by `maxEntriesPerRun`): `validateMemoryWrite` (`warn` OR `critical` →
 * skip, `blocked++`; NO downgrade-and-store) → compute trust in CODE at the
 * surviving-source ceiling → `revise()` via the port (a rejecting store → WARN +
 * continue), counting the adapter's RETURNED outcome (superseded/inserted also bump
 * `written`; corroborated does not). Emit a counts-only `memory:user_representation_built` event.
 *
 * @returns `ok(stats)` on success (even with 0 written); `err` only when the
 *   source read fails (cannot proceed safely). A per-candidate failure is non-fatal.
 */
export async function runUserRepresentationBuild(
  deps: MemoryUserRepresentationDeps,
): Promise<MemoryUserRepresentationResult> {
  const { config, agentId, tenantId, userId, userRepresentationStore, eventBus, logger, clock } = deps;
  const startMs = clock.now();

  let built = 0;
  let written = 0;
  let blocked = 0;
  let skippedOverCap = 0;
  // Input-bound counters (counts-only; never carry source content).
  let sourcesConsidered = 0;
  let sourcesUsed = 0;
  let sourcesTruncated = false;
  // REVISE-01 classification counters (counts-only; never carry candidate content).
  let superseded = 0;
  let corroborated = 0;
  let inserted = 0;

  const emit = (): void => {
    eventBus?.emit("memory:user_representation_built", {
      agentId,
      built,
      written,
      blocked,
      skippedOverCap,
      sourcesConsidered,
      sourcesUsed,
      sourcesTruncated,
      superseded,
      corroborated,
      inserted,
      durationMs: clock.now() - startMs,
      timestamp: clock.now(),
    });
  };

  const stats = (): MemoryUserRepresentationStats => ({
    built,
    written,
    blocked,
    skippedOverCap,
    sourcesConsidered,
    sourcesUsed,
    sourcesTruncated,
    superseded,
    corroborated,
    inserted,
  });

  // The DEFAULT-OFF cost gate. No build() call, no write, no spend.
  if (!config.enabled) {
    logger.debug(
      { agentId, step: "user-repr" as const },
      "User representation build disabled (enabled=false) — skipping",
    );
    emit();
    return ok(stats());
  }

  // 1. Read the high-trust source memories. A READ failure is FATAL — we cannot
  //    safely proceed over an unknown source set (mirrors reasoning-job.ts:285-289).
  const sourcesResult = await fromPromise(deps.readSources());
  if (!sourcesResult.ok) return err(sourcesResult.error);
  if (!sourcesResult.value.ok) return err(sourcesResult.value.error);
  const allSources = sourcesResult.value.value;

  // 2. ANTI-POISONING EXCLUDE: drop `external`-trust sources UNCONDITIONALLY, BEFORE
  //    the build — there is no `reasonExternal` escape hatch for USER. An `external`
  //    claim can NEVER enter the profile. The build seam never sees the excluded
  //    content.
  const sources = allSources.filter((s) => s.trustLevel !== "external");
  sourcesConsidered = sources.length;

  if (sources.length === 0) {
    emit();
    return ok(stats());
  }

  // 3. INPUT BOUND: cap the source set fed into ONE build() prompt so it can
  //    never grow unbounded (an over-context prompt silently fails the build → no
  //    profile; mirrors maxEntriesPerRun's DoS intent, on the INPUT axis). Sources are
  //    newest-first (the cron orders `created_at DESC`), so we keep the NEWEST and drop
  //    the older tail: first the count cap, then a cumulative-char budget. Truncation is
  //    surfaced as a counts-only WARN + on the event so an operator can diagnose a thin
  //    profile (a chatty user is no longer silently windowed away).
  const maxSourceMemories = config.maxSourceMemories ?? DEFAULT_MAX_SOURCE_MEMORIES;
  const maxSourceChars = config.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS;
  const countCapped = sources.slice(0, maxSourceMemories);
  const usedSources: UserRepresentationSourceMemory[] = [];
  let sourceText = "";
  for (const s of countCapped) {
    const line = usedSources.length === 0 ? `- ${s.content}` : `\n- ${s.content}`;
    // Always admit the FIRST (newest) source even if it alone exceeds the char
    // budget — never send an empty prompt; thereafter the budget gates the rest.
    if (usedSources.length > 0 && sourceText.length + line.length > maxSourceChars) {
      break; // char budget reached
    }
    sourceText += line;
    usedSources.push(s);
  }
  sourcesUsed = usedSources.length;
  sourcesTruncated = sourcesUsed < sources.length;
  if (sourcesTruncated) {
    logger.warn(
      {
        agentId,
        errorKind: "validation" as const,
        step: "user-repr" as const,
        sourcesConsidered,
        sourcesUsed,
        maxSourceMemories,
        maxSourceChars,
        hint: "high-trust source set exceeded the per-build input bound — distilling over the NEWEST sources only; raise maxSourceMemories/maxSourceChars (or page the cron read) for a fuller profile",
      },
      "User representation source set truncated to the per-build input bound",
    );
  }

  // 4. The source-trust ceiling, computed in CODE over the USED sources — the
  //    candidates are distilled from exactly these, so the ceiling must reflect
  //    them. All are high-trust (external already excluded), so
  //    the ceiling is the floor of the used sources — a system+learned mix yields
  //    `learned`; the writer can never raise trust above its sources, and the LLM
  //    has no say (the parser stripped any trust field). `usedSources` is non-empty
  //    here (sources.length > 0 and the first line always fits — see below).
  let sourceTrust: UserRepresentationTrust = "system";
  for (const s of usedSources) {
    // s.trustLevel is one of system|learned here (external filtered out above).
    sourceTrust = minTrust(sourceTrust, s.trustLevel as UserRepresentationTrust);
  }

  // The INJECTED offline build() seam over the BOUNDED source text. Non-fatal: a
  // thrown/aborted build → WARN + return ok with nothing written (mirrors
  // reasoning-job.ts:407-420).
  const builtResult = await fromPromise(deps.build(sourceText));
  if (!builtResult.ok) {
    logger.warn(
      {
        agentId,
        err: builtResult.error,
        errorKind: "dependency" as const,
        step: "user-repr" as const,
        hint: "offline representation build seam failed/aborted — no profile entries written this run",
      },
      "User representation build LLM call failed (non-fatal)",
    );
    emit();
    return ok(stats());
  }
  const candidates = builtResult.value;
  built = candidates.length;

  const now = clock.now();

  // 5. CURRENT-PROFILE PRE-READ — the CHEAP exact-dup pre-skip ONLY. After Plan 02,
  //    `read()` returns CURRENT-TRUTH only (t_valid_end IS NULL). We derive
  //    `existingKeys` (the `(entryType, content)` set): an EXACT current-truth
  //    duplicate is a no-op re-distillation, so we skip the revise() txn entirely (a
  //    no-op transaction saved) and count it as a `corroborated` no-op. The job no
  //    longer re-classifies the contradict/corroborate/coexist relation — that is the
  //    adapter's AUTHORITATIVE call inside revise(), RETURNED to us as a
  //    {@link ReviseOutcome} (WR-01: the counts come from the adapter, by
  //    construction, not from a divergent job-side heuristic). The read is non-fatal:
  //    a failed read degrades to "no exact-dup pre-skip" — every surviving candidate
  //    is then passed to revise(), whose adapter is the authoritative belt.
  const existingKeys = new Set<string>();
  const existing = await fromPromise(
    userRepresentationStore.read({ tenantId, agentId, userId }),
  );
  if (existing.ok && existing.value.ok) {
    for (const e of existing.value.value) existingKeys.add(`${e.entryType}::${e.content}`);
  } else {
    logger.warn(
      {
        agentId,
        errorKind: "dependency" as const,
        step: "user-repr" as const,
        hint: "profile pre-read failed — skipping the exact-dup pre-skip; the adapter revise() remains the authoritative per-slot resolution",
      },
      "User representation profile pre-read failed (non-fatal)",
    );
  }

  for (const candidate of candidates) {
    // The bounded run: count the overflow for observability, then stop writing once
    // the cap is reached (the DoS cost bound, mirrors reasoning-job.ts:391).
    if (written >= config.maxEntriesPerRun) {
      skippedOverCap++;
      continue;
    }

    // Idempotency optimization: a candidate BYTE-identical to a current-truth row
    // (same entryType + content) is a no-op re-distillation — skip the revise() txn
    // (keeps `written` at 0 on an unchanged re-run). It is the STRONGEST same-slot
    // corroboration (normalized-equal to itself), so it is COUNTED as `corroborated`
    // (REVISE-01 telemetry for the daemon event) even though we save the no-op
    // write. NOT counted as `blocked` (it is not a rejection); the content already
    // passed the firewall when first written.
    if (existingKeys.has(`${candidate.entryType}::${candidate.content}`)) {
      corroborated++;
      continue;
    }

    // Pitfall 2: the redaction firewall on the LLM-produced content (the
    // secret-egress guard runs FIRST). For USER there is no `external` tier to
    // down-store a `warn` into — the high-trust floor + the DB CHECK forbid it — so
    // a non-`clean` verdict (`warn` OR `critical`) is SKIPPED, NOT downgraded-and-
    // stored. A `warn` entry produces 0 rows, exactly like `critical`.
    const verdict = validateMemoryWrite(candidate.content);
    if (verdict.severity !== "clean") {
      blocked++;
      logger.warn(
        {
          agentId,
          errorKind: "validation" as const,
          step: "user-repr" as const,
          severity: verdict.severity,
          patterns: verdict.patterns,
          criticalPatterns: verdict.criticalPatterns,
          hint: "representation candidate matched a dangerous/secret/suspicious pattern — skipped (the high-trust profile has no reduced-weight tier)",
        },
        "Skipping representation candidate that failed the memory-write security scan",
      );
      continue;
    }

    // Trust is CODE-computed at the source ceiling — NEVER from the LLM, NEVER
    // `external`. `sourceMemoryId` is omitted: a profile entry is distilled from the
    // FUSED source set, not a single message (provenance to a single id would be
    // misleading; the table column is optional). CONSEQUENCE: because
    // `source_memory_id` is NULL here, the table's ON DELETE CASCADE does NOT retire
    // these rows when their source memories are deleted —
    // an offline-built entry persists until the next run revise()-replaces it (the
    // adapter soft-closes the superseded incumbent, never DELETEs). There is no
    // orphan-sweep; do not rely on CASCADE to garbage-collect builder-produced rows
    // (the adapter docstring carries the full caveat).
    const entry: UserRepresentationInput = {
      entryType: candidate.entryType,
      content: candidate.content,
      trust: sourceTrust,
    };

    // The non-fatal write (mirrors reasoning-job.ts:462). REVISE-01: the write path
    // is `revise()` (the trust-first bi-temporal soft-close), NOT the blind `upsert`.
    // The adapter filters every statement on `(tenantId, agentId, userId)` and
    // resolves the slot trust-first; it RETURNS the AUTHORITATIVE decided outcome so
    // we count what was actually persisted (WR-01 — no divergent job-side classifier).
    // A rejecting/erroring store → WARN + continue (nothing counted for a failed write).
    const revised = await fromPromise(
      userRepresentationStore.revise(entry, { tenantId, agentId, userId, now }),
    );
    if (!revised.ok || !revised.value.ok) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          step: "user-repr" as const,
          hint: "userRepresentationStore.revise failed/rejected — candidate skipped, run continues",
        },
        "Failed to revise representation entry (non-fatal)",
      );
      continue;
    }

    // Count the ADAPTER's AUTHORITATIVE outcome (counts only — never the
    // content/entryType). `written` is ROW writes only (IN-02): a `superseded` or
    // `inserted` wrote a new current-truth row; a `corroborated` was an in-place
    // confidence bump (NO row) — counted under the corroboration tally, NOT `written`;
    // a `recorded-not-believed` (lower-trust contradiction, anti-poison) persisted
    // nothing and is not tallied here at all.
    const outcome = revised.value.value;
    if (outcome === "superseded") {
      superseded++;
      written++;
    } else if (outcome === "inserted") {
      inserted++;
      written++;
    } else if (outcome === "corroborated") {
      corroborated++;
    }
    // outcome === "recorded-not-believed": nothing persisted, nothing counted.

    // Same-run bookkeeping: a later BYTE-identical candidate is now an exact
    // current-truth that the cheap exact-dup pre-skip catches (saving its no-op txn).
    existingKeys.add(`${candidate.entryType}::${candidate.content}`);
  }

  logger.info(
    { agentId, step: "user-repr" as const, ...stats(), durationMs: clock.now() - startMs },
    "User representation build completed",
  );
  // GENQ-01: classify the source memories vs the built profile. Fires only on an
  // issue (the F-ML1 class: non-Latin sources translated into a Latin profile, or
  // an empty build) — VISIBILITY ONLY, content-free, guarded (never fails the run).
  emitGenerationQuality(eventBus, logger, {
    agentId,
    pass: "user_representation",
    sourceText,
    outputText: candidates.map((candidate) => candidate.content).join("\n"),
    nowMs: clock.now(),
  });
  emit();
  return ok(stats());
}

// Re-exported so the daemon's seam can import the parser alongside the job from a
// single agent-internal home (mirrors the reasoning-job/seam split).
export { parseUserRepresentationOutput };
