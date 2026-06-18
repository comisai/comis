// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide source-integrity invariant: no `.ts` source file (production OR
 * test) under `packages/*\/src/` may contain a NUL (0x00) byte.
 *
 * A stray NUL byte — typically an editor/paste artifact inside a template
 * literal — makes `grep`, `ripgrep`, `git diff`, and code-review tooling treat
 * the whole file as BINARY and silently skip its text. That is a direct
 * diagnosability hazard: a NUL in `skill-synthesis-job.ts` / `offline-learning.ts`
 * (v2.26 learning code) hid those files from every text search, which is exactly
 * how a real defect can escape review. The fail-safe is to forbid the byte
 * outright — a separator inside a key-join string should be a normal character.
 *
 * Found during the Phase 201 code-review fix (two `${a}\\0${b}` key-join helpers).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");

/** Walk a package `src/` tree and collect every `.ts` file (production AND test). */
function walkTsFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // symlink loop guard
    if (entry.isDirectory()) {
      if (["dist", "node_modules", "__snapshots__"].includes(entry.name)) continue;
      walkTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
}

function listAllTsFiles(): string[] {
  const out: string[] = [];
  let packageDirs;
  try {
    packageDirs = readdirSync(PACKAGES_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const pkg of packageDirs) {
    if (!pkg.isDirectory() || pkg.name.startsWith(".")) continue;
    walkTsFiles(resolve(PACKAGES_ROOT, pkg.name, "src"), out);
  }
  return out;
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT) ? absPath.slice(REPO_ROOT.length + 1) : absPath;
}

describe("source-integrity — no NUL bytes in .ts source", () => {
  it("no packages/*/src .ts file (production or test) contains a NUL (0x00) byte", () => {
    const files = listAllTsFiles();
    const offenders: string[] = [];
    for (const file of files) {
      const buf = readFileSync(file);
      if (buf.includes(0)) offenders.push(repoRelative(file));
    }
    expect(offenders, `Files containing NUL bytes (binary to grep/diff/review):\n${offenders.join("\n")}`).toEqual([]);
  });
});
