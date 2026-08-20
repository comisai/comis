// SPDX-License-Identifier: Apache-2.0
/**
 * Shared local-model cache seeding for the integration / e2e / live test tiers.
 *
 * WHY THIS EXISTS
 * ---------------
 * Each test daemon boots on its own throwaway dataDir (see the
 * single-instance-lock rationale in `daemon-harness.ts`). The daemon resolves
 * its local embedding/reranker models dir as `<dataDir>/models` (Zod default
 * `embedding.local.modelsDir = "models"`, resolved via `safePath(dataDir,
 * "models")`). Because every fork gets a fresh `mkdtempSync` dataDir, every
 * test daemon with local embedding enabled re-downloads the ~635 MB `bge-m3`
 * GGUF (and, when the reranker auto-ons, the ~606 MB
 * `bge-reranker-v2-m3` GGUF) from Hugging Face into that temp dir.
 *
 * On a developer machine that is fatal in two ways:
 *   1. Disk: 30+ parallel test daemons each writing a 635 MB model into temp
 *      exhausts the volume → `ENOSPC` cascades that fail hundreds of files.
 *   2. Latency: a cold model download can exceed the suite's 60 s
 *      `hookTimeout`, so daemon `beforeAll` boots intermittently time out.
 *
 * THE FIX
 * -------
 * If the developer already has the models cached in the real data dir
 * (`~/.comis/models`, populated by any prior real daemon run), seed those
 * `.gguf` files into the test daemon's `<dataDir>/models`. The daemon's model
 * resolver then finds the file already present and skips the download entirely.
 * Same-filesystem targets use a zero-copy hard link; cross-filesystem targets
 * (for example, a bind-mounted home cache feeding a container overlay) receive
 * a regular file copy.
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
 * Gated on the cache existing: when `~/.comis/models` is absent (CI runners,
 * fresh contributor checkouts) this is a no-op and the daemon downloads as
 * before. Seeding errors surface immediately; silently falling through would
 * make every worker download another model and hide the infrastructure fault
 * behind hook timeouts and disk exhaustion.
 *
 * @module
 */
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Seed cached `*.gguf` models from `~/.comis/models` into `<dataDir>/models`
 * so a test daemon booted on `dataDir` reuses them instead of re-downloading.
 * No-op when the shared cache does not exist. Uses hard links when possible and
 * copies only when the source and target are on different filesystems.
 *
 * @param dataDir Absolute path to a test daemon's throwaway data dir.
 */
export function seedModelCache(dataDir: string): void {
  const cacheDir = join(homedir(), ".comis", "models");
  if (!existsSync(cacheDir)) return; // CI / fresh machine — download as normal.

  const destDir = join(dataDir, "models");
  mkdirSync(destDir, { recursive: true });

  for (const name of readdirSync(cacheDir)) {
    // Only seed completed models; skip `.ipull` partial-download artifacts.
    if (!name.endsWith(".gguf")) continue;
    const source = join(cacheDir, name);
    const dest = join(destDir, name);
    if (existsSync(dest)) continue;
    try {
      linkSync(source, dest);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "EXDEV") throw error;
      copyFileSync(source, dest);
    }
  }
}

/**
 * Default local embedding model URI. MUST match the Zod default for
 * `embedding.local.modelUri` in `packages/core/src/config/schema-embedding.ts`.
 * If they drift, the cache simply seeds a different file and daemons download
 * as before (degraded, never broken).
 */
const DEFAULT_EMBEDDING_MODEL_URI =
  "hf:gpustack/bge-m3-GGUF:bge-m3-Q8_0.gguf";

/** Cap the one-time download so a stalled network can never wedge globalSetup
 *  longer than the per-fork-download fallback would have cost anyway. */
const MODEL_CACHE_DOWNLOAD_TIMEOUT_MS = 240_000;

/**
 * Populate the shared model cache (`~/.comis/models`) ONCE so `seedModelCache`
 * has a source to seed from.
 *
 * `seedModelCache` is a no-op when `~/.comis/models` is empty — the case on CI
 * runners and fresh checkouts. There, every parallel test daemon downloads the
 * ~635 MB embedding GGUF into its own throwaway dataDir simultaneously,
 * saturating disk/network so `beforeAll` daemon boots exceed the 60 s
 * `hookTimeout` (the chronic CI failure: integration files failing with
 * "Hook timed out", zero assertion failures).
 *
 * This downloads the default embedding GGUF a SINGLE time — serially, in the
 * vitest main process via `globalSetup`, before any fork — using the same
 * `node-llama-cpp` `resolveModelFile` the daemon uses, so the file lands with
 * the exact name daemons resolve. Afterwards all daemons seed from the one
 * cached source (via `seedModelCache`) instead of downloading it independently.
 *
 * Best-effort: a no-op when the model is already cached (warm dev machine), and
 * any failure (no native binary, network, fs) is swallowed so daemons fall back
 * to per-fork download — never worse than today. Runs outside the suite's
 * `hookTimeout` (globalSetup is not a test hook).
 */
export async function ensureSharedModelCache(): Promise<void> {
  try {
    const cacheDir = join(homedir(), ".comis", "models");
    mkdirSync(cacheDir, { recursive: true });
    // Already cached → nothing to download; seedModelCache will reuse it.
    if (readdirSync(cacheDir).some((n) => /bge-m3.*\.gguf$/i.test(n))) return;
    const llamaCpp = (await import("node-llama-cpp")) as {
      resolveModelFile: (uri: string, dir: string) => Promise<string>;
    };
    const download = llamaCpp.resolveModelFile(DEFAULT_EMBEDDING_MODEL_URI, cacheDir);
    // If the timeout wins we stop awaiting; keep the dangling promise from
    // surfacing as an unhandled rejection. A partial `.ipull` is ignored by
    // seedModelCache, so daemons just download per-fork (today's behavior).
    download.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, MODEL_CACHE_DOWNLOAD_TIMEOUT_MS);
    });
    await Promise.race([download.then(() => undefined), cap]);
    if (timer) clearTimeout(timer);
  } catch {
    // Native binary unavailable / network / fs error — daemons download per-fork.
  }
}
