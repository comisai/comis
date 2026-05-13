// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/skills — Public surface for the `.` subpath.
 *
 * Re-exports from `./skills/index.js`. Per Phase 33 (SKILLS-SPLIT-01..04),
 * the three subpath exports are:
 *   - `.`            → this file → skills/index.js (skill registry, manifest, prompt, mcp client)
 *   - `./tools`      → tools/index.js (builtin non-platform, browser, media, integrations)
 *   - `./platform-tools` → platform-tools/index.js (RPC-coupled tool factories)
 *
 * The architecture invariant (`skills/src/skills/*` does not import from
 * `tools/` or `platform-tools/`) is enforced by 33-02 Plan Task 3.
 *
 * @module
 */
export * from "./skills/index.js";
