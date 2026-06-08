// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `obs.explain` traceId → sessionKey canonicalization (the X1 identity seam).
 *
 * `obs.explain` accepts EITHER a `sessionKey` OR a `traceId`. So a single
 * assembler path runs for both inputs — identity is structural, not two
 * parallel code paths — the by-`traceId` input is resolved to its canonical
 * `sessionKey` FIRST, then the rest of the handler operates on that one key.
 *
 * The resolution reuses the obs-trace day-keyed session-index scan
 * (`<dataDir>/logs/session-index.YYYY-MM-DD.jsonl`, today + yesterday,
 * soft-fail on missing/corrupt files). The 678 fixture is a multi-turn
 * session whose TWO traceIds both index the ONE sessionKey — either traceId
 * resolves to the same canonical key.
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { safePath, systemDateFrom, systemNowMs } from "@comis/core";

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
 *   `synthetic === true` (D9 test/harness sessions) are skipped, so a synthetic
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
      if (rec.synthetic === true && !includeSynthetic) continue; // D9 default-exclude
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
