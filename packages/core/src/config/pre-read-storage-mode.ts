// SPDX-License-Identifier: Apache-2.0
/**
 * `preReadStorageMode` — daemon-boot pre-read of `security.storage` from YAML
 * config files.
 *
 * The daemon needs this answer BEFORE `writeMasterKeyIfAbsent` so that
 * file/env mode first boots do not create key material (REQ-17). Full config
 * parsing happens later in the boot sequence; this is a lightweight YAML scan
 * with no Zod validation, no `${VAR}` substitution, and no `$include` resolution.
 *
 * Layered-config precedence: later files override earlier ones, matching
 * `bootstrap()`'s YAML merge semantics.
 *
 * The function also detects legacy credential-storage keys in the YAML files
 * and returns `"legacy"` so the daemon boot gate can fail cleanly before any
 * key material is written. The specific migration error is emitted by the
 * daemon gate (not here) to keep this pre-read function pure.
 *
 * Note: the legacy env var (removed in v1.5) is NOT checked here — the
 * daemon reads it separately via `systemGetEnv` before calling this function
 * (same pattern as the replaced `preReadSecretsEnabled`).
 *
 * Replaces: `preReadSecretsEnabled` from `pre-read-secrets-enabled.ts`.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { CredentialStorageMode } from "./schema-security.js";

/**
 * The return type for the daemon boot gate pre-read.
 * - `"encrypted" | "file" | "env"` — clean mode, maps directly to security.storage
 * - `"legacy"` — a legacy key was detected in YAML; caller must fail boot with
 *   a migration error (see `checkLegacyConfigKeys` in `migration-guard.ts`)
 */
export type StorageModePreRead = CredentialStorageMode | "legacy";

/**
 * Pre-reads `security.storage` from YAML config files (layered, last-wins
 * override) before full config parse. Returns the mode or `"legacy"` if any
 * legacy key is detected in the YAML.
 *
 * The daemon calls this BEFORE `writeMasterKeyIfAbsent` to ensure file/env
 * mode first boots do not create key material (REQ-17).
 *
 * Silently ignores: missing files, unreadable files, and parse errors. These
 * are surfaced by the full `bootstrap()` pass later in daemon startup.
 *
 * @param configPaths - Ordered list of absolute YAML paths (same order the
 *   daemon passes to `bootstrap()` — earlier paths are base layers, later
 *   paths overlay).
 * @returns
 *   - `"encrypted"` (schema default) when no config path explicitly sets the mode
 *   - `"file"` / `"env"` when `security.storage` is set to that value
 *   - `"legacy"` when a removed legacy credential-storage key is present in the YAML
 */
export function preReadStorageMode(
  configPaths: readonly string[],
): StorageModePreRead {
  let mode: StorageModePreRead = "encrypted"; // schema default

  for (const filePath of configPaths) {
    if (!existsSync(filePath)) continue;
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const raw = parsed as Record<string, unknown>;

    // Detect removed legacy key: root "oauth" section with "storage" field
    if (
      typeof raw["oauth"] === "object" &&
      raw["oauth"] !== null &&
      typeof (raw["oauth"] as Record<string, unknown>)["storage"] === "string"
    ) {
      mode = "legacy";
      continue;
    }

    const secSection = raw["security"];
    if (
      typeof secSection !== "object" ||
      secSection === null ||
      Array.isArray(secSection)
    ) {
      continue;
    }
    const sec = secSection as Record<string, unknown>;

    // Detect removed legacy key: security.secrets "enabled" boolean field
    const secretsSection = sec["secrets"];
    if (
      typeof secretsSection === "object" &&
      secretsSection !== null &&
      !Array.isArray(secretsSection) &&
      typeof (secretsSection as Record<string, unknown>)["enabled"] === "boolean"
    ) {
      mode = "legacy";
      continue;
    }

    // Read security.storage if present and valid
    const storageVal = sec["storage"];
    if (
      storageVal === "encrypted" ||
      storageVal === "file" ||
      storageVal === "env"
    ) {
      mode = storageVal;
    }
  }

  return mode;
}
