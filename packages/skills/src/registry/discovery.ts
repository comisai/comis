// SPDX-License-Identifier: Apache-2.0
/**
 * Filesystem discovery for prompt skill manifests (SKILL.md / root .md files).
 *
 * Scans configured paths for skill files using dual-mode matching:
 * - Root `.md` files in the skills directory root
 * - Recursive `SKILL.md` files in subdirectories
 *
 * All discovered skills are type "prompt".
 *
 * Features:
 * - `.gitignore`, `.ignore`, `.fdignore` pattern support via `ignore` package
 * - First-loaded-wins collision handling with diagnostics
 * - Symlink deduplication via `realpathSync`
 * - Extracts extended metadata including invocation controls and argument hints
 *
 * Uses synchronous fs operations to prevent TOCTOU races.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { parseFrontmatter } from "../manifest/parser.js";
import type { ResourceDiagnostic, ResourceCollision } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger for discovery warnings. */
export interface DiscoveryLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Source of a discovered skill: where in the discovery path order it was found.
 * "bundled" = first discovery path (highest priority), typically agent workspace skills.
 * "workspace" = middle discovery paths. "local" = last discovery path.
 * Note: "bundled" does not necessarily mean shipped with the repo -- it means
 * the highest-priority discovery path (index 0).
 */
export type SkillSource = "bundled" | "workspace" | "local";

/** Metadata extracted from a SKILL.md or root .md frontmatter during discovery. */
export interface SkillMetadata {
  /** Unique skill name (from frontmatter) */
  readonly name: string;
  /** Human-readable description (from frontmatter) */
  readonly description: string;
  /** Absolute path to the skill directory containing the manifest file */
  readonly path: string;
  /** Source category based on discovery path order */
  readonly source: SkillSource;
  /** Skill type: always "prompt" for Markdown instruction skills */
  readonly type: "prompt";
  /** Whether users can invoke this skill via /skill:name */
  readonly userInvocable: boolean;
  /** When true, skill is hidden from model's available skills listing */
  readonly disableModelInvocation: boolean;
  /** Optional hint text shown to users (e.g., "[name]") */
  readonly argumentHint?: string;
  /** Absolute path to the actual manifest file (.md or SKILL.md) */
  readonly filePath: string;
  /** Platform constraints. undefined = runs everywhere. */
  readonly os?: string[];
  /** Binary and env var prerequisites. */
  readonly requires?: { readonly bins: string[]; readonly env: string[] };
  /** Unique programmatic key (slug format). Used as display name when present. */
  readonly skillKey?: string;
  /** Main environment variable for grouping (display hint). */
  readonly primaryEnv?: string;
  /** Dispatch mode tag (metadata-only in this phase). */
  readonly commandDispatch?: string;
}

/** Result of skill discovery: skills found plus any diagnostics (collisions, warnings). */
export interface DiscoveryResult {
  readonly skills: SkillMetadata[];
  readonly diagnostics: ResourceDiagnostic[];
}

// ---------------------------------------------------------------------------
// Ignore helpers
// ---------------------------------------------------------------------------

/** Ignore file names to load at each directory level. */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;

/** Type alias for the ignore matcher instance. */
type IgnoreMatcher = ReturnType<typeof ignore>;

/** Convert a path to POSIX-style forward slashes (required by `ignore` package). */
function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Prefix an ignore pattern with a directory-relative scope.
 * Handles comments, negation, anchoring, and prefix scoping.
 *
 * @returns Prefixed pattern string, or null if the line should be skipped.
 */
function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

  let pattern = line;
  let negated = false;

  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }

  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }

  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

/**
 * Load ignore rules from `.gitignore`, `.ignore`, and `.fdignore` files
 * in the given directory, prefixing patterns with the relative path from root.
 */
