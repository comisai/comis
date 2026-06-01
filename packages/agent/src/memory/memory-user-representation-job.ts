// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user representation offline builder job (Phase 107 — USER-02).
 *
 * NOTE (Task 1 scaffold): this file currently exports only the deps/config/stats
 * TYPES + a placeholder handler so the prompt/parser unit lands first (Task 1).
 * The full builder — gate → read → exclude-external → bound → build seam →
 * validateMemoryWrite (skip non-clean) → upsert → counts-only event → idempotent —
 * is implemented in Task 2 + Task 3.
 *
 * @module
 */

import { ok, type Result } from "@comis/shared";
import type {
  UserRepresentationStore,
  UserRepresentationTrust,
  ClockPort,
  ComisLogger,
} from "@comis/core";
import type { UserRepresentationBuildOutput } from "./memory-user-representation-prompt.js";

/**
 * One high-trust source memory the builder distills the profile from. The builder
 * reads these via the INJECTED `readSources` seam (so the job stays
 * `@comis/memory`-free — the agent↛memory build cut); the daemon (107-05) wires a
 * scoped `memories` read. `trustLevel` is the FULL ladder (`system`/`learned`/
 * `external`) so the job can EXCLUDE `external` before the build (anti-poisoning).
 */
export interface UserRepresentationSourceMemory {
  /** The source memory id (provenance + the idempotency key set). */
  id: string;
  /** The source text the build seam distills (untrusted). */
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
   * `(tenantId, agentId, userId)`. Abstracted so the job stays `@comis/memory`-free.
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

// Used to silence "value never read" while the trust ceiling is computed in Task 2.
const _DEFAULT_TRUST: UserRepresentationTrust = "learned";
void _DEFAULT_TRUST;

/**
 * Run one offline representation-build pass for a single (tenant, agent, user).
 *
 * NOTE: placeholder body (Task 1 scaffold) — implemented in Task 2 + Task 3.
 */
export async function runUserRepresentationBuild(
  _deps: MemoryUserRepresentationDeps,
): Promise<MemoryUserRepresentationResult> {
  return ok({ built: 0, written: 0, blocked: 0, skippedOverCap: 0 });
}
