// SPDX-License-Identifier: Apache-2.0
/**
 * Per-turn capability-index renderer.
 *
 * Renders the `## Capabilities` block for the dynamic preamble. Lives
 * post-deferral in the executor lifecycle; consumes a `ToolCapabilityPort`
 * for cluster/skill resolution and an `ExcludeDeferralResult` for active
 * vs deferred tool partitioning.
 *
 * Pure-function builder: no logger, no IO, no `Result` envelope, no mutable
 * module state beyond frozen module-level constants. Mirrors the shape of
 * `buildDeferredToolsContext` in `tool-deferral.ts`.
 *
 * IMPORTANT -- cache fence:
 * This module is consumed ONLY by `executor-tool-assembly.ts`. It MUST NOT
 * be imported by `prompt-assembly.ts` -- the static prompt cache prefix MUST
 * stay byte-identical when the skill registry reloads between turns.
 * An architecture-grep enforces this invariant.
 *
 * @module
 */

import type {
  ToolCapabilityPort,
  PromptSkillCapability,
  ClusterConfig,
} from "@comis/core";
import { extractMcpServerName } from "@comis/shared";
import type { ExcludeDeferralResult } from "./tool-deferral.js";
import { TOOL_ORDER } from "../bootstrap/sections/tool-descriptions.js";
import { CHARS_PER_TOKEN_RATIO } from "../context-engine/constants.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Output struct from {@link buildCapabilityIndexContext}. All counts are
 * post-elision -- they reflect what the renderer surfaces, not the upstream
 * input cardinality.
 */
export interface CapabilityIndexRenderResult {
  /** Rendered text block. Empty string when the index is gated off or all-zero counts. */
  readonly text: string;
  /** Estimated tokens for the rendered text (`Math.ceil(text.length / CHARS_PER_TOKEN_RATIO)`). */
  readonly capabilityIndexTokens: number;
  /** Number of distinct clusters surfaced. */
  readonly clusterCount: number;
  /** Number of active tools (builtins + active MCP tools). */
  readonly activeToolCount: number;
  /** Number of deferred MCP tools after the orphan-drop (server connected). */
  readonly deferredToolCount: number;
  /** Number of visible eligible prompt skills (port-reported, not rendered count). */
  readonly promptSkillCount: number;
}

// ---------------------------------------------------------------------------
// Module-level frozen sentinel + constants
// ---------------------------------------------------------------------------

/**
 * Frozen empty result. Returned when the gate is off or when all three
 * surface counts are zero. Identity-stable so callers can do cheap reference
 * equality checks if useful.
 */
const EMPTY: CapabilityIndexRenderResult = Object.freeze({
  text: "",
  capabilityIndexTokens: 0,
  clusterCount: 0,
  activeToolCount: 0,
  deferredToolCount: 0,
  promptSkillCount: 0,
});

/**
 * Active-tool count threshold above which all per-cluster name lists are
 * dropped (cluster headers + `(N tools)` counts remain).
 * Currently a fixed constant; revisit only if telemetry shows fleets clustering near it.
 */
const ELISION_THRESHOLD = 32;

/**
 * Maximum names rendered per server (active MCP) or per skill cluster
 * before `+N more` truncation.
 */
const PER_GROUP_NAME_CAP = 8;

// ---------------------------------------------------------------------------
// Internal rendering types (file-scoped)
// ---------------------------------------------------------------------------

interface ServerBucket {
  /** Active MCP tools surfaced under this server (full sanitized names). */
  activeTools: string[];
  /** Count of deferred MCP tools surviving orphan-drop. */
  deferredCount: number;
}

interface ClusterRender {
  readonly id: string;
  readonly config: ClusterConfig;
  /** Names of active builtin / non-MCP tools assigned to this cluster. */
  builtins: string[];
  /** MCP server -> active+deferred bucket map. */
  mcpServers: Map<string, ServerBucket>;
  /** Skills assigned to this cluster (full capability views). */
  skills: PromptSkillCapability[];
}