function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
  const relativeDir = path.relative(rootDir, dir);
  const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

  for (const filename of IGNORE_FILE_NAMES) {
    // eslint-disable-next-line no-restricted-syntax -- Trusted: dir from config, filename from constant
    const ignorePath = path.join(dir, filename);
    if (!fs.existsSync(ignorePath)) continue;
    try {
      const content = fs.readFileSync(ignorePath, "utf-8");
      const patterns = content
        .split(/\r?\n/)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => Boolean(line));
      if (patterns.length > 0) ig.add(patterns);
    } catch {
      /* skip unreadable ignore files */
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine source category based on the index of the discovery path.
 * First path (index 0) = "bundled" (highest priority, e.g., agent workspace skills),
 * last path = "local", everything in between = "workspace".
 */
function resolveSource(pathIndex: number, totalPaths: number): SkillSource {
  if (totalPaths === 1) return "bundled";
  if (pathIndex === 0) return "bundled";
  if (pathIndex === totalPaths - 1) return "local";
  return "workspace";
}

/** Fields extracted from frontmatter during discovery (excludes path and source). */
interface ExtractedMetadata {
  readonly name: string;
  readonly description: string;
  readonly type: "prompt";
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly argumentHint?: string;
  readonly os?: string[];
  readonly requires?: { readonly bins: string[]; readonly env: string[] };
  readonly skillKey?: string;
  readonly primaryEnv?: string;
  readonly commandDispatch?: string;
}

/**
 * Try to extract metadata from a skill file's YAML frontmatter.
 * Returns null if the file cannot be read or the frontmatter is invalid.
 *
 * Only parses the frontmatter block -- does not validate the full manifest schema.
 * This keeps discovery fast and lightweight (Level 1 progressive disclosure).
 */
function extractMetadataFromSkillMd(
  skillMdPath: string,
): ExtractedMetadata | null {
  let content: string;
  try {
    content = fs.readFileSync(skillMdPath, "utf-8");
  } catch {
    return null;
  }

  const fmResult = parseFrontmatter<Record<string, unknown>>(content);
  if (!fmResult.ok) {
    return null;
  }

  const obj = fmResult.value.frontmatter;
  if (typeof obj["name"] !== "string" || typeof obj["description"] !== "string") {
    return null;
  }

  // All skills are type "prompt"
  const type = "prompt" as const;
  const userInvocable = typeof obj["userInvocable"] === "boolean" ? obj["userInvocable"] : true;
  const disableModelInvocation = typeof obj["disableModelInvocation"] === "boolean"
    ? obj["disableModelInvocation"]
    : false;
  const argumentHint = typeof obj["argumentHint"] === "string" ? obj["argumentHint"] : undefined;

  // --- Comis namespace support ---
  // Read from comis: namespace block only
  const ns = (typeof obj["comis"] === "object" && obj["comis"] !== null && !Array.isArray(obj["comis"]))
    ? obj["comis"] as Record<string, unknown>
    : undefined;

  // os field -- coerce string to array, normalize lowercase
  const rawOs = ns?.["os"];
  const os: string[] | undefined = typeof rawOs === "string"
    ? [rawOs.toLowerCase()]
    : Array.isArray(rawOs)
      ? rawOs.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase())
      : undefined;

  // requires field -- validate strict shape (bins + env only)
  const rawRequires = ns?.["requires"];
  let requires: { bins: string[]; env: string[] } | undefined;
  if (rawRequires && typeof rawRequires === "object" && !Array.isArray(rawRequires)) {
    const r = rawRequires as Record<string, unknown>;
    const bins = Array.isArray(r["bins"]) ? r["bins"].filter((v): v is string => typeof v === "string") : [];
    const env = Array.isArray(r["env"]) ? r["env"].filter((v): v is string => typeof v === "string") : [];
    requires = { bins, env };
  }

  // skill-key field -- coerce to valid slug
  const rawSkillKey = ns?.["skill-key"];
  const skillKey: string | undefined = typeof rawSkillKey === "string"
    ? rawSkillKey.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "") || undefined
    : undefined;

  // primary-env field
  const rawPrimaryEnv = ns?.["primary-env"];
  const primaryEnv = typeof rawPrimaryEnv === "string" ? rawPrimaryEnv : undefined;

  // command-dispatch field
  const rawCommandDispatch = ns?.["command-dispatch"];
  const commandDispatch = typeof rawCommandDispatch === "string" ? rawCommandDispatch : undefined;

  return { name: obj["name"], description: obj["description"], type, userInvocable, disableModelInvocation, argumentHint, os, requires, skillKey, primaryEnv, commandDispatch };
}

/**
 * Recursive internal helper for discovering skills within a directory tree.
 *
 * @param dir - Current directory to scan
 * @param source - Source category for skills found here
 * @param includeRootFiles - If true, match any .md file (root level); if false, match only SKILL.md
 * @param skillMap - Accumulator map for deduplication (first-loaded-wins)
 * @param diagnostics - Accumulator for collision and warning diagnostics
 * @param realPathSet - Set of resolved real paths for symlink deduplication
 * @param ig - Ignore matcher instance for gitignore-style filtering
 * @param rootDir - Root directory for relative path computation (for ignore patterns)
 * @param logger - Optional structured logger for discovery warnings
 */
