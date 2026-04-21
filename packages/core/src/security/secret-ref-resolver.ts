// SPDX-License-Identifier: Apache-2.0
/**
 * SecretRef resolver — resolves secret references from env, file, or exec sources.
 *
 * Providers:
 * - **env**: Reads from SecretManager (environment variables / encrypted store)
 * - **file**: Reads from an absolute file path with permission validation.
 *   Supports JSON Pointer extraction via `provider#/json/pointer` syntax.
 * - **exec**: Invokes a credential helper binary via JSON RPC protocol with timeout.
 *
 * Resolver implementation.
 * Config-level deep walk.
 */

import { ok, err } from "@comis/shared";
import type { Result } from "@comis/shared";
import type { SecretRef } from "../domain/secret-ref.js";
import { isSecretRef } from "../domain/secret-ref.js";
import type { SecretManager } from "./secret-manager.js";
import { readFileSync, statSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Dependencies for resolving secret references.
 *
 * File system and child_process functions are injectable for testability.
 * Production code uses node:fs / node:child_process defaults.
 */
export interface ResolveSecretRefDeps {
  secretManager: SecretManager;
  readFileSync?: (filePath: string, encoding: "utf-8") => string;
  statSync?: (filePath: string) => {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mode: number;
  };
  realpathSync?: (filePath: string) => string;
  execFileSync?: (
    cmd: string,
    args: string[],
    opts: {
      input?: string;
      timeout?: number;
      encoding?: BufferEncoding;
      maxBuffer?: number;
    },
  ) => string;
}

/** Options for secret ref resolution. */
export interface ResolveSecretRefOptions {
  /** Maximum file size in bytes for file source (default: 1MB). */
  fileMaxBytes?: number;
  /** Timeout in milliseconds for exec source (default: 10s). */
  execTimeoutMs?: number;
}

const DEFAULT_FILE_MAX_BYTES = 1_048_576; // 1MB
const DEFAULT_EXEC_TIMEOUT_MS = 10_000; // 10s

/**
 * Resolve a single SecretRef to its string value.
 *
 * @param ref - The SecretRef to resolve
 * @param deps - Dependencies (SecretManager + optional fs/exec overrides)
 * @param options - Resolution options (file size limit, exec timeout)
 * @returns Result<string, Error> — the resolved secret value or an error
 */
export function resolveSecretRef(
  ref: SecretRef,
  deps: ResolveSecretRefDeps,
  options?: ResolveSecretRefOptions,
): Result<string, Error> {
  switch (ref.source) {
    case "env":
      return resolveEnvRef(ref, deps);
    case "file":
      return resolveFileRef(ref, deps, options);
    case "exec":
      return resolveExecRef(ref, deps, options);
    default:
      return err(new Error(`Unknown SecretRef source: ${String((ref as SecretRef).source)}`));
  }
}

/** Resolve an env-source SecretRef from SecretManager. */
function resolveEnvRef(ref: SecretRef, deps: ResolveSecretRefDeps): Result<string, Error> {
  const value = deps.secretManager.get(ref.id);
  if (value === undefined) {
    return err(
      new Error(`Secret ref env:${ref.provider}/${ref.id} not found in SecretManager`),
    );
  }
  return ok(value);
}

/** Resolve a file-source SecretRef from disk. */
function resolveFileRef(
  ref: SecretRef,
  deps: ResolveSecretRefDeps,
  options?: ResolveSecretRefOptions,
): Result<string, Error> {
  const _statSync = deps.statSync ?? statSync;
  const _realpathSync = deps.realpathSync ?? realpathSync;
  const _readFileSync = deps.readFileSync ?? readFileSync;
  const maxBytes = options?.fileMaxBytes ?? DEFAULT_FILE_MAX_BYTES;

  // Validate absolute path
  if (!path.isAbsolute(ref.id)) {
    return err(
      new Error(
        `Secret ref file:${ref.provider}/${ref.id} must use an absolute path`,
      ),
    );
  }

  // Defense-in-depth: reject path traversal segments
  if (ref.id.includes("..")) {
    return err(
      new Error(
        `Secret ref file:${ref.provider}/${ref.id} contains path traversal segments`,
      ),
    );
  }

  // Validate file exists and is a regular file
  let resolvedPath = ref.id;
  let stat;
  try {
    stat = _statSync(ref.id);
  } catch {
    return err(
      new Error(`Secret ref file:${ref.provider}/${ref.id} not found`),
    );
  }

  // Handle symlinks: resolve and re-validate
  if (stat.isSymbolicLink()) {
    try {
      resolvedPath = _realpathSync(ref.id);
      stat = _statSync(resolvedPath);
    } catch {
      return err(
        new Error(
          `Secret ref file:${ref.provider}/${ref.id} symlink could not be resolved`,
        ),
      );
    }
  }

  if (!stat.isFile()) {
    return err(
      new Error(
        `Secret ref file:${ref.provider}/${ref.id} is not a regular file`,
      ),
    );
  }

  // Check file size limit
  if (stat.size > maxBytes) {
    return err(
      new Error(
        `Secret ref file:${ref.provider}/${ref.id} exceeds size limit (${stat.size} > ${maxBytes} bytes)`,
      ),
    );
  }

  // Read file content
  let content: string;
  try {
    content = _readFileSync(resolvedPath, "utf-8");
  } catch (e: unknown) {
    return err(
      new Error(
        `Secret ref file:${ref.provider}/${ref.id} read failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  // Check for JSON Pointer in provider field (format: "providerName#/json/pointer")
  const hashIndex = ref.provider.indexOf("#");
  if (hashIndex !== -1) {
    const pointer = ref.provider.slice(hashIndex + 1);
    return extractJsonPointer(content, pointer, ref);
  }

  // Single-value file: trim whitespace
  return ok(content.trim());
}

/**
 * Extract a value from JSON content using a JSON Pointer (RFC 6901).
 * Simple implementation: split on `/`, walk the parsed object.
 */
function extractJsonPointer(
  content: string,
  pointer: string,
  ref: SecretRef,
): Result<string, Error> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return err(
      new Error(
        `Secret ref file:${ref.provider}/${ref.id} is not valid JSON (pointer extraction requires JSON)`,
      ),
    );
  }

  // Split pointer: "/data/apiKey" -> ["data", "apiKey"]
  const segments = pointer
    .split("/")
    .filter((s) => s !== "")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~")); // RFC 6901 escaping

  let current: unknown = parsed;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return err(
        new Error(
          `Secret ref file:${ref.provider}/${ref.id} JSON Pointer "${pointer}" path not found`,
        ),
      );
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current !== "string") {
    return err(
      new Error(
        `Secret ref file:${ref.provider}/${ref.id} JSON Pointer "${pointer}" resolved to ${typeof current}, expected string`,
      ),
    );
  }

  return ok(current);
}

/** Resolve an exec-source SecretRef via JSON RPC child process. */
function resolveExecRef(
  ref: SecretRef,
  deps: ResolveSecretRefDeps,
  options?: ResolveSecretRefOptions,
): Result<string, Error> {
  const _execFileSync =
    deps.execFileSync ??
    ((
      cmd: string,
      args: string[],
      opts: {
        input?: string;
        timeout?: number;
        encoding?: BufferEncoding;
        maxBuffer?: number;
      },
    ) => execFileSync(cmd, args, { ...opts, encoding: opts.encoding ?? "utf-8" }) as string);
  const timeoutMs = options?.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxBuffer = options?.fileMaxBytes ?? DEFAULT_FILE_MAX_BYTES;

  const input = JSON.stringify({
    protocolVersion: 1,
    provider: ref.provider,
    ids: [ref.id],
  });

  let stdout: string;
  try {
    stdout = _execFileSync(ref.provider, [], {
      input,
      timeout: timeoutMs,
      encoding: "utf-8",
      maxBuffer,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return err(
      new Error(
        `Secret ref exec:${ref.provider}/${ref.id} command failed: ${message}`,
      ),
    );
  }

  // Parse response
  let response: unknown;
  try {
    response = JSON.parse(stdout);
  } catch {
    return err(
      new Error(
        `Secret ref exec:${ref.provider}/${ref.id} returned invalid JSON`,
      ),
    );
  }

  // Validate response shape
  const resp = response as {
    protocolVersion?: number;
    values?: Record<string, string>;
  };
  if (resp.protocolVersion !== 1 || typeof resp.values !== "object" || resp.values === null) {
    return err(
      new Error(
        `Secret ref exec:${ref.provider}/${ref.id} response does not match protocol (expected { protocolVersion: 1, values: { ... } })`,
      ),
    );
  }

  const value = resp.values[ref.id];
  if (value === undefined) {
    return err(
      new Error(
        `Secret ref exec:${ref.provider}/${ref.id} not found in credential helper response`,
      ),
    );
  }

  return ok(value);
}

/**
 * Deep-walk a config object and resolve all SecretRef values to strings.
 *
 * Operates on a structuredClone of the input — never mutates the original.
 * If any SecretRef resolution fails, returns the first error immediately.
 *
 * @param config - The config object to walk
 * @param deps - Dependencies for resolution
 * @param options - Resolution options
 * @returns Result<Record<string, unknown>, Error> — resolved config or error
 */
export function resolveConfigSecretRefs(
  config: Record<string, unknown>,
  deps: ResolveSecretRefDeps,
  options?: ResolveSecretRefOptions,
): Result<Record<string, unknown>, Error> {
  const cloned = structuredClone(config);
  const walkResult = walkAndResolve(cloned, deps, options);
  if (!walkResult.ok) return walkResult;
  return ok(cloned);
}

/**
 * Recursively walk an object and resolve SecretRef values in-place (on the clone).
 */
function walkAndResolve(
  obj: unknown,
  deps: ResolveSecretRefDeps,
  options?: ResolveSecretRefOptions,
): Result<void, Error> {
  if (obj === null || typeof obj !== "object") return ok(undefined);

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (isSecretRef(obj[i])) {
        const result = resolveSecretRef(obj[i] as SecretRef, deps, options);
        if (!result.ok) return err(result.error);
        obj[i] = result.value;
      } else {
        const walkResult = walkAndResolve(obj[i], deps, options);
        if (!walkResult.ok) return walkResult;
      }
    }
    return ok(undefined);
  }

  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isSecretRef(record[key])) {
      const result = resolveSecretRef(record[key] as SecretRef, deps, options);
      if (!result.ok) return err(result.error);
      record[key] = result.value;
    } else {
      const walkResult = walkAndResolve(record[key], deps, options);
      if (!walkResult.ok) return walkResult;
    }
  }
  return ok(undefined);
}
