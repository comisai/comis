// SPDX-License-Identifier: Apache-2.0
/**
 * Pre-Zod migration guard for legacy config keys.
 *
 * Must be called at the top of `validateConfig`, BEFORE `AppConfigSchema.safeParse`.
 * `z.strictObject` fires `unrecognized_keys` immediately during `safeParse`, which
 * swallows legacy keys silently. Running this guard on the raw merged object ensures
 * operators get a named, actionable `MIGRATION_ERROR` instead of a cryptic Zod error.
 *
 * REQ-02: detects `oauth.storage`, `security.secrets.enabled`, and mixed-mode
 * conflicts; names `security.storage` in the migration hint.
 *
 * @module
 */

import { ok, err } from "@comis/shared";
import type { Result } from "@comis/shared";
import type { ConfigError } from "./types.js";

/**
 * Inspect a raw (un-Zod-parsed) merged config object for legacy keys that
 * were removed in v1.5 and emit a `MIGRATION_ERROR` with an actionable hint.
 *
 * Detected legacy patterns:
 * - `oauth.storage` (any string value) — replaced by `security.storage`
 * - `security.secrets.enabled` (any boolean) — replaced by `security.storage: env`
 * - `security.secrets.dbPath` (any string value) — dead knob; removed in P1.
 *   The value was never read by the daemon (`setup-secrets.ts` hardcodes
 *   `"secrets.db"`). Remove the key from config.yaml to proceed.
 *
 * Mixed-mode detection: if both legacy keys are present and their implied modes
 * disagree, the error message names the store that would be stranded for each
 * possible choice, so the operator can make an informed migration decision.
 *
 * @param raw - Raw merged config object before Zod validation.
 * @returns `ok(undefined)` when no legacy keys are detected.
 *   `err(ConfigError{ code: "MIGRATION_ERROR" })` when any legacy key is present.
 */
export function checkLegacyConfigKeys(
  raw: Record<string, unknown>,
): Result<void, ConfigError> {
  const hasOauthStorage =
    typeof raw["oauth"] === "object" &&
    raw["oauth"] !== null &&
    typeof (raw["oauth"] as Record<string, unknown>)["storage"] === "string";

  const secretsSection =
    typeof raw["security"] === "object" &&
    raw["security"] !== null &&
    typeof (raw["security"] as Record<string, unknown>)["secrets"] === "object" &&
    (raw["security"] as Record<string, unknown>)["secrets"] !== null
      ? ((raw["security"] as Record<string, unknown>)["secrets"] as Record<string, unknown>)
      : null;

  const hasSecretsEnabled =
    secretsSection !== null &&
    typeof secretsSection["enabled"] === "boolean";

  // T-02-07: security.secrets.dbPath is a dead knob (value was never read).
  // Reject it with a clear MIGRATION_ERROR so operators are not misled into
  // thinking the config key does anything.
  const hasSecretsDbPath =
    secretsSection !== null &&
    "dbPath" in secretsSection;

  if (!hasOauthStorage && !hasSecretsEnabled && !hasSecretsDbPath) {
    return ok(undefined);
  }

  // security.secrets.dbPath dead-knob check (standalone — takes priority so
  // the message is accurate even when combined with other legacy keys).
  if (hasSecretsDbPath) {
    return err({
      code: "MIGRATION_ERROR",
      message:
        "security.secrets.dbPath is no longer supported — it was a dead knob " +
        "(the value was never read; the database path is fixed at <dataDir>/secrets.db). " +
        "Remove it from your config.yaml. " +
        "To configure the storage backend, set security.storage: encrypted|file|env (default: encrypted). " +
        "See the migration guide in the changelog.",
    });
  }

  // Both legacy keys present — check for mixed-mode conflict
  if (hasOauthStorage && hasSecretsEnabled) {
    const oauthMode = (raw["oauth"] as Record<string, unknown>)["storage"] as string;
    const secretsEnabled = secretsSection!["enabled"] as boolean;
    // secrets.enabled: false => env mode; secrets.enabled: true => encrypted mode
    const secretsImpliedMode = secretsEnabled ? "encrypted" : "env";

    if (oauthMode !== secretsImpliedMode) {
      return err({
        code: "MIGRATION_ERROR",
        message:
          `Mixed-mode legacy config detected: oauth.storage="${oauthMode}" and ` +
          `security.secrets.enabled=${String(secretsEnabled)} imply different modes. ` +
          `security.storage collapses ALL THREE credential stores into ONE mode. ` +
          `Choosing "${oauthMode}" will strand secrets.db (encrypted secrets). ` +
          `Choosing "${secretsImpliedMode}" will strand auth-profiles.json (OAuth profiles). ` +
          `Set security.storage: encrypted|file|env and remove both legacy keys. ` +
          `See the migration guide in the changelog.`,
      });
    }
  }

  // One or both legacy keys present (even if they agree) — emit rename hint
  const legacyKeys = (
    [
      hasOauthStorage ? "oauth.storage" : false,
      hasSecretsEnabled ? "security.secrets.enabled" : false,
    ] as Array<string | false>
  )
    .filter((k): k is string => k !== false)
    .join(", ");

  return err({
    code: "MIGRATION_ERROR",
    message:
      `Legacy config key(s) detected: ${legacyKeys}. ` +
      `These keys were removed in v1.5. ` +
      `Replace with: security.storage: encrypted|file|env (default: encrypted). ` +
      `See the migration guide in the changelog.`,
  });
}
