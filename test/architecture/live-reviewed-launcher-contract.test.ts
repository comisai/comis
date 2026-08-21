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
 *  - The companion probes `<launcher> --version` while composing the service
 *    and compares stdout to the exact pinned version. A launcher that answers
 *    anything else — including one that demands its reviewed token first,
 *    because `--version` is not that token — surfaces only as
 *    `Failure cause: codex_composition` from a socket timeout, several layers
 *    above the probe that actually refused.
 *
 * So this pins the provisioning script to the gates it serves: every launcher
 * path a gate references must be installed, and every version a gate pins must
 * be the version the launcher reports. Bumping `--codex-version` in a scenario
 * without moving the provisioner is the drift this exists to catch.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  it("keeps service-backed live fixtures on a valid integration policy", () => {
    for (const file of ["e0-journey.test.ts", "wave4-join.test.ts"]) {
      expect(read(`${SCENARIOS}/${file}`), `${file} supplies an integration policy`).toContain(
        'integrationPolicies: [{ id: "integration-default", strategy: "merge" }]',
      );
    }
  });

  it("keeps the journey forge check response complete", () => {
    const source = read(`${SCENARIOS}/e0-journey.test.ts`);
    expect(source, "GitHub check-runs truth includes its required total").toContain(
      "total_count: 1,",
    );
  });

  it("reviews the scout decision inventory before cleanup", () => {
    const source = read(`${SCENARIOS}/e0-journey.test.ts`);
    expect(source, "the liaison records the reviewed scout inventory").toContain(
      'tool: "attest_scout_decisions"',
    );
    const deployment = read(`${SCENARIOS}/wave4-join.test.ts`);
    expect(deployment, "the deployment contribution binds the attestation tool").toContain(
      'toolName: "attest_scout_decisions"',
    );
    expect(deployment, "attestation is a service-scoped mutation, not a live-run command").toContain(
      'toolName: "attest_scout_decisions",\n    behavior: "read_only" as const,\n    actionClassification: "mutate" as const',
    );
    expect(
      deployment.match(/"attest_scout_decisions"/gu),
      "the managed binding and both MCP allowlists agree",
    ).toHaveLength(3);
  });

  it("installs every launcher the live gates pin, under the reviewed prefix", () => {
    const script = read(PROVISIONER);
    const paths = pinnedLauncherPaths();
    expect(paths.length, "gates pin at least one launcher").toBeGreaterThan(0);
    for (const path of paths) {
      // The script installs by name under a prefix, so the NAME is what must
      // appear; the prefix is asserted separately below.
      expect(script, `${path} is provisioned`).toContain(path.split("/").pop()!);
      expect(path.slice(0, path.lastIndexOf("/"))).toBe("/usr/local/bin");
    }
    // The reviewed prefix is the default. LAUNCHER_PREFIX exists for the
    // hermetic gate below, not as a way to install somewhere unreviewed.
    expect(script).toContain('PREFIX="${LAUNCHER_PREFIX:-/usr/local/bin}"');
  });

  it("reports every harness version the live gates require", () => {
    const script = read(PROVISIONER);
    const versions = pinnedVersions();
    expect(versions.length, "gates pin at least one harness version").toBeGreaterThan(0);
    for (const version of versions) expect(script, `${version} is provisioned`).toContain(version);
  });

  it("provisions launchers that answer the probe with the pinned versions", () => {
    // Executing the script is the point. A text-only check passed a provisioner
    // that could not run at all: a `local` referencing a sibling assignment in
    // the same statement, which `set -u` rejects. It then passed a second one
    // whose stub check asked `command -v` while the launcher delegated to
    // "$PREFIX/$tool" — so an ambient harness suppressed the stub and the
    // launcher pointed at a path nothing created.
    //
    // The run is hermetic: a temp prefix and a minimal PATH, so an ambient
    // harness on the developer's machine cannot change what is asserted.
    const prefix = mkdtempSync(join(tmpdir(), "reviewed-launchers-"));
    try {
      const env = { PATH: "/usr/bin:/bin", LAUNCHER_PREFIX: prefix };
      const provision = spawnSync("/bin/bash", [resolve(REPO_ROOT, PROVISIONER)], {
        env, encoding: "utf8",
      });
      expect(provision.status, `provisioner failed: ${provision.stderr}`).toBe(0);

      const versions = pinnedVersions();
      const reported = pinnedLauncherPaths().map((path) => {
        const probe = spawnSync(join(prefix, path.split("/").pop()!), ["--version"], {
          env, encoding: "utf8",
        });
        expect(probe.status, `probe failed: ${probe.stderr}`).toBe(0);
        return probe.stdout.trim();
      });

      // Every launcher answers a pinned version, and every pinned version is
      // answered by some launcher — neither direction alone catches a swap.
      for (const answer of reported) expect(versions).toContain(answer);
      for (const version of versions) expect(reported).toContain(version);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("gives the generated launchers an absolute interpreter", () => {
    const script = read(PROVISIONER);
    // The probe inherits the environment today only because no probe
    // environment is configured. The adapter accepts one, and such an
    // environment need not carry PATH — which `#!/usr/bin/env bash` requires to
    // resolve `bash`. A failure there reads as an unavailable executable rather
    // than a bad shebang, so an absolute interpreter is cheap insurance.
    expect(script).toContain("#!/bin/bash");
    const generated = script.slice(script.indexOf("<<LAUNCHER"));
    expect(generated, "generated launcher avoids env-based shebang").not.toContain("#!/usr/bin/env");
  });
});
