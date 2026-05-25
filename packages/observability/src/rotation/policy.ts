// SPDX-License-Identifier: Apache-2.0
/**
 * Rotation policy helpers.
 *
 * `applyRotationPolicy` handles one already-rotated file set: gzip if
 * `compressAged` and not yet `.gz`, unlink if older than `maxAgeDays`,
 * unlink if the per-base-file count exceeds `maxFiles`.
 *
 * The active (base) file is NEVER touched — only `.N`-numbered or
 * already-rotated artifacts. Symlinks are skipped (lstat gate).
 *
 * @module
 */

import * as fs from "node:fs/promises";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { ComisLogger } from "@comis/core";
import { systemNowMs } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cross-stream rotation policy.
 *
 * Matches `LogRotationConfig` from `@comis/core` schema-observability.ts.
 * The interface is duplicated here so `@comis/observability` does not need
 * to import the Zod schema at runtime.
 */
export interface RotationPolicy {
  readonly maxSizeBytes: number;
  readonly maxFiles: number;
  readonly maxAgeDays: number;
  readonly compressAged: boolean;
}

export interface ApplyRotationDeps {
  readonly logger?: Pick<ComisLogger, "warn"> & { debug?: (...args: unknown[]) => void };
  /** Override "now" for deterministic age-prune tests. */
  readonly nowMs?: () => number;
}

export interface ApplyRotationInput {
  /** Base file path (e.g. "/home/user/.comis/logs/daemon.log") — NEVER touched. */
  readonly basePath: string;
  /**
   * All rotated siblings of basePath
   * (e.g. ["/home/user/.comis/logs/daemon.1.log", "daemon.2.log.gz"]).
   */
  readonly rotatedFiles: ReadonlyArray<string>;
  readonly policy: RotationPolicy;
}

export interface ApplyRotationResult {
  gzipped: number;
  unlinkedByAge: number;
  unlinkedByCount: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Apply gzip + age-prune + count-prune to one base file's rotation set.
 *
 * Steps:
 *   1. Gzip uncompressed `.N` files (if `compressAged`; skip base; skip already `.gz`).
 *   2. Prune files older than `maxAgeDays` (by mtime).
 *   3. Prune files beyond `maxFiles` count (oldest-first by mtime).
 *
 * All steps are best-effort; per-file errors are logged at WARN with
 * `errorKind:"internal"` and do not abort remaining files.
 *
 * Returns counts of gzipped, age-pruned, and count-pruned files.
 */
export async function applyRotationPolicy(
  input: ApplyRotationInput,
  deps: ApplyRotationDeps = {},
): Promise<ApplyRotationResult> {
  const now = deps.nowMs?.() ?? systemNowMs();
  const ageCutoffMs = now - input.policy.maxAgeDays * 86_400_000;

  // Stat all candidate files (lstat to skip symlinks).
  const statResults = await Promise.all(
    input.rotatedFiles.map(async (p) => {
      try {
        const st = await fs.lstat(p);
        if (st.isSymbolicLink()) return null; // symlink-safe: skip
        return { path: p, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  // present = non-null stat results with mutable path (updated after gzip rename).
  const present: Array<{ path: string; mtimeMs: number }> = statResults
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s) => ({ ...s }));

  // ── Step 1: Gzip uncompressed .N files ──────────────────────────────────
  let gzipped = 0;
  if (input.policy.compressAged) {
    for (const entry of present) {
      if (entry.path === input.basePath) continue; // never touch the active base
      if (entry.path.endsWith(".gz")) continue;    // already compressed
      const gzPath = entry.path + ".gz";
      try {
        await pipeline(
          createReadStream(entry.path),
          createGzip(),
          createWriteStream(gzPath),
        );
        await fs.unlink(entry.path);
        entry.path = gzPath; // update for subsequent steps
        gzipped++;
      } catch (err) {
        deps.logger?.warn(
          {
            err,
            file: entry.path,
            errorKind: "internal" as const,
            hint: "Log rotation gzip failed; check disk space and permissions. See observability.logRotation.",
          },
          "rotation:gzip_failed",
        );
      }
    }
  }

  // ── Step 2: Prune by age ─────────────────────────────────────────────────
  let unlinkedByAge = 0;
  const survivors: typeof present = [];
  for (const entry of present) {
    if (entry.path === input.basePath) {
      survivors.push(entry);
      continue;
    }
    if (entry.mtimeMs < ageCutoffMs) {
      try {
        await fs.unlink(entry.path);
        unlinkedByAge++;
      } catch (err) {
        deps.logger?.warn(
          {
            err,
            file: entry.path,
            errorKind: "internal" as const,
            hint: "Log rotation age-prune failed. See observability.logRotation.",
          },
          "rotation:age_prune_failed",
        );
        survivors.push(entry); // keep in survivors so count-prune can handle it
      }
    } else {
      survivors.push(entry);
    }
  }

  // ── Step 3: Prune by count (oldest-first by mtime, keep maxFiles) ────────
  let unlinkedByCount = 0;
  const nonBase = survivors.filter((e) => e.path !== input.basePath);
  if (nonBase.length > input.policy.maxFiles) {
    nonBase.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    const toDelete = nonBase.slice(0, nonBase.length - input.policy.maxFiles);
    for (const entry of toDelete) {
      try {
        await fs.unlink(entry.path);
        unlinkedByCount++;
      } catch (err) {
        deps.logger?.warn(
          {
            err,
            file: entry.path,
            errorKind: "internal" as const,
            hint: "Log rotation count-prune failed. See observability.logRotation.",
          },
          "rotation:count_prune_failed",
        );
      }
    }
  }

  return { gzipped, unlinkedByAge, unlinkedByCount };
}
