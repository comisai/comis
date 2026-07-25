// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AppConfig, ConfigError } from "./types.js";
import { AppConfigSchema } from "./schema.js";
import type { IncludeResolverDeps } from "./include-resolver.js";
import { resolveIncludes } from "./include-resolver.js";
import {
  findUnresolvedEnvRefs,
  substituteEnvVars,
  type UnresolvedEnvRef,
} from "./env-substitution.js";

/**
 * Options for enhanced config file loading with $include and ${VAR} support.
 */
export interface ConfigLoadOptions {
  /** Dependencies for $include resolution. If omitted, $include is not processed. */
  includeDeps?: IncludeResolverDeps;
  /** Secret getter for ${VAR} substitution. If omitted, substitution is not performed. */
  getSecret?: (key: string) => string | undefined;
}

/**
 * Load and parse a configuration file (YAML or JSON).
 *
 * File format is determined by extension:
 * - `.yaml` / `.yml` -> YAML parser
 * - `.json` -> JSON parser
 * - Other -> attempts YAML first (superset of JSON)
 *
 * When options are provided, the processing pipeline becomes:
 * 1. Read file + parse YAML/JSON
 * 2. If `options.includeDeps` provided: resolve $include directives
 * 3. If `options.getSecret` provided: substitute ${VAR} references
 * 4. Return processed object
 *
 * Returns the raw parsed object (unvalidated) or a ConfigError.
 */
export function loadConfigFile(
  filePath: string,
  options?: ConfigLoadOptions,
): Result<Record<string, unknown>, ConfigError> {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    return err({
      code: "FILE_NOT_FOUND",
      message: `Config file not found: ${resolved}`,
      path: resolved,
    });
  }

  let content: string;
  try {
    content = fs.readFileSync(resolved, "utf-8");
  } catch (e) {
    return err({
      code: "FILE_NOT_FOUND",
      message: `Failed to read config file: ${resolved}`,
      path: resolved,
      details: e,
    });
  }

  const ext = path.extname(resolved).toLowerCase();

  try {
    let parsed: unknown;

    if (ext === ".json") {
      parsed = JSON.parse(content);
    } else {
      // YAML is a superset of JSON, so use YAML parser for .yaml, .yml, and unknown
      parsed = parseYaml(content);
    }

    // Handle empty files (YAML parses to null/undefined)
    if (parsed === null || parsed === undefined) {
      return ok({});
    }

    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return err({
        code: "PARSE_ERROR",
        message: `Config file must contain an object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        path: resolved,
      });
    }

    let processed: Record<string, unknown> = parsed as Record<string, unknown>;

    // Step 2: Resolve $include directives (if deps provided)
    if (options?.includeDeps) {
      const includeResult = resolveIncludes(processed, path.dirname(resolved), options.includeDeps);
      if (!includeResult.ok) {
        return includeResult as Result<Record<string, unknown>, ConfigError>;
      }
      processed = includeResult.value as Record<string, unknown>;
    }

    // Step 3: Substitute ${VAR} references (if getSecret provided)
    if (options?.getSecret) {
      const subResult = substituteConfigEnvVars(processed, options.getSecret, resolved);
      if (!subResult.ok) {
        return subResult;
      }
      processed = subResult.value;
    }

    return ok(processed);
  } catch (e) {
    return err({
      code: "PARSE_ERROR",
      message: `Failed to parse config file: ${resolved}`,
      path: resolved,
      details: e,
    });
  }
}

/**
 * Validate a raw config object against the AppConfigSchema.
 *
 * Applies Zod defaults for missing fields, enforces strict typing,
 * and returns a fully typed AppConfig or a ConfigError with validation details.
 */
export function validateConfig(raw: Record<string, unknown>): Result<AppConfig, ConfigError> {
  const result = AppConfigSchema.safeParse(raw);

  if (result.success) {
    return ok(result.data);
  }

  return err({
    code: "VALIDATION_ERROR",
    message: `Config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    details: result.error.issues,
  });
}

interface DisabledMcpStash {
  readonly idx: number;
  readonly original: unknown;
}

/**
 * Replace `enabled: false` MCP server entries in
 * `integrations.mcp.servers[]` with neutral stubs and return the originals
 * so `restoreDisabledMcpServers` can put them back after env substitution.
 * The returned masking copy leaves the caller's parsed layer unchanged.
 */
function maskDisabledMcpServers(processed: Record<string, unknown>): {
  masked: Record<string, unknown>;
  stash: DisabledMcpStash[];
} {
  const integrations = processed.integrations;
  if (integrations === null || typeof integrations !== "object" || Array.isArray(integrations)) {
    return { masked: processed, stash: [] };
  }
  const mcp = (integrations as Record<string, unknown>).mcp;
  if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) {
    return { masked: processed, stash: [] };
  }
  const servers = (mcp as Record<string, unknown>).servers;
  if (!Array.isArray(servers)) return { masked: processed, stash: [] };

  const stash: DisabledMcpStash[] = [];
  const maskedServers = [...servers];
  for (let idx = 0; idx < servers.length; idx++) {
    const srv = servers[idx];
    if (srv === null || typeof srv !== "object" || Array.isArray(srv)) continue;
    if ((srv as { enabled?: unknown }).enabled !== false) continue;
    stash.push({ idx, original: srv });
    maskedServers[idx] = { enabled: false };
  }
  if (stash.length === 0) return { masked: processed, stash };
  return {
    masked: {
      ...processed,
      integrations: {
        ...(integrations as Record<string, unknown>),
        mcp: {
          ...(mcp as Record<string, unknown>),
          servers: maskedServers,
        },
      },
    },
    stash,
  };
}

/**
 * Restore originals saved by `maskDisabledMcpServers`. Operates
 * on the substituted tree (a fresh object returned by `substituteEnvVars`),
 * walking back to the same array index. No-op when stash is empty.
 */
function restoreDisabledMcpServers(
  processed: Record<string, unknown>,
  stash: readonly DisabledMcpStash[],
): void {
  if (stash.length === 0) return;
  const integrations = processed.integrations;
  if (integrations === null || typeof integrations !== "object" || Array.isArray(integrations)) {
    return;
  }
  const mcp = (integrations as Record<string, unknown>).mcp;
  if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) return;
  const servers = (mcp as Record<string, unknown>).servers;
  if (!Array.isArray(servers)) return;
  for (const { idx, original } of stash) {
    if (idx < servers.length) servers[idx] = original;
  }
}

/**
 * Apply the daemon's environment-substitution contract to one config layer.
 * Disabled MCP entries remain literal because connect-time filtering never
 * consumes their environment.
 */
export function substituteConfigEnvVars(
  processed: Record<string, unknown>,
  getSecret: (key: string) => string | undefined,
  configPath?: string,
): Result<Record<string, unknown>, ConfigError> {
  const { masked, stash } = maskDisabledMcpServers(processed);
  const subResult = substituteEnvVars(masked, getSecret, configPath);
  if (!subResult.ok) {
    return subResult as Result<Record<string, unknown>, ConfigError>;
  }
  const substituted = subResult.value as Record<string, unknown>;
  restoreDisabledMcpServers(substituted, stash);
  return ok(substituted);
}

/** Find unresolved refs using the same disabled-MCP exclusion as substitution. */
export function findConfigUnresolvedEnvRefs(
  processed: Record<string, unknown>,
  getSecret: (key: string) => string | undefined,
): UnresolvedEnvRef[] {
  const { masked } = maskDisabledMcpServers(processed);
  return findUnresolvedEnvRefs(masked, getSecret);
}
