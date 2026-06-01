// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user representation offline builder job (Phase 107 — USER-02).
 *
 * The WRITE path of the per-user profile. Mirrors {@link runMemoryReasoning} 1:1
 * (the canonical offline-job template): a background cron seam OFF the recall hot
 * path. It refreshes a single user's profile from their HIGH-TRUST source
 * memories: default-OFF gate → read sources → EXCLUDE `external`-trust
 * (anti-poisoning) → bound → INJECTED `build()` seam → `validateMemoryWrite` on
 * every candidate → `upsert` via the port → counts-only event → idempotent.
 *
 * Security posture (design §9 — the same anti-poisoning discipline as the
 * reasoning + triple-extraction jobs, with the USER hardening):
 * - Anti-poisoning (USER-02, T-107-03-01): `external`-trust source memories are
 *   filtered out BEFORE the build — UNCONDITIONALLY (there is no `reasonExternal`
 *   escape hatch). An `external` claim can NEVER enter the profile (layer 2 of the
 *   3-layer defense; the 107-02 DB CHECK + write-time reject are layers 1+3).
 * - The redaction firewall (T-107-03-02): every build() candidate runs through
 *   `validateMemoryWrite` (the secret-egress guard FIRST) BEFORE upsert. A
 *   non-`clean` verdict (`warn` OR `critical`) is SKIPPED (`blocked++`) — NOT
 *   downgraded-and-stored. This is the USER delta from the KG path (Pitfall 2):
 *   the high-trust floor + the DB CHECK forbid `external`, so the reasoning job's
 *   `warn → downgrade-to-external → store` branch is INVALID here; a `warn` entry
 *   cannot be a valid high-trust row, so it is skipped exactly like `critical`.
 * - Trust is computed in CODE at the source ceiling (T-107-03-03), NEVER chosen by
 *   the LLM (the parser STRIPS any smuggled trust field). The writer can only
 *   lower trust toward the surviving sources' floor — it can never raise it.
 * - DEFAULT-OFF cost gate (T-107-03-04): with `config.enabled === false` the
 *   build() seam is NEVER called and nothing is written (no LLM spend, no write).
 * - The run is BOUNDED by `maxEntriesPerRun` (caps writes; overflow counted as
 *   `skippedOverCap`). It emits a MINIMAL, counts-only
 *   `memory:user_representation_built` event + counts-only logs — NEVER the
 *   profile `content` (AGENTS.md §2.7 / T-107-03-05).
 * - Idempotent (USER-02): a re-run over unchanged sources writes 0 new — the
 *   upsert is keyed on `(scope, entryType, content)`, so re-distilling the same
 *   sources replaces in place rather than appending.
 *
 * The `build` LLM call is INJECTED (the offline seam) — the daemon (107-05) builds
 * it from a cheap model; it is NEVER invoked on the recall path. The agent consumes
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

