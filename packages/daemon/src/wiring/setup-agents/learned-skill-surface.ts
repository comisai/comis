// SPDX-License-Identifier: Apache-2.0
/**
 * Learned-skill surface helper (v2.26 Verified Learning, SURFACE-01/03 + D1).
 *
 * Joins the platform `@comis/skills` registry snapshot with the `@comis/memory`
 * `mental_models` store (the `kind='skill'` rows) into ONE `<available_skills>`
 * listing — platform skills FIRST, promoted read-only learned procedures APPENDED
 * LAST (the cache-stability
 * keystone: the cached byte-prefix never shifts, so a newly-promoted skill is
 * picked up on the NEXT session via the per-session prompt-skills freeze, never
 * mid-session). Each surfaced procedure is MATERIALIZED to a read-tool-openable
 * `<workspace>/.learned-skills/<name>/SKILL.md` (D1) — a SIBLING dot-dir the skill
 * registry never discovers (no double-listing), derived WHOLESALE from `list()` on
 * every refresh so a demoted procedure's file is gone (derive-on-refresh, never a
 * stale file). Its `<location>` is emitted ABSOLUTE (WR-02) — the same shape
 * platform skills use and the `read` tool reports — so ATTR-01 skill-use
 * attribution (exact `<location>`-string match) fires on a `read` of that path.
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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { suppressError } from "@comis/shared";
import { safePath, PathTraversalError, type MentalModel, type MentalModelStorePort, type LearningScope } from "@comis/core";
import { formatAvailableSkillsXml, type PromptSkillDescription, type SkillRegistry } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";

/** The sibling dot-dir (NOT a skill discoveryPath; the registry skips dot-dirs). */
const LEARNED_SKILLS_DIRNAME = ".learned-skills";

/**
 * Surface filter: a read-only (`!mutating`) procedure in `candidate` OR `active`
 * state surfaces. The store's `list()` drops soft-evicted rows (`evicted_at IS
 * NULL`); `stale`/`archived` and any `mutating` procedure never appear.
 *
 * WHY candidates surface (live-2026-06-18 deadlock fix): promotion `candidate→active`
 * is USE-BASED (`promoteByName` bumps `proof_count` only when the skill appears in a
 * resolved-success turn's `memory:skill_used` attribution — design §SKILL-04, the
 * `LOW_PROOF_COUNT` admission cap is the deliberate anti-gaming belt so synthesis can
 * NEVER directly mint an `active` skill). But a turn can only attribute a skill it was
 * SHOWN — so a never-surfaced candidate is never used, never promoted, never surfaced:
 * a deadlock that left every learned skill stuck at `proof_count=1` forever (verified
 * live: 0 skills ever reached `active`). Surfacing read-only candidates lets them be
 * TRIED; a corroborated-success reuse promotes to `active`, a corroborated failure
 * demotes/archives — the outcome-gated verified-reuse loop. Candidates are admitted
 * only after static + (script-)sandbox validation at `trust=learned`, read-only, so
 * trying one is bounded-safe; `active` remains the corroborated (proof≥N) tier.
 */
function isSurfaceable(skill: MentalModel): boolean {
  return (skill.state === "active" || skill.state === "candidate") && !skill.mutating;
}

/**
 * The ABSOLUTE `<location>` of a surfaced skill's materialized SKILL.md (WR-02).
 * Derived through `safePath` so a path-traversal `name` is rejected (never escapes
 * the workspace). Emitted ABSOLUTE — the SAME shape platform skills use
 * (`metadata.path`) and the `read` tool reports — so the ATTR-01 attribution index
 * (keyed on the exact `<location>` string the model reads with) matches a `read` of
 * this path. A workspace-RELATIVE location here would (a) never match an absolute
 * read path and (b) be an inconsistent mixed-format block within one
 * `<available_skills>` listing that the model may "normalize", silently breaking
 * skill-use attribution.
 */
