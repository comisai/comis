// SPDX-License-Identifier: Apache-2.0
/**
 * The offline DIRECTIONAL relationship builder job.
 *
 * The WRITE path of the per-channel directional relationship model. Mirrors
 * {@link runUserRepresentationBuild} 1:1 (the canonical offline-job template): a
 * background cron seam OFF the recall hot path. It refreshes ONE channel's
 * directional relationship edges from its HIGH-TRUST, multi-party source memories:
 * default-OFF gate → read sources → EXCLUDE `external`-trust (anti-poisoning) →
 * bound → INJECTED `build()` seam → `validateMemoryWrite` on every candidate →
 * `upsert` via the port → counts-only event → idempotent.
 *
 * The DELTA from the per-user profile builder:
 * - The candidate is DIRECTIONAL — `subjectUserId` (the speaker) + `aboutUserId`
 *   (whom the statement concerns) + free `content`. A→B is a DISTINCT edge from B→A;
 *   the idempotency key + the upsert are keyed on the full directional triple
 *   `(subjectUserId, aboutUserId, content)` — they are never collapsed/symmetrized.
 * - The `sourceText` is SENDER-PREFIXED `- [userId]: content` instead of the
 *   per-user-profile bare `- content`, so the build seam can attribute the speaker (the subject).
 * - The scope carries `channelId` (the new per-channel privacy isolation axis)
 *   alongside `tenantId` + `agentId`.
 *
 * Security posture (the same anti-poisoning discipline as the user-representation +
 * reasoning + triple-extraction jobs):
 * - Anti-poisoning (layer 3): `external`-trust source memories
 *   are filtered out BEFORE the build — UNCONDITIONALLY. An `external` claim can
 *   NEVER build a relationship edge (the DB CHECK constraint + write-time reject are
 *   layers 1+2; the port-type floor is the contract layer). The build seam never
 *   sees the excluded content.
 * - The redaction firewall: every build() candidate runs through
 *   `validateMemoryWrite` (the secret-egress guard FIRST) BEFORE upsert. A
 *   non-`clean` verdict (`warn` OR `critical`) is SKIPPED (`blocked++`) — NOT
 *   downgraded-and-stored: the high-trust floor + the DB CHECK forbid
 *   `external`, so a `warn` entry cannot be a valid relationship row; it is skipped
 *   exactly like `critical`.
 * - Trust is computed in CODE at the source ceiling, NEVER chosen by the
 *   LLM (the parser STRIPS any smuggled trust field). The writer can only lower
 *   trust toward the surviving sources' floor — it can never raise it.
 * - DEFAULT-OFF cost gate: with `config.enabled === false` the build() seam is NEVER
 *   called and nothing is written (no LLM spend, no write).
 * - The run is BOUNDED by `maxEntriesPerRun` (caps writes; overflow counted as
 *   `skippedOverCap`) + the input bounds. It emits a MINIMAL, counts-only
 *   `memory:relationship_built` event + counts-only logs — NEVER the relationship
 *   `content` or the directional user-id pair as content (AGENTS.md §2.7).
 * - Idempotent: a re-run over unchanged sources writes 0 new — the
 *   upsert is keyed on `(scope, subjectUserId, aboutUserId, content)`, so
 *   re-distilling the same sources replaces in place rather than appending.
 *
 * The `build` LLM call is INJECTED (the offline seam) — the daemon builds it from a
 * cheap model; it is NEVER invoked on the recall path. The agent consumes the store
 * as a port TYPE from `@comis/core` (the agent↛memory build cut); the daemon injects
 * the concrete memory-package adapter. NO memory-package import here, NO wall-clock
 * global (the injected `clock`).
 *
 * @module
 */

import { ok, err, fromPromise, type Result } from "@comis/shared";
import { validateMemoryWrite } from "@comis/core";
import type {
  RelationshipStore,
  RelationshipInput,
  RelationshipTrust,
  ClockPort,
  ComisLogger,
} from "@comis/core";
import {
  parseRelationshipOutput,
  type RelationshipBuildOutput,
} from "./memory-relationship-prompt.js";

// ---------------------------------------------------------------------------
// Trust ceiling helper
// ---------------------------------------------------------------------------

