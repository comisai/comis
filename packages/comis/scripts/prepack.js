#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

/**
 * Prepack script for the comisai umbrella package.
 *
 * 1. Copies each @comis/* workspace package (dist + package.json + extra files)
 *    into a local node_modules tree so that npm's bundledDependencies mechanism
 *    includes them in the published tarball.
 * 2. Rewrites workspace:* dependency references in package.json to real versions
 *    so npm can resolve them (pnpm does this automatically, npm does not).
 *
 * This lets users `npm install -g comisai` without the @comis/* packages being
 * published separately.
 */

import { cpSync, mkdirSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findUnhoistedRuntimeDeps,
  readManifest,
  resolveBundledSourceDir,
  serializeBundledManifest,
  thirdPartyBundledPackages,
} from "./bundled-manifest.js";
import { PATCH_MARKERS, UPSTREAM_ABSORBED_MARKERS } from "./patch-markers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const comisRoot = resolve(__dirname, "..");
const monoRoot = resolve(comisRoot, "../..");
const patchedProviderSource = realpathSync(
  join(monoRoot, "node_modules", "@earendil-works", "pi-ai"),
);

// Verify every hunk landed, not just one. Naming the file and the expected
// behaviour keeps a failure actionable: the previous single-marker check said
// only "the patch is missing", which sent a reader hunting for a broken patch
// when the patch had applied and the marker was the stale part.
const missingPatches = PATCH_MARKERS.filter(({ file, marker }) => {
  const path = join(patchedProviderSource, ...file);
  return !existsSync(path) || !readFileSync(path, "utf8").includes(marker);
});
if (missingPatches.length > 0) {
  console.error(
    "ERROR: installed @earendil-works/pi-ai is missing patched behaviour — "
      + "check that pnpm.patchedDependencies pins the installed version:",
  );
  for (const { file, describes } of missingPatches) {
    console.error(`  - ${file.join("/")}: ${describes}`);
  }
  process.exit(1);
}

// Upstream-owned behaviour we depend on but no longer patch. Warn only —
// see UPSTREAM_ABSORBED_MARKERS for why this must not block a publish.
for (const { file, marker, describes } of UPSTREAM_ABSORBED_MARKERS) {
  const path = join(patchedProviderSource, ...file);
  if (!existsSync(path) || !readFileSync(path, "utf8").includes(marker)) {
    console.warn(
      `WARNING: @earendil-works/pi-ai no longer exposes \`${marker}\` in ${file.join("/")} — `
        + `${describes}. Upstream may have dropped it; provider error text will degrade if so.`,
    );
  }
}

// Single source of truth: bundledDependencies in our own package.json.
// Tarball-smoke and umbrella-bundling test read the SAME source.
// `bundledDependencies` also contains native-dep helpers (`bindings`,
// `file-uri-to-path`) bundled via FORCE_BUNDLE in step 4 — the filter
// keeps only `@comis/*` entries as workspace packages.
const ownPkgJson = JSON.parse(
  readFileSync(join(comisRoot, "package.json"), "utf8"),
);
const WORKSPACE_PACKAGES = (ownPkgJson.bundledDependencies ?? [])
  .filter(/** @param {string} s */ (s) => typeof s === "string" && s.startsWith("@comis/"))
  .map(/** @param {string} s */ (s) => s.replace(/^@comis\//, ""));

if (WORKSPACE_PACKAGES.length === 0) {
  console.error("ERROR: bundledDependencies @comis/* entries empty in packages/comis/package.json");
  process.exit(1);
}

// --- Step 0: Verify third-party bundled packages are fully hoisted ---
// Their bundled copies ship without a dependency list (steps 4 and 5), so the
// umbrella is the only thing that installs what they import. Check before
// writing anything: a missing hoist produces a tarball that installs fine
// locally and breaks only under `npm install -g`.
const unhoisted = [];
for (const name of thirdPartyBundledPackages(ownPkgJson)) {
  const sourceDir = resolveBundledSourceDir(monoRoot, name, ownPkgJson.dependencies?.[name]);
  if (sourceDir === null) {
    console.error(`ERROR: bundled ${name} is not installed — run pnpm install`);
    process.exit(1);
  }
  const missing = findUnhoistedRuntimeDeps(readManifest(sourceDir), ownPkgJson);
  if (missing.length > 0) {
    unhoisted.push(`${name} needs ${missing.join(", ")}`);
  }
}
if (unhoisted.length > 0) {
  console.error("ERROR: bundled packages depend on packages the umbrella does not provide:");
  for (const line of unhoisted) {
    console.error(`  ${line}`);
  }
  console.error("Add each as an exact pin to packages/comis/package.json dependencies.");
  process.exit(1);
}

// --- Step 1: Bundle workspace packages into node_modules/@comis/ ---

const bundledModules = join(comisRoot, "node_modules");
const comisScope = join(bundledModules, "@comis");
if (existsSync(comisScope)) {
  rmSync(comisScope, { recursive: true, force: true });
}

/** @type {Record<string, string>} */
const resolvedVersions = {};

for (const pkg of WORKSPACE_PACKAGES) {
  const srcDir = join(monoRoot, "packages", pkg);
  const destDir = join(bundledModules, "@comis", pkg);

  mkdirSync(destDir, { recursive: true });

  // Copy dist/
  const distSrc = join(srcDir, "dist");
  if (!existsSync(distSrc)) {
    console.error(`ERROR: ${distSrc} does not exist — run pnpm build first`);
    process.exit(1);
  }
  cpSync(distSrc, join(destDir, "dist"), {
    recursive: true,
    filter: (src) =>
      !src.endsWith(".test.js") &&
      !src.endsWith(".test.d.ts") &&
      !src.endsWith(".test.d.ts.map") &&
      !src.includes(`${sep}__test-helpers${sep}`) &&
      !src.endsWith(`${sep}__test-helpers`),
  });

  // Copy package.json with dependencies stripped — all external deps are
  // listed at the comisai top level, so bundled packages don't need their own.
  // A bundled copy that keeps its dependency list makes npm treat those deps
  // as part of this bundle and skip unpacking them; see bundled-manifest.js.
  writeFileSync(
    join(destDir, "package.json"),
    serializeBundledManifest(readManifest(srcDir)),
  );

  // Copy extra files listed in the package's "files" field beyond dist/
  const pkgJson = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));
  const extraFiles = (pkgJson.files || []).filter((f) => f !== "dist");
  for (const extra of extraFiles) {
    const extraSrc = join(srcDir, extra);
    if (existsSync(extraSrc)) {
      cpSync(extraSrc, join(destDir, extra), { recursive: true });
    }
  }

  resolvedVersions[`@comis/${pkg}`] = pkgJson.version;
  console.log(`  bundled @comis/${pkg}@${pkgJson.version}`);
}

