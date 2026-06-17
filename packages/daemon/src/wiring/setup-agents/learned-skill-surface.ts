// SPDX-License-Identifier: Apache-2.0
/**
 * Learned-skill surface helper (v2.26 Verified Learning, SURFACE-01/03 + D1).
 *
 * Joins the platform `@comis/skills` registry snapshot with the `@comis/memory`
 * `learned_skills` store into ONE `<available_skills>` listing — platform skills
 * FIRST, promoted read-only learned procedures APPENDED LAST (the cache-stability
 * keystone: the cached byte-prefix never shifts, so a newly-promoted skill is
 * picked up on the NEXT session via the per-session prompt-skills freeze, never
 * mid-session). Each surfaced procedure is MATERIALIZED to a read-tool-openable
 * `<workspace>/.learned-skills/<name>/SKILL.md` (D1) — a SIBLING dot-dir the read
 * tool resolves workspace-first but the skill registry never discovers (no
 * double-listing), derived WHOLESALE from `list()` on every refresh so a demoted
 * procedure's file is gone (derive-on-refresh, never a stale file).
 *
 * Only the daemon may touch BOTH the skills registry AND the learned-skills store
 * (the closed graph). The seam (`getPromptSkillsXml`, `setup-agents-runtime.ts`)
 * is synchronous (`() => string`); `list()` is async — so the async
 * list→materialize half (`refreshLearnedSkillSurface`) runs out-of-band and caches
 * the surfaced rows, and the sync seam (`renderLearnedSkillsXml`) reads that cache.
 * With `learningSkills` disabled (default) or no admitted skills the listing is
 * BYTE-IDENTICAL to platform-only.
 *
 * @module
 */

import { relative } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { safePath, type LearnedSkill, type LearnedSkillStorePort, type LearningScope } from "@comis/core";
import { formatAvailableSkillsXml, type PromptSkillDescription, type SkillRegistry } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";

/** The sibling dot-dir (NOT a skill discoveryPath) the read tool resolves workspace-first. */
const LEARNED_SKILLS_DIRNAME = ".learned-skills";

/**
 * Surface filter (the WR-03 read-only fail-closed-dead stands): only an `active`,
 * read-only (`!mutating`) procedure surfaces. The store's `list()` already drops
 * soft-evicted rows (`evicted_at IS NULL`); `stale`/`candidate`/`archived` and any
 * `mutating` procedure never appear in the listing OR on disk.
 */
function isSurfaceable(skill: LearnedSkill): boolean {
  return skill.state === "active" && !skill.mutating;
}

/**
 * The workspace-relative `<location>` of a surfaced skill's materialized SKILL.md.
 * Derived through `safePath` so a path-traversal `name` is rejected (never escapes
 * the workspace), then made relative so the read tool resolves it workspace-first.
 */
function materializedLocation(workspaceDir: string, name: string): string {
  const abs = safePath(workspaceDir, LEARNED_SKILLS_DIRNAME, name, "SKILL.md");
  // POSIX-style relative path for the listing (read tool joins it onto the workspace).
  return relative(workspaceDir, abs).split(/[\\/]/).join("/");
}

/**
 * (A) The append-after-platform merge (the cache keystone). Build ONE combined
 * `PromptSkillDescription[]` — `platformDescriptions` first, the surfaceable
 * `learnedSkills` mapped + appended LAST with `source: 'learned'` and a
 * `<location>` pointing at the materialized SKILL.md — and render it via
 * `formatAvailableSkillsXml` ONCE (a single `<available_skills>` wrapper). The
 * platform byte-prefix is unchanged when learned skills are appended.
 */
export function mergeLearnedSkillsXml(
  platformDescriptions: readonly PromptSkillDescription[],
  learnedSkills: readonly LearnedSkill[],
  materializedDir: string,
): string {
  const learnedDescriptions: PromptSkillDescription[] = learnedSkills
    .filter(isSurfaceable)
    .map((s) => ({
      name: s.name,
      description: s.description,
      location: materializedLocation(materializedDir, s.name),
      source: "learned" as const,
    }));
  return formatAvailableSkillsXml([...platformDescriptions, ...learnedDescriptions]);
}

