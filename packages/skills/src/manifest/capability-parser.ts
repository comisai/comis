// SPDX-License-Identifier: Apache-2.0
/**
 * Defensive parser for `comis.capability` skill manifest blocks.
 *
 * Pitfall 7 mitigation. The outer `ComisNamespaceSchema` is z.strictObject --
 * a typo'd nested capability key (`replacePackages` missing `s`) would
 * normally cause the whole `comis:` block to fail parse and the skill to
 * become invisible. This function parses the capability sub-block separately
 * with try/recover semantics: on any validation failure (typo, type mismatch,
 * empty string), log a Pino WARN with `errorKind: "config"` and return
 * undefined. The skill renders under the fallback `prompt-skills` cluster.
 *
 * Per design §4.2.1: capability metadata is enrichment, not a gate.
 * The skill itself is NEVER hidden solely because optional capability
 * metadata is invalid.
 *
 * Caller pattern (Plan 17-04 wires this in two sites):
 *   const ns = (typeof obj["comis"] === "object" && ...) ? ... : undefined;
 *   const capability = parseComisCapabilityDefensively(ns?.["capability"], skillName, logger);
 *   // ... include `capability` in SkillMetadata; downstream filters tolerate undefined.
 *
 * @module
 */

import type { ToolCapabilityMetadata } from "@comis/core";
import { ComisCapabilityBlockSchema } from "./schema.js";

// Re-export ToolCapabilityMetadata so consumers that import from
// `@comis/skills/manifest/capability-parser` keep working after the
// Wave 1 merge swapped the local declaration for the canonical
// `@comis/core` type. Plan 17-03 introduced the local interface as a
// wave-1-parallel workaround; Plan 17-04 closes that deviation.
export type { ToolCapabilityMetadata };

/** Pino-compatible logger interface. The skills package already uses this shape; reuse here. */
interface DiscoveryLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Defensively parse a `comis.capability` block.
 *
 * On success: returns the parsed shape (with defaults applied).
 * On failure: logs a Pino WARN with `errorKind: "config"`, the skillName,
 * the Zod issue paths, and an operator-actionable hint, then returns
 * undefined. NEVER throws.
 *
 * @param raw - The raw `capability` value from `manifest.comis.capability`
 *              (may be undefined or null).
 * @param skillName - Used in the WARN log payload for operator context.
 * @param logger - Optional Pino logger. When omitted, parse failures fall
 *                 through silently (the function still returns undefined;
 *                 the caller may emit its own log).
 * @returns Parsed capability metadata, or undefined if absent / malformed.
 */
export function parseComisCapabilityDefensively(
  raw: unknown,
  skillName: string,
  logger: DiscoveryLogger | undefined,
): ToolCapabilityMetadata | undefined {
  // Fast path: no capability block declared -> no log, no work.
  if (raw === undefined) return undefined;

  const result = ComisCapabilityBlockSchema.safeParse(raw);
  if (result.success) {
    // Coerce the Zod-inferred shape into ToolCapabilityMetadata
    // (compatible by structure).
    return {
      cluster: result.data.cluster,
      summary: result.data.summary,
      replacesPackages: result.data.replacesPackages,
    };
  }

  // Malformed -- log WARN and fall back. This path NEVER raises an exception.
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
  logger?.warn(
    {
      errorKind: "config" as const,
      skillName,
      issues,
      hint:
        "Fix the comis.capability block in the skill manifest, or remove it. " +
        "The skill will render under the fallback 'prompt-skills' cluster until corrected.",
    },
    "Malformed comis.capability metadata; skill renders under fallback cluster.",
  );
  return undefined;
}
