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

import { cpSync, mkdirSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const comisRoot = resolve(__dirname, "..");
const monoRoot = resolve(comisRoot, "../..");

const WORKSPACE_PACKAGES = [
  "shared",
  "core",
  "infra",
  "memory",
  "gateway",
  "skills",
  "scheduler",
  "agent",
  "channels",
  "cli",
  "daemon",
  "web",
];

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
    filter: (src) => !src.endsWith(".test.js") && !src.endsWith(".test.d.ts") && !src.endsWith(".test.d.ts.map"),
  });

  // Copy package.json with dependencies stripped — all external deps are
  // listed at the comisai top level, so bundled packages don't need their own.
  // This prevents npm from trying to install transitive deps (like baileys)
  // from the bundled packages, which causes preinstall script failures.
  const bundledPkgJson = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));
  delete bundledPkgJson.dependencies;
  delete bundledPkgJson.devDependencies;
  delete bundledPkgJson.peerDependencies;
  writeFileSync(join(destDir, "package.json"), JSON.stringify(bundledPkgJson, null, 2) + "\n");

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
// pnpm creates symlinks like node_modules/sd-notify -> ../../node_modules/.pnpm/...
// npm follows these and creates invalid path-traversal entries in the tarball.
// Keep only @comis/ (our bundled packages) and remove everything else.
const entries = readdirSync(bundledModules);
let removed = 0;
for (const entry of entries) {
  if (entry === "@comis") continue;
  const entryPath = join(bundledModules, entry);
  const stat = lstatSync(entryPath);
  if (stat.isSymbolicLink() || entry === ".bin") {
    rmSync(entryPath, { recursive: true, force: true });
    removed++;
  }
}
if (removed > 0) {
  console.log(`  removed ${removed} pnpm symlinks from node_modules/`);
}

// --- Step 4: Generate npm-shrinkwrap.json ---
// Locks the entire transitive dep tree with SHA-512 integrity hashes so that
// consumers running `npm install -g comisai` get the exact tree we tested
// against, regardless of caret ranges in transitive package.json files.
// Without this, a compromised patch published one level down (event-stream /
// ua-parser-js / node-ipc style) flows through to fresh installs automatically.
// npm always includes npm-shrinkwrap.json in published tarballs.
const shrinkwrapPath = join(comisRoot, "npm-shrinkwrap.json");
const lockPath = join(comisRoot, "package-lock.json");
if (existsSync(shrinkwrapPath)) rmSync(shrinkwrapPath);
if (existsSync(lockPath)) rmSync(lockPath);

execSync("npm install --package-lock-only --ignore-scripts --omit=dev --no-audit --no-fund", {
  cwd: comisRoot,
  stdio: "pipe",
});
renameSync(lockPath, shrinkwrapPath);
console.log("  generated npm-shrinkwrap.json");

console.log("prepack: done");
