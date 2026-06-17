// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user representation offline builder job.
 *
 * The WRITE path of the per-user profile. Mirrors {@link runMemoryReasoning} 1:1
 * (the canonical offline-job template): a background cron seam OFF the recall hot
 * path. It refreshes a single user's profile from their HIGH-TRUST source
 * memories: default-OFF gate → read sources → EXCLUDE `external`-trust
 * (anti-poisoning) → bound → INJECTED `build()` seam → `validateMemoryWrite` on
 * every candidate → classify vs the current profile (contradict → supersede /
 * corroborate → bump / topic-distinct → coexist) → `revise()` via the port
 * (REVISE-01, the trust-first bi-temporal soft-close — NOT a blind insert) →
 * counts-only event (incl. superseded/corroborated/inserted) → idempotent.
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
  UserRepresentationEntry,
  UserRepresentationType,
  ClockPort,
  ComisLogger,
} from "@comis/core";
import {
  parseUserRepresentationOutput,
  type UserRepresentationBuildOutput,
} from "./memory-user-representation-prompt.js";
import { emitGenerationQuality } from "./emit-generation-quality.js";
import { contentSimilarity } from "./memory-consolidation-clustering.js";

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
// REVISE-01: the deterministic same-belief-slot classifier (counts only)
// ---------------------------------------------------------------------------

/**
 * The Sørensen–Dice content-similarity threshold at/above which a same-`entryType`
 * candidate is the SAME belief slot as an incumbent (so the revision is a
 * corroboration or a trust-first supersession, NOT a coexisting new fact). BELOW
 * it, a same-type candidate is topic-distinct and COEXISTS (Pitfall 4 — distinct
 * preferences must never be collapsed into a false contradiction).
 *
 * Empirically calibrated against the Plan-02 corpus (the SAME `contentSimilarity`
 * Dice used by the @comis/memory adapter's own classifier, so the job-side counts
 * agree with the adapter's slot decision): "prefers coffee"↔"prefers tea" = 0.609
 * (same slot, different value → supersede); identical = 1.0 (corroborate); "enjoys
 * hiking on weekends"↔"drinks espresso every morning" = 0.115 (topic-distinct →
 * coexist). Mirrors the adapter's `SAME_SLOT_DICE` floor (Plan 02) intentionally.
 */
const SAME_SLOT_DICE = 0.6;

/**
 * The three counts-only classification outcomes for a candidate vs the current
 * profile (REVISE-01). These are the JOB-side classification ATTEMPT (telemetry
 * for the Plan-05 `learning:user_model_revised` event), NOT a transactional
 * ledger: the authoritative per-slot resolution (and a possible
 * lower-trust-candidate downgrade to recorded-not-believed) happens INSIDE
 * `revise()` in the @comis/memory adapter (Plan 02). Counts agree with the adapter
 * because both use the same `entryType` + `contentSimilarity >= SAME_SLOT_DICE`
 * heuristic.
 */
type RevisionOutcome = "corroborated" | "superseded" | "inserted";

/**
 * Classify a candidate against the live current-truth profile (the `read()`
 * result): a same-`entryType` incumbent with `contentSimilarity >= SAME_SLOT_DICE`
 * is the same belief slot — `corroborated` when the content is normalized-equal
 * (a restatement → confidence bump in place), else `superseded` (same topic,
 * different value → trust-first soft-close). No same-slot incumbent →
 * `inserted` (a NEW coexisting current-truth — different `entryType`, or a
 * topic-distinct same-type fact). Deterministic, no LLM, no abstain gate.
 */
