// SPDX-License-Identifier: Apache-2.0
/**
 * ToolCapabilityPort -- hexagonal architecture boundary for the v1.1 capability layer.
 *
 * Provides both a static config-derived view (clusters, hints, aliases) AND a
 * live runtime view (connected MCP servers, visible prompt skills). One port,
 * two views -- per design §4.3, the earlier two-port split was rejected because
 * exec runs per-tool-call (not per-turn) and needs a live getter.
 *
 * Adapters: live daemon-side adapter (Phase 23), createNoOpCapabilityPort
 * (production no-op interim, this package), createCapabilityPortStub
 * (test-only fixture, __test-helpers/ -- production source MUST NOT import).
 *
 * @module
 */

/**
 * Capability source reference -- discriminated union pointing at either a
 * connected MCP server or a visible prompt skill. Used in the package-alias
 * map to resolve "import yfinance" or "pip install pandas" back to a connected
 * tool/skill that should be preferred over the install.
 */
export type CapabilitySourceRef =
  | { readonly type: "mcp"; readonly name: string }
  | { readonly type: "skill"; readonly name: string };

/**
 * Merged capability view of a single visible prompt skill.
 *
 * All operator overrides, manifest `comis.capability` values, and skill-key
 * fallbacks are pre-merged in the adapter (precedence:
 * operator(skillKey) > operator(skillName) > comis.capability > fallback).
 * Consumers see the final merged shape.
 */
export interface PromptSkillCapability {
  /** Stable skill identifier used by the agent runtime. */
  readonly name: string;
  /** Optional canonical key (`<author>::<slug>`) for cross-host portability. */
  readonly skillKey?: string;
  /** Human-readable description (falls back to manifest description if no override). */
  readonly description: string;
  /** Cluster ID for capability-index grouping (e.g. "data-fetching-financial"). */
  readonly cluster?: string;
  /** Operator-tunable display summary; falls back to description when absent. */
  readonly summary?: string;
  /** Package names this skill replaces (for install-detour overlap detection). */
  readonly replacesPackages: readonly string[];
  /** Where the skill was discovered from. */
  readonly source?: "bundled" | "workspace" | "local";
}

/**
 * Cluster metadata used by the capability-index renderer.
 */
export interface ClusterConfig {
  readonly label: string;
  readonly priority: number;
  readonly preferOverInstalls: boolean;
}

/**
 * Hint metadata for a connected MCP server.
 */
export interface McpServerHint {
  readonly cluster: string;
  readonly description: string;
  readonly replacesPackages: readonly string[];
}

/**
 * Hint metadata for a visible prompt skill (operator-supplied overrides).
 */
export interface SkillHint {
  readonly cluster: string;
  readonly description?: string;
  readonly replacesPackages: readonly string[];
}

/**
 * The capability port. Covers both the static config-derived view and a live
 * runtime view. Adapter implementation lives in @comis/daemon (Phase 23);
 * the in-package createNoOpCapabilityPort serves as the production no-op
 * interim while Phase 17 lands.
 *
 * Adapters: createNoOpCapabilityPort (production no-op, this package),
 * createCapabilityPortStub (test-only fixture, __test-helpers/),
 * live daemon-side adapter (Phase 23).
 */
export interface ToolCapabilityPort {
  // ---------------------------------------------------------------------------
  // Config view (7 methods) -- static, derived from `tooling.*` config + the
  // tool metadata registry.
  // ---------------------------------------------------------------------------

  /**
   * Whether the per-turn capability index renderer should fire at all. When
   * false, the renderer returns empty text and the executor-prompt-runner
   * filters it out (§5 empty-render rule).
   *
   * @returns `true` if the operator has enabled the capability index.
   */
  isCapabilityIndexEnabled(): boolean;

  /**
   * Install-detour mode for pip/npm/pnpm/yarn detection.
   * - `observe`: log only, no agent-visible response.
   * - `advise`: emit a non-blocking advisory next turn.
   * - `soft-stop`: refuse the exec call with an operator-overridable message.
   *
   * @returns The currently-configured mode.
   */
  getInstallDetourMode(): "observe" | "advise" | "soft-stop";

  /**
   * Cluster ID for a builtin tool (exec, read, write, ...).
   *
   * @param toolName - The builtin tool's registered name.
   * @returns The cluster ID, or undefined if the tool is uncategorized.
   */
  getBuiltinCluster(toolName: string): string | undefined;

  /**
   * Cluster metadata (label, priority, preferOverInstalls flag).
   *
   * @param clusterId - The cluster identifier.
   * @returns The cluster config, or undefined if the cluster is unknown.
   */
  getClusterConfig(clusterId: string): ClusterConfig | undefined;

  /**
   * Hint metadata for a connected MCP server (operator-supplied overrides).
   *
   * @param serverName - The MCP server name (sanitized form).
   * @returns The hint, or undefined if no operator override exists.
   */
  getMcpServerHint(serverName: string): McpServerHint | undefined;

  /**
   * Hint metadata for a visible prompt skill (operator-supplied overrides).
   *
   * @param skillName - The skill's runtime name.
   * @param skillKey - Optional canonical key (`<author>::<slug>`).
   * @returns The hint, or undefined if no operator override exists.
   */
  getSkillHint(skillName: string, skillKey?: string): SkillHint | undefined;

  /**
   * Pre-normalized package alias map (PEP-503-like keys for Python:
   * lowercase, `_` and `.` collapsed to `-`).
   *
   * Build fresh on each call (no memoization in v1.1 per design §4.3
   * method-body contract -- visible skills can change mid-session
   * (skill discovery, allow/deny edits), connected MCP servers can
   * connect/disconnect, capturing at construction would freeze stale state).
   *
   * @returns A read-only map keyed by normalized package name pointing at
   *   the matching MCP server or prompt skill.
   */
  getPackageAliasMap(): ReadonlyMap<string, CapabilitySourceRef>;

  // ---------------------------------------------------------------------------
  // Runtime view (2 methods) -- live, derived from the running daemon's MCP
  // client manager + the skill registry's discovery sweep.
  // ---------------------------------------------------------------------------

  /**
   * Currently-connected MCP server names (sanitized form).
   *
   * @returns A read-only array of server names. Order is undefined.
   */
  getConnectedMcpServers(): readonly string[];

  /**
   * Visible eligible prompt skills with merged capability metadata.
   * Filters: allowedSkills/deniedSkills, runtime eligibility (os/bins/env),
   * AND `disableModelInvocation !== true`.
   * Merging: operator(skillKey) > operator(skillName) > comis.capability > fallback.
   *
   * IMPORTANT -- cache fence (design §4.3 invariant; Pitfall 1):
   * This method MUST NOT be consumed by `assembleRichSystemPrompt`'s
   * `assemblerParams` in `packages/agent/src/executor/prompt-assembly.ts`.
   * If a skill discovery sweep runs between turns, the cached system-prompt
   * prefix MUST stay byte-identical. Consumers: per-turn capability index
   * renderer (Phase 20) + install-detour parser (Phase 22) ONLY.
   *
   * @returns A read-only array of merged capability views.
   */
  getPromptSkillCapabilities(): readonly PromptSkillCapability[];
}
