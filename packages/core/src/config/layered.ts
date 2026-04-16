import type { Result } from "@comis/shared";
import { err } from "@comis/shared";
import type { AppConfig, ConfigError } from "./types.js";
import { loadConfigFile, validateConfig } from "./loader.js";
import { migrateConfig } from "./migrate.js";

/** Keys that could cause prototype pollution -- filtered as defense-in-depth. */
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Deep merge two objects with layered override semantics.
 *
 * Rules:
 * - Objects: recursive merge
 * - Arrays: later layer replaces entirely (no concatenation)
 * - Primitives: later layer overrides
 * - undefined values: ignored (don't overwrite existing)
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(override)) {
    // Defense-in-depth: skip prototype-polluting keys
    if (PROTO_KEYS.has(key)) {
      continue;
    }

    const overrideValue = override[key];

    // Skip undefined values
    if (overrideValue === undefined) {
      continue;
    }

    const baseValue = result[key];

    // If both are plain objects, recurse
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(
        baseValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>,
      );
    } else {
      // Arrays replace, primitives override
      result[key] = overrideValue;
    }
  }

  return result;
}

/**
 * Check if a value is a plain object (not array, null, or class instance).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Merge multiple raw config layers and validate the result.
 *
 * Layers are applied left-to-right: later layers override earlier ones.
 * The merged result is validated against AppConfigSchema.
 */
export function mergeLayered(layers: Record<string, unknown>[]): Result<AppConfig, ConfigError> {
  if (layers.length === 0) {
    return validateConfig({});
  }

  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    merged = deepMerge(merged, layer);
  }

  const migrated = migrateConfig(merged);
  return validateConfig(migrated);
}

/**
 * Load config files from multiple paths and merge them in order.
 *
 * Files are loaded left-to-right with later files overriding earlier ones.
 * This supports the common pattern: defaults.yaml < config.yaml < config.local.yaml
 *
 * If any file fails to load, returns the error immediately.
 */
export function loadLayered(
  configPaths: string[],
  options?: { getSecret?: (key: string) => string | undefined },
): Result<AppConfig, ConfigError> {
  const layers: Record<string, unknown>[] = [];

  for (const configPath of configPaths) {
    const result = loadConfigFile(configPath, options?.getSecret ? { getSecret: options.getSecret } : undefined);
    if (!result.ok) {
      return err(result.error);
    }
    layers.push(result.value);
  }

  return mergeLayered(layers);
}