// ---------------------------------------------------------------------------
// Reserved cluster IDs
//
// Inlined as string literals at the three fallback sites instead of named
// constants -- the IDs are part of the user-visible config schema in
// `packages/core/src/config/schema-tooling.ts`. Renaming them is intentionally
// not supported -- the cluster ID itself is fixed.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Build the per-turn capability-index render result.
 *
 * Behavior:
 *  - Gate respect: returns {@link EMPTY} when `port.isCapabilityIndexEnabled()` is false.
 *  - Empty-input fast path: returns {@link EMPTY} when all three surface counts are zero.
 *  - Cluster bucketing: builtins -> `getBuiltinCluster()` (or `"other-tools"`),
 *    MCP -> `getMcpServerHint().cluster` (or `"external-integrations"`),
 *    skills -> `skill.cluster` (or `"prompt-skills"`).
 *  - Orphan-drop: deferred MCP tools whose server is not in the live
 *    `getConnectedMcpServers()` snapshot are dropped silently.
 *  - Sort: `(priority asc, clusterId asc)` for clusters; `TOOL_ORDER` for
 *    builtins (alphabetical fallback for unknowns); alphabetical for MCP
 *    servers and skills.
 *  - Per-group cap: 8 names + `+N more`.
 *  - >32 elision: drop ALL per-cluster name lists; keep headers + counts only.
 *  - Forbidden-literal discipline: the rendered text names neither the
 *    client-side discovery tool nor the server-side tool search regex tool.
 *    The deferred-tools preamble bullet uses the mechanism-neutral
 *    `"discovery mechanism available in your active toolspace"` wording.
 *    An architecture-grep enforces the file-level invariant.
 *
 * Restart-required note: `tooling.capabilityIndex.enabled` requires a daemon
 * restart to take effect. The renderer respects the port's reported value at
 * render time but does not enforce the restart constraint.
 *
 * @param deferralResult - Output of `applyToolDeferral` (active + deferred tool partition).
 * @param port - The capability port (gate flag, cluster/skill resolution, live runtime view).
 * @returns Frozen {@link CapabilityIndexRenderResult}; identity-stable {@link EMPTY} for the no-op path.
 */
