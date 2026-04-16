#!/usr/bin/env node

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

import { cpSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  cpSync(distSrc, join(destDir, "dist"), { recursive: true });

  // Copy package.json
  cpSync(join(srcDir, "package.json"), join(destDir, "package.json"));

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

let rewritten = 0;
if (pkg.dependencies) {
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    if (typeof version === "string" && version.startsWith("workspace:")) {
      const real = resolvedVersions[name];
      if (real) {
        pkg.dependencies[name] = real;
        rewritten++;
      }
    }
  }
}

if (rewritten > 0) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  resolved ${rewritten} workspace:* references to real versions`);
}

console.log("prepack: done");
