#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const packagesRoot = resolve(repoRoot, "packages");

/**
 * Every `packages/*` manifest must agree with the release tag, not just the
 * umbrella. The umbrella bundles the `@comis/*` packages, so a package left at
 * an older version ships that drift in the published tarball. A clean merge
 * cannot catch it: a release bump on the default branch never touches a package
 * that exists only on a feature branch, so the new package keeps its pre-bump
 * version with no conflict to resolve.
 */
const manifests = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json")))
  .map((entry) => {
    const manifestPath = join(packagesRoot, entry.name, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return {
      name: manifest.name ?? entry.name,
      version: manifest.version,
      path: `packages/${entry.name}/package.json`,
    };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

const umbrella = manifests.find((manifest) => manifest.name === "comisai");
if (!umbrella) {
  console.error("Could not locate the comisai umbrella package under packages/.");
  process.exit(1);
}

const releaseTag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const expectedTag = `v${umbrella.version}`;

if (releaseTag !== expectedTag) {
  console.error(
    `Release tag ${releaseTag || "<missing>"} does not match comisai package version ${umbrella.version}.`,
  );
  process.exit(1);
}

const drifted = manifests.filter((manifest) => manifest.version !== umbrella.version);
if (drifted.length > 0) {
  console.error(
    `Release tag ${releaseTag} matches comisai, but these workspace packages disagree with version ${umbrella.version}:`,
  );
  for (const manifest of drifted) {
    console.error(`  ${manifest.name} is ${manifest.version ?? "<missing>"} (${manifest.path})`);
  }
  console.error("All packages/* versions must move together before tagging a release.");
  process.exit(1);
}

console.log(`Verified release tag ${releaseTag} across ${manifests.length} workspace packages.`);
