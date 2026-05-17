// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/skills — Public surface for the `.` subpath.
 *
 * Re-exports from `./skills/index.js`. The three subpath exports are:
 *   - `.`            → this file → skills/index.js (skill registry, manifest, prompt, mcp client)
 *   - `./tools`      → tools/index.js (builtin non-platform, browser, media, integrations)
 *   - `./platform-tools` → platform-tools/index.js (RPC-coupled tool factories)
 *
 * The architecture invariant — `skills/src/skills/*` does not import from
 * `tools/` or `platform-tools/` — is enforced by an architecture test.
 *
 * @module
 */
export * from "./skills/index.js";
