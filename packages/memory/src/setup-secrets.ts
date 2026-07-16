// SPDX-License-Identifier: Apache-2.0
/**
 * setupSecrets — Master key bootstrap utility.
 *
 * Three-way branching on SECRETS_MASTER_KEY:
 *  1. Absent / empty / whitespace → ok(null) — envfile mode (no encrypted store)
 *  2. Present but invalid          → err() with actionable guidance
 *  3. Present and valid            → ok({ crypto, dbPath }) — ready for SqliteSecretStore
 *
 * This utility lives in @comis/memory (not daemon) so it is testable
 * without daemon dependencies. Called during daemon boot.
 */

import type { Result } from "@comis/shared";
import { ok, err, tryCatch } from "@comis/shared";
import {
  parseMasterKey,
  createSecretsCrypto,
  safePath,
} from "@comis/core";
import type { SecretsCrypto } from "@comis/core";
import { deriveActivityRecordingMasterKey } from "@comis/observability";

/**
 * Result of a successful secrets bootstrap when a valid master key is provided.
 */
export interface SecretsBootResult {
  /** SecretsCrypto engine initialized with the parsed master key */
  readonly crypto: SecretsCrypto;
  /** Dedicated root key for the isolated activity-recording crypto domain. */
  readonly activityRecordingMasterKey: Buffer;
  /** Resolved absolute path where secrets.db should be created */
  readonly dbPath: string;
}

export interface SetupSecretsOptions {
  /** Environment record (passed explicitly — do NOT access process.env directly) */
  env: Record<string, string | undefined>;
  /** Data directory where secrets.db will be stored */
  dataDir: string;
  /**
   * Same-boot key injection: the freshly-generated master key hex from
   * `writeMasterKeyIfAbsent`. Used when SECRETS_MASTER_KEY is not yet in `env`
   * (because `loadEnvFile` hasn't run yet on the new key). NEVER log this value.
   */
  seedKeyHex?: string;
}

/**
 * Resolve the master key from the environment and prepare crypto + path.
 *
 * @returns ok(null) when key absent (envfile mode), ok({ crypto, dbPath }) when valid,
 *          err(Error) when key is present but invalid.
 */
export function setupSecrets(
  opts: SetupSecretsOptions,
): Result<SecretsBootResult | null, Error> {
  // Treat empty/whitespace SECRETS_MASTER_KEY as absent so seedKeyHex is not
  // silently discarded when the operator exports an empty SECRETS_MASTER_KEY.
  const envKey = opts.env.SECRETS_MASTER_KEY;
  const raw = (envKey !== undefined && envKey.trim() !== "") ? envKey : opts.seedKeyHex;

  // Branch 1: absent or empty → envfile mode
  if (raw === undefined || raw.trim() === "") {
    return ok(null);
  }

  // Branch 2/3: present — parse and validate
  const parseResult = tryCatch(() => parseMasterKey(raw));

  if (!parseResult.ok) {
    return err(
      new Error(
        `Invalid SECRETS_MASTER_KEY: ${parseResult.error.message}. ` +
          "Set a valid hex (64+ chars) or base64 (44+ chars) key, " +
          "or remove the variable for envfile-only mode.",
      ),
    );
  }

  // Branch 3: valid key — create crypto engine and compute dbPath
  const masterKey = parseResult.value;

  const cryptoResult = tryCatch(() => createSecretsCrypto(masterKey));
  if (!cryptoResult.ok) {
    return err(
      new Error(
        `Failed to initialize secrets crypto: ${cryptoResult.error.message}`,
      ),
    );
  }

  const activityKey = deriveActivityRecordingMasterKey(masterKey);
  if (!activityKey.ok) {
    return err(new Error("Failed to initialize activity recording crypto authority"));
  }

  const dbPath = safePath(opts.dataDir, "secrets.db");

  return ok({
    crypto: cryptoResult.value,
    activityRecordingMasterKey: activityKey.value,
    dbPath,
  });
}