function classifyRevision(
  candidate: { entryType: UserRepresentationType; content: string },
  current: UserRepresentationEntry[],
): RevisionOutcome {
  const candNorm = candidate.content.trim().toLowerCase();
  let sameSlot: UserRepresentationEntry | undefined;
  for (const inc of current) {
    if (inc.entryType !== candidate.entryType) continue;
    if (contentSimilarity(inc.content, candidate.content) >= SAME_SLOT_DICE) {
      sameSlot = inc;
      break;
    }
  }
  if (!sameSlot) return "inserted";
  return sameSlot.content.trim().toLowerCase() === candNorm ? "corroborated" : "superseded";
}

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
  /** Entries written via the port revise() (the surviving candidates passed through). */
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
   * REVISE-01 (counts only): candidates the job classified as a same-slot
   * contradiction (same `entryType`, content differs, `contentSimilarity >=
   * SAME_SLOT_DICE`) — a trust-first soft-close of the incumbent inside revise().
   * The job-side classification ATTEMPT (the adapter may downgrade a lower-trust
   * candidate to recorded-not-believed); telemetry for the Plan-05 daemon event.
   */
  superseded: number;
  /**
   * REVISE-01 (counts only): candidates classified as a same-slot corroboration
   * (same `entryType`, content normalized-equal to an incumbent) — a confidence
   * bump in place inside revise(), no new current-truth row.
   */
  corroborated: number;
  /**
   * REVISE-01 (counts only): candidates classified as NEW (no same-slot incumbent
   * — a different `entryType`, or a topic-distinct same-type fact that COEXISTS).
   * Inserted as a new current-truth row by revise().
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
 * surviving-source ceiling → `upsert` via the port (a rejecting store → WARN +
 * continue). Emit a counts-only `memory:user_representation_built` event.
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

  // 5. CURRENT-PROFILE PRE-READ: the classification input AND the exact-dup
  //    pre-skip. After Plan 02, `read()` returns CURRENT-TRUTH only (t_valid_end IS
  //    NULL) — exactly the live profile to classify each candidate against
  //    (REVISE-01). We keep BOTH:
  //      - `currentProfile` (the UserRepresentationEntry[]) — the same-belief-slot
  //        classification input for the counts + the contradict/corroborate/coexist
  //        decision (the per-slot supersession itself happens INSIDE revise()).
  //      - `existingKeys` (the `(entryType, content)` set) — the CHEAP exact-dup
  //        pre-skip: an EXACT current-truth duplicate is a no-op re-distillation, so
  //        we skip the revise() txn entirely (a no-op transaction saved). The
  //        authoritative resolution for everything else is revise().
  //    The read is non-fatal: a failed read degrades to "no pre-skip, classify
  //    against an empty profile" — every surviving candidate is then passed to
  //    revise(), whose adapter is the second belt (it re-classifies per slot).
  const existingKeys = new Set<string>();
  let currentProfile: UserRepresentationEntry[] = [];
  const existing = await fromPromise(
    userRepresentationStore.read({ tenantId, agentId, userId }),
  );
  if (existing.ok && existing.value.ok) {
    currentProfile = existing.value.value;
    for (const e of currentProfile) existingKeys.add(`${e.entryType}::${e.content}`);
  } else {
    logger.warn(
      {
        agentId,
        errorKind: "dependency" as const,
        step: "user-repr" as const,
        hint: "profile pre-read failed — skipping the exact-dup pre-skip and classifying against an empty profile (the adapter revise() re-classifies per slot)",
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

    // REVISE-01 classification (counts-only telemetry for the Plan-05 daemon
    // event). DETERMINISTIC, no LLM: same `entryType` + Dice `contentSimilarity >=
    // SAME_SLOT_DICE` against the live current-truth profile ⇒ same belief slot —
    // `corroborated` (content normalized-equal, a restatement) or `superseded`
    // (same topic, different value); no same-slot incumbent ⇒ `inserted` (a NEW
    // coexisting current-truth — different `entryType`, or a topic-distinct
    // same-type fact, Pitfall 4). This count is the job-side classification
    // ATTEMPT; the AUTHORITATIVE per-slot resolution (incl. a possible
    // lower-trust-candidate downgrade to recorded-not-believed) happens INSIDE
    // revise() (Plan 02). Classified BEFORE the write so a same-run earlier
    // candidate of the same slot is already in `currentProfile`.
    const outcome = classifyRevision(candidate, currentProfile);

    // The non-fatal write (mirrors reasoning-job.ts:462). REVISE-01: the write path
    // is now `revise()` (the trust-first bi-temporal soft-close), NOT the blind
    // `upsert`. The adapter filters every statement on `(tenantId, agentId,
    // userId)` and resolves the slot trust-first (corroborate / supersede / insert);
    // a lower-trust contradiction is recorded-not-believed (anti-poison). A
    // rejecting/erroring store → WARN + continue (the count is NOT incremented for a
    // failed write).
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
    written++;
    // Count the classified outcome (counts only — never the content/entryType).
    if (outcome === "corroborated") corroborated++;
    else if (outcome === "superseded") superseded++;
    else inserted++;
    // Same-run bookkeeping: a later EXACT-duplicate candidate is now an exact
    // current-truth (the exact-dup pre-skip catches it), AND a later same-slot
    // candidate now classifies against this just-written row in `currentProfile`.
    existingKeys.add(`${candidate.entryType}::${candidate.content}`);
    currentProfile = [
      ...currentProfile,
      { id: `pending-${written}`, entryType: candidate.entryType, content: candidate.content, trust: sourceTrust, createdAt: now, validFrom: now },
    ];
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
