// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace version alignment — the guard for the cross-package version-drift
 * class that a clean text merge cannot surface.
 *
 * Every `packages/*` manifest must carry the SAME version. The umbrella
 * `comisai` package bundles the `@comis/*` packages via `bundledDependencies`,
 * so a package left behind at an older version is not a cosmetic
 * inconsistency — the drift reaches the published tarball and surfaces at
 * publish time rather than in any local build.
 *
 * The drift is invisible to Git. A release bump on the default branch touches
 * only the packages that exist THERE; a feature branch that adds a NEW package
 * has nothing for the merge to conflict on, so the new package silently keeps
 * its pre-bump version while every sibling moves. That is exactly how
 * `@comis/capability-service-sdk` stayed at 1.0.60 while the other sixteen
 * packages merged cleanly to 1.0.63 — no conflict, no failing gate, caught only
 * by enumerating the versions by hand.
 *
 * Two layers are asserted here:
 *  1. the static manifest invariant, so the drift fails `pnpm validate`
 *     locally at merge time, before a push; and
 *  2. the release preflight (`verify-release-tag.mjs`), so a tag whose version
 *     disagrees with ANY workspace package — not merely the umbrella — is
 *     rejected before publishing. The preflight is exercised against a
 *     synthetic workspace in a temp dir so the assertion proves the script's
 *     real behavior without mutating this repo's manifests.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const PREFLIGHT_REL = join(".github", "scripts", "verify-release-tag.mjs");
const PREFLIGHT = resolve(REPO_ROOT, PREFLIGHT_REL);

interface Manifest {
  name?: string;
  version?: string;
}

/** Every `packages/<name>` workspace dir that has a `package.json`. */
function workspaceManifests(): Array<{ dir: string; name: string; version: string }> {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(PACKAGES_ROOT, e.name, "package.json")))
    .map((e) => {
      const manifest = JSON.parse(
        readFileSync(resolve(PACKAGES_ROOT, e.name, "package.json"), "utf8"),
      ) as Manifest;
      return { dir: e.name, name: manifest.name ?? e.name, version: manifest.version ?? "" };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Stand up a throwaway workspace holding a copy of the real preflight script,
 * so the script's own repo-root resolution (`<script>/../..`) lands on the
 * synthetic `packages/` tree.
 */
function runPreflightAgainst(versions: Record<string, string>, tag: string): ReturnType<typeof spawnSync> {
  const root = mkdtempSync(join(tmpdir(), "comis-preflight-"));
  try {
    mkdirSync(join(root, ".github", "scripts"), { recursive: true });
    copyFileSync(PREFLIGHT, join(root, PREFLIGHT_REL));
    for (const [dir, version] of Object.entries(versions)) {
      mkdirSync(join(root, "packages", dir), { recursive: true });
      writeFileSync(
        join(root, "packages", dir, "package.json"),
        JSON.stringify({ name: dir === "comis" ? "comisai" : `@comis/${dir}`, version }, null, 2),
      );
    }
    return spawnSync("node", [join(root, PREFLIGHT_REL), tag], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("workspace package version alignment", () => {
  const manifests = workspaceManifests();

  it("has more than one workspace package (sanity: the walker resolved the repo)", () => {
    expect(manifests.length).toBeGreaterThan(1);
  });

  it("every packages/* manifest declares a version", () => {
    const missing = manifests.filter((m) => m.version === "").map((m) => m.dir);
    expect(missing, `packages missing a "version" field: [${missing.join(", ")}]`).toEqual([]);
  });

  it("every packages/* manifest carries the SAME version as the umbrella", () => {
    const umbrella = manifests.find((m) => m.name === "comisai");
    expect(umbrella, "packages/comis must declare the umbrella `comisai` package").toBeDefined();
    const expected = umbrella!.version;

    const drifted = manifests
      .filter((m) => m.version !== expected)
      .map((m) => `${m.name}@${m.version}`);

    expect(
      drifted,
      `these packages disagree with the umbrella version ${expected}: [${drifted.join(", ")}]. ` +
        `All packages/* versions must move together — the umbrella bundles the @comis/* packages ` +
        `via bundledDependencies, so drift ships in the published tarball and surfaces at publish ` +
        `time, not in a local build. A clean merge CANNOT catch this: a release bump on the default ` +
        `branch never touches a package that exists only on the feature branch.`,
    ).toEqual([]);
  });
});

describe("release preflight rejects a tag that disagrees with any workspace package", () => {
  it("accepts a tag when every workspace package agrees", () => {
    const result = runPreflightAgainst({ comis: "9.9.9", core: "9.9.9", skills: "9.9.9" }, "v9.9.9");
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a tag when a NON-umbrella package lags behind", () => {
    const result = runPreflightAgainst({ comis: "9.9.9", core: "9.9.9", skills: "9.9.8" }, "v9.9.9");
    expect(
      result.status,
      "the preflight passed while @comis/skills lagged the tag — this is the drift class that " +
        "reached the merge unguarded; the gate must read EVERY packages/* manifest, not only the umbrella",
    ).not.toBe(0);
    expect(result.stderr).toContain("@comis/skills");
  });

  it("still rejects a tag that disagrees with the umbrella itself", () => {
    const result = runPreflightAgainst({ comis: "9.9.9", core: "9.9.9" }, "v0.0.0");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/does not match/i);
  });
});