/**
 * One high-trust source memory the builder distills the profile from. The builder
 * reads these via the INJECTED `readSources` seam (so the job stays free of any
 * memory-package import — the agent↛memory build cut); the daemon (107-05) wires a
 * scoped `memories` read. `trustLevel` is the FULL ladder (`system`/`learned`/
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
  /** Upper bound on entries written per run (the DoS cost bound). */
  maxEntriesPerRun: number;
}

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
  /** Entries written via the port upsert. */
  written: number;
  /** Candidates blocked by validateMemoryWrite (warn OR critical — Pitfall 2). */
  blocked: number;
  /** Candidates skipped because they exceeded maxEntriesPerRun. */
  skippedOverCap: number;
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

  const emit = (): void => {
    eventBus?.emit("memory:user_representation_built", {
      agentId,
      built,
      written,
      blocked,
      skippedOverCap,
      durationMs: clock.now() - startMs,
      timestamp: clock.now(),
    });
  };

  const stats = (): MemoryUserRepresentationStats => ({ built, written, blocked, skippedOverCap });

  // T-107-03-04: the DEFAULT-OFF cost gate. No build() call, no write, no spend.
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

  // 2. ANTI-POISONING EXCLUDE (USER-02, T-107-03-01): drop `external`-trust sources
  //    UNCONDITIONALLY, BEFORE the build — there is no `reasonExternal` escape hatch
  //    for USER. An `external` claim can NEVER enter the profile. The build seam
  //    never sees the excluded content.
  const sources = allSources.filter((s) => s.trustLevel !== "external");

  if (sources.length === 0) {
    emit();
    return ok(stats());
  }

  // 3. The source-trust ceiling, computed in CODE over the SURVIVING sources
  //    (T-107-03-03). All survivors are high-trust (external already excluded), so
  //    the ceiling is the floor of the survivors — a system+learned mix yields
  //    `learned`; the writer can never raise trust above its sources, and the LLM
  //    has no say (the parser stripped any trust field).
  let sourceTrust: UserRepresentationTrust = "system";
  for (const s of sources) {
    // s.trustLevel is one of system|learned here (external filtered out above).
    sourceTrust = minTrust(sourceTrust, s.trustLevel as UserRepresentationTrust);
  }

  // 4. The INJECTED offline build() seam over the surviving source text. Non-fatal:
  //    a thrown/aborted build → WARN + return ok with nothing written
  //    (mirrors reasoning-job.ts:407-420).
  const sourceText = sources.map((s) => `- ${s.content}`).join("\n");
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

  // 5. IDEMPOTENCY (USER-02, analog #10b): a re-run over unchanged sources must
  //    write 0 new. Read the current profile once and dedup candidates against the
  //    EXISTING `(entryType, content)` set — re-distilling the same sources yields
  //    the same candidates, which are already present, so they are skipped. The
  //    dedup keys on the CONTENT set (not a global "ran once" flag), so a NEW source
  //    that yields a NEW candidate still writes. The adapter's own
  //    upsert-replace-per-(scope, entryType, content) is the second belt; this read
  //    keeps `written` honest (0 new on a no-op re-run). The read is non-fatal: a
  //    failed read degrades to "dedup nothing" (the adapter upsert still de-dups).
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
        hint: "profile pre-read for idempotency failed — falling back to the adapter's upsert de-dup",
      },
      "User representation idempotency pre-read failed (non-fatal)",
    );
  }

  for (const candidate of candidates) {
    // The bounded run (T-107-03-04): count the overflow for observability, then stop
    // writing once the cap is reached (the DoS cost bound, mirrors reasoning-job.ts:391).
    if (written >= config.maxEntriesPerRun) {
      skippedOverCap++;
      continue;
    }

    // Idempotency skip: a candidate already in the profile (same entryType +
    // content) is a no-op re-distillation — do NOT re-write it (keeps `written`
    // at 0 on an unchanged re-run). NOT counted as blocked (it is not a rejection).
    if (existingKeys.has(`${candidate.entryType}::${candidate.content}`)) {
      continue;
    }

    // T-107-03-02 / Pitfall 2: the redaction firewall on the LLM-produced content
    // (the secret-egress guard runs FIRST). For USER there is no `external` tier to
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

    // Trust is CODE-computed at the source ceiling (T-107-03-03) — NEVER from the
    // LLM, NEVER `external`. `sourceMemoryId` is omitted: a profile entry is
    // distilled from the FUSED source set, not a single message (provenance to a
    // single id would be misleading; the table column is optional).
    const entry: UserRepresentationInput = {
      entryType: candidate.entryType,
      content: candidate.content,
      trust: sourceTrust,
    };

    // The non-fatal write (mirrors reasoning-job.ts:462). The adapter filters every
    // statement on `(tenantId, agentId, userId)`; the upsert is idempotent per
    // (scope, entryType, content). A rejecting/erroring store → WARN + continue.
    const upserted = await fromPromise(
      userRepresentationStore.upsert(entry, { tenantId, agentId, userId, now }),
    );
    if (!upserted.ok || !upserted.value.ok) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          step: "user-repr" as const,
          hint: "userRepresentationStore.upsert failed/rejected — candidate skipped, run continues",
        },
        "Failed to upsert representation entry (non-fatal)",
      );
      continue;
    }
    written++;
    // Same-run dedup: a later identical candidate is now "existing" → not re-written.
    existingKeys.add(`${candidate.entryType}::${candidate.content}`);
  }

  logger.info(
    { agentId, step: "user-repr" as const, ...stats(), durationMs: clock.now() - startMs },
    "User representation build completed",
  );
  emit();
  return ok(stats());
}

// Re-exported so the daemon's seam (107-05) can import the parser alongside the
// job from a single agent-internal home (mirrors the reasoning-job/seam split).
export { parseUserRepresentationOutput };
