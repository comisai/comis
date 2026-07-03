// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-01 — the self-registering STORY_LIBRARY (public barrel).
 *
 * Mirrors the platform-tool registry pattern
 * (packages/skills/src/platform-tools/registry.ts): a single module that is the
 * source of truth for the user-story set. The library STATE + registration
 * primitives live in ./registry-core.ts (an import-free leaf, to break the
 * circular-init hazard); this barrel re-exports them AND imports every seed
 * story module so each self-registers at load. Importing `registry.ts` therefore
 * yields a fully-populated library.
 *
 * THE OPEN/CLOSED CONTRACT: adding a journey = drop one ./stories/*.ts
 * spec file that calls `registerStory(...)` (imported from ./registry-core.js) +
 * add ONE import line below — ZERO change to registry-core, the journey-runner,
 * the step interpreter, or the schema. The new story automatically joins the next
 * live run, the (scenario×model) grid, the coverage view
 * (storyCoverageContributions), and READINESS. registry.test.ts's open/closed
 * test proves this mechanically.
 *
 * @module
 */

// Re-export the core surface (state + primitives live in the import-free leaf).
export {
  registerStory,
  getStories,
  getStory,
  storyCoverageContributions,
} from "./registry-core.js";

// ===========================================================================
// Seed story registrations — the ONLY enumeration point (open/closed seam)
// ===========================================================================
//
// Each import triggers that story module's top-level `registerStory(...)`.
// Adding a journey = add one line here + one ./stories/*.ts spec file. NO change
// to registry-core / the runner / steps / the schema.
import "./stories/us-01.research-recall.js";
import "./stories/us-02.voice-concierge.js";
import "./stories/us-03.multimodal.js";
import "./stories/us-04.multi-agent-dag.js";
import "./stories/us-05.long-autonomous.js";
import "./stories/us-06.scheduled-proactive.js";
import "./stories/us-07.terminal-driven.js";
import "./stories/us-08.cross-channel-broadcast.js";
