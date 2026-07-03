// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `obs.explain` ref → sessionKey canonicalization (the identity seam).
 *
 * `obs.explain` accepts ONE of a `sessionKey`, a `traceId`, OR a `rootRunId`.
 * So a single assembler path runs for all inputs — identity is
 * structural, not parallel code paths — the by-`traceId` and by-`rootRunId`
 * inputs are resolved to their canonical `sessionKey` FIRST, then the rest of
 * the handler operates on that one key.
 *
 * The resolution reuses the obs-trace day-keyed session-index scan
 * (`<dataDir>/logs/session-index.YYYY-MM-DD.jsonl`, today + yesterday,
 * soft-fail on missing/corrupt files). The 678 fixture is a multi-turn
 * session whose TWO traceIds both index the ONE sessionKey — either traceId
 * resolves to the same canonical key.
 *
 * The sibling {@link resolveRootRunToSession} canonicalizes an
 * autonomy run's `rootRunId` (the synthetic in-process root by a pure
 * prefix-strip; a real socket/spawned root by the same day-keyed scan, matching
 * a `capability.audited` record's `rootRunId` and returning its `runId`). Both
 * soft-fail to `""` — NEVER fabricate a sessionKey.
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { safePath, systemDateFrom, systemNowMs } from "@comis/core";
import type { DurableRunPort } from "@comis/core";

/** Default data directory (lazy — resolved at call time). Mirrors obs-trace.ts. */
function defaultDataDir(): string {
  return safePath(os.homedir(), ".comis");
}

// ---------------------------------------------------------------------------
// Date helpers: produce "YYYY-MM-DD" without new Date() (globals gate).
// ---------------------------------------------------------------------------

function todayKey(): string {
  return systemDateFrom(systemNowMs()).toISOString().slice(0, 10);
}

