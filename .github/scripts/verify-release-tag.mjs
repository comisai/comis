#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "packages", "comis", "package.json"), "utf8"),
);

const releaseTag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const expectedTag = `v${packageJson.version}`;

if (releaseTag !== expectedTag) {
  console.error(
    `Release tag ${releaseTag || "<missing>"} does not match comisai package version ${packageJson.version}.`,
  );
  process.exit(1);
}

console.log(`Verified release tag ${releaseTag}.`);