function materializedLocation(workspaceDir: string, name: string): string {
  return safePath(workspaceDir, LEARNED_SKILLS_DIRNAME, name, "SKILL.md");
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
  learnedSkills: readonly MentalModel[],
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
 *
 * WR-04: each skill is materialized under its OWN try/catch, so a single poison
 * `name` (a traversal that makes `safePath` throw) or a single write failure
 * (EACCES / ENOSPC / a name colliding with a file already created this loop) is
 * SKIPPED + WARNed rather than aborting the whole batch after the wholesale
 * `rmSync` (which would otherwise leave `.current` empty + a half-written subtree
 * — one bad skill disabling the entire learned surface for the agent).
 */
export function materializeLearnedSkills(
  workspaceDir: string,
  learnedSkills: readonly MentalModel[],
  logger?: ComisLogger,
): void {
  const root = safePath(workspaceDir, LEARNED_SKILLS_DIRNAME);
  // Wholesale rebuild: drop the existing subtree so a removed skill's file is gone.
  rmSync(root, { recursive: true, force: true });

  const surfaceable = learnedSkills.filter(isSurfaceable);
  if (surfaceable.length === 0) return;

  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const skill of surfaceable) {
    try {
      // safePath validates `name` (rejects traversal) and pins the file under root.
      const skillDir = safePath(root, skill.name);
      const file = safePath(skillDir, "SKILL.md");
      mkdirSync(skillDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, renderSkillFile(skill), { mode: 0o600 });
    } catch (e: unknown) {
      // A traversal `name` is a validation problem (a corrupt/forged row); any other
      // failure is a resource problem (fs). Skip the ONE bad skill; the batch goes on.
      const isTraversal = e instanceof PathTraversalError;
      const errorKind: "validation" | "resource" = isTraversal ? "validation" : "resource";
      logger?.warn(
        {
          submodule: "learned-skill-surface",
          errorKind,
          err: e instanceof Error ? e : new Error(String(e)),
          hint: isTraversal
            ? "a learned skill name failed path validation (traversal/absolute) — skipped; check the mental_models row"
            : "writing a learned skill SKILL.md failed (disk full / permissions / collision) — skipped",
        },
        "Learned-skill materialize skipped one skill (non-fatal)",
      );
    }
  }
}

/**
 * Minimal SKILL.md: a frontmatter the discovery parser would accept + the body.
 * Exported so the MODEL-03 byte-identity golden can pin the exact rendered bytes
 * for a `kind='skill'` MentalModel (the no-behavior-change guarantee).
 */
export function renderSkillFile(skill: MentalModel): string {
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
  learnedSkills: readonly MentalModel[];
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
  learnedSkillStore: MentalModelStorePort | undefined;
  scope: LearningScope;
  workspaceDir: string;
  logger: ComisLogger;
}): Promise<readonly MentalModel[]> {
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

  materializeLearnedSkills(workspaceDir, result.value, logger);
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

/**
 * Per-agent surfaced-skills cache (the bridge between the async refresh and the
 * SYNC seam). Holds the latest surfaceable rows; the seam reads `.current`
 * synchronously every assembly, the freeze captures whatever is current at session
 * start. Constructed once per agent at boot — it fires ONE `refreshLearnedSkillSurface`
 * (materialize + cache) fire-and-forget; until it resolves (and when it fails-closed)
 * `.current` is `[]`, so the listing is platform-only (byte-identical). A
 * newly-promoted skill is picked up on the NEXT session (the per-session freeze) once
 * a later refresh updates `.current` (Plan 05 re-refreshes on promote/demote).
 */
export function createLearnedSkillSurfaceCache(args: {
  learnedSkillStore: MentalModelStorePort | undefined;
  scope: LearningScope;
  workspaceDir: string;
  logger: ComisLogger;
}): { readonly current: readonly MentalModel[] } {
  return createRefreshableLearnedSkillSurface(args).cache;
}

/**
 * WR-01: the cache PLUS a reusable `refresh()` that re-runs the async
 * list→materialize→cache and updates `cache.current` in place. The boot refresh
 * fires once here (fire-and-forget); the resolve-seam loop calls `refresh()` again
 * after a promote/demote moved a row, so the NEXT session's freeze captures the new
 * active set (SURFACE-03: it mutates `cache.current`, NOT an already-frozen
 * snapshot). Default-off / no store ⇒ each refresh resolves to `[]` and writes
 * nothing (byte-identical). Both the boot refresh and `refresh()` are non-fatal.
 */
export function createRefreshableLearnedSkillSurface(args: {
  learnedSkillStore: MentalModelStorePort | undefined;
  scope: LearningScope;
  workspaceDir: string;
  logger: ComisLogger;
}): { cache: { readonly current: readonly MentalModel[] }; refresh: () => Promise<void> } {
  const cache: { current: readonly MentalModel[] } = { current: [] };
  const refresh = async (): Promise<void> => {
    cache.current = await refreshLearnedSkillSurface(args);
  };
  // Boot refresh (fire-and-forget): until it resolves (and when it fails-closed)
  // `.current` is `[]`, so the listing is platform-only (byte-identical).
  suppressError(refresh(), "learned-skill surface boot refresh");
  return { cache, refresh };
}