function yesterdayKey(): string {
  return systemDateFrom(systemNowMs() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Resolve a `traceId` to its canonical `sessionKey` by scanning the last two
 * days of session-index JSONL files. Returns the FIRST matching row's
 * `sessionKey` (falling back to its `sessionId` when the row predates the
 * `sessionKey` field). Returns `""` when no row matches OR the index files
 * are absent/corrupt — soft-fail, never throws on I/O.
 *
 * @param dataDir - data directory containing `logs/session-index.*.jsonl`.
 *   Defaults to `~/.comis` when an empty string is passed.
 * @param traceId - the trace identifier to canonicalize.
 * @param includeSynthetic - when `false` (the default), rows stamped
 *   `synthetic === true` (test/harness sessions) are skipped, so a synthetic
 *   row never canonicalizes a traceId for `obs.explain`. Pass `true` to resolve
 *   them (the admin opt-in).
 * @returns the canonical sessionKey, or `""` when unresolvable.
 */
export async function resolveTraceToSession(
  dataDir: string,
  traceId: string,
  includeSynthetic = false,
): Promise<string> {
  const base = dataDir.length > 0 ? dataDir : defaultDataDir();
  for (const dayKey of [yesterdayKey(), todayKey()]) {
    const logsDir = safePath(base, "logs");
    const file = safePath(logsDir, `session-index.${dayKey}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue; // Soft-fail: unreadable index file is non-fatal.
    }
    for (const line of content.split("\n")) {
      if (!line) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // Skip malformed JSONL lines per standard convention.
      }
      if (rec.synthetic === true && !includeSynthetic) continue; // test/harness rows excluded by default
      if (rec.traceId !== traceId) continue;
      // Canonical sessionKey is preferred; fall back to a sessionId-derived
      // key for rows that predate the sessionKey field.
      if (typeof rec.sessionKey === "string" && rec.sessionKey.length > 0) {
        return rec.sessionKey;
      }
      if (typeof rec.sessionId === "string" && rec.sessionId.length > 0) {
        return rec.sessionId;
      }
    }
  }
  return "";
}

/**
 * Resolve an autonomy run's `rootRunId` to its canonical `sessionKey`,
 * so the `fleet → explain` drill-down (paste the worst run's `rootRunId`) shares
 * the ONE assembler path with the by-sessionKey/by-traceId inputs. The sibling of
 * {@link resolveTraceToSession}. TWO honest sources, in order:
 *
 *   1. **Synthetic in-process root (the common case, PURE — no I/O):** a
 *      self-spawning top-level run with no real lease is anchored on a synthetic
 *      `root-session-<formattedKey>` root (`createRootRunIdResolver`,
 *      setup-capability-endpoint-boot.ts:101) where `<formattedKey>` IS the
 *      canonical sessionKey for the in-process leg. Strip the prefix to recover it.
 *
 *   2. **Real socket/spawned root:** scan the same day-keyed session-index for a
 *      `capability.audited` record whose `rootRunId` matches, and return its
 *      `runId` (≈ the sessionKey). The `capability.audited` record carries BOTH
 *      ids (events-orchestration.ts:90-104); the canonical trajectory-record shape
 *      nests them under `data` (the spawn-tree fold reads `data.rootRunId`,
 *      obs-explain-signal-folds.ts:337), so this reads `data.{rootRunId,runId}`
 *      first and tolerates a flat top-level shape as a fallback.
 *
 * Soft-fail to `""` when neither source resolves — NEVER fabricate a
 * sessionKey/leaseId. An empty return drives the
 * not-found marker in obs-explain.ts, so a typo'd `rootRunId` surfaces an honest
 * not-found verdict rather than a clean-looking empty report. The
 * session-index read is dataDir-scoped via `safePath` (no arbitrary-file read)
 * and uses `systemDateFrom(systemNowMs())` for day keys (no direct
 * wall-clock read — deterministic, the globals gate).
 *
 * @param dataDir - data directory containing `logs/session-index.*.jsonl`.
 *   Defaults to `~/.comis` when an empty string is passed.
 * @param rootRunId - the autonomy run's root id (synthetic `root-session-…` or a
 *   real socket/spawned root).
 * @param _durableRuns - RESERVED (optional): the two sources above need NO store,
 *   so this is unused today. It is accepted to keep the call-site signature stable
 *   for a possible future direct-store arm without a later signature churn.
 * @returns the canonical sessionKey, or `""` when unresolvable.
 */
export async function resolveRootRunToSession(
  dataDir: string,
  rootRunId: string,
  _durableRuns?: DurableRunPort,
): Promise<string> {
  // Source 1 (PURE, common case): a synthetic in-process root is
  // `root-session-<formattedKey>` — strip the prefix to recover the formattedKey,
  // which IS the canonical sessionKey for the in-process leg. No I/O.
  const PREFIX = "root-session-";
  if (rootRunId.startsWith(PREFIX)) return rootRunId.slice(PREFIX.length);

  // Source 2 (real socket/spawned root): scan the day-keyed session-index for a
  // capability.audited record whose rootRunId === arg, return its runId. Mirrors
  // resolveTraceToSession's [yesterdayKey(), todayKey()] loop + safePath read +
  // per-line JSONL parse + soft-fail.
  const base = dataDir.length > 0 ? dataDir : defaultDataDir();
  for (const dayKey of [yesterdayKey(), todayKey()]) {
    const logsDir = safePath(base, "logs");
    const file = safePath(logsDir, `session-index.${dayKey}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue; // Soft-fail: unreadable index file is non-fatal.
    }
    for (const line of content.split("\n")) {
      if (!line) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // Skip malformed JSONL lines per standard convention.
      }
      // The canonical capability.audited record nests its ids under `data` (the
      // shape the spawn-tree fold reads); tolerate a flat top-level shape too.
      const data =
        typeof rec.data === "object" && rec.data !== null
          ? (rec.data as Record<string, unknown>)
          : rec;
      const recRootRunId = typeof data.rootRunId === "string" ? data.rootRunId : rec.rootRunId;
      if (recRootRunId !== rootRunId) continue;
      const runId = typeof data.runId === "string" ? data.runId : rec.runId;
      if (typeof runId === "string" && runId.length > 0) return runId;
      // A matching root with no usable runId is not a resolution — keep scanning;
      // never fabricate a key.
    }
  }
  return ""; // unresolvable → the not-found marker fires in obs-explain.ts
}
