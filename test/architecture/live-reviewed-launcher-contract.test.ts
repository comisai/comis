// SPDX-License-Identifier: Apache-2.0
/**
 * Reviewed-launcher provisioning guard.
 *
 * The capability-service live gates cannot run on a host that does not already
 * carry a reviewed launcher at a fixed absolute path. Nothing in the repository
 * created those files, so the deterministic E0 mechanics gate was reproducible
 * only on a host somebody had prepared by hand — the setup lived in nobody's
 * tree.
 *
 * Two contracts ride on each launcher, and both fail far from their cause:
 *
 *  - `launcherHash()` READS the file to compute the terminal-allowlist pin, so
 *    an absent launcher kills the whole describe block in `beforeAll` with a
 *    bare ENOENT that names a path no test creates.
 *  - DevCrew probes `<launcher> --version` while composing the service and
 *    compares stdout to the exact pinned version. A launcher that answers
 *    anything else surfaces only as `Failure cause: codex_composition` from a
 *    socket timeout — several layers above the probe that actually refused.
 *
 * So this pins the provisioning script to the gates it serves: every launcher
 * path a gate references must be installed, and every version a gate pins must
 * be the version the launcher reports. Bumping `--codex-version` in a scenario
 * without moving the provisioner is the drift this exists to catch.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const SCENARIOS = "test/live/scenarios/capability-service";
const PROVISIONER = `${SCENARIOS}/provision-reviewed-launchers.sh`;

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

/** Absolute launcher paths the live gates pin, in declaration order. */
function pinnedLauncherPaths(): string[] {
  const found = new Set<string>();
  for (const file of ["e0-mechanics.test.ts", "e0-journey.test.ts", "wave4-join.test.ts"]) {
    for (const match of read(`${SCENARIOS}/${file}`).matchAll(/"(\/usr\/local\/bin\/[a-z0-9-]*launcher)"/gu)) {
      found.add(match[1]!);
    }
  }
  return [...found].sort();
}

/**
 * Harness versions the gates require the launcher to report verbatim.
 *
 * A flag is written either as a bare literal or as an env override with a
 * literal default (`process.env[...] ?? "2.1.233 (Claude Code)"`). The pinned
 * value is the LAST literal on the line in both forms — taking the first would
 * capture the env-var NAME and pin the provisioner to a string no probe ever
 * returns.
 */
function pinnedVersions(): string[] {
  const source = read(`${SCENARIOS}/wave4-join.test.ts`);
  const found = new Set<string>();
  for (const line of source.split("\n")) {
    if (!/"--(?:codex|claude)-version"/u.test(line)) continue;
    const literals = [...line.matchAll(/"([^"]+)"/gu)].map((m) => m[1]!);
    const pinned = literals.at(-1);
    if (pinned !== undefined) found.add(pinned);
  }
  return [...found].sort();
}

describe("reviewed launcher provisioning", () => {
  it("installs every launcher path the live gates pin", () => {
    const script = read(PROVISIONER);
    const paths = pinnedLauncherPaths();
    expect(paths.length, "gates pin at least one launcher").toBeGreaterThan(0);
    for (const path of paths) expect(script, `${path} is provisioned`).toContain(path);
  });

  it("reports every harness version the live gates require", () => {
    const script = read(PROVISIONER);
    const versions = pinnedVersions();
    expect(versions.length, "gates pin at least one harness version").toBeGreaterThan(0);
    for (const version of versions) expect(script, `${version} is provisioned`).toContain(version);
  });

  it("gives the generated launchers an absolute interpreter", () => {
    const script = read(PROVISIONER);
    // The version probe runs with a sanitized environment that can be empty, so
    // `#!/usr/bin/env bash` cannot resolve `bash` and the probe reads as an
    // unavailable executable rather than a bad shebang.
    expect(script).toContain("#!/bin/bash");
    const generated = script.slice(script.indexOf("<<LAUNCHER"));
    expect(generated, "generated launcher avoids env-based shebang").not.toContain("#!/usr/bin/env");
  });
});
