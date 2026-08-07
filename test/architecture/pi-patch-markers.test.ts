// SPDX-License-Identifier: Apache-2.0
/**
 * The pack-time patch verification must track the patch it verifies.
 *
 * `prepack.js` refuses to publish unless the installed provider carries our
 * `patchedDependencies` changes — the tarball is what users install, so a patch
 * that silently failed to apply must not ship. It proves that by grepping the
 * installed files for strings only the patch introduces.
 *
 * Those strings are a second copy of the patch's contents, and the two drifted:
 * a version rebase legitimately dropped one hunk (upstream had absorbed it)
 * while the marker still pointed at that hunk. The pack then failed insisting
 * the patch was missing, when in fact every surviving hunk had applied — a
 * confusing failure that reds `tarball` on every branch, and one no test caught
 * because nothing tied the marker list to the patch file.
 *
 * This pins the relationship in both directions: every file the patch modifies
 * needs a marker, and every marker must name a file the patch actually
 * modifies. A rebase that adds or drops a hunk now has to update the table.
 *
 * Static and cross-platform: reads the patch and the marker table, installs
 * nothing, runs no pack.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PATCH_MARKERS, UPSTREAM_ABSORBED_MARKERS } from "../../packages/comis/scripts/patch-markers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

interface RootManifest {
  readonly pnpm?: { readonly patchedDependencies?: Record<string, string> };
}

/** The patch file pinned for `@earendil-works/pi-ai`, whatever version it is on. */
function piAiPatchPath(): string {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as RootManifest;
  const patched = manifest.pnpm?.patchedDependencies ?? {};
  const entry = Object.entries(patched).find(([spec]) => spec.startsWith("@earendil-works/pi-ai@"));
  expect(
    entry,
    "root package.json no longer pins a patch for @earendil-works/pi-ai — if the patch is gone for "
      + "good, delete PATCH_MARKERS and this test rather than leaving a check that can never pass",
  ).toBeDefined();
  return join(REPO_ROOT, entry![1]);
}

/** Paths the patch modifies, as they appear in its `diff --git` headers. */
function patchedFiles(patchPath: string): string[] {
  const out = new Set<string>();
  for (const line of readFileSync(patchPath, "utf8").split("\n")) {
    const match = /^diff --git a\/(\S+) b\/\S+$/.exec(line);
    if (match) {
      out.add(match[1]);
    }
  }
  return [...out].sort();
}

const markerPath = (file: readonly string[]): string => file.join("/");

describe("pi-ai patch markers track the patch", () => {
  it("has a marker for every file the patch modifies", () => {
    const patchPath = piAiPatchPath();
    expect(existsSync(patchPath), `${patchPath} is pinned but missing`).toBe(true);

    const covered = new Set(PATCH_MARKERS.map((m) => markerPath(m.file)));
    const uncovered = patchedFiles(patchPath).filter((f) => !covered.has(f));

    expect(
      uncovered,
      "The pi-ai patch modifies files that prepack.js does not verify. A hunk that fails to apply "
        + "in one of these would ship unnoticed. Add an entry to PATCH_MARKERS in "
        + "packages/comis/scripts/patch-markers.js naming a string only that hunk introduces.",
    ).toEqual([]);
  });

  it("has no marker for a file the patch no longer touches", () => {
    const patchPath = piAiPatchPath();
    const touched = new Set(patchedFiles(patchPath));
    const stale = PATCH_MARKERS.map((m) => markerPath(m.file)).filter((f) => !touched.has(f));

    expect(
      stale,
      "PATCH_MARKERS names files the pi-ai patch does not modify, so prepack.js will fail the pack "
        + "looking for a hunk that no longer exists — the exact drift that reds `tarball` on every "
        + "branch. Drop the entry, and if upstream absorbed the behaviour move it to "
        + "UPSTREAM_ABSORBED_MARKERS so it is warned about instead of enforced.",
    ).toEqual([]);
  });

  it("keeps absorbed-upstream markers out of the enforced set", () => {
    // These describe upstream's own code. Enforcing them would block a release
    // whenever upstream renames a private helper, so they must stay advisory.
    const enforced = new Set(PATCH_MARKERS.map((m) => markerPath(m.file)));
    const overlap = UPSTREAM_ABSORBED_MARKERS.map((m) => markerPath(m.file)).filter((f) =>
      enforced.has(f),
    );

    expect(
      overlap,
      "A file appears in both PATCH_MARKERS (hard failure) and UPSTREAM_ABSORBED_MARKERS (warning). "
        + "Upstream-owned behaviour must not be able to fail a publish.",
    ).toEqual([]);
  });

  it("gives every marker a non-empty search string and description", () => {
    const bad = [...PATCH_MARKERS, ...UPSTREAM_ABSORBED_MARKERS].filter(
      (m) => m.file.length === 0 || m.marker.trim() === "" || m.describes.trim() === "",
    );

    expect(
      bad.map((m) => markerPath(m.file) || "(empty path)"),
      "Every marker needs a file, a search string, and a description — the description is what the "
        + "pack failure prints, and a bare path does not tell a reader what broke.",
    ).toEqual([]);
  });
});
