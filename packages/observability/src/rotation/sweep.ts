// SPDX-License-Identifier: Apache-2.0
/**
 * Per-stream rotation sweep.
 *
 * Iterates the 5 observability streams and applies the rotation
 * policy to each. Called at daemon startup (post-invariant-emit) and
 * may be called after a stream's own rename-shift step (config-audit).
 *
 * Stream catalog:
 *   1. daemon.log              — pino-roll size-roll → daemon.N.log
 *   2. cache-trace.jsonl       — in-file cap; sweep prunes accumulated history
 *   3. config-audit.jsonl      — rename-shift in append.ts; sweep gzips + age-prunes
 *   4. session-index.YYYY-MM-DD.jsonl — date-roll; sweep prunes old days
 *   5. *.trajectory.jsonl      — per-session files; sweep prunes old sessions
 *
 * @module
 */

import * as fs from "node:fs/promises";
import type { ComisLogger } from "@comis/core";
import { safePath, systemDateFrom, systemNowMs } from "@comis/core";
import { applyRotationPolicy, type RotationPolicy } from "./policy.js";

// ---------------------------------------------------------------------------
// Stream patterns
// ---------------------------------------------------------------------------

/**
 * Closed list of stream patterns the sweep handles.
 * Each entry has:
 *   - `label`           — human-readable stream name
 *   - `basePattern`     — regex matching the active (non-rotated) base file
 *   - `rotatedPattern`  — regex matching rotated siblings (may overlap basePattern for date-rolled streams)
 *
 * For date-rolled streams (session-index), `basePattern` matches ALL dated
 * files including today's; the sweep identifies today's file separately and
 * excludes it from the rotated set.
 *
 * For trajectory files, `basePattern` is empty (no single active base file).
 */
export const ROTATION_STREAM_PATTERNS: ReadonlyArray<{
  readonly label: string;
  readonly basePattern: RegExp;
  readonly rotatedPattern: RegExp;
  /**
   * Issue 5 (small-model e2e 2026-06-12): true when the stream's LIVE writer
   * always uses an INDEXED filename (pino-roll never writes the bare base —
   * its active file is the highest-index `daemon.N.log` from the very first
   * boot). For such streams the newest uncompressed indexed file must be
   * protected from the sweep UNCONDITIONALLY: a stale (often 0-byte) base
   * file in the dir says nothing about liveness, and keying the protection
   * on base ABSENCE let every daemon startup gzip+unlink the just-opened
   * live file while the daemon held its fd — the process kept appending to
   * the unlinked inode and the on-disk history was lost.
   */
  readonly liveFileCarriesIndex?: true;
}> = [
  // daemon.log / daemon.1.log / daemon.1.log.gz — pino-roll stream: the live
  // file is ALWAYS indexed (see liveFileCarriesIndex).
  {
    label: "daemon.log",
    basePattern: /^daemon\.log$/,
    rotatedPattern: /^daemon\.\d+\.log(\.gz)?$/,
    liveFileCarriesIndex: true,
  },
  // cache-trace.jsonl / cache-trace.1.jsonl / cache-trace.1.jsonl.gz
  {
    label: "cache-trace.jsonl",
    basePattern: /^cache-trace\.jsonl$/,
    rotatedPattern: /^cache-trace\.\d+\.jsonl(\.gz)?$/,
  },
  // config-audit.jsonl / config-audit.jsonl.1 / config-audit.jsonl.1.gz
  {
    label: "config-audit.jsonl",
    basePattern: /^config-audit\.jsonl$/,
    rotatedPattern: /^config-audit\.jsonl\.\d+(\.gz)?$/,
  },
  // session-index.YYYY-MM-DD.jsonl — every dated file; today's is the "base"
  {
    label: "session-index.YYYY-MM-DD.jsonl",
    basePattern: /^session-index\.\d{4}-\d{2}-\d{2}\.jsonl$/,
    rotatedPattern: /^session-index\.\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/,
  },
  // *.trajectory.jsonl — per-session files; no single active base
  {
    label: "*.trajectory.jsonl",
    basePattern: /^$/, // no single active base
    rotatedPattern: /\.trajectory\.jsonl(\.gz)?$/,
  },
];

// ---------------------------------------------------------------------------
// Sweep deps + function
// ---------------------------------------------------------------------------

export interface SweepDeps {
  readonly logger?: Pick<ComisLogger, "warn"> & { debug?: (...args: unknown[]) => void };
  readonly nowMs?: () => number;
}

