// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest rules for the packages copied into the umbrella tarball's bundled
 * `node_modules/`.
 *
 * npm counts a dependency of a bundled package as part of that bundle whenever
 * it resolves into the bundling package's own `node_modules/` — arborist's
 * `Node#getBundler()` walks `edgesIn` and returns the bundler as soon as one
 * dependent is itself bundled. A GLOBAL install places every dependency of
 * `comisai` under `node_modules/comisai/node_modules/`, which is exactly that
 * directory, so npm skips unpacking those packages (it expects the tarball to
 * carry them) while still scheduling their lifecycle scripts. A script whose
 * package was never unpacked runs with a working directory that does not
 * exist, and npm reports that as `spawn sh ENOENT`. A local install hoists the
 * same packages to the project root instead, outside the bundler, so it
 * succeeds — the failure only reaches users through `npm install -g`.
 *
 * Two rules keep a bundled copy inert:
 *
 *   1. It declares no dependencies, so npm never attributes another package to
 *      its bundle.
 *   2. Everything it needs at runtime is a top-level dependency of the umbrella
 *      package, so npm installs it normally and Node resolves it by walking up
 *      from the bundled copy.
 *
 * Both rules are enforced at pack time by `prepack.js` and at test time by
 * `test/architecture/umbrella-bundled-metadeps.test.ts`.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Manifest fields that make npm plan a subtree for a bundled package. */
export const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

/**
 * Strip every dependency field from a package manifest that is about to be
 * written into the bundled `node_modules/` tree. Rule 1.
 *
 * @param {Record<string, unknown>} sourceManifest
 * @returns {Record<string, unknown>}
 */
export function toBundledManifest(sourceManifest) {
  const manifest = { ...sourceManifest };
  for (const field of DEPENDENCY_FIELDS) {
    delete manifest[field];
  }
  return manifest;
}

/**
 * Serialize a bundled manifest exactly the way the tarball carries it.
 *
 * @param {Record<string, unknown>} sourceManifest
 * @returns {string}
 */
export function serializeBundledManifest(sourceManifest) {
  return JSON.stringify(toBundledManifest(sourceManifest), null, 2) + "\n";
}

/**
 * Read a `package.json` from a directory.
 *
 * @param {string} dir
 * @returns {Record<string, unknown>}
 */
export function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/**
 * Locate the installed source directory for a third-party bundled package.
 * Direct workspace dependencies live in the hoisted `node_modules/`; anything
 * reached transitively (or through a pnpm patch, whose store directory carries
 * a `_patch_hash` suffix) only exists inside the pnpm store.
 *
 * @param {string} monoRoot
 * @param {string} name
 * @param {string | undefined} version
 * @returns {string | null}
 */
export function resolveBundledSourceDir(monoRoot, name, version) {
  const hoisted = join(monoRoot, "node_modules", name);
  if (existsSync(join(hoisted, "package.json"))) {
    return hoisted;
  }
  if (!version) {
    return null;
  }
  const stored = join(
    monoRoot,
    "node_modules",
    ".pnpm",
    `${name.replace("/", "+")}@${version}`,
    "node_modules",
    name,
  );
  return existsSync(join(stored, "package.json")) ? stored : null;
}

/**
 * The bundled packages that are not `@comis/*` workspace packages. Their
 * manifests come from the registry, so they arrive with dependency fields that
 * must be stripped and hoisted rather than authored away.
 *
 * @param {Record<string, unknown>} umbrellaManifest
 * @returns {string[]}
 */
export function thirdPartyBundledPackages(umbrellaManifest) {
  const bundled = /** @type {string[]} */ (umbrellaManifest.bundledDependencies ?? []);
  return bundled.filter((name) => typeof name === "string" && !name.startsWith("@comis/"));
}

/**
 * Dependencies a bundled package needs at runtime that the umbrella package
 * does not provide. Rule 2: a non-empty result means the bundled copy would
 * lose those imports once its own dependency list is stripped.
 *
 * A dependency that is itself bundled counts as provided — the tarball ships
 * it. Versions are deliberately not compared: npm already resolves a bundled
 * package's imports to the umbrella's hoisted pin, so requiring an exact match
 * would fail on differences npm never honors.
 *
 * @param {Record<string, unknown>} sourceManifest
 * @param {Record<string, unknown>} umbrellaManifest
 * @returns {string[]}
 */
export function findUnhoistedRuntimeDeps(sourceManifest, umbrellaManifest) {
  const provided = new Set([
    ...Object.keys(/** @type {object} */ (umbrellaManifest.dependencies ?? {})),
    .../** @type {string[]} */ (umbrellaManifest.bundledDependencies ?? []),
  ]);
  const required = Object.keys(/** @type {object} */ (sourceManifest.dependencies ?? {}));
  return required.filter((name) => !provided.has(name)).sort();
}