// --- Step 2: Rewrite workspace:* references in package.json ---

const pkgPath = join(comisRoot, "package.json");
const originalContent = readFileSync(pkgPath, "utf8");
const backupPath = join(comisRoot, "package.json.workspace-backup");
writeFileSync(backupPath, originalContent);

const pkg = JSON.parse(originalContent);

// Resolve workspace:* to real versions — required for bundledDependencies to work
// (npm needs valid version ranges in dependencies to include the bundled copies).
let resolved = 0;
if (pkg.dependencies) {
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    if (typeof version === "string" && version.startsWith("workspace:")) {
      const real = resolvedVersions[name];
      if (real) {
        pkg.dependencies[name] = real;
        resolved++;
      }
    }
  }
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`  resolved ${resolved} workspace:* references to real versions`);

// --- Step 3: Remove pnpm symlinks from node_modules/ ---
// pnpm populates node_modules/ with symlinks and scope directories that must not
// end up in the tarball. Keep only @comis/ (our bundled packages).
const entries = readdirSync(bundledModules);
let removed = 0;
for (const entry of entries) {
  if (entry === "@comis") continue;
  rmSync(join(bundledModules, entry), { recursive: true, force: true });
  removed++;
}
if (removed > 0) {
  console.log(`  removed ${removed} pnpm entries from node_modules/`);
}

// --- Step 4: Bundle the patched provider package ---
// pnpm patches modify the local dependency tree, but npm consumers do not
// read pnpm.patchedDependencies. Copy the verified installed artifact into
// the umbrella package so global installs execute the same provider code.
const patchedProviderDest = join(bundledModules, "@earendil-works", "pi-ai");
mkdirSync(patchedProviderDest, { recursive: true });
for (const entry of ["dist", "README.md", "package.json"]) {
  const source = join(patchedProviderSource, entry);
  if (!existsSync(source)) {
    console.error(`ERROR: required patched provider file is missing: ${source}`);
    process.exit(1);
  }
  if (entry === "package.json") {
    // Rewritten, never copied: a registry manifest carries a dependency list,
    // and npm then counts those dependencies as part of this bundle and skips
    // unpacking them in a global install. Step 0 verified the umbrella
    // provides them instead.
    writeFileSync(
      join(patchedProviderDest, entry),
      serializeBundledManifest(readManifest(patchedProviderSource)),
    );
    continue;
  }
  cpSync(source, join(patchedProviderDest, entry), { recursive: true });
}
// Report the version actually bundled. A hard-coded literal here silently goes
// stale on the next provider bump and then misreports what the tarball carries.
console.log(
  `  bundled patched @earendil-works/pi-ai@${readManifest(patchedProviderSource).version}`,
);

// --- Step 5: Bundle native-dep helpers that npm fails to install ---
// npm's reify creates empty directories for transitive deps of non-bundled
// native modules (better-sqlite3 → bindings → file-uri-to-path) when
// bundledDependencies is present. Ship them in the tarball so they're always
// available regardless of npm's behavior.
const FORCE_BUNDLE = { "bindings": "1.5.0", "file-uri-to-path": "1.0.0" };
const pnpmStore = join(monoRoot, "node_modules", ".pnpm");
for (const [name, version] of Object.entries(FORCE_BUNDLE)) {
  const src = join(pnpmStore, `${name}@${version}`, "node_modules", name);
  const dest = join(bundledModules, name);
  if (!existsSync(src)) {
    console.error(`ERROR: ${src} not found in pnpm store`);
    process.exit(1);
  }
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  writeFileSync(join(dest, "package.json"), serializeBundledManifest(readManifest(src)));
  console.log(`  force-bundled ${name}@${version}`);
}

console.log("prepack: done");
