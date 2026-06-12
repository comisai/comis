// SPDX-License-Identifier: Apache-2.0
/**
 * Boot-path skill-bundle re-merge orchestrator.
 *
 * Runs BEFORE setupMcp in daemon.ts:bootAgents — order is critical. setupMcp
 * reads `container.config.integrations.mcp.servers` to construct the runtime
 * manager; the re-merge MUST update that array first or new bundle entries
 * persist on disk but never connect at boot (sequencing-bug class).
 *
 * Idempotent: identical disk state in ⇒ identical disk state out. The
 * skip-when-equal short-circuit at the tail suppresses a spurious YAML
 * rewrite + audit JSONL line + config:mutated event when nothing changed
 * (the boot-loop guarantee).
 *
 * Boot NEVER passes `force: true`: operators
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

import { readFileSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { safePath, SkillsConfigSchema } from "@comis/core";
import type { AppContainer, McpServerEntry, PerAgentConfig } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { parseSkillManifest, createSkillRegistry } from "@comis/skills";
import type { SkillRegistry } from "@comis/skills";
import { resolveWorkspaceDir } from "@comis/core";
import { persistMcpServers } from "../api/shared/persist-mcp-servers.js";
import { resolveBundle } from "../skills/bundle-mcp-resolver.js";
import { formatBundleError } from "../skills/bundle-install-helper.js";
import {
  readBundleInstallState,
  recordBundleEntries,
} from "../skills/bundle-install-state.js";
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
  /** EventBus for the config:mutated 500ms coalescer. */
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
  // Pre-sort `initialServers` so the skip-when-equal compare in Step 4
  // matches the resolver's STEP 4 sort-by-name output. Without this pre-sort,
  // an on-disk config.yaml whose servers were not written in alphabetical
  // order (any user-added entry pre-normalize) makes deepEqualServers return
  // false on the first boot post-normalize, triggering a spurious YAML
  // rewrite + audit JSONL append + config:mutated event for a noop merge.
  // With the pre-sort, the compare is apples-to-apples and the idempotence
  // invariant (noop boot ⇒ noop YAML write) holds from boot 1.
  const rawInitialServers = (integrations?.mcp?.servers ?? []) as McpServerEntry[];
  const initialServers: readonly McpServerEntry[] = [...rawInitialServers].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  let currentServers: readonly McpServerEntry[] = initialServers;

  // Read the daemon-private installed-bundles state file once, up-front.
  // The resolver consults this state for the "did WE install this entry?"
  // check on every per-skill pass. dataDir falls back to "." so the test
  // fixture path (container.config.dataDir undefined) does not crash —
  // readBundleInstallState gracefully returns `{}` when the file is missing.
  const dataDir =
    (deps.container?.config?.dataDir as string | undefined) ?? "";
  const installedBundleState = dataDir.length > 0
    ? readBundleInstallState(dataDir)
    : {};

  // Track which skills' bundles successfully resolved on this boot — at the
  // tail we re-record them into the state file so a SKILL.md change between
  // boots (entries added/removed/modified) is reflected without requiring
  // a manual --force re-install.
  const resolvedBundlesForRecord: Array<{
    skillId: string;
    bundleServers: readonly McpServerEntry[];
  }> = [];

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
      // No bundle block ⇒ a legacy skill predating bundle support (silent no-op).
      continue;
    }

    const resolveResult = await resolveBundle({
      skillId,
      manifestMcpServers: bundleServers,
      currentServers,
      // BOOT NEVER FORCES. Operators must run
      // `skill.install --force` to override user-owned entries.
      force: false,
      ...(integrations?.mcp?.osvCheckEnabled !== undefined && {
        osvCheckEnabled: integrations.mcp.osvCheckEnabled,
      }),
      ...(integrations?.mcp?.osvCacheTtlMs !== undefined && {
        osvCacheTtlMs: integrations.mcp.osvCacheTtlMs,
      }),
      logger: deps.logger,
      installedBundleState,
    });

    if (!resolveResult.ok) {
      // Pass a STRING to the Pino `err` field. The Pino error serializer
      // only fires for true `Error` instances; passing a plain `BundleError`
      // object (a discriminated union) bypasses serialization and the log
      // record loses `err.message` / `err.stack`. The structured fields
      // (bundleErrorKind, skillId, hint) carry the searchable signal; `err`
      // carries the formatted operator-readable string.
      deps.logger.warn(
        {
          skillId,
          bundleErrorKind: resolveResult.error.kind,
          err: formatBundleError(resolveResult.error),
          hint: "Boot-path bundle resolver rejected this skill; skill remains installed but MCPs not wired (operator may run 'comis skill install --force' if appropriate).",
          errorKind: "config" as const,
        },
        "setupSkillBundles: resolver rejected",
      );
      continue;
    }

    currentServers = resolveResult.value.nextServers;
    resolvedBundlesForRecord.push({ skillId, bundleServers });
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
  // invariant holds: this is the only sanctioned write path for
  // integrations.mcp.servers at boot time.
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

  // Refresh the daemon-private installed-bundles state file with every
  // successfully-resolved bundle from this boot. The install-helper wrote
  // the original record on install, but a SKILL.md edit between boots
  // (operator added/removed an entry; bundle author shipped a new version)
  // needs the state file to track the CURRENT bundle shape, not the
  // historical shape from first install. Best-effort: failures are logged
  // but do NOT abort boot.
  if (dataDir.length > 0) {
    for (const { skillId, bundleServers } of resolvedBundlesForRecord) {
      const recordResult = recordBundleEntries(dataDir, skillId, bundleServers);
      if (!recordResult.ok) {
        deps.logger.warn(
          {
            skillId,
            err: recordResult.error.message,
            hint: "Boot bundle state-file refresh failed; next install of this skill may require --force because the daemon cannot prove provenance.",
            errorKind: "config" as const,
          },
          "setupSkillBundles: state file write failed",
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable structural equality on the readonly server array.
 *
 * `nextServers` (the resolver output) is sorted by name via the
 * resolver's STEP 4 determinism gate. `initialServers` is pre-sorted
 * by the orchestrator's Step 1 so the on-disk YAML order does
 * not introduce a spurious-rewrite path when the config was written
 * before normalization (or by a `mcp.connect` call pre-normalize). Both
 * inputs are sorted by the time they reach this compare.
 *
 * Implementing this as `JSON.stringify(a) === JSON.stringify(b)` rather
 * than a deep recursive walk is intentional — McpServerEntry is plain
 * data (no functions, no symbols, no Map/Set), the sort steps guarantee
 * order stability, and the JSON encoding is canonical for objects-with-
 * no-cycles. The cost is O(N · M) for N entries of size M; acceptable
 * for the typical N ≤ 50.
 */
function deepEqualServers(
  a: readonly McpServerEntry[],
  b: readonly McpServerEntry[],
): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Discovery-only pre-pass — invoked by daemon.ts BEFORE setupMcp
// ---------------------------------------------------------------------------

/**
 * Sequencing-gate helper for the boot-path bundle orchestrator.
 *
 * Builds a thin Map<agentId, SkillRegistry> for the boot-path bundle
 * orchestrator BEFORE `setupAgents` runs. Each registry is constructed with
 * the same `createSkillRegistry` factory the production per-agent setup
 * uses, but with NO eligibility context and NO logger overrides — the
 * orchestrator only consumes `getAllMetadata()` (filePath + name), which
 * doesn't depend on either.
 *
 * The discovery pass mirrors `setup-agents-runtime.ts` lines 318-340:
 *   - Per-agent `effectiveConfig.skills` (falls back to schema default)
 *   - Per-agent workspace `<agentWorkspace>/skills` prepended to
 *     discoveryPaths (first-loaded-wins)
 *   - Relative discoveryPaths resolved against `container.config.dataDir`
 *
 * The registries returned here are DISCARDED after `setupSkillBundles` runs.
 * The real per-agent registries (with eligibility + watcher) are built later
 * inside `setupAgents`; the discovery is idempotent so the two passes don't
 * race or leak state.
 *
 * @param container Daemon container (config.agents + config.dataDir consumed).
 * @param logger Logger forwarded into createSkillRegistry (filtered to the
 *   SkillsLogger interface internally).
 * @returns Map<agentId, SkillRegistry> with `getAllMetadata()` populated.
 */
export function buildSkillRegistriesForBundles(
  container: AppContainer,
  logger: ComisLogger,
): ReadonlyMap<string, SkillRegistry> {
  const registries = new Map<string, SkillRegistry>();
  const dataDir =
    container.config.dataDir && container.config.dataDir.length > 0
      ? container.config.dataDir
      : ".";
  const agents = container.config.agents as Record<string, PerAgentConfig>;

  for (const [agentId, agentConfig] of Object.entries(agents)) {
    const effectiveConfig = agentConfig;
    const skillsConfig = effectiveConfig.skills ?? SkillsConfigSchema.parse({});

    // Mirror setup-agents-runtime.ts lines 324-339: agent workspace skills
    // dir prepended; relative discoveryPaths resolved against dataDir.
    let agentDir: string;
    try {
      agentDir = resolveWorkspaceDir(effectiveConfig, agentId, container.config.dataDir || undefined);
    } catch (e) {
      logger.warn(
        {
          agentId,
          err: e instanceof Error ? e.message : String(e),
          hint: "Boot bundle pre-pass: cannot resolve agent workspace; skipping this agent's bundle discovery on this boot.",
          errorKind: "config" as const,
        },
        "buildSkillRegistriesForBundles: workspace resolution failed",
      );
      continue;
    }
    const agentSkillsDir = safePath(agentDir, "skills");
    try {
      // fs-safe-allowed: per-agent workspace skills dir (`<agentWorkspace>/skills`); workspace dir is operator-configured, not ~/.comis/ directly — mirrors setup-agents-runtime.ts:328 precedent
      mkdirSync(agentSkillsDir, { recursive: true });
    } catch {
      // Non-fatal — discovery will just produce zero skills for this path.
    }
    const resolvedPaths = skillsConfig.discoveryPaths.map((p: string) =>
      isAbsolute(p) ? p : pathResolve(dataDir, p),
    );
    if (!resolvedPaths.includes(agentSkillsDir)) {
      resolvedPaths.unshift(agentSkillsDir);
    }
    const resolvedSkillsConfig = { ...skillsConfig, discoveryPaths: resolvedPaths };

    const registry = createSkillRegistry(
      resolvedSkillsConfig,
      container.eventBus,
      { agentId, tenantId: container.config.tenantId, userId: "system" },
      // No SkillsLogger forwarded — discovery prints to its own debug stream;
      // the boot orchestrator surfaces operator-visible WARN logs itself.
      undefined,
      // No eligibility context — boot orchestrator does not care about the
      // os/binary/env-var filter; it walks every discovered skill on disk.
      undefined,
    );
    registry.init();
    registries.set(agentId, registry);
  }

  return registries;
}