function discoverSkillsFromDir(
  dir: string,
  source: SkillSource,
  includeRootFiles: boolean,
  skillMap: Map<string, SkillMetadata>,
  diagnostics: ResourceDiagnostic[],
  realPathSet: Set<string>,
  ig: IgnoreMatcher,
  rootDir: string,
  logger?: DiscoveryLogger,
  skillKeyMap?: Map<string, SkillMetadata>,
): void {
  // Load ignore rules for this directory level
  addIgnoreRules(ig, dir, rootDir);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip hidden entries and node_modules
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    // eslint-disable-next-line no-restricted-syntax -- Trusted: dir from config, entry.name from readdirSync
    const fullPath = path.join(dir, entry.name);

    // Resolve symlinks to determine actual type
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stats = fs.statSync(fullPath);
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
      } catch {
        // Broken symlink -- skip gracefully
        continue;
      }
    }

    // Check ignore rules (append "/" for directories per gitignore spec)
    const relPath = toPosixPath(path.relative(rootDir, fullPath));
    if (relPath && ig.ignores(isDirectory ? `${relPath}/` : relPath)) continue;

    if (isDirectory) {
      // Recurse into subdirectories with includeRootFiles=false
      discoverSkillsFromDir(fullPath, source, false, skillMap, diagnostics, realPathSet, ig, rootDir, logger, skillKeyMap);
      continue;
    }

    if (!isFile) continue;

    // Dual-mode file matching:
    // Root level (includeRootFiles=true): match any .md file
    // Subdirectory level (includeRootFiles=false): match only SKILL.md
    const isRootMd = includeRootFiles && entry.name.endsWith(".md");
    const isSkillMd = !includeRootFiles && entry.name === "SKILL.md";

    if (!isRootMd && !isSkillMd) continue;

    // Symlink deduplication: resolve to real path
    let realPath: string;
    try {
      realPath = fs.realpathSync(fullPath);
    } catch {
      realPath = fullPath;
    }

    // Silent skip if same real file already loaded (same file via different symlink)
    if (realPathSet.has(realPath)) continue;

    const metadata = extractMetadataFromSkillMd(fullPath);
    if (metadata === null) {
      logger?.warn(
        { skillPath: fullPath, hint: "Check skill file has valid YAML frontmatter with name and description fields", errorKind: "validation" as const },
        "Skipping malformed skill file",
      );
      continue;
    }

    // Determine the skill directory:
    // For root .md files: the directory containing the file
    // For subdirectory SKILL.md: the directory containing SKILL.md
    const skillDir = isRootMd ? dir : path.dirname(fullPath);

    // First-loaded-wins: keep existing, emit collision diagnostic for duplicate
    const existing = skillMap.get(metadata.name);
    if (existing) {
      const collision: ResourceCollision = {
        resourceType: "skill",
        name: metadata.name,
        winnerPath: existing.path,
        loserPath: skillDir,
      };
      diagnostics.push({
        type: "collision",
        message: `name "${metadata.name}" collision`,
        path: skillDir,
        collision,
      });
    } else {
      const skillMeta: SkillMetadata = {
        name: metadata.name,
        description: metadata.description,
        path: skillDir,
        source,
        type: metadata.type,
        userInvocable: metadata.userInvocable,
        disableModelInvocation: metadata.disableModelInvocation,
        argumentHint: metadata.argumentHint,
        filePath: fullPath,
        os: metadata.os,
        requires: metadata.requires,
        skillKey: metadata.skillKey,
        primaryEnv: metadata.primaryEnv,
        commandDispatch: metadata.commandDispatch,
      };
      skillMap.set(metadata.name, skillMeta);
      realPathSet.add(realPath);

      // Skill-key collision detection (last-loaded-wins)
      if (skillKeyMap && metadata.skillKey) {
        const existingByKey = skillKeyMap.get(metadata.skillKey);
        if (existingByKey) {
          logger?.warn(
            { skillKey: metadata.skillKey, existingPath: existingByKey.filePath, newPath: fullPath, hint: "Two skills share the same skill-key; last-loaded wins", errorKind: "config" as const },
            "Skill-key collision detected",
          );
        }
        skillKeyMap.set(metadata.skillKey, skillMeta);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover prompt skills from filesystem paths with recursive scanning and dual-mode matching.
 *
 * For each discovery path:
 * - Root level: matches any `.md` file (prompt skills as root files)
 * - Subdirectories: matches only `SKILL.md` files (prompt skills in subdirs)
 * - Skips hidden directories (`.name`) and `node_modules`
 * - Respects `.gitignore`, `.ignore`, and `.fdignore` files
 *
 * All discovered skills are type "prompt" regardless of frontmatter.
 *
 * Paths are processed in order. If two skills have the same name, the first
 * path (lower index) wins. This enables priority: bundled > workspace > local.
 *
 * Missing paths are silently skipped (not all discovery paths may exist).
 * Malformed skill files are logged as warnings and skipped.
 * Symlinked files pointing to the same real path are silently deduplicated.
 *
 * @param paths - Directories to scan for skill files
 * @param logger - Optional structured logger for discovery warnings
 * @returns DiscoveryResult with deduplicated skills and diagnostics
 */
export function discoverSkills(paths: string[], logger?: DiscoveryLogger): DiscoveryResult {
  const skillMap = new Map<string, SkillMetadata>();
  const diagnostics: ResourceDiagnostic[] = [];
  const realPathSet = new Set<string>();
  const skillKeyMap = new Map<string, SkillMetadata>();

  for (let i = 0; i < paths.length; i++) {
    const basePath = paths[i];
    const source = resolveSource(i, paths.length);
    const ig = ignore();
    discoverSkillsFromDir(basePath, source, true, skillMap, diagnostics, realPathSet, ig, basePath, logger, skillKeyMap);
  }

  return { skills: Array.from(skillMap.values()), diagnostics };
}
