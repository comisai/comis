// SPDX-License-Identifier: Apache-2.0
/**
 * Shared local-model cache seeding for the integration / e2e / live test tiers.
 *
 * WHY THIS EXISTS
 * ---------------
 * Each test daemon boots on its own throwaway dataDir (see the D14
 * single-instance-lock rationale in `daemon-harness.ts`). The daemon resolves
 * its local embedding/reranker models dir as `<dataDir>/models` (Zod default
 * `embedding.local.modelsDir = "models"`, resolved via `safePath(dataDir,
 * "models")`). Because every fork gets a fresh `mkdtempSync` dataDir, every
 * test daemon with local embedding enabled re-downloads the ~139 MB
 * `nomic-embed-text-v1.5` GGUF (and, when the reranker auto-ons, the ~606 MB
 * `bge-reranker-v2-m3` GGUF) from Hugging Face into that temp dir.
 *
 * On a developer machine that is fatal in two ways:
 *   1. Disk: 30+ parallel test daemons each writing a 139 MB model into temp
 *      exhausts the volume → `ENOSPC` cascades that fail hundreds of files.
 *   2. Latency: a cold 139 MB download over a ~2-3 MB/s link takes ~50-60 s —
 *      right at the suite's 60 s `hookTimeout`, so daemon `beforeAll` boots
 *      intermittently time out (observed: `gateway-auth` / `tool-link` files
 *      timing out at exactly 60003 ms while the model downloaded).
 *
 * THE FIX
 * -------
 * If the developer already has the models cached in the real data dir
 * (`~/.comis/models`, populated by any prior real daemon run), hard-link those
 * `.gguf` files into the test daemon's `<dataDir>/models`. The daemon's model
 * resolver then finds the file already present and skips the download entirely
 * — boots drop from ~60 s to ~1-3 s and consume zero extra disk (a hard link
 * shares the inode; temp dir and `~/.comis` are on the same volume).
 *
 * WHY HARD LINKS, NOT A SYMLINK
 * -----------------------------
 * `safePath()` (the daemon's path guard) walks each component of
 * `<dataDir>/models` and throws `PathTraversalError` if any component is a
 * symlink whose realpath escapes the dataDir. A symlinked `models` dir → an
 * external cache would therefore be rejected and break embedding setup. Hard
 * links are ordinary directory entries (not symlinks), so they pass the guard
 * while still pointing at the cached inode.
 *
 * CI / FRESH MACHINES
 * -------------------
 * Best-effort and gated on the cache existing: when `~/.comis/models` is
 * absent (CI runners, fresh contributor checkouts) this is a no-op and the
 * daemon downloads as before. A cross-device or permission error on any single
 * link is swallowed so the daemon falls back to downloading that model. This
 * only ever speeds tests up — it never changes which models a daemon resolves.
 *
 * @module
 */
import { existsSync, mkdirSync, readdirSync, linkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Hard-link any cached `*.gguf` models from `~/.comis/models` into
 * `<dataDir>/models` so a test daemon booted on `dataDir` reuses them instead
 * of re-downloading. No-op when the shared cache does not exist. Best-effort:
 * never throws.
 *
 * @param dataDir Absolute path to a test daemon's throwaway data dir.
 */
export function seedModelCache(dataDir: string): void {
  try {
    const cacheDir = join(homedir(), ".comis", "models");
    if (!existsSync(cacheDir)) return; // CI / fresh machine — download as normal.

    const destDir = join(dataDir, "models");
    mkdirSync(destDir, { recursive: true });

    for (const name of readdirSync(cacheDir)) {
      // Only seed completed models; skip `.ipull` partial-download artifacts.
      if (!name.endsWith(".gguf")) continue;
      const dest = join(destDir, name);
      if (existsSync(dest)) continue;
      try {
        linkSync(join(cacheDir, name), dest);
      } catch {
        // Cross-device link / perms — let the daemon download this one model.
      }
    }
  } catch {
    // Cache unreadable / temp dir vanished — best-effort, daemon downloads.
  }
}
