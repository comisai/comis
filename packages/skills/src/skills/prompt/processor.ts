// SPDX-License-Identifier: Apache-2.0
/**
 * XML formatting utilities for prompt skill system prompt injection.
 *
 * Pure utility functions that transform prompt skill metadata and content
 * into safe XML for system prompt injection. Used by the prompt skill
 * registry and system prompt assembler.
 *
 * All functions are stateless -- no event bus, no config reads, no filesystem.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal skill description needed for the <available_skills> XML listing. */
export interface PromptSkillDescription {
  readonly name: string;
  readonly description: string;
  /** Absolute path to the skill directory. Emitted in available_skills listing and used by expandSkillForInvocation. */
  readonly location: string;
  /** When true, skill is hidden from the model's available skills listing. */
  readonly disableModelInvocation?: boolean;
  /** Origin of this skill: bundled (shared), workspace, or local (agent-specific). */
  readonly source?: "bundled" | "workspace" | "local";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Instruction text injected into the system prompt to tell the model
 * how to use prompt skills.
 */
export const SYSTEM_PROMPT_INSTRUCTION =
  "Use the read tool to load a skill's file when the task matches its description. " +
  "When a skill file references a relative path, resolve it against the skill directory.";

// ---------------------------------------------------------------------------
// XML Escaping
// ---------------------------------------------------------------------------

/**
 * Escape the 5 predefined XML entities in a string.
 *
 * The `&` character is escaped FIRST to prevent double-escaping of
 * entity references produced by subsequent replacements.
 *
 * Pattern based on `escapeHtml()` in `ir-renderer.ts:207`, extended
 * with `"` and `'` for full XML entity coverage.
 *
 * @param str - The string to escape
 * @returns The escaped string safe for XML attribute values and text content
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Available Skills XML Listing
// ---------------------------------------------------------------------------

/**
 * Generate an `<available_skills>` XML block listing visible prompt skills.
 *
 * Skills with `disableModelInvocation === true` are filtered out.
 * Returns an empty string when no visible skills remain (including empty input).
 *
 * Each skill's name, description, and location (absolute path) are XML-escaped for safety.
 *
 * @param skills - Readonly array of skill descriptions to list
 * @returns XML string or empty string if no visible skills
 */
export function formatAvailableSkillsXml(
  skills: readonly PromptSkillDescription[],
): string {
  const visible = skills.filter((s) => s.disableModelInvocation !== true);
  if (visible.length === 0) return "";

  const entries = visible.map(
    (s) =>
      `  <skill>\n` +
      `    <name>${escapeXml(s.name)}</name>\n` +
      `    <description>${escapeXml(s.description)}</description>\n` +
      `    <location>${escapeXml(s.location)}</location>\n` +
      `  </skill>`,
  );

  return `<available_skills>\n${entries.join("\n")}\n</available_skills>`;
}

// ---------------------------------------------------------------------------
// Argument Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a user argument string into individual arguments, respecting quoted strings.
 *
 * Splits on whitespace but preserves content inside single or double quotes.
 * Quotes are stripped from the output. Empty input returns an empty array.
 *
 * @param argsString - Raw argument string from user invocation
 * @returns Array of individual argument strings
 */
export function parseSkillArgs(argsString: string): string[] {
  const trimmed = argsString.trim();
  if (!trimmed) return [];

  const args: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (/\s/.test(ch) && !inDouble && !inSingle) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);

  return args;
}

// ---------------------------------------------------------------------------
// Template Substitution
// ---------------------------------------------------------------------------

/** Named placeholder pattern: {identifier} */
const NAMED_PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** SDK positional patterns: $1, $2, ..., $@, $ARGUMENTS, ${@:N} */
const POSITIONAL_RE = /\$(?:(\d+)|(@|ARGUMENTS)|\{@:(\d+)\})/g;

/**
 * Substitute arguments into a skill body containing template patterns.
 *
 * Supports two syntaxes:
 * - **Named placeholders:** `{placeholder}` -- mapped positionally (first unique placeholder gets args[0], etc.)
 * - **SDK positional:** `$1`, `$2` (1-indexed), `$@`/`$ARGUMENTS` (all args), `${@:N}` (args from index N onwards)
 *
 * When more placeholders exist than args, unmatched placeholders are left as-is.
 * When more args exist than named placeholders, remaining args are appended as "Additional arguments: ...".
 *
 * @param body - Skill body possibly containing template patterns
 * @param args - Parsed argument array
 * @returns Object with substituted body and whether templates were detected
 */
