// SPDX-License-Identifier: Apache-2.0
/**
 * Guards npm-installability of the versions we pin.
 *
 * pnpm treats an unsatisfied peer dependency as a warning and installs anyway,
 * so the workspace stays green while the published package becomes
 * un-installable: `npm install` fails the same conflict with `ERESOLVE`. No
 * other gate sees it — `pnpm validate` installs through pnpm, and the tarball
 * smoke packs the tarball without ever installing it.
 *
 * The live failure: `@hono/node-server` was bumped 1.19.14 -> 2.0.11 while
 * `@hono/node-ws@1.3.1` still declared `peerDependencies: { "@hono/node-server":
 * "^1.19.11" }` (upstream has published no `@hono/node-ws` that accepts 2.x).
 * pnpm warned; npm refused. That broke the installer's bundled-dependency
 * repair pass, which runs a plain `npm install` inside the installed package,
 * and left the CLI unable to load.
 *
 * A violation is only reported when the SAME package.json pins both the
 * dependent and the peer — that is the pairing we control and can fix by
 * choosing a compatible version. Optional peers are exempt: npm does not fail
 * on those.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { formatViolations, type ViolationCitation } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** Manifests we publish or install from: every workspace package. */
function workspaceManifests(): { file: string; manifest: Manifest }[] {
  const out: { file: string; manifest: Manifest }[] = [];
  for (const pkg of readdirSync(join(REPO_ROOT, "packages")).sort()) {
    const file = join("packages", pkg, "package.json");
    const abs = join(REPO_ROOT, file);
    if (existsSync(abs)) {
      out.push({ file, manifest: readJson(abs) });
    }
  }
  return out;
}

/** The installed copy of a dependency, or null when it is not a real package. */
function installedManifest(name: string): Manifest | null {
  const abs = join(REPO_ROOT, "node_modules", name, "package.json");
  return existsSync(abs) ? readJson(abs) : null;
}

describe("npm peer consistency", () => {
  it("pins versions that satisfy every declared peer we also pin", () => {
    const violations: ViolationCitation[] = [];

    for (const { file, manifest } of workspaceManifests()) {
      const deps = manifest.dependencies ?? {};

      for (const [name, pin] of Object.entries(deps)) {
        if (pin.startsWith("workspace:")) {
          continue;
        }
        const installed = installedManifest(name);
        if (installed === null) {
          continue;
        }

        for (const [peerName, range] of Object.entries(installed.peerDependencies ?? {})) {
          if (installed.peerDependenciesMeta?.[peerName]?.optional === true) {
            continue;
          }
          const ourPin = deps[peerName];
          // Only the pairs this manifest itself controls. A peer we do not pin
          // is npm's problem to resolve, not a conflict we introduced.
          if (ourPin === undefined || ourPin.startsWith("workspace:")) {
            continue;
          }
          if (!semver.satisfies(ourPin, range)) {
            violations.push({
              file,
              line: 0,
              snippet: `${name}@${pin} requires peer ${peerName}@"${range}", but this manifest pins ${peerName}@${ourPin} — npm install fails with ERESOLVE`,
            });
          }
        }
      }
    }

    expect(
      violations,
      formatViolations({
        description: "A pinned version violates a dependency's peer range; npm refuses to install it.",
        violations,
        suggestedFix:
          "Pin a pair npm can resolve: move the peer back to a version inside the declared range, or upgrade the dependent to a release whose peer range covers the new major. pnpm only warns here, so the conflict surfaces first in a user's `npm install`.",
        designRef:
          "CLAUDE.md — supply-chain invariants: every dependency is exact-pinned, and the published tarball must install under npm",
      }),
    ).toEqual([]);
  });
});