/**
 * The HIGH-TRUST ladder rank for the source-trust ceiling (`system` 2 >
 * `learned` 1). `external` is structurally excluded BEFORE this is consulted
 * (the anti-poisoning filter removes it), so the ceiling is only ever taken over
 * the high-trust floor — the writer can never mint a trust above its sources.
 */
const TRUST_RANK: Record<RelationshipTrust, number> = { system: 2, learned: 1 } as const;

/** Pick the lower-trust of two high-trust levels (the source-trust ceiling). */
function minTrust(a: RelationshipTrust, b: RelationshipTrust): RelationshipTrust {
  return TRUST_RANK[a] <= TRUST_RANK[b] ? a : b;
}

/**
 * One high-trust source memory the builder distills directional edges from. The
 * builder reads these via the INJECTED `readSources` seam (so the job stays free of
 * any memory-package import — the agent↛memory build cut); the daemon wires a
 * channel-scoped `memories` read. `userId` is the SPEAKER (the subject candidate)
 * — sender-prefixed into the `sourceText` so the build seam can attribute who
 * said what about whom. `trustLevel` is the FULL ladder (`system`/`learned`/
 * `external`) so the job can EXCLUDE `external` before the build (anti-poisoning).
 */
export interface RelationshipSourceMemory {
  /** The source memory id (provenance + the idempotency key set). */
  id: string;
  /** The speaker who produced the memory (the subject candidate; sender-prefixed into sourceText). */
  userId?: string;
  /** The source text the build seam distills (conversation-derived). */
  content: string;
  /** The source's trust — `external` is filtered out BEFORE the build. */
  trustLevel: "system" | "learned" | "external";
}

/** Configuration for one offline relationship-build run. */
export interface MemoryRelationshipConfig {
  /** DEFAULT-OFF cost gate. When false: no build() call, no write, no spend. */
  enabled: boolean;
  /** Upper bound on entries WRITTEN per run (the DoS cost bound on the write side). */
  maxEntriesPerRun: number;
  /**
   * INPUT bound: the max number of source memories fed into ONE build()
   * prompt. The sources arrive newest-first (the cron's `inspect` orders
   * `created_at DESC`), so the cap keeps the NEWEST `maxSourceMemories` and drops
   * the older tail — the build prompt can never grow unbounded with a chatty
   * channel's full history (an over-context prompt silently fails the build → no
   * edges). Optional: absent ⇒ {@link DEFAULT_MAX_SOURCE_MEMORIES}.
   */
  maxSourceMemories?: number;
  /**
   * INPUT bound: the max total characters of the concatenated `sourceText`
   * fed into ONE build() prompt. Applied AFTER the count cap — sources are admitted
   * newest-first until the next one would exceed the budget. Optional: absent ⇒
   * {@link DEFAULT_MAX_SOURCE_CHARS}.
   */
  maxSourceChars?: number;
}

/**
 * Default input bounds. Conservative caps that keep ONE distillation prompt
 * well within a cheap model's context window while admitting a rich channel's worth
 * of recent high-trust sources. An operator can widen/narrow them via config; they
 * mirror `maxEntriesPerRun`'s DoS-bound intent on the INPUT axis.
 */
const DEFAULT_MAX_SOURCE_MEMORIES = 200;
const DEFAULT_MAX_SOURCE_CHARS = 24_000;

/** Dependencies injected into the offline relationship-build handler. */
export interface MemoryRelationshipDeps {
  agentId: string;
  tenantId: string;
  /** The per-channel privacy isolation axis — threaded into deps + the upsert scope. */
  channelId: string;
  config: MemoryRelationshipConfig;
  /**
   * The SEGREGATED relationship store (port TYPE from `@comis/core`) — the `upsert`
   * write path. The daemon injects the concrete adapter; the agent cannot import
   * that package (the agent↛memory build cut).
   */
  relationshipStore: RelationshipStore;
  /**
   * The INJECTED scoped source read: the high-trust, multi-party source memories for
   * `(tenantId, agentId, channelId)`. Abstracted so the job imports no memory
   * package. A READ failure is FATAL (the job cannot safely proceed over an unknown
   * source set).
   */
  readSources: () => Promise<Result<RelationshipSourceMemory[], Error>>;
  /** Wall-clock reads — the scope `now`. NEVER a wall-clock global. */
  clock: ClockPort;
  logger: ComisLogger;
  /** Minimal counts-only event sink (mirrors the user-representation/reasoning jobs). */
  eventBus?: { emit(event: string, payload: unknown): void };
  /**
   * The INJECTED offline build() seam: the sender-prefixed source-memory text →
   * typed DIRECTIONAL candidates. The OFFLINE seam — NEVER on the recall hot path;
   * the caller (the daemon) builds it from a cheap model. A thrown call is non-fatal.
   */
  build: (sourceText: string) => Promise<RelationshipBuildOutput>;
}

