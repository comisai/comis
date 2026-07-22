#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

/**
 * Tarball smoke test.
 *
 * Packs the umbrella `comisai` package via `pnpm --filter comisai pack`,
 * extracts the resulting tarball, and asserts that every workspace package
 * declared in `packages/comis/package.json:bundledDependencies` (the single
 * source of truth) is bundled with a populated `dist/` directory inside
 * `package/node_modules/@comis/`.
 *
 * Assertions (5):
 *   1. The `node_modules/@comis/<pkg>` directory count matches the
 *      `@comis/*` entries in bundledDependencies.
 *   2. The set of bundled directories equals the set of `@comis/*`
 *      bundledDependencies entries (every expected package present; no extras).
 *   3. Every bundled `@comis/<pkg>` has a non-empty `dist/` subdirectory.
 *   4. `node_modules/@comis/orchestrator/dist/` exists (explicit check —
 *      guards against silent regression of the orchestrator extraction).
 *   5. The patched provider error normalizer is bundled, so a clean npm
 *      install cannot replace it with the unpatched registry artifact.
 *
 * Working-tree defense-in-depth checks (run AFTER cleanup):
 *   a. `packages/comis/package.json` is byte-identical before and after pack.
 *      The `prepack.js` rewrite of `workspace:*` → real versions is expected
 *      to be reverted by `postpack.js` from `package.json.workspace-backup`.
 *      Comparing bytes supports intentional uncommitted package edits while
 *      still preventing pack from poisoning the next `pnpm install`.
 *   b. `packages/comis/package.json.workspace-backup` does NOT exist.
 *      `postpack.js` removes it after restoring; we verify it was cleaned up.
 *
 * Precondition: `pnpm build` must have been run — the smoke test does NOT
 * invoke build itself (avoid duplicate work in CI). The CI workflow's
 * `Build` step satisfies this for CI; local runs need a preceding
 * `pnpm build`.
 *
 * Exit codes:
 *   0 — all assertions passed.
 *   1 — at least one assertion failed (details printed to stderr).
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

// --- Step 1: Read expected packages from bundledDependencies (single source of truth) ---
//
// `packages/comis/package.json:bundledDependencies` is the canonical
// workspace-package list. This script reads it directly (the prepack.js
// array — formerly the source — is now itself derived from the same
// bundledDependencies field, so a regex parse over prepack.js would
// be an indirection without added coverage).
//
// `bundledDependencies` also contains native-dep helpers (`bindings`,
// `file-uri-to-path`) bundled via FORCE_BUNDLE in prepack.js step 4. The
// `@comis/*` filter keeps only workspace packages as `expectedPackages`,
// matching the consumer-facing surface of the tarball's
// `node_modules/@comis/` directory.

const comisPkgPath = join(repoRoot, "packages/comis/package.json");
const originalComisPkgContent = readFileSync(comisPkgPath, "utf8");
const comisPkg = JSON.parse(originalComisPkgContent);
const expectedPackages = (comisPkg.bundledDependencies ?? [])
  .filter((s) => typeof s === "string" && s.startsWith("@comis/"))
  .map((s) => s.replace(/^@comis\//, ""));

if (expectedPackages.length === 0) {
  console.error(
    "FAIL: bundledDependencies @comis/* entries empty in packages/comis/package.json",
  );
  process.exit(1);
}
console.log(
  `Expected ${expectedPackages.length} bundled packages (from bundledDependencies): ` +
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
    ok(`bundled count matches bundledDependencies (${bundled.length})`);
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
    ok(`bundled set equals bundledDependencies @comis/* entries`);
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
  ok(`every bundledDependencies @comis/* entry has a populated dist/ subdirectory`);

  // Assertion 4 — orchestrator/dist explicitly present
  const orchestratorDist = join(comisModulesDir, "orchestrator/dist");
  if (!existsSync(orchestratorDist)) {
    fail(`@comis/orchestrator/dist/ missing from tarball (explicit check)`);
  } else {
    ok(`@comis/orchestrator/dist/ present (explicit check)`);
  }

  // Assertion 5 — the dependency patch must cross the npm distribution boundary.
  const providerErrorBody = join(
    extractDir,
    "package/node_modules/@earendil-works/pi-ai/dist/utils/error-body.js",
  );
  if (!existsSync(providerErrorBody)) {
    fail(`patched @earendil-works/pi-ai error normalizer missing at ${providerErrorBody}`);
  } else {
    const providerSource = readFileSync(providerErrorBody, "utf8");
    if (!providerSource.includes("function isNonEmptyJsonBody")) {
      fail(`bundled @earendil-works/pi-ai does not contain the dependency patch`);
    } else {
      ok(`patched @earendil-works/pi-ai error normalizer is bundled`);
    }
  }
} finally {
  // Step 6 — Cleanup tmpdir.
  rmSync(packDest, { recursive: true, force: true });
}

// --- Step 7: Working-tree defense-in-depth checks (AFTER tmpdir cleanup) ---

// Check (a): package.json restored byte-for-byte to its pre-pack state.
try {
  const restoredComisPkgContent = readFileSync(comisPkgPath, "utf8");
  if (restoredComisPkgContent !== originalComisPkgContent) {
    fail(
      `postpack did NOT restore packages/comis/package.json to its pre-pack contents; ` +
        `this would poison the next \`pnpm install\`.`,
    );
  } else {
    ok(`postpack restored packages/comis/package.json byte-for-byte`);
  }
} catch (e) {
  fail(`could not verify restored packages/comis/package.json: ${e.message}`);
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
