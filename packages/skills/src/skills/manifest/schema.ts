// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { McpServerEntrySchema } from "@comis/core";

/**
 * Schema for skill names: lowercase alphanumeric with hyphens,
 * 1-64 chars, no consecutive hyphens, no leading/trailing hyphens.
 */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "Skill name must be lowercase alphanumeric with hyphens, no leading/trailing hyphens",
  )
  .refine((s) => !s.includes("--"), "Skill name must not contain consecutive hyphens");

/**
 * Permissions required by a skill to execute.
 * Mirrors the Node.js --permission flag categories.
 * All fields default to empty arrays (no permissions).
 */
export const SkillPermissionsSchema = z.strictObject({
    /** Filesystem read access paths (e.g. ["/tmp/skill-data"]) */
    fsRead: z.array(z.string()).default([]),
    /** Filesystem write access paths */
    fsWrite: z.array(z.string()).default([]),
    /** Network access domains (e.g. ["api.example.com"]) */
    net: z.array(z.string()).default([]),
    /** Environment variable access (read-only, specific keys) */
    env: z.array(z.string()).default([]),
  });

/**
 * OS field schema with preprocess coercion.
 * Accepts a single string (wraps in array, lowercases) or an array of strings (lowercases each).
 * No enum restriction -- any OS string is valid (e.g., "playstation").
 */
export const OsFieldSchema = z.preprocess((val) => {
  if (typeof val === "string") return [val.toLowerCase()];
  if (Array.isArray(val)) return val.map((v) => (typeof v === "string" ? v.toLowerCase() : v));
  return val;
}, z.array(z.string()).optional());

/**
 * Skill prerequisites schema (strict: only bins and env keys accepted).
 * Undefined means no prerequisites; present means the skill declares external dependencies.
 */
export const SkillRequiresSchema = z.strictObject({
  bins: z.array(z.string()).default([]),
  env: z.array(z.string()).default([]),
});

/**
 * Skill key schema with preprocess coercion to slug format.
 * Lowercases, replaces spaces with hyphens, strips non-alphanumeric-hyphen chars.
 */
export const SkillKeySchema = z.preprocess((val) => {
  if (typeof val === "string") {
    return val
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
  }
  return val;
}, z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "skill-key must be a valid slug").optional());


/**
 * Capability metadata block for the capability layer.
 *
 * Optional sub-block of `comis:` namespace. All inner fields optional. The
 * block is z.strictObject -- unknown nested keys (typos like
 * `replacePackages` missing `s`) are rejected when used in a strict-parse
 * context.
 *
 * IMPORTANT -- defensive parse at registry-side:
 * The outer ComisNamespaceSchema is strict, so a malformed `capability` block
 * would normally cause the whole `comis:` block to fail parse and the skill
 * to become invisible. The registry's discovery enrichment extracts
 * `comis.capability` SEPARATELY via `parseComisCapabilityDefensively`, which
 * logs a WARN and returns undefined on failure -- letting the skill render
 * under the fallback `prompt-skills` cluster. The strict schema here is the
 * declaration of the contract; the defensive parser is the recovery
 * mechanism.
 *
 * The skill itself is never hidden solely because optional capability
 * metadata is invalid.
 */
export const ComisCapabilityBlockSchema = z.strictObject({
  /** Cluster ID this skill belongs to (operator may override via tooling.skills.capabilityHints). */
  cluster: z.string().min(1).optional(),
  /** Operator-tunable display summary; falls back to skill description if absent. */
  summary: z.string().min(1).optional(),
  /** Package names this skill replaces (for install-detour overlap detection). */
  replacesPackages: z.array(z.string().min(1)).default([]),
});

/** Parsed `comis.capability` block (Zod-inferred, defaults applied). */
export type ComisCapabilityBlockParsed = z.infer<typeof ComisCapabilityBlockSchema>;

/**
 * Comis-specific namespace schema for fields that only apply within the
 * Comis platform. Other pi-coding-agent hosts will simply ignore this block.
 *
 * Skills place these fields under `comis:` in frontmatter.
 */
