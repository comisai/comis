// SPDX-License-Identifier: Apache-2.0
/**
 * MCP and skill discovery for `comis config sync-tooling`.
 *
 * Pure helpers (no daemon RPC, no Commander wiring): given a parsed config
 * and a homeDir, return the union of installed MCPs and skills the operator
 * has on disk. The CLI command callback in `commands/config.ts` orchestrates:
 * it resolves homeDir via `os.homedir()`, calls `loadConfigFile`, passes both
 * into these functions, then feeds the result into `generate.ts`.
 *
 * @module
 */

import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { safePath } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discovered MCP server from `integrations.mcp.servers[].name`. */
export interface DiscoveredMcp {
  /** Sanitized MCP server name (already pre-validated by the operator's editor). */
  readonly name: string;
  /**
   * Always `undefined` — `McpServerEntrySchema` is `z.strictObject` and has
   * no `description` field. The CLI generates the stub `"TODO"` literal in
   * `generate.ts`, never here.
   */
  readonly description: undefined;
}

/** Discovered skill from a SKILL.md frontmatter walk. */
export interface DiscoveredSkill {
  /** Skill name from frontmatter `name`. */
  readonly name: string;
  /**
   * Description priority chain:
   *   1. `comis.capability.summary`
   *   2. `frontmatter.description`
   *   3. `undefined` (the stub fallback fires later in generate.ts)
   */
  readonly description: string | undefined;
  /** Explicit cluster from `comis.capability.cluster`, undefined otherwise. */
  readonly cluster: string | undefined;
  /** Filesystem path of the directory containing the SKILL.md. */
  readonly sourceDir: string;
}

/** Aggregate result of an end-to-end discovery pass. */
export interface DiscoveredArtifacts {
  readonly mcps: DiscoveredMcp[];
  readonly skills: DiscoveredSkill[];
}

/** Discover-time errors (boundary `Result` shape; helpers below never throw). */
export type DiscoverError =
  | { code: "INVALID_CONFIG"; message: string }
  | { code: "INVALID_FRONTMATTER"; skillPath: string; message: string };

// ---------------------------------------------------------------------------
// MCP discovery — pure config read
// ---------------------------------------------------------------------------

/**
 * Read MCP server names from a parsed config object (no fs I/O).
 *
 * Reads `config.integrations.mcp.servers` (array). For each entry with a
 * non-empty string `name`, returns `{ name, description: undefined }`.
 * Returns `[]` for missing/malformed shapes.
 *
 * NEVER throws — this reads pre-validation shape. Schema validation is the
 * upstream daemon's responsibility.
 */
