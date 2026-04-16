/**
 * Partial config validator: section-by-section validation that preserves valid portions.
 *
 * Unlike full validation which rejects the entire config on any error,
 * partial validation parses each top-level section independently. Valid
 * sections are collected into a partial config, and errors are reported
 * per-section. This enables graceful degradation when only some config
 * sections contain errors.
 *
 * @module
 */

import type { AppConfig, ConfigError } from "./types.js";
import { AppConfigSchema } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of section-by-section config validation.
 */
export interface PartialValidationResult {
  /** Successfully parsed config sections (may be partial) */
  config: Partial<AppConfig>;
  /** Section names that parsed successfully */
  validSections: string[];
  /** Errors for sections that failed validation */
  errors: Array<{ section: string; error: ConfigError }>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a raw config object section-by-section, preserving valid portions.
 *
 * Each top-level key in `raw` is parsed against its corresponding schema
 * independently. Valid sections are collected into a partial AppConfig,
 * while invalid sections produce errors without affecting other sections.
 *
 * Unknown top-level keys (not present in AppConfigSchema) are silently
 * ignored -- they are not treated as errors.
 *
 * @param raw - Raw config object to validate
 * @returns Aggregate result with valid sections and per-section errors
 *
 * @example
 * const result = validatePartial({
 *   tenantId: "my-app",
 *   security: "invalid", // will produce an error
 *   gateway: {},          // will be valid with defaults
 * });
 * // result.validSections = ["tenantId", "gateway"]
 * // result.errors = [{ section: "security", error: { ... } }]
 */
export function validatePartial(
  raw: Record<string, unknown>,
): PartialValidationResult {
  const config: Record<string, unknown> = {};
  const validSections: string[] = [];
  const errors: Array<{ section: string; error: ConfigError }> = [];

  // Get the schema shape to access per-key schemas
  const schemaShape = AppConfigSchema.shape;
  const knownKeys = new Set(Object.keys(schemaShape));

  for (const key of Object.keys(raw)) {
    // Skip unknown keys (not in schema)
    if (!knownKeys.has(key)) {
      continue;
    }

    const keySchema = schemaShape[key as keyof typeof schemaShape];
    if (!keySchema) {
      continue;
    }

    const result = keySchema.safeParse(raw[key]);

    if (result.success) {
      config[key] = result.data;
      validSections.push(key);
    } else {
      errors.push({
        section: key,
        error: {
          code: "VALIDATION_ERROR",
          message: `Validation failed for section "${key}": ${result.error.issues.map((i) => i.message).join("; ")}`,
          path: key,
          details: result.error.issues,
        },
      });
    }
  }

  return {
    config: config as Partial<AppConfig>,
    validSections,
    errors,
  };
}
