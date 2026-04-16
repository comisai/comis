#!/usr/bin/env node

/**
 * Postpack script — restores workspace:* references in package.json
 * after npm pack/publish has captured the resolved versions in the tarball.
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const comisRoot = resolve(__dirname, "..");

const pkgPath = join(comisRoot, "package.json");
const backupPath = join(comisRoot, "package.json.workspace-backup");

if (existsSync(backupPath)) {
  const original = readFileSync(backupPath, "utf8");
  writeFileSync(pkgPath, original);
  rmSync(backupPath);
  console.log("postpack: restored package.json with workspace:* references");
}
