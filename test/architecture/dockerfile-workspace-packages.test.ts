// SPDX-License-Identifier: Apache-2.0
/**
 * Dockerfile workspace-package COPY completeness — the local guard for the
 * Docker-build dependency-drift class.
 *
 * The full-build Dockerfiles (`Dockerfile`, `Dockerfile.install`) seed the
 * dependency install by COPYing each `packages/<name>/package.json` BEFORE
 * `pnpm install --frozen-lockfile`, then build the WHOLE workspace
 * (`pnpm -r build` / `pnpm build`). The COPY list is hand-maintained, so it
 * drifts: when a NEW workspace package is added, its `package.json` must also be
 * added to the COPY list or `pnpm install` never fetches its dependencies and
 * the image build fails at `tsc` time.
 *
 * Live incident: `@comis/observability-otel` was added but NOT added to
 * the COPY list → `error TS2307: Cannot find module '@opentelemetry/*'` — which
 * `pnpm validate` could NOT catch (it builds the FULL local workspace where the
 * deps are already installed; only the Docker image has the selective per-package
 * COPY layer). It surfaced only in the Docker Release CI job.
 *
 * This is a STATIC, cross-platform invariant (no Docker daemon, no Linux) that
 * keeps the COPY list in sync with the actual `packages/*` workspace — so the
 * drift is caught locally in `pnpm validate` (the architecture project runs under
 * `test:coverage`), not in CI.
 *
 * `Dockerfile.web` is a MINIMAL builder (`pnpm --filter @comis/web build`, only
 * `@comis/web` + its workspace deps) and is intentionally NOT covered here.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");

/**
 * The Dockerfiles that build the ENTIRE workspace and therefore MUST COPY every
 * `packages/*` `package.json` before the frozen install. (Both run a full
 * `pnpm -r build`; a missing package breaks the install/build.)
 */
const FULL_BUILD_DOCKERFILES = ["Dockerfile", "Dockerfile.install"];

/** Every `packages/<name>` workspace dir that has a `package.json`. */
function workspacePackages(): string[] {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(PACKAGES_ROOT, e.name, "package.json")))
    .map((e) => e.name)
    .sort();
}

/**
 * The set of `<name>`s COPY'd via `COPY packages/<name>/package.json …` in the
 * install LAYER (before the first `pnpm install --frozen-lockfile`; COPYs after
 * the install do not seed it).
 */
function copiedBeforeInstall(dockerfile: string): Set<string> {
  const src = readFileSync(resolve(REPO_ROOT, dockerfile), "utf8");
  const installIdx = src.search(/pnpm install --frozen-lockfile/);
  const head = installIdx === -1 ? src : src.slice(0, installIdx);
  const copied = new Set<string>();
  const re = /^\s*COPY\s+packages\/([^/\s]+)\/package\.json\b/gm;
  for (let m = re.exec(head); m !== null; m = re.exec(head)) copied.add(m[1]!);
  return copied;
}

describe("Dockerfile workspace-package COPY completeness", () => {
  const pkgs = workspacePackages();

  it("has at least one workspace package (sanity: the walker resolved the repo)", () => {
    expect(pkgs.length).toBeGreaterThan(0);
  });

  for (const dockerfile of FULL_BUILD_DOCKERFILES) {
    it(`${dockerfile} COPYs every packages/* package.json before the frozen install`, () => {
      const copied = copiedBeforeInstall(dockerfile);
      const missing = pkgs.filter((p) => !copied.has(p));
      expect(
        missing,
        `${dockerfile} is missing a per-package COPY for: [${missing.join(", ")}]. ` +
          `Their dependencies will NOT install in the Docker build → the image build fails at tsc ` +
          `(e.g. the v2.28 observability-otel @opentelemetry TS2307). Add ` +
          `"COPY packages/<name>/package.json packages/<name>/" before "pnpm install --frozen-lockfile".`,
      ).toEqual([]);
    });
  }
});
