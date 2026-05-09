// SPDX-License-Identifier: Apache-2.0
/**
 * Live ToolCapabilityPort adapter -- daemon-side wiring (Phase 23 WIRING-01..11).
 *
 * Replaces the interim no-op port factory (Phase 17) with a factory
 * whose 9 frozen methods read live state from:
 *   - `deps.toolingConfig`        (operator config; the `tooling.*` subtree)
 *   - `deps.skillRegistry`        (already applies allow/deny + eligibility +
 *                                   disableModelInvocation filters)
 *   - `deps.mcpClientManager`     (live MCP connection state per server)
 *
 * Cross-field cluster-ID validation runs at construction time across three
 * surfaces (`builtinAssignments`, `mcp.capabilityHints[*].cluster`,
 * `skills.capabilityHints[*].cluster`). Operator typos emit a Pino WARN with
 *   { errorKind: "config", configPath, unresolvedClusterId, hint }
 * and DO NOT throw -- lookup-time fallback applies (`external-integrations`
 * for unresolved MCP clusters; `prompt-skills` for unresolved skill clusters).
 * See RESEARCH.md Pitfall 8 for why DEBUG would be wrong here.
 *
 * Default merge contract (Pitfall 2 -- design §4.2 line 151 / schema-tooling.ts
 * lines 144-153 JSDoc): `mergedClusters = { ...DEFAULT_CLUSTER_CONFIG,
 * ...operator.clusters }`. Empty operator config preserves the 3 reserved IDs;
 * partial-add preserves defaults plus addition; per-key override wins for the
 * overridden key only. The same shape applies to `mergedBuiltinAssignments`.
 *
 * Liveness:
 *   - `getConnectedMcpServers()` filters `getAllConnections()` by
 *     `c.status === "connected"` on EVERY call -- never cached at construction
 *     (TOCTOU mitigation per design §4.3 line 297-299).
 *   - `getPackageAliasMap()` rebuilds fresh per call from operator MCP hints +
 *     visible skills + universal MCP fallback. No memoization in v1.1.
 *   - `getPromptSkillCapabilities()` re-invokes `skillRegistry`'s sweep on
 *     every call; the operator-hint callback resolves through `port.getSkillHint`
 *     at call time (Pitfall E -- arrow lambda holds the `port` reference, not
 *     a snapshot of `getSkillHint`).
 *
 * Returned port is `Object.freeze`d -- post-construction tampering is
 * structurally impossible in strict mode (silently no-ops in sloppy mode).
 *
 * Boundary discipline (Pitfall 13): production source MUST NOT import test
 * stubs from `@comis/core/__test-helpers/`. Plan 23-03 lands the
 * architecture-grep that enforces the boundary across the daemon tree;
 * this file pre-empts the violation.
 *
 * @module
 */

import type {
  ToolCapabilityPort,
  PromptSkillCapability,
  CapabilitySourceRef,
  ClusterConfig,
  ToolingConfig,
  McpServerHint,
  SkillHint,
} from "@comis/core";
import {
  DEFAULT_CLUSTER_CONFIG,
  DEFAULT_BUILTIN_ASSIGNMENTS,
  getToolMetadata,
} from "@comis/core";
import type { SkillRegistry, McpClientManager } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";

/**
 * Dependencies for the live ToolCapabilityPort adapter.
 *
 * Receivers MUST hold the daemon's container.config.tooling slice (NOT the
 * top-level AppConfig) and the live skill registry / MCP client manager
 * instances -- the adapter closes over them and re-reads on every method call.
 */
export interface ToolCapabilityAdapterDeps {
  readonly toolingConfig: ToolingConfig;
  readonly skillRegistry: SkillRegistry;
  readonly mcpClientManager: McpClientManager;
  readonly logger: ComisLogger;
}

// Module-level reference-stable empty alias map. Returned only when no
// operator hints / visible skills / connected servers exist; downstream
// callers can rely on stable identity for cheap equality checks.
const EMPTY_ALIAS_MAP: ReadonlyMap<string, CapabilitySourceRef> = new Map();

/**
 * PEP-503-like normalization for package alias keys.
 *
 * - npm scoped packages (`@scope/name`) are preserved as-is, lowercased.
 * - Everything else: lowercased, with runs of `_`, `.`, `-` collapsed to a
 *   single `-`. Matches design §8.1 rule 5.
 *
 * @param pkg - The raw package identifier from operator config or skill metadata.
 * @returns The normalized key for `getPackageAliasMap`.
 */
function normalizeAliasKey(pkg: string): string {
  if (pkg.startsWith("@")) return pkg.toLowerCase();
  return pkg.toLowerCase().replace(/[_.\-]+/g, "-");
}

