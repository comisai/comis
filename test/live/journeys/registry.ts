// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-01 — the self-registering STORY_LIBRARY.
 *
 * Mirrors the platform-tool registry pattern
 * (packages/skills/src/platform-tools/registry.ts): a single module that is the
 * source of truth for the user-story set. Each seed story module
 * (./stories/us-NN.*.ts) calls `registerStory(...)` at load; this file is the
 * ONE place that imports them (exactly as registry.ts imports the 38 tool
 * factories). Registration is the single validation choke point — `registerStory`
 * zod-parses (throws on malformed), de-dupes by id (throws on a duplicate — the
 * parity contract), then pushes.
 *
 * THE OPEN/CLOSED CONTRACT (§7.7): adding a journey = drop one ./stories/*.ts
 * spec file that calls `registerStory(...)` + add ONE import line below — ZERO
 * change to the journey-runner, the step interpreter, or the schema. The new
 * story automatically joins the next live run, the (scenario×model) grid, the
 * coverage view (storyCoverageContributions), and READINESS. registry.test.ts's
 * open/closed test proves this mechanically.
 *
 * @module
 */
import { UserStorySchema, type UserStory, type CategoryTag } from "./types.js";

// ===========================================================================
// The library (mutable internal; exposed only via copy through getStories)
// ===========================================================================

const STORY_LIBRARY: UserStory[] = [];

/**
 * Register a user story into STORY_LIBRARY.
 *
 * The single validation choke point: zod-parses (throws on a malformed story),
 * rejects a duplicate id (throws — the parity de-dupe contract), then pushes.
 *
 * @param story - The candidate story (validated here; pass DATA, not a class).
 * @returns The parsed (validated) story.
 * @throws If the story is malformed (zod) or its id already exists.
 */
export function registerStory(story: unknown): UserStory {
  const parsed = UserStorySchema.parse(story);
  if (STORY_LIBRARY.some((s) => s.id === parsed.id)) {
    throw new Error(`duplicate story id: ${parsed.id}`);
  }
  STORY_LIBRARY.push(parsed);
  return parsed;
}

/**
 * Return all registered stories as a COPY — mutating the returned array does
 * not corrupt the library (defensive, like the platform-tool registry snapshot).
 */
export function getStories(): readonly UserStory[] {
  return [...STORY_LIBRARY];
}

/** Return the story with the given id, or undefined. */
export function getStory(id: string): UserStory | undefined {
  return STORY_LIBRARY.find((s) => s.id === id);
}

// ===========================================================================
// Coverage auto-wiring view (E2E-03)
// ===========================================================================

/**
 * The story-coverage VIEW: one entry per registered story exposing its
 * tags (Cat A–V subsystems composed) + dimensions (config mode-values exercised).
 *
 * This satisfies E2E-03's "each story's tags + dimensions contribute to the §7.2
 * coverage matrix" — auto-wired (it walks STORY_LIBRARY, so it grows the instant
 * a story registers, with zero downstream change). It deliberately does NOT add
 * rows to `COVERAGE_DIMENSIONS`: the §7.2 matrix enumerates CONFIG mode-values
 * (owned + settled by the depth phases 136–146); journeys are a HORIZONTAL
 * composition layer settled by their test files existing (scenario-cert style,
 * like SEC-02/03 + PLAT-01/02/04). coverage-matrix.ts re-exports this view so
 * the runner / architecture gate / soak read it from one place.
 */
export function storyCoverageContributions(): Array<{
  storyId: string;
  tags: CategoryTag[];
  dimensions: string[];
}> {
  return getStories().map((s) => ({
    storyId: s.id,
    tags: [...s.tags],
    dimensions: [...s.dimensions],
  }));
}

// ===========================================================================
// Seed story registrations — the ONLY enumeration point (open/closed seam)
// ===========================================================================
//
// Each import triggers that story module's top-level `registerStory(...)`.
// Adding a journey = add one line here + one ./stories/*.ts spec file. NO change
// to registerStory / the runner / steps / the schema.
// NOTE: the 8 seed imports are added in Wave 2 (Plan 147-02 Task 1) once the
// spec files exist — kept here as a placeholder so the open/closed seam (where
// stories are added by ADDING lines, never editing logic) is explicit.
// import "./stories/us-01.research-recall.js";
// import "./stories/us-02.voice-concierge.js";
// import "./stories/us-03.multimodal.js";
// import "./stories/us-04.multi-agent-dag.js";
// import "./stories/us-05.long-autonomous.js";
// import "./stories/us-06.scheduled-proactive.js";
// import "./stories/us-07.terminal-driven.js";
// import "./stories/us-08.cross-channel-broadcast.js";
