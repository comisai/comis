// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 68 BUNDLE-03 (Plan 05) — boot-path skill-bundle re-merge orchestrator.
 *
 * Runs BEFORE setupMcp in daemon.ts:bootAgents — order is critical. setupMcp
 * reads `container.config.integrations.mcp.servers` to construct the runtime
 * manager; the re-merge MUST update that array first or new bundle entries
 * persist on disk but never connect at boot (68-P-NEW-4 sequencing-bug class).
 *
 * Idempotent: identical disk state in ⇒ identical disk state out. The
 * skip-when-equal short-circuit at the tail suppresses a spurious YAML
 * rewrite + audit JSONL line + config:mutated event when nothing changed
 * (the boot-loop guarantee).
 *
 * Boot NEVER passes `force: true` (CONTEXT.md decisions #8 + #9): operators
 * must explicitly run `comis skill install --force` to override user-owned
 * entries. A boot-time name collision logs WARN with `errorKind:"config"`
 * and skips that skill's bundle wiring; the skill itself remains installed,
 * just without its MCPs connected until the next manual install/update.
 *
 * Cycle-safety: imports `persistMcpServers` via its LEAF module path rather
 * than the `@comis/daemon` barrel — this file lives INSIDE
 * `packages/daemon/src/`, so a barrel import would close a self-cycle.
 * Same convention as bundle-mcp-resolver.ts and bundle-install-helper.ts.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import type { McpServerEntry } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { parseSkillManifest } from "@comis/skills";
import type { SkillRegistry } from "@comis/skills";
import { persistMcpServers } from "../api/shared/persist-mcp-servers.js";
import { resolveBundle } from "../skills/bundle-mcp-resolver.js";
import type { WorkspaceApiDeps } from "../api/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Deps slice for the boot-path bundle orchestrator. Mirrors the WorkspaceApiDeps
 * shape persistMcpServers consumes: container + persistDeps + eventBus + logger.
 * Plus the per-agent skill registries (so the orchestrator can enumerate the
 * installed skills' manifest file paths).
 */
export interface SetupSkillBundlesDeps {
  /** Daemon container — boot orchestrator reads container.config.integrations
   *  and persistMcpServers writes container.config.integrations on success. */
  readonly container: WorkspaceApiDeps["container"];
  /** Per-agent skill registries (same map setupAgents produces). The orchestrator
   *  enumerates every metadata across every registry; manifest paths are
   *  deduplicated by absolute path so a shared skill discoverable from N
   *  registries only resolves once. */
  readonly skillRegistries: ReadonlyMap<string, SkillRegistry>;
  /** persistToConfig deps — REQUIRED for the YAML write step. When omitted,
   *  the orchestrator still runs Phase A resolver passes but skips the
   *  persist (logs a WARN if changes are pending). Test-only path. */
  readonly persistDeps?: WorkspaceApiDeps["persistDeps"];
  /** EventBus for the config:mutated 500ms coalescer (Phase 64 RELY-08). */
  readonly eventBus?: WorkspaceApiDeps["eventBus"];
  /** Pino logger; canonical fields. The orchestrator NEVER logs secret values. */
  readonly logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Enumerate every installed skill across every registry, resolve each bundle
 * via `resolveBundle({ force: false })`, accumulate the unioned merged
 * `nextServers` array, and persist once at the tail via `persistMcpServers`.
 *
 * Algorithm:
 *
 *   1. Snapshot the current `integrations.mcp.servers` array — both the
 *      starting `currentServers` (fed into each per-skill resolveBundle call)
 *      and the `initialServers` baseline for the skip-when-equal check.
 *
 *   2. Build a Map<filePath, skillId> across every registry's
 *      `getAllMetadata()`. The Map deduplicates by absolute path so a skill
 *      discoverable from multiple per-agent registries only resolves once.
 *
 *   3. For each (filePath, skillId) pair:
 *      a. readFileSync(filePath). Unreadable ⇒ WARN + skip (the skill remains
 *         installed but its bundle is not wired this boot).
 *      b. parseSkillManifest(content). Parse failure ⇒ WARN + skip.
 *      c. If manifest.mcpServers is absent or empty ⇒ silent skip.
 *      d. resolveBundle({ skillId, manifestMcpServers, currentServers,
 *         force: false, ...osvFwd, logger }). Resolver err ⇒ WARN + skip
 *         (boot path tolerates per-skill failure; the operator can re-run
 *         install --force to recover).
 *      e. Resolver ok ⇒ assign `currentServers = result.value.nextServers`
 *         so the NEXT skill's resolveBundle sees the prior merge result.
 *
 *   4. After all skills have been walked, compare the final `currentServers`
 *      to the snapshot `initialServers`. If structurally equal, RETURN
 *      WITHOUT persisting (idempotence proof: noop boot ⇒ noop YAML write).
 *
 *   5. Otherwise call `persistMcpServers(deps, currentServers,
 *      "skills.bundle.boot", "boot", undefined)` ONCE. Single atomic YAML
 *      write covers every bundled skill (one audit JSONL line, one
 *      config:mutated coalescer event).
 */
export async function setupSkillBundles(deps: SetupSkillBundlesDeps): Promise<void> {
  // Step 0 — short-circuit when there are no registries (test fixture path
  // or pre-discovery boot). Saves the readFileSync + parse round-trip for
  // the common "no skills installed" path.
  if (deps.skillRegistries.size === 0) return;

  // Step 1 — snapshot currentServers + initialServers. The two diverge as
  // each resolveBundle call refines `currentServers`; `initialServers`
  // remains the boot-time baseline for the skip-when-equal compare.
  const integrations = deps.container?.config?.integrations as
    | {
        mcp?: {
          servers?: McpServerEntry[];
          osvCheckEnabled?: boolean;
          osvCacheTtlMs?: number;
        };
      }
    | undefined;
  const initialServers = (integrations?.mcp?.servers ?? []) as McpServerEntry[];
  let currentServers: readonly McpServerEntry[] = initialServers;

  // Step 2 — deduplicate manifest paths across registries (Map<filePath,
  // skillId>). Same shared skill discoverable from multiple per-agent
  // registries only resolves once; insertion order preserves discovery
  // order, which feeds into the resolver as a stable boot ordering.
  const manifestPaths = new Map<string, string>();
  for (const registry of deps.skillRegistries.values()) {
    for (const meta of registry.getAllMetadata()) {
      if (!manifestPaths.has(meta.filePath)) {
        manifestPaths.set(meta.filePath, meta.name);
      }
    }
  }

  // Step 3 — per-skill resolve. Failures isolated (WARN + skip); successes
  // advance `currentServers` so the NEXT skill sees the merged state.
  for (const [filePath, skillId] of manifestPaths) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (e) {
      deps.logger.warn(
        {
          skillId,
          filePath,
          err: e instanceof Error ? e.message : String(e),
          hint: "Boot bundle re-merge: SKILL.md unreadable; bundle MCPs not wired for this skill on this boot. Skill itself remains installed.",
          errorKind: "config" as const,
        },
        "setupSkillBundles: manifest unreadable",
      );
      continue;
    }

    const parseResult = parseSkillManifest(content);
    if (!parseResult.ok) {
      deps.logger.warn(
        {
          skillId,
          filePath,
          err: parseResult.error.message,
          hint: "Boot bundle re-merge: SKILL.md parse failed; bundle MCPs not wired for this skill on this boot.",
          errorKind: "config" as const,
        },
        "setupSkillBundles: manifest parse failed",
      );
      continue;
    }

    const bundleServers = parseResult.value.mcpServers;
    if (bundleServers === undefined || bundleServers.length === 0) {
      // No bundle block ⇒ pre-Phase-68 skill (silent no-op).
      continue;
    }

    const resolveResult = await resolveBundle({
      skillId,
      manifestMcpServers: bundleServers,
      currentServers,
      // BOOT NEVER FORCES. CONTEXT.md decision #8 + #9. Operators must run
      // `skill.install --force` to override user-owned entries.
      force: false,
      ...(integrations?.mcp?.osvCheckEnabled !== undefined && {
        osvCheckEnabled: integrations.mcp.osvCheckEnabled,
      }),
      ...(integrations?.mcp?.osvCacheTtlMs !== undefined && {
        osvCacheTtlMs: integrations.mcp.osvCacheTtlMs,
      }),
      logger: deps.logger,
    });

    if (!resolveResult.ok) {
      deps.logger.warn(
        {
          skillId,
          err: resolveResult.error,
          hint: "Boot-path bundle resolver rejected this skill; skill remains installed but MCPs not wired (operator may run 'comis skill install --force' if appropriate).",
          errorKind: "config" as const,
        },
        "setupSkillBundles: resolver rejected",
      );
      continue;
    }

    currentServers = resolveResult.value.nextServers;
  }

  // Step 4 — skip-when-equal short-circuit. True idempotence: a noop boot
  // does NOT rewrite YAML, does NOT append an audit JSONL line, does NOT
  // emit a config:mutated event. The byte-equal-output guarantee.
  if (deepEqualServers(currentServers, initialServers)) return;

  if (!deps.persistDeps) {
    // Changes pending but no persist deps wired (test fixture path).
    deps.logger.warn(
      {
        hint: "Boot bundle re-merge produced changes but persistDeps unavailable; YAML not written. Test-fixture / pre-bootstrap path.",
        errorKind: "config" as const,
      },
      "setupSkillBundles: persistDeps missing",
    );
    return;
  }

  // Step 5 — persist ONCE with the unified merged array. The single-writer
  // invariant (Phase 62 R9) holds: this is the only sanctioned write path
  // for integrations.mcp.servers at boot time.
  await persistMcpServers(
    {
      persistDeps: deps.persistDeps,
      container: deps.container,
      eventBus: deps.eventBus,
      logger: deps.logger,
    } as unknown as WorkspaceApiDeps,
    [...currentServers],
    "skills.bundle.boot",
    "boot",
    undefined,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable structural equality on the readonly server array. Both arrays
 * arrive sorted by name (the resolver's STEP 4 determinism gate), so a
 * JSON.stringify compare is a safe and cheap byte-equality check.
 *
 * Implementing this as `JSON.stringify(a) === JSON.stringify(b)` rather
 * than a deep recursive walk is intentional — McpServerEntry is plain
 * data (no functions, no symbols, no Map/Set), the resolver's sort step
 * guarantees order stability, and the JSON encoding is canonical for
 * objects-with-no-cycles. The cost is O(N · M) for N entries of size M;
 * acceptable for the typical N ≤ 50.
 */
function deepEqualServers(
  a: readonly McpServerEntry[],
  b: readonly McpServerEntry[],
): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