/**
 * Build the live ToolCapabilityPort adapter.
 *
 * Pure synchronous function. Construction-time work:
 *   - Key-by-key merge of `DEFAULT_CLUSTER_CONFIG` with operator clusters.
 *   - Key-by-key merge of `DEFAULT_BUILTIN_ASSIGNMENTS` with operator assignments.
 *   - Cross-field cluster-ID validation across 3 surfaces (one Pino WARN per
 *     unresolved reference; never throws).
 *
 * Lookup-time work:
 *   - All 9 port methods are closures over the merged maps + the live
 *     `skillRegistry` / `mcpClientManager` references.
 *
 * @param deps - The adapter's dependencies.
 * @returns A frozen `ToolCapabilityPort`.
 */
export function createToolCapabilityAdapter(
  deps: ToolCapabilityAdapterDeps,
): ToolCapabilityPort {
  const log = deps.logger.child({ submodule: "tool-capability-adapter" });

  // Pitfall 2 mitigation -- key-by-key default merge at adapter construction.
  // Schema cannot supply DEFAULT_CLUSTER_CONFIG via `.default(...)` because
  // z.record(...).default({}) replaces the entire record (see schema-tooling.ts
  // lines 144-153 JSDoc).
  const mergedClusters: Record<string, ClusterConfig> = {
    ...DEFAULT_CLUSTER_CONFIG,
    ...deps.toolingConfig.capabilityClusters.clusters,
  };
  const mergedBuiltinAssignments: Record<string, string> = {
    ...DEFAULT_BUILTIN_ASSIGNMENTS,
    ...deps.toolingConfig.capabilityClusters.builtinAssignments,
  };

  // Build the validation set once; used by all three loops AND by the lookup
  // closures below (so a runtime typo also falls through to the documented
  // fallback rather than silently substituting at lookup time).
  const validClusterIds = new Set(Object.keys(mergedClusters));

  // ---------------------------------------------------------------------------
  // Cross-field cluster-ID validation (3 surfaces). Each loop emits one Pino
  // WARN per unresolved reference. Construction is total -- no throws.
  // ---------------------------------------------------------------------------

  // Surface 1: builtinAssignments[toolName] -> clusterId
  for (const [toolName, clusterId] of Object.entries(mergedBuiltinAssignments)) {
    if (!validClusterIds.has(clusterId)) {
      log.warn(
        {
          hint: `Add cluster '${clusterId}' to tooling.capabilityClusters.clusters or fix the reference at tooling.capabilityClusters.builtinAssignments.${toolName}`,
          errorKind: "config" as const,
          configPath: `tooling.capabilityClusters.builtinAssignments.${toolName}`,
          unresolvedClusterId: clusterId,
        },
        "Unresolved cluster ID in tooling config (builtinAssignments)",
      );
    }
  }

  // Surface 2: mcp.capabilityHints[serverName].cluster
  for (const [serverName, hint] of Object.entries(
    deps.toolingConfig.mcp.capabilityHints,
  )) {
    if (!validClusterIds.has(hint.cluster)) {
      log.warn(
        {
          hint: `Add cluster '${hint.cluster}' to tooling.capabilityClusters.clusters or fix the reference at tooling.mcp.capabilityHints.${serverName}.cluster`,
          errorKind: "config" as const,
          configPath: `tooling.mcp.capabilityHints.${serverName}.cluster`,
          unresolvedClusterId: hint.cluster,
        },
        "Unresolved cluster ID in tooling config (mcp.capabilityHints)",
      );
    }
  }

  // Surface 3: skills.capabilityHints[skillName].cluster
  for (const [skillName, hint] of Object.entries(
    deps.toolingConfig.skills.capabilityHints,
  )) {
    if (!validClusterIds.has(hint.cluster)) {
      log.warn(
        {
          hint: `Add cluster '${hint.cluster}' to tooling.capabilityClusters.clusters or fix the reference at tooling.skills.capabilityHints.${skillName}.cluster`,
          errorKind: "config" as const,
          configPath: `tooling.skills.capabilityHints.${skillName}.cluster`,
          unresolvedClusterId: hint.cluster,
        },
        "Unresolved cluster ID in tooling config (skills.capabilityHints)",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Build the frozen port. All closures capture `deps`, `mergedClusters`,
  // `mergedBuiltinAssignments`, and `validClusterIds` lexically; runtime state
  // (MCP connections, visible skills) is re-read on every method call.
  // ---------------------------------------------------------------------------

  const port: ToolCapabilityPort = Object.freeze({
    isCapabilityIndexEnabled: (): boolean =>
      deps.toolingConfig.capabilityIndex.enabled,

    getInstallDetourMode: (): "observe" | "advise" | "soft-stop" =>
      deps.toolingConfig.installDetours.mode,

    getBuiltinCluster: (toolName: string): string | undefined => {
      // Operator override wins when it resolves; an unresolved override
      // already triggered a construction-time WARN -- fall through to
      // metadata so the caller never sees a phantom cluster ID.
      const opOverride = mergedBuiltinAssignments[toolName];
      if (opOverride !== undefined && validClusterIds.has(opOverride)) {
        return opOverride;
      }
      const meta = getToolMetadata(toolName);
      return meta?.capability?.cluster;
    },

    getClusterConfig: (clusterId: string): ClusterConfig | undefined =>
      mergedClusters[clusterId],

    getMcpServerHint: (serverName: string): McpServerHint | undefined => {
      const hint = deps.toolingConfig.mcp.capabilityHints[serverName];
      if (!hint) return undefined;
      // WIRING-06 fallback: unresolved cluster -> "external-integrations".
      const cluster = validClusterIds.has(hint.cluster)
        ? hint.cluster
        : "external-integrations";
      return {
        cluster,
        description: hint.description,
        replacesPackages: hint.replacesPackages,
      };
    },

    getSkillHint: (
      skillName: string,
      skillKey?: string,
    ): SkillHint | undefined => {
      // Precedence: operator(skillKey) > operator(skillName) (design §4.2.1).
      const hintByKey = skillKey
        ? deps.toolingConfig.skills.capabilityHints[skillKey]
        : undefined;
      const hintByName = !hintByKey
        ? deps.toolingConfig.skills.capabilityHints[skillName]
        : undefined;
      const hint = hintByKey ?? hintByName;
      if (!hint) return undefined;
      // WIRING-06 fallback: unresolved cluster -> "prompt-skills".
      const cluster = validClusterIds.has(hint.cluster)
        ? hint.cluster
        : "prompt-skills";
      return {
        cluster,
        ...(hint.description !== undefined ? { description: hint.description } : {}),
        replacesPackages: hint.replacesPackages,
      };
    },

    getPackageAliasMap: (): ReadonlyMap<string, CapabilitySourceRef> => {
      // Fresh per call -- design §4.3 line 297-299 mandates no memoization in
      // v1.1. Visible skills can change mid-session (file-watcher reloads,
      // allow/deny edits); MCP servers connect/disconnect; capturing at
      // construction would freeze stale state.
      const skills = port.getPromptSkillCapabilities();
      const connectedServers = port.getConnectedMcpServers();
      const mcpHints = Object.entries(deps.toolingConfig.mcp.capabilityHints);

      // Reference-stable empty result for cheap equality checks downstream.
      if (
        mcpHints.length === 0 &&
        skills.length === 0 &&
        connectedServers.length === 0
      ) {
        return EMPTY_ALIAS_MAP;
      }

      const map = new Map<string, CapabilitySourceRef>();

      // 1. Operator MCP hints -- replacesPackages entries point at the server.
      for (const [serverName, hint] of mcpHints) {
        for (const pkg of hint.replacesPackages) {
          const key = normalizeAliasKey(pkg);
          if (!map.has(key)) {
            map.set(key, { type: "mcp", name: serverName });
          }
        }
      }

      // 2. Visible skills -- replacesPackages entries point at the skill.
      // Pitfall E: `port.getPromptSkillCapabilities()` reference resolves at
      // call time; the lexical `port` const is in scope by the time
      // `getPackageAliasMap` fires.
      for (const skill of skills) {
        for (const pkg of skill.replacesPackages) {
          const key = normalizeAliasKey(pkg);
          if (!map.has(key)) {
            map.set(key, { type: "skill", name: skill.name });
          }
        }
      }

      // 3. Universal MCP fallback -- each connected server alias-keyed by its
      // own name (so `pip install <serverName>` resolves to the server itself
      // even without an operator-supplied replacesPackages entry).
      for (const serverName of connectedServers) {
        const key = normalizeAliasKey(serverName);
        if (!map.has(key)) {
          map.set(key, { type: "mcp", name: serverName });
        }
      }

      // Reference-stability guarantee (line 80-82 module docstring):
      // the early-return shortcut above only fires when ALL three input
      // sources are length-zero. Operator hints / skills / connected servers
      // that produce zero map entries (e.g. every hint has
      // `replacesPackages: []`) bypass that shortcut and would otherwise
      // return a fresh empty map -- silently breaking the documented
      // identity-stable empty-result contract. Re-check the size after the
      // loops complete and collapse to the shared sentinel when empty.
      if (map.size === 0) return EMPTY_ALIAS_MAP;
      return map;
    },

    getConnectedMcpServers: (): readonly string[] =>
      deps.mcpClientManager
        .getAllConnections()
        .filter((c) => c.status === "connected")
        .map((c) => c.name),

    getPromptSkillCapabilities: (): readonly PromptSkillCapability[] =>
      deps.skillRegistry.getPromptSkillCapabilities((skillName, skillKey) =>
        port.getSkillHint(skillName, skillKey),
      ),
  });

  return port;
}
