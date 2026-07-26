// SPDX-License-Identifier: Apache-2.0
/**
 * Dockerfile corepack pnpm pin — the local guard for the pnpm-version drift class.
 *
 * The root `package.json` declares the authoritative package manager via
 * `packageManager: "pnpm@<version>"`, and every Dockerfile independently
 * re-pins the same version with `corepack prepare pnpm@<version> --activate`.
 * Those pins are hand-maintained and there is no tooling that moves them
 * together: a dependency bot bumping `packageManager` leaves the Dockerfiles
 * behind, so the image builds its `--frozen-lockfile` install with a different
 * pnpm than the one that wrote `pnpm-lock.yaml`.
 *
 * `pnpm validate` cannot catch this. It runs the locally-installed pnpm against
 * the local workspace and never reads a Dockerfile, so the drift is invisible to
 * every deterministic gate and surfaces only when the Docker Release workflow
 * builds an image — the same blind spot that let the `@comis/observability-otel`
 * COPY-list drift reach CI (see `dockerfile-workspace-packages.test.ts`).
 *
 * This is a STATIC, cross-platform invariant (no Docker daemon, no Linux), so
 * the drift is caught locally under `test:coverage` instead of in CI.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** Every Dockerfile that activates pnpm through corepack. */
const DOCKERFILES = ["Dockerfile", "Dockerfile.install", "Dockerfile.web"] as const;

const COREPACK_PNPM = /corepack\s+prepare\s+pnpm@(\S+?)\s+--activate/g;

function declaredPackageManagerVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  const declared = manifest.packageManager;
  expect(declared, "root package.json must declare packageManager").toBeTruthy();
  const [name, version] = declared!.split("@");
  expect(name, "packageManager must be pnpm").toBe("pnpm");
  return version;
}

describe("Dockerfile corepack pnpm pins", () => {
  it("every corepack pnpm pin matches the packageManager version in root package.json", () => {
    const expected = declaredPackageManagerVersion();
    const violations: string[] = [];

    for (const file of DOCKERFILES) {
      const contents = readFileSync(resolve(REPO_ROOT, file), "utf8");
      const lines = contents.split("\n");

      lines.forEach((line, index) => {
        for (const match of line.matchAll(COREPACK_PNPM)) {
          const pinned = match[1];
          if (pinned !== expected) {
            violations.push(
              `${file}:${index + 1} pins pnpm@${pinned} but package.json declares pnpm@${expected}`,
            );
          }
        }
      });
    }

    expect(
      violations,
      `Dockerfile pnpm pins drifted from the declared packageManager. ` +
        `An image built this way installs a frozen lockfile with a pnpm that did not write it. ` +
        `Move every pin together:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("each Dockerfile that installs dependencies actually pins pnpm through corepack", () => {
    const missing = DOCKERFILES.filter((file) => {
      const contents = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return !/corepack\s+prepare\s+pnpm@/.test(contents);
    });

    expect(
      missing,
      `These Dockerfiles no longer pin pnpm via corepack, so the image would resolve ` +
        `whatever pnpm the base image ships: ${missing.join(", ")}. ` +
        `Either restore the pin or drop the file from DOCKERFILES in this test.`,
    ).toEqual([]);
  });
});