/** Counts-only outcome of one build run (never carries the relationship content). */
export interface MemoryRelationshipStats {
  /** Candidates returned by the build seam (the pre-filter input count). */
  built: number;
  /** Entries written via the port upsert. */
  written: number;
  /** Candidates blocked by validateMemoryWrite (warn OR critical). */
  blocked: number;
  /** Candidates skipped because they exceeded maxEntriesPerRun. */
  skippedOverCap: number;
  /** Surviving (post-external-exclude) high-trust sources for this channel. */
  sourcesConsidered: number;
  /** Sources actually fed into the bounded build() prompt. */
  sourcesUsed: number;
  /** True when the input bound dropped one or more sources from the prompt. */
  sourcesTruncated: boolean;
}

/** The job's Result alias (exported for the test + the daemon onComplete mapping). */
export type MemoryRelationshipResult = Result<MemoryRelationshipStats, Error>;

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Run one offline relationship-build pass for a single (tenant, agent, channel).
 *
 * Gate on `config.enabled` (default-OFF → return early, no build seam, no write) →
 * read the high-trust source memories (READ failure is fatal → `err`) → EXCLUDE
 * `external`-trust sources (anti-poisoning) → call the INJECTED `build` seam over
 * the SENDER-PREFIXED surviving source text (non-fatal via `fromPromise`) → for
 * each DIRECTIONAL candidate (bounded by `maxEntriesPerRun`): `validateMemoryWrite`
 * (`warn` OR `critical` → skip, `blocked++`; NO downgrade-and-store) → compute trust
 * in CODE at the surviving-source ceiling → `upsert` via the port (a rejecting store
 * → WARN + continue). Emit a counts-only `memory:relationship_built` event.
 *
 * @returns `ok(stats)` on success (even with 0 written); `err` only when the
 *   source read fails (cannot proceed safely). A per-candidate failure is non-fatal.
 */
