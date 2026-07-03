// SPDX-License-Identifier: Apache-2.0
/**
 * Shared reader for this CLI's own version, from `packages/cli/package.json`.
 *
 * `import.meta.url` is per-module, so the relative specifier below resolves
 * from THIS module's own location. Compiled to `dist/util/cli-version.js`, the
 * `../../package.json` specifier (two hops up) points at `packages/cli/package.json`.
 * Every caller imports this one reader and inherits the correct resolution
 * regardless of its own directory depth.
 *
 * @module
 */

import { createRequire } from "node:module";

/**
 * Read this CLI's version from `packages/cli/package.json`.
 *
 * Returns `undefined` — never throws — when the package cannot be resolved, so
 * callers treat an absent version as "unknown" rather than a hard failure.
 */
export function readCliVersion(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}
