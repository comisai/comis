// SPDX-License-Identifier: Apache-2.0
/**
 * `preReadSecretsEnabled` — daemon-boot pre-read of
 * `security.secrets.enabled` from YAML config files.
 *
 * The daemon needs this answer BEFORE `writeMasterKeyIfAbsent` and the
 * encrypted-store bootstrap, because full config parsing happens later
 * in the boot sequence (after `mergedEnv` is built — and mergedEnv
 * itself depends on whether the encrypted store opened). To avoid the
 * chicken-and-egg, we do a lightweight YAML scan here: no Zod
 * validation, no `${VAR}` substitution, no `$include` resolution.
 *
 * The field is a boolean, so substitution and include directives are
 * irrelevant. Full validation runs later via `bootstrap()`; if a config
 * file is malformed we silently fall back to the secure-by-default
 * value (`true`) — the full bootstrap will surface the error with a
 * proper `ConfigError` on the next step.
 *
 * Layered-config precedence: later files override earlier ones, matching
 * `bootstrap()`'s YAML merge semantics.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * Read `security.secrets.enabled` from each YAML path in order and
 * return the effective value. Later paths override earlier ones. Falls
 * back to `true` (schema-default; matches daemon secure-by-default
 * behavior) when no path explicitly sets the field.
 *
 * Silently ignores: missing files, unreadable files, parse errors, and
 * non-boolean values at `security.secrets.enabled`. These are
 * surfaced by the full bootstrap pass later in daemon startup.
 *
 * @param configPaths - Ordered list of absolute YAML paths (same order
 *   the daemon passes to `bootstrap()` — earlier paths are base layers,
 *   later paths overlay).
 * @returns `true` when the store should auto-bootstrap, `false` when a
 *   config explicitly opts out.
 */
export function preReadSecretsEnabled(
  configPaths: readonly string[],
): boolean {
  let enabled = true;
  for (const path of configPaths) {
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch {
      continue;
    }
    const value = extractSecretsEnabled(parsed);
    if (value !== undefined) {
      enabled = value;
    }
  }
  return enabled;
}

function extractSecretsEnabled(parsed: unknown): boolean | undefined {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const security = (parsed as Record<string, unknown>).security;
  if (security === null || typeof security !== "object" || Array.isArray(security)) {
    return undefined;
  }
  const secrets = (security as Record<string, unknown>).secrets;
  if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) {
    return undefined;
  }
  const value = (secrets as Record<string, unknown>).enabled;
  if (typeof value !== "boolean") return undefined;
  return value;
}
