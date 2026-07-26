// SPDX-License-Identifier: Apache-2.0
/**
 * Pure parser and name resolver for `/.well-known/skills/index.json`.
 *
 * The index names files only. It grants no trust, carries no content hash, and
 * performs no network or filesystem work. Callers fetch every resolved file
 * through the normal remote-fetch substrate and route the resulting map through
 * `vetSkillBundle`.
 *
 * @module
 */

import { z } from "zod";
import { err, ok, type Result } from "@comis/shared";

const WellKnownSkillSchema = z.strictObject({
  name: z.string().min(1).max(64),
  description: z.string().max(1024).optional(),
  files: z.array(z.string().min(1).max(512)).max(200).optional(),
});

const WellKnownIndexSchema = z.strictObject({
  skills: z.array(WellKnownSkillSchema).max(10_000),
});

/** Validated index projection. */
export type WellKnownIndex = z.infer<typeof WellKnownIndexSchema>;

/** A resolved entry ready for the daemon fetch loop. */
export interface ResolvedWellKnownSkill {
  readonly name: string;
  readonly description?: string;
  readonly files: readonly string[];
}

/** Closed error taxonomy for deterministic caller mapping. */
export type WellKnownIndexError =
  | { readonly kind: "invalid_index"; readonly message: string }
  | { readonly kind: "skill_not_found"; readonly message: string }
  | { readonly kind: "unsafe_path"; readonly message: string; readonly path: string };

/** Parse untrusted JSON into the strict bounded index projection. */
export function parseWellKnownIndex(
  input: unknown,
): Result<WellKnownIndex, WellKnownIndexError> {
  const parsed = WellKnownIndexSchema.safeParse(input);
  if (!parsed.success) {
    return err({ kind: "invalid_index", message: parsed.error.message });
  }
  return ok(parsed.data);
}

/** Normalize one portable relative path or return null when it is unsafe. */
function normalizeRelativePath(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, "/").trim();
  if (normalized.length === 0 || normalized.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.length > 10) return null;
  if (segments.some((segment) => segment === ".." || segment.includes("\0"))) return null;
  return segments.join("/");
}

/** Resolve one exact name and validate every named file before any fetch occurs. */
export function resolveWellKnownSkill(
  index: WellKnownIndex,
  name: string,
): Result<ResolvedWellKnownSkill, WellKnownIndexError> {
  const entry = index.skills.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    return err({ kind: "skill_not_found", message: `Skill not found in well-known index: ${name}` });
  }

  const normalized = new Set<string>(["SKILL.md"]);
  for (const rawPath of entry.files ?? []) {
    const path = normalizeRelativePath(rawPath);
    if (path === null) {
      return err({
        kind: "unsafe_path",
        message: `Well-known skill contains an unsafe member path: ${rawPath}`,
        path: rawPath,
      });
    }
    normalized.add(path);
  }

  const files = [...normalized].sort((a, b) => {
    if (a === "SKILL.md") return -1;
    if (b === "SKILL.md") return 1;
    return a.localeCompare(b);
  });
  return ok({
    name: entry.name,
    ...(entry.description !== undefined && { description: entry.description }),
    files,
  });
}
