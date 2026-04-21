// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import * as path from "node:path";
import type { ConfigError } from "./types.js";
import { deepMerge } from "./layered.js";

/**
 * Maximum nesting depth for $include directives.
 * Prevents runaway recursion from deeply-nested (but non-circular) include chains.
 */
export const MAX_INCLUDE_DEPTH = 10;

/**
 * Injectable dependencies for include resolution.
 * Allows testing without filesystem access and production use with safePath().
 */
export interface IncludeResolverDeps {
  /** Read a file by absolute path. */
  readFile: (absPath: string) => Result<string, ConfigError>;
  /** Parse raw file content into an object. */
  parseFn: (raw: string, filePath: string) => Result<Record<string, unknown>, ConfigError>;
  /** Resolve an include path relative to a base directory (uses safePath in production). */
  resolvePath: (basePath: string, includePath: string) => Result<string, ConfigError>;
}

/**
 * Resolve all `$include` directives in a parsed config object tree.
 *
 * Processing rules:
 * - Walks the object tree recursively looking for `$include` string keys
 * - For each `$include`, loads and parses the referenced file
 * - Deep merges: included content is the base, sibling keys override
 * - Detects circular references via a visited path set
 * - Enforces a maximum nesting depth of MAX_INCLUDE_DEPTH
 * - Include paths are resolved via deps.resolvePath (safePath in production)
 *
 * @param obj - The parsed config object (or any value from the tree)
 * @param basePath - Directory to resolve relative include paths against
 * @param deps - Injectable file I/O and path resolution
 * @param visited - Set of already-visited absolute paths (for circular detection)
 * @param depth - Current nesting depth (0-based)
 * @returns The resolved object with all $include directives expanded
 */
export function resolveIncludes(
  obj: unknown,
  basePath: string,
  deps: IncludeResolverDeps,
  visited?: Set<string>,
  depth?: number,
): Result<unknown, ConfigError> {
  const currentDepth = depth ?? 0;
  const visitedSet = visited ?? new Set<string>();

  // Non-object values pass through unchanged
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return ok(obj);
  }

  // Arrays: resolve each element recursively
  if (Array.isArray(obj)) {
    const resolved: unknown[] = [];
    for (const element of obj) {
      const result = resolveIncludes(element, basePath, deps, visitedSet, currentDepth);
      if (!result.ok) {
        return result;
      }
      resolved.push(result.value);
    }
    return ok(resolved);
  }

  // Plain object: check for $include directive
  const record = obj as Record<string, unknown>;

  if ("$include" in record && typeof record.$include === "string") {
    // Check depth limit
    if (currentDepth >= MAX_INCLUDE_DEPTH) {
      return err({
        code: "INCLUDE_ERROR",
        message: `Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded — check for deep nesting`,
      });
    }

    const includePath = record.$include;

    // Resolve the include path against the base directory
    const resolveResult = deps.resolvePath(basePath, includePath);
    if (!resolveResult.ok) {
      return err({
        code: "INCLUDE_ERROR",
        message: resolveResult.error.message,
        path: includePath,
      });
    }

    const absPath = path.normalize(resolveResult.value);

    // Check for circular includes
    if (visitedSet.has(absPath)) {
      const cycle = [...visitedSet, absPath].join(" -> ");
      return err({
        code: "CIRCULAR_INCLUDE",
        message: `Circular $include detected: ${cycle}`,
        path: absPath,
      });
    }

    // Add to visited set
    const newVisited = new Set(visitedSet);
    newVisited.add(absPath);

    // Read the included file
    const readResult = deps.readFile(absPath);
    if (!readResult.ok) {
      return err({
        code: "INCLUDE_ERROR",
        message: `Failed to read included file "${includePath}": ${readResult.error.message}`,
        path: absPath,
      });
    }

    // Parse the included file
    const parseResult = deps.parseFn(readResult.value, absPath);
    if (!parseResult.ok) {
      return err({
        code: "INCLUDE_ERROR",
        message: `Failed to parse included file "${includePath}": ${parseResult.error.message}`,
        path: absPath,
      });
    }

    // Recursively resolve includes in the included content
    const includedBasePath = path.dirname(absPath);
    const resolvedIncluded = resolveIncludes(
      parseResult.value,
      includedBasePath,
      deps,
      newVisited,
      currentDepth + 1,
    );
    if (!resolvedIncluded.ok) {
      return resolvedIncluded;
    }

    // Build the sibling object (everything except $include)
    const siblings: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (key !== "$include") {
        siblings[key] = record[key];
      }
    }

    // Resolve includes in sibling values too
    const resolvedSiblings = resolveIncludes(siblings, basePath, deps, visitedSet, currentDepth);
    if (!resolvedSiblings.ok) {
      return resolvedSiblings;
    }

    // Deep merge: included content is the base, siblings override
    const included = resolvedIncluded.value as Record<string, unknown>;
    const overrides = resolvedSiblings.value as Record<string, unknown>;
    return ok(deepMerge(included, overrides));
  }

  // No $include at this level — recurse into all values
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const resolved = resolveIncludes(record[key], basePath, deps, visitedSet, currentDepth);
    if (!resolved.ok) {
      return resolved;
    }
    result[key] = resolved.value;
  }
  return ok(result);
}
