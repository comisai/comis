#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

/**
 * Tarball smoke test (GUARDRAILS-12).
 *
 * Packs the umbrella `comisai` package via `pnpm --filter comisai pack`,
 * extracts the resulting tarball, and asserts that every workspace package
 * declared in `packages/comis/scripts/prepack.js` is bundled with a populated
 * `dist/` directory inside `package/node_modules/@comis/`.
 *
 * Assertions (4):
 *   1. The `node_modules/@comis/<pkg>` directory count matches the
 *      WORKSPACE_PACKAGES entry count in prepack.js.
 *   2. The set of bundled directories equals the set of WORKSPACE_PACKAGES
 *      entries (every expected package present; no extras).
 *   3. Every bundled `@comis/<pkg>` has a non-empty `dist/` subdirectory.
 *   4. `node_modules/@comis/orchestrator/dist/` exists (explicit Phase 36
 *      check — guards against silent regression of the orchestrator
 *      extraction landed in Phase 32).
 *
 * Pitfall-3 defense-in-depth checks (run AFTER cleanup):
 *   a. `git status --porcelain packages/comis/package.json` is empty.
 *      The `prepack.js` rewrite of `workspace:*` → real versions is expected
 *      to be reverted by `postpack.js` from `package.json.workspace-backup`.
 *      We verify this so a future regression in postpack.js cannot poison
 *      the working tree for the next `pnpm install`.
 *   b. `packages/comis/package.json.workspace-backup` does NOT exist.
 *      `postpack.js` removes it after restoring; we verify it was cleaned up.
 *
 * Precondition: `pnpm build` must have been run — the smoke test does NOT
 * invoke build itself (Pitfall 4 — avoid duplicate work in CI). The CI
 * workflow's `Build` step satisfies this for CI; local runs need a
 * preceding `pnpm build`.
 *
 * Exit codes:
 *   0 — all assertions passed.
 *   1 — at least one assertion failed (details printed to stderr).
 *
 * Design ref: Phase 36 / GUARDRAILS-12; research §"Pattern 4: Tarball smoke
 * test" (lines 430-512) and §"Pitfall 3: Tarball smoke test mutates working
 * tree" (lines 571-582).
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

let exitCode = 0;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  exitCode = 1;
};
const ok = (msg) => console.log(`OK: ${msg}`);

// --- Step 1: Parse WORKSPACE_PACKAGES from prepack.js (cross-check source of truth) ---

const prepackPath = join(repoRoot, "packages/comis/scripts/prepack.js");
const prepackContent = readFileSync(prepackPath, "utf8");
const match = prepackContent.match(/const WORKSPACE_PACKAGES = \[([\s\S]*?)\];/);
if (!match) {
  console.error("FAIL: could not locate WORKSPACE_PACKAGES array in prepack.js");
  process.exit(1);
}
// Robust parse: strip line-level // comments per-line FIRST (so any literal
// `]` inside a comment cannot fool the non-greedy regex above on a
// follow-up read), then JSON.parse the cleaned array body. This is more
// resilient than the previous split-on-comma + strip-quotes pipeline:
//   - Tolerates trailing commas (common JS convention) via the trim/regex.
//   - Treats the array elements as proper JSON strings, so commas inside
//     a hypothetical name literal cannot split incorrectly.
//   - Pre-strips //-line-end comments before JSON.parse sees them.
let expectedPackages;
try {
  const cleaned = match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .join("")
    // Drop a single trailing comma if present so JSON.parse accepts the
    // array body (JSON does not allow trailing commas; JS code does).
    .replace(/,\s*$/, "");
  expectedPackages = JSON.parse(`[${cleaned}]`);
  if (!Array.isArray(expectedPackages) || expectedPackages.some((p) => typeof p !== "string")) {
    throw new Error("WORKSPACE_PACKAGES must be a string[]");
  }
} catch (e) {
  console.error(`FAIL: could not parse WORKSPACE_PACKAGES from prepack.js: ${e.message}`);
  process.exit(1);
}
console.log(
  `Expected ${expectedPackages.length} bundled packages (from WORKSPACE_PACKAGES): ` +
    `${expectedPackages.sort().join(", ")}`,
);

// --- Step 2-6: Pack, extract, assert, cleanup ---

const packDest = mkdtempSync(join(tmpdir(), "comis-pack-test-"));
const comisPackageRoot = join(repoRoot, "packages/comis");
try {
  // Step 2 — Pack the umbrella. This invokes prepack.js (mutates
  // packages/comis/package.json) and postpack.js (restores it).
  //
  // We run `pnpm pack` from `packages/comis/` directly rather than
  // `pnpm --filter comisai pack` from the repo root because pnpm 10.x
  // rejects `--filter` on the non-recursive `pack` command (ERROR:
  // "Unknown option: 'recursive'"). The `--config.node-linker=hoisted`
  // flag mirrors `.github/workflows/npm-publish.yml` and is required
  // because `bundledDependencies` is incompatible with pnpm's default
  // isolated linker (ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED).
  execSync(`pnpm pack --pack-destination ${packDest} --config.node-linker=hoisted`, {
    cwd: comisPackageRoot,
    stdio: "inherit",
  });

  // Step 3 — Locate the tarball.
  const tgzEntries = readdirSync(packDest).filter((f) => f.endsWith(".tgz"));
  if (tgzEntries.length !== 1) {
    fail(
      `expected exactly 1 .tgz in ${packDest}; got ${tgzEntries.length} ` +
        `(${tgzEntries.join(", ") || "<none>"})`,
    );
    process.exit(exitCode);
  }
  // Explicit guard so a future refactor that loosens the length check
  // above (e.g., switches to `>= 1` and picks the first) cannot silently
  // produce `join(packDest, undefined)` -> "packDest/undefined". Today
  // the prior `!== 1` exit makes this unreachable; keep the guard as a
  // tripwire.
  const firstEntry = tgzEntries[0];
  if (firstEntry === undefined) {
    fail(`unreachable: tgzEntries.length === 1 but tgzEntries[0] is undefined`);
    process.exit(exitCode);
  }
  const tarballPath = join(packDest, firstEntry);
  ok(`tarball located at ${tarballPath}`);

  // Step 4 — Extract.
  // Both paths come from tmpdir-derived locations (TMPDIR / mkdtempSync),
  // which can in principle contain spaces or shell metacharacters if the
  // operator has set TMPDIR explicitly. CI runners use /tmp (safe), but
  // this script is documented as runnable locally; quote both paths
  // defensively rather than rely on the inherited environment.
  const extractDir = join(packDest, "extracted");
  execSync(
    `mkdir -p "${extractDir}" && tar -xzf "${tarballPath}" -C "${extractDir}"`,
  );

  // Step 5 — Assertions.
  const comisModulesDir = join(extractDir, "package/node_modules/@comis");
  if (!existsSync(comisModulesDir)) {
    fail(`node_modules/@comis/ missing from tarball at ${comisModulesDir}`);
    process.exit(exitCode);
  }
  const bundled = readdirSync(comisModulesDir)
    .filter((n) => !n.startsWith("."))
    .sort();

  // Assertion 1 — count match
  if (bundled.length !== expectedPackages.length) {
    fail(
      `bundled count mismatch: got ${bundled.length} ` +
        `(${bundled.join(", ")}), expected ${expectedPackages.length} ` +
        `(${expectedPackages.sort().join(", ")})`,
    );
  } else {
    ok(`bundled count matches WORKSPACE_PACKAGES (${bundled.length})`);
  }

  // Assertion 2 — set equality
  const bundledSet = new Set(bundled);
  const missing = expectedPackages.filter((p) => !bundledSet.has(p));
  const extras = bundled.filter((p) => !expectedPackages.includes(p));
  if (missing.length > 0) {
    fail(`bundled set missing: ${missing.join(", ")}`);
  }
  if (extras.length > 0) {
    fail(`bundled set has unexpected extras: ${extras.join(", ")}`);
  }
  if (missing.length === 0 && extras.length === 0) {
    ok(`bundled set equals WORKSPACE_PACKAGES`);
  }

  // Assertion 3 — every entry has a dist/ subdir
  for (const pkg of expectedPackages) {
    const distPath = join(comisModulesDir, pkg, "dist");
    if (!existsSync(distPath)) {
      fail(`@comis/${pkg}/dist/ missing inside tarball at ${distPath}`);
    } else {
      const distEntries = readdirSync(distPath);
      if (distEntries.length === 0) {
        fail(`@comis/${pkg}/dist/ exists but is empty`);
      }
    }
  }
  ok(`every WORKSPACE_PACKAGES entry has a populated dist/ subdirectory`);

  // Assertion 4 — orchestrator/dist explicitly present (Phase 36 acceptance)
  const orchestratorDist = join(comisModulesDir, "orchestrator/dist");
  if (!existsSync(orchestratorDist)) {
    fail(`@comis/orchestrator/dist/ missing from tarball (Phase 36 explicit check)`);
  } else {
    ok(`@comis/orchestrator/dist/ present (Phase 36 explicit check)`);
  }
} finally {
  // Step 6 — Cleanup tmpdir.
  rmSync(packDest, { recursive: true, force: true });
}

// --- Step 7: Pitfall-3 defense-in-depth checks (AFTER tmpdir cleanup) ---

// Check (a): working tree clean for packages/comis/package.json.
try {
  const status = execSync("git status --porcelain packages/comis/package.json", {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (status.length > 0) {
    fail(
      `postpack did NOT restore packages/comis/package.json — git status reports: ` +
        `\n${status}\nThis would poison the next \`pnpm install\`.`,
    );
  } else {
    ok(`postpack restored packages/comis/package.json (working tree clean)`);
  }
} catch (e) {
  fail(`could not run git status --porcelain packages/comis/package.json: ${e.message}`);
}

// Check (b): workspace-backup file removed.
const backupPath = join(repoRoot, "packages/comis/package.json.workspace-backup");
if (existsSync(backupPath)) {
  fail(
    `packages/comis/package.json.workspace-backup still exists after smoke — ` +
      `postpack did not clean it up.`,
  );} else {
  ok(`package.json.workspace-backup removed`);
}

process.exit(exitCode);
