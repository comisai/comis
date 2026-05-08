// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-first capability-layer configuration schema (v1.1).
 *
 * Operator-only YAML tree controlling capability clusters, MCP/skill
 * capability hints, install-detour mode, and the per-turn capability
 * index toggle. The entire `tooling.*` subtree is immutable at runtime
 * (see immutable-keys.ts) -- agents cannot self-configure capability
 * routing or detour policy.
 *
 * @module
 */

import { z } from "zod";

/**
 * Operator-overridable shape for a single cluster entry.
 *
 * `priority` (default 100) and `preferOverInstalls` (default true) make sense
 * across both reserved and operator-defined clusters. Reserved IDs are listed
 * in DEFAULT_CLUSTER_CONFIG below; operators may override scalar fields per-key
 * but the IDs themselves are fixed (renderer references them by literal).
 */
const ClusterEntrySchema = z.strictObject({
  /** Display label for the cluster (e.g., "Data fetching - financial / market"). */
  label: z.string().min(1),
  /** Render-order priority. Lower numbers surface earlier. (default: 100) */
  priority: z.number().int().default(100),
  /** Should this cluster's tools be preferred over `pip install`/`npm install` of comparable packages? (default: true) */
  preferOverInstalls: z.boolean().default(true),
});

/**
 * Capability hint shape for an MCP server.
 *
 * BOTH `cluster` and `description` are required. The asymmetry vs. skills is
 * intentional (design §4.2 schema-asymmetry note): MCP servers do not carry
 * an in-band human-readable description suitable for the renderer, so the
 * operator must supply one. Skills already carry `description` in the
 * manifest, so the hint may omit it.
 */
const McpCapabilityHintSchema = z.strictObject({
  cluster: z.string().min(1),
  description: z.string().min(1),
  replacesPackages: z.array(z.string().min(1)).default([]),
});

/**
 * Capability hint shape for a prompt skill.
 *
 * `description` is optional -- skills carry their own description in the
 * manifest frontmatter; the hint may override it but is not required to.
 */
const SkillCapabilityHintSchema = z.strictObject({
  cluster: z.string().min(1),
  description: z.string().min(1).optional(),
  replacesPackages: z.array(z.string().min(1)).default([]),
});

// Sub-section schemas (inner). Each top-level field uses
// `.default(() => Sub.parse({}))` so empty input yields fully-populated
// defaults (matches the codebase-wide convention -- see schema.ts root).
const CapabilityClustersSubSchema = z.strictObject({
  clusters: z.record(z.string(), ClusterEntrySchema).default({}),
  /** Builtin tool name -> cluster ID assignments. Operator-supplied. */
  builtinAssignments: z.record(z.string(), z.string()).default({}),
});

const McpSubSchema = z.strictObject({
  capabilityHints: z.record(z.string(), McpCapabilityHintSchema).default({}),
});

const SkillsSubSchema = z.strictObject({
  capabilityHints: z.record(z.string(), SkillCapabilityHintSchema).default({}),
});

const CapabilityIndexSubSchema = z.strictObject({
  enabled: z.boolean().default(true),
});

const InstallDetoursSubSchema = z.strictObject({
  /**
   * Install-detour mode controls how the install-detour validator acts when
   * an exec command would `pip install` / `npm install` a package that
   * overlaps with an already-connected MCP server or skill.
   *
   * - "observe"   -- emit an event, no user-facing message, allow the install.
   * - "advise"    -- emit an event AND surface a hint to the agent. (default)
   * - "soft-stop" -- emit an event AND block the install pending override.
   */
  mode: z.enum(["observe", "advise", "soft-stop"]).default("advise"),
});

/**
 * Tool-first capability-layer configuration.
 *
 * Strict object: unknown top-level keys (and unknown keys at every nested
 * level) are rejected at parse time. Every section is `.default(...)` so an
 * empty `tooling: {}` block (or omitting `tooling` entirely from
 * AppConfig) yields a fully-populated default tree.
 *
 * Per design §4.2 (capability-layer config) and §5 rules 7-9 (immutable
 * tree, operator-only authority).
 */
export const ToolingConfigSchema = z.strictObject({
  /**
   * Cluster definitions and builtin tool->cluster assignments.
   *
   * NOTE: `clusters` is a `z.record(...)` whose default is `{}`, NOT
   * `DEFAULT_CLUSTER_CONFIG`. See the load-bearing JSDoc on
   * DEFAULT_CLUSTER_CONFIG below for why -- the merge-with-defaults
   * contract is enforced at adapter-construction time (Phase 23).
   */
  capabilityClusters: CapabilityClustersSubSchema.default(() =>
    CapabilityClustersSubSchema.parse({}),
  ),
  /** Capability hints for connected MCP servers (keyed by server name). */
  mcp: McpSubSchema.default(() => McpSubSchema.parse({})),
  /** Capability hints for prompt skills (keyed by skill name or skill-key). */
  skills: SkillsSubSchema.default(() => SkillsSubSchema.parse({})),
  /** Per-turn capability index toggle. Default: true. */
  capabilityIndex: CapabilityIndexSubSchema.default(() =>
    CapabilityIndexSubSchema.parse({}),
  ),
  /** Install-detour validator mode. Default: "advise". */
  installDetours: InstallDetoursSubSchema.default(() =>
    InstallDetoursSubSchema.parse({}),
  ),
});

/** Inferred ToolingConfig type. */
export type ToolingConfig = z.infer<typeof ToolingConfigSchema>;

/**
 * Three reserved cluster IDs ship by default. Renderer references them by literal:
 * - "external-integrations" -- connected MCP servers without an operator hint
 * - "prompt-skills" -- visible skills without operator/manifest metadata
 * - "other-tools" -- non-MCP tools without getBuiltinCluster() resolution
 *
 * Operators may override label, priority, preferOverInstalls per-key, but the IDs
 * themselves are fixed. Per design §4.2 + §5 rules 7/8/9.
 *
 * IMPORTANT: This object is intentionally NOT used as a `.default(...)` argument on
 * `clusters` because z.record(...).default({}) does NOT key-merge -- it replaces
 * the whole record. The merge MUST happen at adapter construction (Phase 23):
 *
 *   const mergedClusters = {
 *     ...DEFAULT_CLUSTER_CONFIG,
 *     ...config.tooling.capabilityClusters.clusters,  // operator wins per-key
 *   };
 *
 * See Pitfall 2 in research/PITFALLS.md for the full rationale.
 */
export const DEFAULT_CLUSTER_CONFIG: Readonly<
  Record<
    string,
    {
      readonly label: string;
      readonly priority: number;
      readonly preferOverInstalls: boolean;
    }
  >
> = Object.freeze({
  "external-integrations": Object.freeze({
    label: "External integrations",
    priority: 9999,
    preferOverInstalls: true,
  }),
  "prompt-skills": Object.freeze({
    label: "Prompt skills",
    priority: 9999,
    preferOverInstalls: true,
  }),
  "other-tools": Object.freeze({
    label: "Other tools",
    priority: 9999,
    preferOverInstalls: false,
  }),
});

/**
 * Default builtin tool->cluster assignments. Empty by default; operators
 * populate via `tooling.capabilityClusters.builtinAssignments`.
 */
export const DEFAULT_BUILTIN_ASSIGNMENTS: Readonly<Record<string, string>> =
  Object.freeze({});
