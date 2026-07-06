// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded, TTL'd on-disk cache of well-known skill-index metadata.
 *
 * A resolver fetches a registry's `/.well-known/skills/index.json`, then
 * fetches each advertised file. This cache stores ONLY the index metadata —
 * each skill's `name` and advertised rel-path list — so a repeat import within
 * the TTL can skip re-fetching the index. It NEVER caches file bodies: every
 * file is re-fetched, re-scanned, and re-hash-pinned on each import, so a cache
 * hit can only save the index round-trip, never substitute content.
 *
 * On-disk shape: one JSON file per origin under a `0o700` dir, written `0o600`
 * via a tmp-file + atomic rename, read through a schema (a corrupt or
 * shape-invalid file is a miss, never trusted), TTL-checked against an injected
 * clock, and bounded by entry count (the oldest files are evicted once the cap
 * is exceeded).
 *
 * The caller passes an already-normalized/hashed `originKey`; the cache never
 * builds a path from a raw URL, and `safePath` contains every entry file to the
 * cache dir regardless of the key.
 *
 * @module
 */

import { safePath, systemNowMs } from "@comis/core";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { z } from "zod";

/** Fixed 15-minute freshness window for a cached index. */
const DEFAULT_TTL_MS = 900_000;
/** Default upper bound on cached origins (oldest evicted beyond it). */
const DEFAULT_MAX_ENTRIES = 64;

/** One cached skill entry — its name and advertised rel-paths, never a body. */
export interface CachedIndexEntry {
  readonly name: string;
  readonly files?: readonly string[];
}

/** A names-and-paths index cache keyed by a normalized origin key. */
export interface SkillIndexCache {
  /** TTL-checked read; a miss (absent / expired / corrupt) returns undefined. */
  get(originKey: string): readonly CachedIndexEntry[] | undefined;
  /** Persist the index metadata for an origin (names + rel-paths only). */
  put(originKey: string, entries: readonly CachedIndexEntry[]): void;
}

/** Per-skill entry schema — required name, optional rel-path list. */
const CachedIndexEntrySchema = z.object({
  name: z.string().min(1),
  files: z.array(z.string()).optional(),
});

/** On-disk cache-file schema — validated at read time before it is trusted. */
const CacheFileSchema = z.object({
  fetchedAt: z.number().int().nonnegative(),
  skills: z.array(CachedIndexEntrySchema),
});

/**
 * Create a bounded, TTL'd names-and-paths index cache rooted at `cacheDir`.
 * `ttlMs` defaults to 15 minutes, `maxEntries` to 64, and `now` to the system
 * clock (injectable for deterministic tests).
 */
export function createSkillIndexCache(opts: {
  cacheDir: string;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}): SkillIndexCache {
  const cacheDir = opts.cacheDir;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = opts.now ?? systemNowMs;

  // Read a cache file's fetchedAt for eviction ordering. An unreadable or
  // shape-invalid file folds to 0 (treated as oldest → evicted first), which
  // also self-heals a corrupt cache dir.
  const readFetchedAt = (filePath: string): number => {
    try {
      const parsed = CacheFileSchema.safeParse(JSON.parse(readFileSync(filePath, "utf-8")));
      return parsed.success ? parsed.data.fetchedAt : 0;
    } catch {
      return 0;
    }
  };

  // Drop the oldest files once the dir holds more than maxEntries.
  const evictOverflow = (): void => {
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    if (files.length <= maxEntries) return;
    const byAge = files
      .map((f) => {
        const path = safePath(cacheDir, f);
        return { path, fetchedAt: readFetchedAt(path) };
      })
      .sort((a, b) => a.fetchedAt - b.fetchedAt);
    for (const victim of byAge.slice(0, files.length - maxEntries)) {
      unlinkSync(victim.path);
    }
  };

  return {
    get(originKey: string): readonly CachedIndexEntry[] | undefined {
      try {
        const cachePath = safePath(cacheDir, `${originKey}.json`);
        if (!existsSync(cachePath)) return undefined;
        const parsed = CacheFileSchema.safeParse(JSON.parse(readFileSync(cachePath, "utf-8")));
        if (parsed.success && now() - parsed.data.fetchedAt < ttlMs) {
          return parsed.data.skills;
        }
      } catch {
        // Corrupt cache / stat race / unsafe key — treat as a miss.
      }
      return undefined;
    },

    put(originKey: string, entries: readonly CachedIndexEntry[]): void {
      // Persist names + rel-paths ONLY — never a body, even if a caller hands
      // over an entry that carries extra fields.
      const skills = entries.map((e) => ({
        name: e.name,
        ...(e.files !== undefined && { files: [...e.files] }),
      }));
      const payload = JSON.stringify({ fetchedAt: now(), skills });
      try {
        mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        chmodSync(cacheDir, 0o700);
        const cachePath = safePath(cacheDir, `${originKey}.json`);
        const tmpPath = `${cachePath}.tmp.${process.pid}`;
        writeFileSync(tmpPath, payload, { mode: 0o600 });
        renameSync(tmpPath, cachePath);
        evictOverflow();
      } catch {
        // Best-effort cache: a write/evict failure must not break an otherwise
        // successful import — the entry is simply not cached and re-fetched.
      }
    },
  };
}
