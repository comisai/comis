// SPDX-License-Identifier: Apache-2.0
/**
 * `resolveBootDataDir` — every data dir a test daemon boots on must carry the shared model cache.
 *
 * The harness seeded only the data dir it created itself. A test that pre-sets `COMIS_DATA_DIR`
 * (credential-storage-modes, daemon-lifecycle, …) kept its own value and got NO seeding, so its
 * daemon cold-downloaded the ~635 MB bge-m3 GGUF into that temp dir — measured twice inside one
 * integration run (`Downloading to /tmp/comis-storage-modes-enc-<rand>/models`, 634.55MB each),
 * which is the >60s `beforeAll` that `model-cache.ts` exists to prevent. It also tipped two
 * neighbours sitting at the boundary (52s and 59.9s) over the 60s hookTimeout.
 *
 * @module
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveBootDataDir } from "./daemon-harness.js";

const cacheDir = join(homedir(), ".comis", "models");
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "comis-boot-dir-"));
  created.push(dir);
  return dir;
}

function cachedModels(): readonly string[] {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir).filter((name) => name.endsWith(".gguf"));
}

describe("resolveBootDataDir", () => {
  it("seeds the shared model cache into a TEST-PROVIDED data dir", () => {
    const dataDir = makeDataDir();
    const resolved = resolveBootDataDir(dataDir);

    expect(resolved.dataDir).toBe(dataDir);
    expect(resolved.presetOwned).toBe(true);

    const cached = cachedModels();
    if (cached.length === 0) return; // Fresh machine with no cache: seeding is a documented no-op.
    const seeded = readdirSync(join(dataDir, "models"));
    for (const model of cached) {
      expect(seeded, `${model} must be hard-linked into the test-owned data dir`).toContain(model);
    }
  });

  it("seeds the fork-owned data dir it creates when no data dir is preset", () => {
    const resolved = resolveBootDataDir(undefined);

    expect(resolved.presetOwned).toBe(false);
    expect(resolved.dataDir).toContain("comis-test-data-");

    const cached = cachedModels();
    if (cached.length === 0) return;
    expect(readdirSync(join(resolved.dataDir, "models")).length).toBeGreaterThan(0);
  });

  it("is idempotent — re-resolving the same data dir does not throw on existing links", () => {
    const dataDir = makeDataDir();
    expect(() => {
      resolveBootDataDir(dataDir);
      resolveBootDataDir(dataDir);
    }).not.toThrow();
  });
});