export function substituteSkillArgs(
  body: string,
  args: string[],
): { substituted: string; hasTemplates: boolean } {
  // Check for named placeholder patterns
  const namedMatches = [...body.matchAll(NAMED_PLACEHOLDER_RE)];
  // Check for positional patterns
  const positionalMatches = [...body.matchAll(POSITIONAL_RE)];

  const hasNamed = namedMatches.length > 0;
  const hasPositional = positionalMatches.length > 0;

  if (!hasNamed && !hasPositional) {
    return { substituted: body, hasTemplates: false };
  }

  let result = body;

  if (hasNamed) {
    // Extract unique placeholder names in order of first appearance
    const seen = new Set<string>();
    const orderedNames: string[] = [];
    for (const m of namedMatches) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        orderedNames.push(m[1]);
      }
    }

    // Build substitution map: positional mapping
    const nameToArg = new Map<string, string>();
    for (let i = 0; i < orderedNames.length && i < args.length; i++) {
      nameToArg.set(orderedNames[i], args[i]);
    }

    // Replace named placeholders (only those with a mapped arg)
    result = result.replace(NAMED_PLACEHOLDER_RE, (match, name: string) => {
      const arg = nameToArg.get(name);
      return arg !== undefined ? arg : match;
    });

    // Handle extra args beyond named placeholders
    if (args.length > orderedNames.length) {
      const extra = args.slice(orderedNames.length);
      result += `\n\nAdditional arguments: ${extra.join(" ")}`;
    }
  }

  if (hasPositional) {
    result = result.replace(POSITIONAL_RE, (match, num: string | undefined, allMarker: string | undefined, sliceStart: string | undefined) => {
      if (num !== undefined) {
        // $1, $2, ... (1-indexed)
        const idx = parseInt(num, 10) - 1;
        return idx >= 0 && idx < args.length ? args[idx] : match;
      }
      if (allMarker !== undefined) {
        // $@ or $ARGUMENTS
        return args.length > 0 ? args.join(" ") : match;
      }
      if (sliceStart !== undefined) {
        // ${@:N} (1-indexed start)
        const startIdx = parseInt(sliceStart, 10) - 1;
        const slice = args.slice(startIdx);
        return slice.length > 0 ? slice.join(" ") : match;
      }
      return match;
    });
  }

  return { substituted: result, hasTemplates: true };
}

// ---------------------------------------------------------------------------
// Skill Expansion for Invocation
// ---------------------------------------------------------------------------

/**
 * Expand a prompt skill body into a `<skill>` XML block for system prompt injection.
 *
 * The body content is NOT XML-escaped -- it contains Markdown intended for the LLM.
 * Only the name, location, baseDir, and user arguments are XML-escaped.
 *
 * When the body contains template patterns (`{placeholder}` or `$1`/`$@`) and args
 * are provided, arguments are substituted directly into the body. Otherwise, args
 * are appended after the closing `</skill>` tag per the pi-mono pattern.
 *
 * @param name - Skill name (XML-escaped in attribute)
 * @param body - Raw Markdown body content (NOT escaped)
 * @param location - Absolute path to skill directory (XML-escaped in attribute)
 * @param baseDir - Base directory for relative path resolution (XML-escaped in preamble)
 * @param args - Optional user arguments to substitute or append after the skill block
 * @returns Formatted skill block string
 */
export function expandSkillForInvocation(
  name: string,
  body: string,
  location: string,
  baseDir: string,
  args?: string,
): string {
  const preamble = `References are relative to ${escapeXml(baseDir)}.`;

  let finalBody = body;
  let argsConsumed = false;

  if (args) {
    const parsedArgs = parseSkillArgs(args);
    const { substituted, hasTemplates } = substituteSkillArgs(body, parsedArgs);
    if (hasTemplates) {
      finalBody = substituted;
      argsConsumed = true;
    }
  }

  const skillBlock =
    `<skill name="${escapeXml(name)}" location="${escapeXml(location)}">\n` +
    `${preamble}\n` +
    `${finalBody}\n` +
    `</skill>`;

  if (!args || argsConsumed) return skillBlock;
  return `${skillBlock}\n\nUser arguments: ${escapeXml(args)}`;
}
