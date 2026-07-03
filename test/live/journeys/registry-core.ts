// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-01 — STORY_LIBRARY core state + registration primitives.
 *
 * Split from registry.ts to break the circular-init hazard: the seed story
 * modules (./stories/us-NN.*.ts) import `registerStory` from HERE, and this
 * module has NO back-imports of the seed modules. So the library array +
 * registerStory/getStories are fully initialized before any seed module's
 * top-level `registerStory(...)` runs.
 *
 * (ESM hoists imports to the top regardless of source position, so a
 * registry.ts that declared `const STORY_LIBRARY = []` AND imported the seed
 * modules at the bottom would still run the seed imports — and thus
 * registerStory — before the `const` executed, hitting the temporal dead zone.
 * Keeping the state in this import-free leaf avoids that.)
 *
 * Mirrors the platform-tool registry's single-source-of-truth role
 * (packages/skills/src/platform-tools/registry.ts); registry.ts is the barrel
 * that imports core + triggers the seed registrations.
 *
 * @module
 */
import { UserStorySchema, type UserStory, type CategoryTag } from "./types.js";

const STORY_LIBRARY: UserStory[] = [];

/**
 * Register a user story into STORY_LIBRARY — the single validation choke point.
 * zod-parses (throws on malformed), rejects a duplicate id (throws — the parity
 * de-dupe contract), then pushes.
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
 * Return all registered stories as a COPY — mutating the returned array does not
 * corrupt the library (defensive, like the platform-tool registry snapshot).
 */
export function getStories(): readonly UserStory[] {
  return [...STORY_LIBRARY];
}

/** Return the story with the given id, or undefined. */
export function getStory(id: string): UserStory | undefined {
  return STORY_LIBRARY.find((s) => s.id === id);
}

/**
 * The story-coverage VIEW (E2E-03): one entry per registered story exposing its
 * tags (Cat A–V subsystems composed) + dimensions (config mode-values exercised).
 *
 * Satisfies "each story's tags + dimensions contribute to the coverage
 * matrix" — auto-wired (walks STORY_LIBRARY, grows the instant a story
 * registers, zero downstream change). It deliberately does NOT add rows to
 * `COVERAGE_DIMENSIONS`: the coverage matrix enumerates CONFIG mode-values (owned +
 * settled by the depth suites); journeys are a HORIZONTAL composition layer
 * settled by their test files existing (scenario-cert style). coverage-matrix.ts
 * re-exports this so the runner / architecture gate / soak read it from one place.
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
