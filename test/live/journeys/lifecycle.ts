// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-05 — per-story lifecycle + READINESS plumbing.
 *
 * - `journeyResultToVerdict` maps a per-story `JourneyResult` → a rig
 *   `CategoryVerdict` (passed → CERTIFIED, failed → BLOCKED, skipped →
 *   SKIPPED(<reason-tag>)), fed to `writeReadiness` for the per-story READINESS
 *   rows (E2E-05 "per-story result in READINESS.md").
 * - `activeStoriesForRun` is the run-grid filter: it excludes `deprecated`
 *   stories and the `__`-prefixed test-only synthetic ids (so a
 *   test-registered story never enters the real run grid), and INCLUDES
 *   `quarantined` stories (measured-non-blocking — the runner mode / soak treats
 *   their failures as data, not a block).
 *
 * The N-run pass-rate + (scenario×model) grid REUSE test/live/stats.ts
 * (computePassRate / buildScenarioModelGrid) — no new statistics logic here.
 *
 * @module
 */
import { getStories } from "./registry-core.js";
import type { CategoryVerdict } from "../report.js";
import type { JourneyResult, UserStory } from "./types.js";

/**
 * Map a per-story journey result to a READINESS category verdict.
 *
 * - "passed"  → "CERTIFIED"
 * - "failed"  → "BLOCKED"
 * - "skipped" → SKIPPED(<reason-tag>): the tag is extracted from a
 *   `SKIPPED(<tag>)` substring in the reason if present, else a coarse tag
 *   ("gated"/"no-creds"/"linux-only"/"skipped") derived from the reason text.
 */
export function journeyResultToVerdict(r: JourneyResult): CategoryVerdict {
  if (r.status === "passed") return "CERTIFIED";
  if (r.status === "failed") return "BLOCKED";

  // skipped → derive a SKIPPED(<tag>) verdict from the reason.
  const reason = r.reason ?? "";
  const explicit = /SKIPPED\(([^)]+)\)/.exec(reason);
  if (explicit) return `SKIPPED(${explicit[1]})`;
  if (/gated|component|cert/i.test(reason)) return "SKIPPED(gated)";
  if (/no-?creds/i.test(reason)) return "SKIPPED(no-creds)";
  if (/linux/i.test(reason)) return "SKIPPED(linux-only)";
  if (/no driver|shape-only/i.test(reason)) return "SKIPPED(shape-only)";
  return "SKIPPED(skipped)";
}

/**
 * The run-grid filter: stories eligible for the live run grid.
 *
 * Excludes `deprecated` (removed capability) and `__`-prefixed test-only
 * synthetic ids (registered by tests; must never enter the real grid). Includes
 * `active` and `quarantined` (the latter measured-non-blocking).
 */
export function activeStoriesForRun(): UserStory[] {
  return getStories().filter(
    (s) => s.status !== "deprecated" && !s.id.startsWith("__"),
  );
}
