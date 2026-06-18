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

// v2.26 Verified Learning (WS2) — the SkillValidationPort adapter (STATIC half,
// Phase 201 Plan 05; the DYNAMIC sandbox half extends it in Plan 06). The whole
// adapter lives in @comis/skills because `applyToolPolicy` (and the bwrap sandbox
// provider, Plan 06) are @comis/skills symbols; the daemon (Plan 07) injects it
// into `runSkillSynthesis` via the SkillValidationPort TYPE. Ahead-of-consumer
// (planned-orphan in test/support/public-api-policy.ts) until that wiring lands.
export {
  createSandboxSkillValidationAdapter,
  classifyMutating,
  type SandboxSkillValidationAdapterDeps,
} from "./learning/sandbox-skill-validation-adapter.js";
