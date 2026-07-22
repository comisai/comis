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
 * Resolution reuses the day-keyed session index
 * (`<dataDir>/logs/session-index.YYYY-MM-DD.jsonl`, today + yesterday) and
 * soft-fails on missing or corrupt files. Root resolution has three honest
 * sources: a session-root prefix, a cron execution trace entry, or a
 * capability-audited spawn record. Every source yields the same canonical key;
 * unresolved references return `""` and never fabricate a session.
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
 * Resolve a governed `rootRunId` to its canonical `sessionKey`, so every
 * `obs.explain` identity enters one assembler path. Three honest sources, in order:
 *
 *   1. **Session root (pure, no I/O):** `root-session-<canonicalKey>` embeds the
 *      canonical session key directly, so stripping only that prefix resolves it.
 *
 *   2. **Cron root:** the scheduler mints `root-cron-<executionId>` and the model
 *      bridge indexes that occurrence with `traceId === executionId`. Strip only
 *      the cron prefix and delegate to {@link resolveTraceToSession}.
 *
 *   3. **Capability-audited root:** scan the same day-keyed session index for a
 *      `capability.audited` record whose `rootRunId` matches, and return its
 *      nonempty `runId`. Canonical records nest both identifiers under `data`;
 *      flat records remain readable when present.
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
 * @param rootRunId - the governed root identifier to canonicalize.
 * @param _durableRuns - durable-run dependency; current resolution authorities
 *   are the embedded session root and the session index.
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
  const SESSION_ROOT_PREFIX = "root-session-";
  if (rootRunId.startsWith(SESSION_ROOT_PREFIX)) {
    return rootRunId.slice(SESSION_ROOT_PREFIX.length);
  }

  // Source 2 (cron root): the execution id is the indexed model trace id. Reuse
  // the canonical trace resolver so parsing, bounds, and soft-failure stay shared.
  const CRON_ROOT_PREFIX = "root-cron-";
  if (rootRunId.startsWith(CRON_ROOT_PREFIX)) {
    const executionId = rootRunId.slice(CRON_ROOT_PREFIX.length);
    if (executionId.length > 0) {
      const sessionKey = await resolveTraceToSession(dataDir, executionId);
      if (sessionKey.length > 0) return sessionKey;
    }
  }

  // Source 3 (capability-audited root): scan the day-keyed session index for a
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
