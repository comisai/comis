// SPDX-License-Identifier: Apache-2.0
/**
 * Resolve an agent's prompt-skill discovery paths from its configured `discoveryPaths`.
 *
 * Two locations the DAEMON controls are always part of the set, independent of the operator's
 * `discoveryPaths` (which may be a custom absolute list):
 *   - the per-agent workspace skills dir (`<agentWorkspace>/skills`), PREPENDED — first-loaded-wins,
 *     so an agent's own skills take precedence;
 *   - the bundled-skill install target (`<dataDir>/skills`, where {@link ../seed-bundled-skills}
 *     seeds claude-code / codex / …), APPENDED — lowest precedence.
 *
 * Why the bundled-target is force-included: the default `discoveryPaths` is `["./skills"]`, which
 * resolves to `<dataDir>/skills` — the SAME dir the bundled-skill seeder writes to. But a CUSTOM
 * `discoveryPaths` (e.g. `["/srv/team-skills"]`) REPLACES that default, silently dropping the
 * daemon's own bundled prompt skills: they're seeded on disk but never discovered, so a
 * description-matched skill like `claude-code` never surfaces into `<available_skills>` and the agent
 * can't follow it (webhook-claude-cli-tdd-20260630-rerun: a leftover `discoveryPaths:[<sim-dir>]`
 * from a prior run hid claude-code/codex/gsd-builder/skill-creator entirely). Force-including the
 * install target makes the bundled skills robust to any `discoveryPaths` override, mirroring how the
 * per-agent workspace dir is always prepended.
 *
 * Relative entries resolve against `dataDir` (so `./skills` → `<dataDir>/skills`). Pure + total.
 *
 * @module
 */
import { isAbsolute, resolve } from "node:path";

/** The bundled-skill install target dir name under the data dir (mirrors seed-bundled-skills.ts). */
export const BUNDLED_SKILLS_DIRNAME = "skills";

/**
 * @param rawDiscoveryPaths - the agent's configured `skills.discoveryPaths` (default `["./skills"]`).
 * @param dataDir - the daemon data dir; relative discovery paths resolve against it.
 * @param agentSkillsDir - the per-agent `<workspace>/skills` dir (already resolved by the caller).
 * @returns the resolved, de-duplicated discovery path list with both daemon-controlled dirs included.
 */
export function resolveSkillDiscoveryPaths(
  rawDiscoveryPaths: readonly string[],
  dataDir: string,
  agentSkillsDir: string,
): string[] {
  const resolved = rawDiscoveryPaths.map((p) => (isAbsolute(p) ? p : resolve(dataDir, p)));
  // Per-agent workspace skills dir takes precedence (first-loaded-wins).
  if (!resolved.includes(agentSkillsDir)) {
    resolved.unshift(agentSkillsDir);
  }
  // The bundled-skill install target is ALWAYS discoverable (lowest precedence), so a custom
  // `discoveryPaths` that omits the default `./skills` cannot silently drop the daemon's own
  // seeded prompt skills (claude-code, codex, …). De-dupe: the default `./skills` already resolves
  // here, so this is a no-op for the common case.
  const bundledSkillsDir = resolve(dataDir, BUNDLED_SKILLS_DIRNAME);
  if (!resolved.includes(bundledSkillsDir)) {
    resolved.push(bundledSkillsDir);
  }
  return resolved;
}
