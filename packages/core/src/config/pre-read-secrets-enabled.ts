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
 * file is malformed we return `undefined` and let the caller decide
 * (the full bootstrap will surface the error with a proper
 * `ConfigError` on the next step).
 *
 * Layered-config precedence: later files override earlier ones, matching
 * `bootstrap()`'s YAML merge semantics. A later file that is SILENT on
 * the field does not erase an earlier explicit value — silence is "no
 * opinion", not "unset".
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * Read `security.secrets.enabled` from each YAML path in order and
 * return the effective explicit value, or `undefined` when no path
 * sets the field. The caller is expected to apply the schema default
 * (`false`) when this returns `undefined` — keeping "default applied"
 * distinguishable from "explicit opt-out" so the daemon can fire the
 * backup-obligation WARN only on the explicit-opt-out path.
 *
 * Silently ignores: missing files, unreadable files, parse errors, and
 * non-boolean values at `security.secrets.enabled`. These are surfaced
 * by the full bootstrap pass later in daemon startup.
 *
 * @param configPaths - Ordered list of absolute YAML paths (same order
 *   the daemon passes to `bootstrap()` — earlier paths are base layers,
 *   later paths overlay).
 * @returns `true` / `false` when a path explicitly sets the field,
 *   `undefined` when no path mentions it (caller applies schema default).
 */
export function preReadSecretsEnabled(
  configPaths: readonly string[],
): boolean | undefined {
  let value: boolean | undefined;
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
    const explicit = extractSecretsEnabled(parsed);
    if (explicit !== undefined) {
      value = explicit;
    }
  }
  return value;
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
