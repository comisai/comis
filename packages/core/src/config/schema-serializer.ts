// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Unknown config section guard in serializeSection(); consumed via daemon config-handlers (@allow-throw boundary).
/**
 * Config schema serializer: converts Zod schemas to JSON Schema for agent introspection.
 *
 * Provides cached conversion of the full AppConfig schema and per-section schemas
 * to JSON Schema format. This allows agents to introspect the configuration structure
 * and understand valid values before attempting config patches.
 *
 * @module
 */

import { z } from "zod";
import { AppConfigSchema } from "./schema.js";
import { SECTION_REGISTRY } from "./section-registry.js";

// ---------------------------------------------------------------------------
// Section schema lookup
// ---------------------------------------------------------------------------

/**
 * Maps config section names to their Zod schema objects.
 *
 * Derived from SECTION_REGISTRY — never a standalone literal list, which
 * would drift from field-metadata.ts and managed-sections.ts. The registry
 * is the single source of truth for the section set.
 */
const SECTION_SCHEMAS: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(SECTION_REGISTRY)
    .filter(([, entry]) => entry.schemaSerializable)
    .map(([name, entry]) => [name, entry.schema]),
);

// ---------------------------------------------------------------------------
// Full schema cache
// ---------------------------------------------------------------------------

let fullSchemaCache: Record<string, unknown> | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert the AppConfig schema (or a specific section) to JSON Schema.
 *
 * When called without arguments, returns the full AppConfig JSON Schema
 * (cached after first call). When called with a section name, returns the
 * JSON Schema for that section only (not cached -- section schemas are small).
 *
 * @param section - Optional section name (e.g., "agent", "gateway")
 * @returns JSON Schema object
 * @throws Error if section name is not recognized
 *
 * @example
 * const full = getConfigSchema(); // full AppConfig schema
 * const agent = getConfigSchema("agent"); // agent section only
 */
export function getConfigSchema(section?: string): Record<string, unknown> {
  if (section !== undefined) {
    const sectionSchema = SECTION_SCHEMAS[section];
    if (!sectionSchema) {
      throw new Error(`Unknown config section: ${section}`);
    }
    return z.toJSONSchema(sectionSchema, { reused: "inline", unrepresentable: "any" }) as Record<string, unknown>;
  }

  if (!fullSchemaCache) {
    fullSchemaCache = z.toJSONSchema(AppConfigSchema, {
      reused: "inline",
      unrepresentable: "any",
    }) as Record<string, unknown>;
  }

  return fullSchemaCache;
}

/**
 * Get the list of available config section names.
 *
 * Useful for agents to discover which sections can be queried individually.
 *
 * @returns Array of section name strings
 */
export function getConfigSections(): string[] {
  return Object.keys(SECTION_SCHEMAS);
}