/**
 * Sweep all configured rotation patterns under `logsDir`.
 *
 * Best-effort — per-file errors are logged at WARN and do not abort
 * the sweep. If `logsDir` does not exist, a DEBUG is emitted and the
 * function returns without error.
 *
 * Called at daemon startup after `emitStartupInvariants` (post-invariant-emit).
 */
export async function sweepRotatedFiles(
  logsDir: string,
  policy: RotationPolicy,
  deps: SweepDeps = {},
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(logsDir);
  } catch (err) {
    deps.logger?.debug?.(
      { err, logsDir },
      "rotation:sweep skipped (logsDir not readable or not present)",
    );
    return;
  }

  for (const stream of ROTATION_STREAM_PATTERNS) {
    const hasBase = stream.basePattern.source !== "^$";

    // For date-rolled session-index: "active base" = today's file (if present).
    // For trajectory (no base): basePath sentinel is used by applyRotationPolicy
    // but the file at that path won't exist, so it's never touched.
    // For all other streams: active base = the single non-numbered base file.
    let activeBase: string | undefined;
    if (!hasBase) {
      // trajectory — no active base file
      activeBase = undefined;
    } else if (stream.label.startsWith("session-index")) {
      // For date-rolled streams: protect only today's dated file.
      activeBase = entries.find((n) => stream.basePattern.test(n) && isTodayDate(n));
    } else {
      // Standard streams: the base file matches the base pattern directly.
      activeBase = entries.find((n) => stream.basePattern.test(n));
    }

    // Collect rotated files: matches rotatedPattern and is not the active base.
    let rotated = entries.filter(
      (n) => stream.rotatedPattern.test(n) && n !== activeBase,
    );

    // Live-file protection: when the stream's active file carries a numeric
    // index, the most-recently-modified UNCOMPRESSED rotated-pattern file IS
    // (or may be) the live file — exclude it from the sweep to prevent
    // gzip+unlink of an open inode. Two triggers:
    //  - `liveFileCarriesIndex` streams (pino-roll: daemon.log): ALWAYS — the
    //    live file is indexed from the first boot, so a (stale, often 0-byte)
    //    base file in the dir is no evidence the indexed files are rotated
    //    (Issue 5: the base-absence-only guard let every startup gzip the
    //    just-opened daemon.N.log out from under the daemon's open fd).
    //  - other base-writing streams: only when the base file is absent (the
    //    original guard, unchanged — their live writer is the base file).
    // Only UNCOMPRESSED files are live candidates: a `.gz` is never a live
    // writer, and letting one win the newest-mtime race would leave the real
    // live file unprotected.
    const protectNewestIndexed =
      hasBase &&
      !stream.label.startsWith("session-index") &&
      (stream.liveFileCarriesIndex === true || activeBase === undefined);
    if (protectNewestIndexed && rotated.length > 0) {
      const liveCandidates = rotated.filter((n) => !n.endsWith(".gz"));
      if (liveCandidates.length > 0) {
        const mtimes = await Promise.all(
          liveCandidates.map(async (name) => {
            try {
              const statPath = safePath(logsDir, name);
              const st = await fs.stat(statPath);
              return { name, mtimeMs: st.mtimeMs };
            } catch {
              return { name, mtimeMs: 0 };
            }
          }),
        );
        const newestName = mtimes.reduce((a, b) => (a.mtimeMs >= b.mtimeMs ? a : b)).name;
        rotated = rotated.filter((n) => n !== newestName);
      }
    }

    if (rotated.length === 0) continue;

    // Use a sentinel basePath that won't exist when there is no real base.
    // safePath(base, segment) ensures segments stay within the logsDir boundary.
    const basePath = activeBase
      ? safePath(logsDir, activeBase)
      : safePath(logsDir, "__no-active-base__");

    // safePath throws PathTraversalError for symlinks that escape logsDir.
    // Filter out any entries that throw — they are silently skipped (symlink-safe).
    const rotatedAbs: string[] = [];
    for (const n of rotated) {
      try {
        rotatedAbs.push(safePath(logsDir, n));
      } catch {
        // PathTraversalError or other — skip this entry (symlink escape blocked)
      }
    }

    await applyRotationPolicy(
      { basePath, rotatedFiles: rotatedAbs, policy },
      { logger: deps.logger, nowMs: deps.nowMs },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTodayDate(filename: string): boolean {
  const m = filename.match(/session-index\.(\d{4}-\d{2}-\d{2})\.jsonl$/);
  if (!m) return false;
  // systemDateFrom + systemNowMs are the sanctioned-root date/time helpers.
  const today = systemDateFrom(systemNowMs()).toISOString().slice(0, 10);
  return m[1] === today;
}