export function readMcpServers(config: Record<string, unknown>): DiscoveredMcp[] {
  const integrations = config["integrations"];
  if (!isPlainObject(integrations)) return [];

  const mcp = integrations["mcp"];
  if (!isPlainObject(mcp)) return [];

  const servers = mcp["servers"];
  if (!Array.isArray(servers)) return [];

  const result: DiscoveredMcp[] = [];
  for (const entry of servers) {
    if (!isPlainObject(entry)) continue;
    const name = entry["name"];
    if (typeof name !== "string" || name.length === 0) continue;
    result.push({ name, description: undefined });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Skill discovery — filesystem walk + frontmatter parse + dedupe
// ---------------------------------------------------------------------------

/**
 * Walk skill discovery paths from the config plus the two daemon defaults
 * (`~/.comis/skills`, `~/.comis/workspace/skills`); dedupe by skill name
 * (first-loaded-wins, matching the daemon at `discovery.ts:382-384`).
 *
 * Discovery rules:
 * - Iterate every `discoveryPaths` entry under any `agents.<id>.skills` —
 *   the union across all agents.
 * - Append the two daemon defaults.
 * - For each path that exists, read first-level entries; for each subdirectory,
 *   look for `SKILL.md`.
 * - Parse frontmatter inline (small, structured); pull `name`, `description`,
 *   `comis.capability.summary`, `comis.capability.cluster`.
 * - Build description by priority: `summary ?? description ?? undefined`.
 *
 * NEVER throws on filesystem or frontmatter errors — malformed entries are
 * silently skipped (the daemon's startup validation will catch any blocker;
 * this helper's job is best-effort discovery).
 */
export function discoverSkills(
  config: Record<string, unknown>,
  options: { homeDir: string },
): DiscoveredSkill[] {
  // 1. Build the union of discovery paths from agents.* + daemon defaults.
  const operatorPaths = collectDiscoveryPathsFromConfig(config);
  // safePath enforces traversal-safety on the daemon defaults; operator-supplied
  // paths come from a Zod-validated config (upstream defense).
  const daemonDefaults: string[] = [
    safePath(options.homeDir, ".comis", "skills"),
    safePath(options.homeDir, ".comis", "workspace", "skills"),
  ];

  // Preserve insertion order: operator paths first, then daemon defaults.
  // Map keyed by name for first-loaded-wins dedupe.
  const seen = new Map<string, DiscoveredSkill>();
  for (const dir of [...operatorPaths, ...daemonDefaults]) {
    walkSkillDir(dir, seen);
  }
  return Array.from(seen.values());
}

/**
 * Collect the union of `agents.<id>.skills.discoveryPaths` from all agents.
 * Returns string paths in iteration order (`Object.keys` for the agents map).
 */
function collectDiscoveryPathsFromConfig(config: Record<string, unknown>): string[] {
  const agents = config["agents"];
  if (!isPlainObject(agents)) return [];

  const paths: string[] = [];
  for (const agentId of Object.keys(agents)) {
    const agent = agents[agentId];
    if (!isPlainObject(agent)) continue;
    const skills = agent["skills"];
    if (!isPlainObject(skills)) continue;
    const discoveryPaths = skills["discoveryPaths"];
    if (!Array.isArray(discoveryPaths)) continue;
    for (const p of discoveryPaths) {
      if (typeof p === "string" && p.length > 0) paths.push(p);
    }
  }
  return paths;
}

/**
 * Walk one discovery directory: for each subdirectory, attempt to extract a
 * SKILL.md. Silently skip nonexistent or unreadable paths. Mutates `seen`.
 */
function walkSkillDir(dir: string, seen: Map<string, DiscoveredSkill>): void {
  if (!fs.existsSync(dir)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    // The dir + entry.name is a trusted compose: dir came from a Zod-validated
    // config or a `safePath` result, and entry.name from `readdirSync` is a
    // single basename (no slashes). Use safePath to satisfy the project rule.
    const skillDir = safePath(dir, entry.name);
    const skillMdPath = safePath(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    const parsed = tryParseSkillFrontmatter(skillMdPath);
    if (parsed === null) continue;
    if (seen.has(parsed.name)) continue;

    seen.set(parsed.name, {
      name: parsed.name,
      description: parsed.description,
      cluster: parsed.cluster,
      sourceDir: skillDir,
    });
  }
}

/**
 * Read SKILL.md, extract `---`-delimited frontmatter block, parse YAML.
 * Returns the discovered skill fields, or `null` on any read/parse failure
 * (the discover layer is silent-skip; the daemon validates strictly later).
 */
function tryParseSkillFrontmatter(skillMdPath: string): {
  name: string;
  description: string | undefined;
  cluster: string | undefined;
} | null {
  let content: string;
  try {
    content = fs.readFileSync(skillMdPath, "utf-8");
  } catch {
    return null;
  }

  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return null;

  const afterOpening = normalized.indexOf("\n");
  if (afterOpening === -1) return null;
  const closingIndex = normalized.indexOf("\n---", afterOpening);
  if (closingIndex === -1) return null;

  const yamlContent = normalized.slice(afterOpening + 1, closingIndex);
  if (yamlContent.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const name = parsed["name"];
  if (typeof name !== "string" || name.length === 0) return null;

  const frontmatterDesc =
    typeof parsed["description"] === "string" && parsed["description"].length > 0
      ? (parsed["description"] as string)
      : undefined;

  // Defensive: comis.capability is optional and may be malformed.
  let summary: string | undefined;
  let cluster: string | undefined;
  const comis = parsed["comis"];
  if (isPlainObject(comis)) {
    const capability = comis["capability"];
    if (isPlainObject(capability)) {
      const s = capability["summary"];
      if (typeof s === "string" && s.length > 0) summary = s;
      const c = capability["cluster"];
      if (typeof c === "string" && c.length > 0) cluster = c;
    }
  }

  // Priority: summary > frontmatter description > undefined.
  const description = summary ?? frontmatterDesc;

  return { name, description, cluster };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