export function buildCapabilityIndexContext(
  deferralResult: ExcludeDeferralResult,
  port: ToolCapabilityPort,
): CapabilityIndexRenderResult {
  // Gate (restart-required).
  if (!port.isCapabilityIndexEnabled()) return EMPTY;

  // Snapshot the live runtime view ONCE per render. Re-querying the port
  // mid-render would risk inconsistent state if a server connect/disconnect
  // happens between two reads.
  const connectedServers = new Set(port.getConnectedMcpServers());
  const visibleSkills = port.getPromptSkillCapabilities();

  // Bucket every input source into a clusterId -> ClusterRender map.
  const clusterMap = new Map<string, ClusterRender>();

  // Active builtin / non-MCP tools.
  for (const tool of deferralResult.activeTools) {
    if (extractMcpServerName(tool.name) !== undefined) continue;
    const clusterId = port.getBuiltinCluster(tool.name) ?? "other-tools";
    const cluster = ensureCluster(clusterMap, clusterId, port);
    cluster.builtins.push(tool.name);
  }

  // Active MCP tools. Group by server within their cluster.
  for (const tool of deferralResult.activeTools) {
    const server = extractMcpServerName(tool.name);
    if (server === undefined) continue;
    const clusterId = port.getMcpServerHint(server)?.cluster ?? "external-integrations";
    const cluster = ensureCluster(clusterMap, clusterId, port);
    const bucket = ensureServerBucket(cluster, server);
    bucket.activeTools.push(tool.name);
  }

  // Deferred MCP tools (with orphan-drop). Non-MCP deferred entries are
  // dropped entirely -- a header-only shell would be misleading because the
  // renderer cannot teach what to do with a non-MCP deferred name.
  let deferredToolCount = 0;
  for (const entry of deferralResult.deferredEntries) {
    const server = extractMcpServerName(entry.name);
    if (server === undefined) continue;
    if (!connectedServers.has(server)) continue; // orphan-drop
    const clusterId = port.getMcpServerHint(server)?.cluster ?? "external-integrations";
    const cluster = ensureCluster(clusterMap, clusterId, port);
    const bucket = ensureServerBucket(cluster, server);
    bucket.deferredCount += 1;
    deferredToolCount += 1;
  }

  // Visible prompt skills. The port has already merged
  // operator > comis.capability > fallback; we only resolve cluster.
  for (const skill of visibleSkills) {
    const clusterId = skill.cluster ?? "prompt-skills";
    const cluster = ensureCluster(clusterMap, clusterId, port);
    cluster.skills.push(skill);
  }

  // Compute totals.
  let activeToolCount = 0;
  for (const cluster of clusterMap.values()) {
    activeToolCount += cluster.builtins.length;
    for (const bucket of cluster.mcpServers.values()) {
      activeToolCount += bucket.activeTools.length;
    }
  }

  // Empty-input fast path.
  if (activeToolCount + deferredToolCount + visibleSkills.length === 0) {
    return EMPTY;
  }

  // Sort clusters: (priority asc, clusterId asc).
  const orderedClusters = [...clusterMap.values()].sort(
    (a, b) => a.config.priority - b.config.priority || a.id.localeCompare(b.id),
  );

  // Determine elision: when total active exceeds 32, drop all per-cluster
  // name lists (cluster headers + `(N tools)` counts remain).
  const eliminateNameLists = activeToolCount > ELISION_THRESHOLD;

  // Render the text envelope.
  const lines: string[] = [];
  lines.push("## Capabilities");
  lines.push("");
  lines.push(
    "Map the task to one of these connected capabilities before using exec to install libraries.",
  );
  lines.push("");
  lines.push("- Active tools: callable now.");
  lines.push(
    "- Deferred tools: connected, but load them through the discovery mechanism available in your active toolspace before invoking them.",
  );
  lines.push(
    "- Prompt skills: available instructions/workflows; use the existing skill-loading mechanism when the task matches.",
  );

  for (const cluster of orderedClusters) {
    lines.push("");
    lines.push(`### ${cluster.config.label}`);
    if (cluster.config.preferOverInstalls) {
      lines.push(
        "Prefer connected tools and available skills over installing equivalent libraries.",
      );
    }
    if (eliminateNameLists) {
      // Headers + count-only.
      const tools = cluster.builtins.length + sumActiveServerTools(cluster);
      lines.push(`(${tools} tools)`);
      const deferredHere = sumDeferredServerTools(cluster);
      if (deferredHere > 0) {
        lines.push(`(${deferredHere} deferred tools)`);
      }
      if (cluster.skills.length > 0) {
        lines.push(`(${cluster.skills.length} skills)`);
      }
      continue;
    }
    appendClusterBody(lines, cluster);
  }

  const text = lines.join("\n");
  const clusterCount = orderedClusters.length;

  return Object.freeze({
    text,
    // flat-by-design: machine-rendered Latin capability index — factor would be 1.0 by construction (TOK-01)
    capabilityIndexTokens: Math.ceil(text.length / CHARS_PER_TOKEN_RATIO),
    clusterCount,
    activeToolCount,
    deferredToolCount,
    promptSkillCount: visibleSkills.length,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers (file-scoped; not exported)
// ---------------------------------------------------------------------------

/**
 * Lookup-or-create a {@link ClusterRender} bucket for a cluster ID. The
 * cluster's {@link ClusterConfig} resolves through the port; missing config
 * for a non-reserved ID falls back to a synthesized default labelled by the
 * cluster ID itself. The wiring layer emits a WARN for missing configs; the
 * renderer only renders.
 */
function ensureCluster(
  map: Map<string, ClusterRender>,
  clusterId: string,
  port: ToolCapabilityPort,
): ClusterRender {
  const existing = map.get(clusterId);
  if (existing) return existing;
  const config = port.getClusterConfig(clusterId) ?? synthesizeClusterConfig(clusterId);
  const cluster: ClusterRender = {
    id: clusterId,
    config,
    builtins: [],
    mcpServers: new Map(),
    skills: [],
  };
  map.set(clusterId, cluster);
  return cluster;
}

/**
 * Synthesize a {@link ClusterConfig} for a cluster ID the port does not
 * recognize. This keeps the renderer total pure -- it never throws on
 * misconfiguration. The wiring layer owns the WARN path; here we render
 * with the cluster ID as both label and a sentinel `9999` priority (sorts
 * last) and `preferOverInstalls: false`.
 */
function synthesizeClusterConfig(clusterId: string): ClusterConfig {
  return Object.freeze({
    label: clusterId,
    priority: 9999,
    preferOverInstalls: false,
  });
}

function ensureServerBucket(cluster: ClusterRender, server: string): ServerBucket {
  const existing = cluster.mcpServers.get(server);
  if (existing) return existing;
  const bucket: ServerBucket = { activeTools: [], deferredCount: 0 };
  cluster.mcpServers.set(server, bucket);
  return bucket;
}

function sumActiveServerTools(cluster: ClusterRender): number {
  let total = 0;
  for (const bucket of cluster.mcpServers.values()) total += bucket.activeTools.length;
  return total;
}

function sumDeferredServerTools(cluster: ClusterRender): number {
  let total = 0;
  for (const bucket of cluster.mcpServers.values()) total += bucket.deferredCount;
  return total;
}

/**
 * Sort builtin/non-MCP tool names within a cluster: known names follow
 * {@link TOOL_ORDER}; unknown names fall through to alphabetical via
 * `localeCompare`.
 */
function sortBuiltinsInCluster(builtins: string[]): string[] {
  const orderIndex = (name: string): number => {
    const idx = TOOL_ORDER.indexOf(name);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };
  return builtins.slice().sort((a, b) => {
    const diff = orderIndex(a) - orderIndex(b);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });
}

/**
 * Append the body of a single cluster (after its `### Label` heading and
 * optional callout have already been pushed) to the line buffer. Renders:
 *   1. Builtin/non-MCP tool names (TOOL_ORDER sort, alphabetical fallback).
 *   2. MCP servers alphabetical, each with capped `+N more` tool list and
 *      optional `(N deferred)` suffix when deferred entries exist.
 *   3. Prompt skills alphabetical, capped at 8 + `+N more`.
 *
 * Elision is handled by the caller (skip this body, emit count-only lines
 * instead).
 */
function appendClusterBody(lines: string[], cluster: ClusterRender): void {
  if (cluster.builtins.length > 0) {
    const sorted = sortBuiltinsInCluster(cluster.builtins);
    lines.push(`- ${sorted.join(", ")}`);
  }
  const sortedServers = [...cluster.mcpServers.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [server, bucket] of sortedServers) {
    const sortedTools = bucket.activeTools.slice().sort((a, b) => a.localeCompare(b));
    const shortNames = sortedTools.map((full) => stripServerPrefix(full, server));
    const head = shortNames.slice(0, PER_GROUP_NAME_CAP);
    const overflow = shortNames.length - head.length;
    const namesPart = head.length === 0
      ? ""
      : `: ${head.join(", ")}${overflow > 0 ? `, +${overflow} more` : ""}`;
    const deferredPart = bucket.deferredCount > 0
      ? ` (${bucket.deferredCount} deferred)`
      : "";
    lines.push(`- [${server}] (${bucket.activeTools.length} tools${deferredPart})${namesPart}`);
  }
  if (cluster.skills.length > 0) {
    const sortedSkills = cluster.skills
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const head = sortedSkills.slice(0, PER_GROUP_NAME_CAP);
    const overflow = sortedSkills.length - head.length;
    const names = head.map((s) => s.name).join(", ");
    const overflowText = overflow > 0 ? `, +${overflow} more` : "";
    lines.push(`- skills: ${names}${overflowText}`);
  }
}

/**
 * Strip the `mcp__<server>--` prefix from a sanitized MCP tool name so the
 * cluster body shows compact short names. Falls back to the full name if
 * the prefix does not match (defensive -- the upstream parser already
 * validated the shape).
 */
function stripServerPrefix(toolName: string, server: string): string {
  const prefix = `mcp__${server}--`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}
