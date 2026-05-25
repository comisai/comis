// SPDX-License-Identifier: Apache-2.0
/**
 * Append-only session index writer (INDEX-01).
 *
 * Writes session lifecycle events to
 * `<dataDir>/logs/session-index.YYYY-MM-DD.jsonl` — one JSONL record
 * per line, date-rolled at midnight UTC.
 *
 * Writer registry is module-private (a top-level `Map<string, QueuedFileWriter>`)
 * so concurrent emit sites (session_started, turn_completed, session_ended) all
 * share a single writer per file-path without cross-call leakage.
 *
 * Security properties (T-06-01-01):
 *   - File path is derived ONLY from `new Date().toISOString().slice(0,10)` —
 *     no user-controlled fields are used in the path (T-06-01-04).
 *   - `confinedBaseDir: dataDir` ensures the writer stays inside dataDir for
 *     both production (`~/.comis`) and test (os.tmpdir() subtree) contexts.
 *   - QueuedFileWriter delegates to appendRegularFile which enforces
 *     O_NOFOLLOW + fchmod 0o600 (T-06-01-01).
 *   - `maxQueuedBytes: 1MB` caps in-flight bytes; write() returns "dropped"
 *     under traffic spikes rather than blocking the event loop (T-06-01-03).
 *
 * @module
 */

import { systemDateFrom, systemNowMs, safePath } from "@comis/core";
import {
  getQueuedFileWriter,
  type QueuedFileWriter,
  type QueuedFileWriteResult,
} from "../shared/queued-file-writer.js";
import type { SessionIndexEvent } from "./types.js";

// Module-private writer registry. Key = absolute file path (includes date).
// A new day automatically creates a new entry (old entry stays in the registry
// and can be evicted by the GC eventually — the Map holds the sole reference).
const writers = new Map<string, QueuedFileWriter>();

/**
 * Append one session index event to the date-rolled JSONL file.
 *
 * The file path is `<dataDir>/logs/session-index.YYYY-MM-DD.jsonl`
 * where YYYY-MM-DD is the current UTC date at write time. A midnight
 * UTC clock advancement automatically switches to a new file.
 *
 * The `confinedBaseDir` is set to `dataDir` so:
 * - In production: `~/.comis/logs/...` is inside `~/.comis` (= dataDir)
 * - In tests: `<tmpdir>/logs/...` is inside `<tmpdir>` (= dataDir)
 *
 * @param dataDir - Comis data root (e.g. `~/.comis` in production)
 * @param record  - Typed session index event (discriminated union)
 * @returns "queued" when the line was accepted, "dropped" when the
 *          in-flight buffer cap would be exceeded
 */
export function appendSessionIndexEntry(
  dataDir: string,
  record: SessionIndexEvent,
): QueuedFileWriteResult {
  const date = systemDateFrom(systemNowMs()).toISOString().slice(0, 10); // "YYYY-MM-DD"
  // safePath composition per AGENTS.md §2.2: each dynamic segment goes through safePath.
  // "logs" and the filename are literal/date-only (no user input) — safePath is belt-and-suspenders here.
  const logsDir = safePath(dataDir, "logs");
  const filePath = safePath(logsDir, `session-index.${date}.jsonl`);
  const writer = getQueuedFileWriter(writers, filePath, {
    maxQueuedBytes: 1 * 1024 * 1024, // 1 MB in-flight cap (T-06-01-03)
    confinedBaseDir: dataDir,         // Confinement to dataDir (T-06-01-01)
  });
  return writer.write(JSON.stringify(record) + "\n");
}
