// SPDX-License-Identifier: Apache-2.0
/**
 * Remove every package's `dist/` and `*.tsbuildinfo` so the next build is a
 * clean-room build.
 *
 * WHY: a leftover `dist/` (and the composite `*.tsbuildinfo`) silently masks
 * real build breakage. The clearest case is a workspace dependency CYCLE: with
 * a stale `dist/` present, `pnpm -r run build` can build packages in the wrong
 * order yet still resolve `@comis/*` from the leftover output — so the build
 * "passes" locally while a fresh CI checkout (no `dist/`) fails with
 * "Cannot find module '@comis/...'". `pnpm build:clean` runs this first so the
 * local build matches CI.
 *
 * Cross-platform (Node fs only); no shell globbing.
 *
 * @module
 */
import { readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const PACKAGES_DIR = "packages";

let removed = 0;
for (const pkg of readdirSync(PACKAGES_DIR)) {
  const pkgDir = join(PACKAGES_DIR, pkg);
  if (!statSync(pkgDir).isDirectory()) continue;

  const dist = join(pkgDir, "dist");
  if (existsSync(dist)) {
    rmSync(dist, { recursive: true, force: true });
    removed++;
  }

  // tsc -b writes `<project>.tsbuildinfo` (default `tsconfig.tsbuildinfo`) in
  // the package root — remove any to force a full type-check + emit.
  for (const entry of readdirSync(pkgDir)) {
    if (entry.endsWith(".tsbuildinfo")) {
      rmSync(join(pkgDir, entry), { force: true });
      removed++;
    }
  }
}

console.log(`clean: removed ${removed} build artifact(s) (packages/*/dist + *.tsbuildinfo)`);