export const ComisNamespaceSchema = z.strictObject({
  /** Target operating systems (coerced: string -> [string], lowercased) */
  os: OsFieldSchema,
  /** External prerequisites: binary executables and environment variables */
  requires: SkillRequiresSchema.optional(),
  /** Explicit skill key override (coerced to slug format) */
  "skill-key": SkillKeySchema,
  /** Display/grouping hint for primary environment (e.g., "discord", "telegram") */
  "primary-env": z.string().optional(),
  /** Metadata-only dispatch tag for command routing */
  "command-dispatch": z.string().optional(),
  /**
   * Capability layer -- optional metadata for cluster, summary,
   * package aliases. Defensively parsed at registry-side; a typo here will
   * NOT hide the skill.
   */
  capability: ComisCapabilityBlockSchema.optional(),
}).optional();

/** Parsed Comis namespace block type. */
export type ComisNamespaceParsed = z.infer<typeof ComisNamespaceSchema>;

/**
 * Per-entry shape for bundled MCP servers in a skill manifest.
 * Normalizes the two acceptable shapes:
 *   Array form (Comis-native):
 *     mcpServers: [{ name: "yfinance", transport: "stdio", ... }]
 *   Nested-object form (Claude-Desktop-compatible):
 *     mcpServers: { yfinance: { transport: "stdio", ... } }
 * Both normalize to the array form so per-entry validation runs against the
 * canonical McpServerEntrySchema. Defensive: `Object.entries` iterates only
 * own-enumerable properties (mitigates the prototype-pollution class).
 *
 * The inner schema is the SAME `McpServerEntrySchema` consumed by
 * `integrations.mcp.servers` -- so bundle entries enforce the canonical
 * per-server invariants (name regex, transport enum, etc.) at parse time.
 * Empty `[]` / `{}` both produce `[]`; absent stays `undefined`.
 */
export const McpServersBundleSchema = z.preprocess(
  (input: unknown) => {
    if (Array.isArray(input)) return input;
    if (input !== null && typeof input === "object") {
      return Object.entries(input as Record<string, unknown>).map(([name, entry]) => {
        if (entry === null || typeof entry !== "object") return entry;
        return { ...(entry as Record<string, unknown>), name };
      });
    }
    return input;
  },
  z.array(McpServerEntrySchema).optional(),
);

/**
 * Full SKILL.md manifest schema.
 * Validated from YAML frontmatter extracted from a SKILL.md file.
 *
 * Comis-only fields (os, requires, skill-key, primary-env, command-dispatch) live
 * exclusively under the `comis:` namespace block.
 */
export const SkillManifestSchema = z.strictObject({
    /** Unique skill name (lowercase alphanumeric with hyphens) */
    name: SkillNameSchema,
    /** Human-readable description (1-1024 chars) */
    description: z.string().min(1).max(1024),
    /** Skill type: always "prompt" for Markdown instruction skills. */
    type: z.literal("prompt").default("prompt"),
    /** Semver version string */
    version: z.string().optional(),
    /** SPDX license identifier */
    license: z.string().optional(),
    /** Free-prose environment/runtime compatibility note; validated but carries no platform semantics. */
    compatibility: z.string().optional(),
    /** Whether users can invoke this skill via /skill:name (default true) */
    userInvocable: z.boolean().default(true),
    /** When true, skill is hidden from model's available skills listing (default false) */
    disableModelInvocation: z.boolean().default(false),
    /** Tool restrictions when skill is active; empty array means no restriction (default []) */
    allowedTools: z.array(z.string()).default([]),
    /** Optional hint text shown to users (e.g., "[name]") */
    argumentHint: z.string().optional(),
    /** Required permissions */
    permissions: SkillPermissionsSchema.default(() => SkillPermissionsSchema.parse({})),
    /** JSON Schema describing the skill's input parameters */
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    /** Arbitrary key-value metadata */
    metadata: z.record(z.string(), z.string()).optional(),
    /** Comis-specific namespace block for platform-only fields */
    comis: ComisNamespaceSchema,
    /** Optional bundled MCP servers declaration (array OR Claude-Desktop nested-object form). */
    mcpServers: McpServersBundleSchema,
  });

/** Parsed and validated skill manifest. */
export type SkillManifestParsed = z.infer<typeof SkillManifestSchema>;

/** Parsed and validated skill permissions. */
export type SkillPermissionsParsed = z.infer<typeof SkillPermissionsSchema>;