/**
 * (B) Materialize the surfaceable learned skills WHOLESALE under
 * `<workspaceDir>/.learned-skills/`. Derive-on-refresh: the subtree is removed
 * first, then a `SKILL.md` is written for each `active ∧ !mutating` skill — so a
 * demoted/archived procedure's file does NOT survive (anti-Tampering). Every
 * dynamic path segment goes through `safePath` (no `path.join`); a `..`/absolute
 * `name` is rejected before any write.
 */
export function materializeLearnedSkills(
  workspaceDir: string,
  learnedSkills: readonly LearnedSkill[],
): void {
  const root = safePath(workspaceDir, LEARNED_SKILLS_DIRNAME);
  // Wholesale rebuild: drop the existing subtree so a removed skill's file is gone.
  rmSync(root, { recursive: true, force: true });

  const surfaceable = learnedSkills.filter(isSurfaceable);
  if (surfaceable.length === 0) return;

  mkdirSync(root, { recursive: true });
  for (const skill of surfaceable) {
    // safePath validates `name` (rejects traversal) and pins the file under root.
    const skillDir = safePath(root, skill.name);
    const file = safePath(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(file, renderSkillFile(skill), { mode: 0o600 });
  }
}

/** Minimal SKILL.md: a frontmatter the discovery parser would accept + the body. */
function renderSkillFile(skill: LearnedSkill): string {
  const fm = [
    "---",
    `name: ${skill.name}`,
    `description: ${jsonScalar(skill.description)}`,
    "source: learned",
    "---",
    "",
  ].join("\n");
  return `${fm}${skill.body}\n`;
}

/** Render a one-line description scalar safely (collapse newlines; quote). */
function jsonScalar(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/g, " ").trim());
}

/**
 * The SYNCHRONOUS seam reader (`getPromptSkillsXml` expects `() => string`).
 * Reads the registry snapshot + the already-refreshed `learnedSkills` cache. When
 * NO skill is surfaceable (default-off, empty, or all filtered out) it returns the
 * registry's rendered prompt UNCHANGED — byte-identical to platform-only. Otherwise
 * it merges platform-first + learned-appended into one wrapper.
 */
export function renderLearnedSkillsXml(args: {
  skillRegistry: SkillRegistry;
  learnedSkills: readonly LearnedSkill[];
  workspaceDir: string;
}): string {
  const { skillRegistry, learnedSkills, workspaceDir } = args;
  const snapshot = skillRegistry.getSnapshot();
  if (!learnedSkills.some(isSurfaceable)) {
    // Byte-identical default path — no merge, the cached platform prompt verbatim.
    return snapshot.prompt;
  }
  return mergeLearnedSkillsXml(snapshot.skills, learnedSkills, workspaceDir);
}

/**
 * The ASYNCHRONOUS half (runs out-of-band of the sync seam). Reads
 * `learnedSkillStore.list(scope)`, materializes the surfaceable skills WHOLESALE,
 * and returns them for the sync seam's cache. Fails CLOSED: no store threaded
 * (default-off) → `[]` and no materialization; `list()` `err` (unresolved scope)
 * → a once DEBUG line + `[]` (the listing stays platform-only, byte-identical).
 * The `(tenant, agent)` `scope` is the SAME one the runtime resolved.
 */
export async function refreshLearnedSkillSurface(args: {
  learnedSkillStore: LearnedSkillStorePort | undefined;
  scope: LearningScope;
  workspaceDir: string;
  logger: ComisLogger;
}): Promise<readonly LearnedSkill[]> {
  const { learnedSkillStore, scope, workspaceDir, logger } = args;
  if (!learnedSkillStore) return [];

  const result = await learnedSkillStore.list(scope);
  if (!result.ok) {
    logger.debug(
      {
        agentId: scope.agentId,
        submodule: "learned-skill-surface",
        errorKind: "config" as const,
        hint: "learned-skill list() failed (likely unresolved scope) — surfacing nothing (fail-closed)",
        err: result.error,
      },
      "Learned-skill surface refresh skipped (list unavailable)",
    );
    return [];
  }

  materializeLearnedSkills(workspaceDir, result.value);
  const surfaced = result.value.filter(isSurfaceable);
  logger.debug(
    {
      agentId: scope.agentId,
      submodule: "learned-skill-surface",
      surfacedCount: surfaced.length,
      totalCount: result.value.length,
    },
    "Learned-skill surface refreshed",
  );
  return surfaced;
}
