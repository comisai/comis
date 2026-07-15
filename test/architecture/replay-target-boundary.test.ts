// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const packagesRoot = resolve(repoRoot, "packages");
const expectedReader = "packages/daemon/src/replay-quarantine.ts";

function repoRelative(path: string): string {
  return relative(repoRoot, path).split(sep).join("/");
}

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === "dist" || entry.name === "node_modules") continue;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(absolutePath);
      else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(absolutePath);
      }
    }
  }
  walk(root);
  return files;
}

describe("replay target environment boundary", () => {
  it("keeps the replay-target flag in its single daemon resolver", () => {
    const readers = productionTypeScriptFiles(packagesRoot)
      .filter((path) => readFileSync(path, "utf8").includes("COMIS_REPLAY_TARGET"))
      .map(repoRelative)
      .sort();

    expect(readers).toEqual([expectedReader]);
    const resolverSource = readFileSync(resolve(repoRoot, expectedReader), "utf8");
    expect(resolverSource.split("COMIS_REPLAY_TARGET")).toHaveLength(2);
    expect(resolverSource.match(/env\.get\(REPLAY_FLAG\)/gu)).toHaveLength(1);
    expect(resolverSource).not.toContain("process.env[REPLAY_FLAG]");
  });

  it("keeps the executable free of static live-composition imports", () => {
    const daemonSource = readFileSync(
      resolve(repoRoot, "packages/daemon/src/daemon-entrypoint.ts"),
      "utf8",
    );
    expect(daemonSource).toContain('import("./daemon.js")');
    expect(daemonSource).not.toMatch(/(?:from\s+|import\s+)["']\.\/daemon\.js["']/u);
    expect(daemonSource).not.toContain("./wiring/");

    const liveSource = readFileSync(
      resolve(repoRoot, "packages/daemon/src/daemon.ts"),
      "utf8",
    );
    expect(liveSource).not.toContain("COMIS_REPLAY_TARGET");
    expect(liveSource).not.toContain("isDirectRun");
  });

  it("keeps restore mutation behind role intent and action selection", () => {
    const daemonSource = readFileSync(
      resolve(repoRoot, "packages/daemon/src/daemon-entrypoint.ts"),
      "utf8",
    );
    const runDirect = daemonSource.slice(daemonSource.indexOf("async function runDirect"));
    const resolveIntent = runDirect.indexOf("resolveIntent");
    const selectAction = runDirect.indexOf("selectDaemonEntrypointAction");
    const restore = runDirect.indexOf("handleRestoreFlag");

    expect(resolveIntent).toBeGreaterThan(0);
    expect(selectAction).toBeGreaterThan(resolveIntent);
    expect(restore).toBeGreaterThan(selectAction);
  });

  it("uses a sealed restore record instead of traversing the mutable clone", () => {
    const resolverSource = readFileSync(resolve(repoRoot, expectedReader), "utf8");

    expect(resolverSource).toContain("restoreAttestation.read()");
    expect(resolverSource).toContain("O_NOFOLLOW");
    expect(resolverSource).not.toContain("createReadStream");
    expect(resolverSource).not.toContain("collectInventory");
    expect(resolverSource).not.toContain("readdir(");
    expect(resolverSource).not.toContain("readlink(");
  });
});