export async function runRelationshipBuild(
  deps: MemoryRelationshipDeps,
): Promise<MemoryRelationshipResult> {
  const { config, agentId, tenantId, channelId, relationshipStore, eventBus, logger, clock } = deps;
  const startMs = clock.now();

  let built = 0;
  let written = 0;
  let blocked = 0;
  let skippedOverCap = 0;
  // Input-bound counters (counts-only; never carry source content).
  let sourcesConsidered = 0;
  let sourcesUsed = 0;
  let sourcesTruncated = false;

  const emit = (): void => {
    eventBus?.emit("memory:relationship_built", {
      agentId,
      built,
      written,
      blocked,
      skippedOverCap,
      sourcesConsidered,
      sourcesUsed,
      sourcesTruncated,
      durationMs: clock.now() - startMs,
      timestamp: clock.now(),
    });
  };

  const stats = (): MemoryRelationshipStats => ({
    built,
    written,
    blocked,
    skippedOverCap,
    sourcesConsidered,
    sourcesUsed,
    sourcesTruncated,
  });

  // The DEFAULT-OFF cost gate. No build() call, no write, no spend.
  if (!config.enabled) {
    logger.debug(
      { agentId, step: "relationship" as const },
      "Relationship build disabled (enabled=false) — skipping",
    );
    emit();
    return ok(stats());
  }

  // 1. Read the high-trust source memories. A READ failure is FATAL — we cannot
  //    safely proceed over an unknown source set (mirrors user-representation-job).
  const sourcesResult = await fromPromise(deps.readSources());
  if (!sourcesResult.ok) return err(sourcesResult.error);
  if (!sourcesResult.value.ok) return err(sourcesResult.value.error);
  const allSources = sourcesResult.value.value;

  // 2. ANTI-POISONING EXCLUDE (layer 3): drop `external`-trust
  //    sources UNCONDITIONALLY, BEFORE the build. An `external` claim can NEVER build
  //    a relationship edge. The build seam never sees the excluded content.
  const sources = allSources.filter((s) => s.trustLevel !== "external");
  sourcesConsidered = sources.length;

  if (sources.length === 0) {
    emit();
    return ok(stats());
  }

  // 3. INPUT BOUND: cap the source set fed into ONE build() prompt so it can
  //    never grow unbounded (an over-context prompt silently fails the build → no
  //    edges; mirrors maxEntriesPerRun's DoS intent, on the INPUT axis). Sources are
  //    newest-first (the cron orders `created_at DESC`), so we keep the NEWEST and
  //    drop the older tail: first the count cap, then a cumulative-char budget.
  //    DELTA: each line is SENDER-PREFIXED `- [userId]: content` so the build
  //    seam can attribute the speaker (the subject) — instead of the per-user-profile
  //    bare `- content`. Truncation is surfaced as a counts-only WARN + on the event.
  const maxSourceMemories = config.maxSourceMemories ?? DEFAULT_MAX_SOURCE_MEMORIES;
  const maxSourceChars = config.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS;
  const countCapped = sources.slice(0, maxSourceMemories);
  const usedSources: RelationshipSourceMemory[] = [];
  let sourceText = "";
  for (const s of countCapped) {
    const prefixed = `[${s.userId ?? "unknown"}]: ${s.content}`;
    const line = usedSources.length === 0 ? `- ${prefixed}` : `\n- ${prefixed}`;
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
        step: "relationship" as const,
        sourcesConsidered,
        sourcesUsed,
        maxSourceMemories,
        maxSourceChars,
        hint: "high-trust source set exceeded the per-build input bound — distilling over the NEWEST sources only; raise maxSourceMemories/maxSourceChars (or page the cron read) for fuller relationship coverage",
      },
      "Relationship source set truncated to the per-build input bound",
    );
  }

  // 4. The source-trust ceiling, computed in CODE over the USED sources —
  //    the candidates are distilled from exactly these, so the ceiling must reflect
  //    them. All are high-trust (external already excluded), so the ceiling is the
  //    floor of the used sources — a system+learned mix yields `learned`; the writer
  //    can never raise trust above its sources, and the LLM has no say (the parser
  //    stripped any trust field). `usedSources` is non-empty here.
  let sourceTrust: RelationshipTrust = "system";
  for (const s of usedSources) {
    // s.trustLevel is one of system|learned here (external filtered out above).
    sourceTrust = minTrust(sourceTrust, s.trustLevel as RelationshipTrust);
  }

  // The INJECTED offline build() seam over the BOUNDED, SENDER-PREFIXED source text.
  // Non-fatal: a thrown/aborted build → WARN + return ok with nothing written.
  const builtResult = await fromPromise(deps.build(sourceText));
  if (!builtResult.ok) {
    logger.warn(
      {
        agentId,
        err: builtResult.error,
        errorKind: "dependency" as const,
        step: "relationship" as const,
        hint: "offline relationship build seam failed/aborted — no edges written this run",
      },
      "Relationship build LLM call failed (non-fatal)",
    );
    emit();
    return ok(stats());
  }
  const candidates = builtResult.value;
  built = candidates.length;

  const now = clock.now();

  // 5. IDEMPOTENCY: a re-run over unchanged sources must write 0 new.
  //    Read the current channel edges once and dedup candidates against the EXISTING
  //    DIRECTIONAL `(subjectUserId, aboutUserId, content)` set — re-distilling the
  //    same sources yields the same candidates, which are already present, so they
  //    are skipped. A→B and B→A are DISTINCT keys (never collapsed). The dedup keys
  //    on the directional triple (not a global "ran once" flag), so a NEW source
  //    that yields a NEW edge still writes. The adapter's own upsert-replace is the
  //    second belt; this read keeps `written` honest (0 new on a no-op re-run). The
  //    read is non-fatal: a failed read degrades to "dedup nothing".
  const existingKeys = new Set<string>();
  const existing = await fromPromise(
    relationshipStore.read({ tenantId, agentId, channelId }),
  );
  if (existing.ok && existing.value.ok) {
    for (const e of existing.value.value) {
      existingKeys.add(`${e.subjectUserId}::${e.aboutUserId}::${e.content}`);
    }
  } else {
    logger.warn(
      {
        agentId,
        errorKind: "dependency" as const,
        step: "relationship" as const,
        hint: "relationship pre-read for idempotency failed — falling back to the adapter's upsert de-dup",
      },
      "Relationship idempotency pre-read failed (non-fatal)",
    );
  }

  for (const candidate of candidates) {
    // The bounded run: count the overflow for observability, then stop writing once
    // the cap is reached (the DoS cost bound).
    if (written >= config.maxEntriesPerRun) {
      skippedOverCap++;
      continue;
    }

    const dedupKey = `${candidate.subjectUserId}::${candidate.aboutUserId}::${candidate.content}`;

    // Idempotency skip: a candidate already a channel edge (same directional triple)
    // is a no-op re-distillation — do NOT re-write it (keeps `written` at 0 on an
    // unchanged re-run). NOT counted as blocked (it is not a rejection).
    if (existingKeys.has(dedupKey)) {
      continue;
    }

    // The redaction firewall on the LLM-produced content (the
    // secret-egress guard runs FIRST). For relationships there is no `external` tier
    // to down-store a `warn` into — the high-trust floor + the DB CHECK forbid it —
    // so a non-`clean` verdict (`warn` OR `critical`) is SKIPPED, NOT downgraded-and-
    // stored. A `warn` candidate produces 0 rows, exactly like `critical`.
    const verdict = validateMemoryWrite(candidate.content);
    if (verdict.severity !== "clean") {
      blocked++;
      logger.warn(
        {
          agentId,
          errorKind: "validation" as const,
          step: "relationship" as const,
          severity: verdict.severity,
          patterns: verdict.patterns,
          criticalPatterns: verdict.criticalPatterns,
          hint: "relationship candidate matched a dangerous/secret/suspicious pattern — skipped (the high-trust edge has no reduced-weight tier)",
        },
        "Skipping relationship candidate that failed the memory-write security scan",
      );
      continue;
    }

    // Trust is CODE-computed at the source ceiling — NEVER from the LLM,
    // NEVER `external`. `sourceMemoryId` is omitted: a relationship edge is distilled
    // from the FUSED multi-party source set, not a single message (provenance to a
    // single id would be misleading; the table column is optional). CONSEQUENCE:
    // because `source_memory_id` is NULL here, the table's ON DELETE CASCADE does NOT
    // retire these rows when their source memories are deleted — an offline-built edge
    // persists until the next run upsert-replaces it (keyed on the directional triple).
    const entry: RelationshipInput = {
      subjectUserId: candidate.subjectUserId,
      aboutUserId: candidate.aboutUserId,
      content: candidate.content,
      trust: sourceTrust,
    };

    // The non-fatal write. The adapter filters every statement on
    // `(tenantId, agentId, channelId)`; the upsert is idempotent per the directional
    // triple. A rejecting/erroring store → WARN + continue.
    const upserted = await fromPromise(
      relationshipStore.upsert(entry, { tenantId, agentId, channelId, now }),
    );
    if (!upserted.ok || !upserted.value.ok) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          step: "relationship" as const,
          hint: "relationshipStore.upsert failed/rejected — candidate skipped, run continues",
        },
        "Failed to upsert relationship edge (non-fatal)",
      );
      continue;
    }
    written++;
    // Same-run dedup: a later identical directional candidate is now "existing".
    existingKeys.add(dedupKey);
  }

  logger.info(
    { agentId, step: "relationship" as const, ...stats(), durationMs: clock.now() - startMs },
    "Relationship build completed",
  );
  emit();
  return ok(stats());
}

// Re-exported so the daemon's seam can import the parser alongside the job from a
// single agent-internal home (mirrors the user-representation job/seam split).
export { parseRelationshipOutput };
