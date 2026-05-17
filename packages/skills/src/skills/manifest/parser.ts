// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { parse as parseYaml } from "yaml";
import type { SkillManifestParsed } from "./schema.js";
import { SkillManifestSchema } from "./schema.js";

// ---------------------------------------------------------------------------
// ParsedFrontmatter
// ---------------------------------------------------------------------------

/** Result of parsing a frontmatter+body file (e.g. SKILL.md). */
export interface ParsedFrontmatter<T> {
  readonly frontmatter: T;
  readonly body: string;
}

/**
 * Parse frontmatter and body from a SKILL.md file.
 *
 * Returns both the typed frontmatter object and the Markdown body content
 * after the closing `---` marker. Line endings are normalized to `\n`.
 *
 * @param content - Raw file content with YAML frontmatter
 * @returns `{ frontmatter, body }` wrapped in `Result`, or a descriptive Error
 */
export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): Result<ParsedFrontmatter<T>, Error> {
  // Normalize line endings
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!normalized.startsWith("---")) {
    return err(new Error("No frontmatter found: file must start with '---'"));
  }

  const afterOpening = normalized.indexOf("\n");
  if (afterOpening === -1) {
    return err(new Error("No frontmatter found: missing closing '---' marker"));
  }

  const closingIndex = normalized.indexOf("\n---", afterOpening);
  if (closingIndex === -1) {
    return err(new Error("No frontmatter found: missing closing '---' marker"));
  }

  const yamlContent = normalized.slice(afterOpening + 1, closingIndex);
  if (yamlContent.trim().length === 0) {
    return err(new Error("Empty frontmatter block"));
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch (e) {
    return err(new Error(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`));
  }

  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    return err(new Error("YAML frontmatter must be an object"));
  }

  // Body is everything after the closing --- marker, trimmed
  const body = normalized.slice(closingIndex + 4).trim();

  return ok({ frontmatter: parsed as T, body });
}

/**
 * Parse a SKILL.md file and validate its frontmatter against SkillManifestSchema.
 *
 * Extracts YAML frontmatter, parses it, then validates with Zod.
 * Comis-only fields must be under the `comis:` namespace block.
 * Returns a validated SkillManifestParsed on success, or a descriptive
 * Error on failure (parse error, validation error, or missing frontmatter).
 *
 * @param content - Raw SKILL.md file content
 * @returns Validated skill manifest or descriptive error
 */
export function parseSkillManifest(content: string): Result<SkillManifestParsed, Error> {
  const parsed = parseFrontmatter<Record<string, unknown>>(content);
  if (!parsed.ok) {
    return parsed;
  }

  const validation = SkillManifestSchema.safeParse(parsed.value.frontmatter);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return err(new Error(`Manifest validation failed: ${issues}`));
  }

  return ok(validation.data);
}
