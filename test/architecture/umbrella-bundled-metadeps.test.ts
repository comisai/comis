// SPDX-License-Identifier: Apache-2.0
/**
 * Guards the two rules that keep the umbrella tarball's bundled
 * `node_modules/` inert for npm's reify planner.
 *
 * npm attributes a dependency to a bundled package's bundle whenever it
 * resolves into the bundling package's own `node_modules/` (arborist
 * `Node#getBundler()` returns the bundler as soon as one dependent is
 * bundled). A GLOBAL install nests every `comisai` dependency there, so npm
 * skips unpacking those packages — expecting the tarball to carry them — yet
 * still schedules their lifecycle scripts. The script then runs with a working
 * directory that was never created, which npm reports as `spawn sh ENOENT`.
 * A local install hoists the same packages to the project root, outside the
 * bundler, and succeeds; only `npm install -g` breaks, so this class of defect
 * reaches users through the installer rather than through any local test.
 *
 * The live failure: bundling `@earendil-works/pi-ai` with its dependency list
 * intact made npm claim all eleven of its dependencies for that bundle. Seven
 * of them were not top-level `comisai` dependencies at all, and one
 * (`@google/genai`) ships a `preinstall` script — so every global install died
 * before a single package was built.
 *
 * Two dimensions, each of which fails independently:
 *
 *   1. Hoisting — every runtime dependency of a third-party bundled package is
 *      a top-level `comisai` dependency (or is itself bundled). Without this,
 *      stripping rule 2 below would silently break the bundled copy's imports.
 *   2. Stripping — `prepack.js` routes every bundled copy's manifest through
 *      `toBundledManifest`, so no bundled copy declares dependencies.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPENDENCY_FIELDS,
  findUnhoistedRuntimeDeps,
  readManifest,
  resolveBundledSourceDir,
  thirdPartyBundledPackages,
  toBundledManifest,
} from "../../packages/comis/scripts/bundled-manifest.js";
import { formatViolations, type ViolationCitation } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PREPACK_PATH = resolve(REPO_ROOT, "packages/comis/scripts/prepack.js");
const UMBRELLA_MANIFEST = "packages/comis/package.json";
const PREPACK_SOURCE = "packages/comis/scripts/prepack.js";
const DESIGN_REF =
  "packages/comis/scripts/bundled-manifest.js — bundled copies declare no dependencies; their runtime deps are hoisted to the umbrella";

const umbrella = readManifest(resolve(REPO_ROOT, "packages/comis"));
const umbrellaDeps = (umbrella.dependencies ?? {}) as Record<string, string>;
const THIRD_PARTY_BUNDLED = thirdPartyBundledPackages(umbrella);

describe("umbrella bundled metadeps", () => {
  it("bundles at least one third-party package (guard stays load-bearing)", () => {
    expect(THIRD_PARTY_BUNDLED.length).toBeGreaterThan(0);
  });

  it("hoists every runtime dependency of a bundled package to the umbrella", () => {
    const violations: ViolationCitation[] = [];

    for (const name of THIRD_PARTY_BUNDLED) {
      const sourceDir = resolveBundledSourceDir(REPO_ROOT, name, umbrellaDeps[name]);
      if (sourceDir === null) {
        violations.push({
          file: UMBRELLA_MANIFEST,
          line: 0,
          snippet: `${name} is bundled but not installed — run \`pnpm install\` (searched node_modules/ and the pnpm store for ${umbrellaDeps[name] ?? "an unpinned version"})`,
        });
        continue;
      }

      const missing = findUnhoistedRuntimeDeps(readManifest(sourceDir), umbrella);
      if (missing.length > 0) {
        violations.push({
          file: UMBRELLA_MANIFEST,
          line: 0,
          snippet: `bundled ${name} needs ${missing.length} package(s) the umbrella does not provide: ${missing.join(", ")}`,
        });
      }
    }

    expect(
      violations,
      formatViolations({
        description: "A bundled package depends on packages the umbrella does not provide.",
        violations,
        suggestedFix:
          "Add each listed package to packages/comis/package.json dependencies as an exact pin. Its dependency list is stripped from the bundled copy, so the umbrella is the only thing that installs it — without the pin, a global install drops it and the bundled copy's imports fail at runtime.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("strips every dependency field from a bundled manifest", () => {
    const bundled = toBundledManifest({
      name: "@earendil-works/pi-ai",
      version: "0.80.10",
      main: "./dist/index.js",
      dependencies: { "@google/genai": "1.52.0" },
      devDependencies: { vitest: "1.0.0" },
      peerDependencies: { zod: "4.x" },
      optionalDependencies: { fsevents: "2.x" },
    });

    for (const field of DEPENDENCY_FIELDS) {
      expect(bundled, `${field} must not survive into the bundled copy`).not.toHaveProperty(field);
    }
    expect(bundled).toEqual({
      name: "@earendil-works/pi-ai",
      version: "0.80.10",
      main: "./dist/index.js",
    });
  });

  it("routes every bundled copy in prepack through the shared strip helper", () => {
    const prepack = readFileSync(PREPACK_PATH, "utf8");
    const violations: ViolationCitation[] = [];

    if (!prepack.includes("bundled-manifest.js")) {
      violations.push({
        file: PREPACK_SOURCE,
        line: 0,
        snippet: "does not import ./bundled-manifest.js — a hand-rolled copy re-opens the defect",
      });
    }

    // A raw copy of a registry package.json carries its dependency list into
    // the tarball, which is exactly what makes npm claim those dependencies
    // for the bundle and skip unpacking them.
    if (/cpSync\([^)]*"package\.json"/s.test(prepack)) {
      violations.push({
        file: PREPACK_SOURCE,
        line: 0,
        snippet: "copies a package.json verbatim into node_modules/ — write it through the helper",
      });
    }

    const stripCalls = prepack.match(/serializeBundledManifest\(/g) ?? [];
    if (stripCalls.length < 2) {
      violations.push({
        file: PREPACK_SOURCE,
        line: 0,
        snippet: `calls serializeBundledManifest ${stripCalls.length} time(s); both the workspace copies and the third-party copies must be stripped`,
      });
    }

    expect(
      violations,
      formatViolations({
        description: "prepack.js can leave a bundled copy's dependency list intact.",
        violations,
        suggestedFix:
          "Write every bundled node_modules/ package.json with serializeBundledManifest() from ./bundled-manifest.js instead of copying the source manifest.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });
});
