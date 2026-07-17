// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI bootstrap offline path; errors propagate to CLI error handler.
/**
 * Offline secret-store helpers.
 *
 * Writes open the encrypted SQLite store directly without a running daemon.
 * Reads can select the file, encrypted, or env backend used by daemon startup.
 * Only call direct store operations when the daemon is provably not running.
 *
 * Single-writer invariant: these functions MUST only be invoked after
 * isDaemonRunning() returns false. The daemon is the sole writer when running.
 *
 * @module
 */

import type { CredentialStorageMode, SecretMetadata } from "@comis/core";
import { loadEnvFile } from "@comis/core";
import type { Result } from "@comis/shared";
import { err, ok } from "@comis/shared";
import { createFileSecretStore } from "./file-secret-store.js";
import { setupSecrets } from "./setup-secrets.js";
import { createSqliteSecretStore } from "./sqlite-secret-store.js";

/**
 * Write (or overwrite) a secret in the encrypted SQLite store directly,
 * without a running daemon.
 *
 * @param opts.name        - Secret name (e.g. "TELEGRAM_BOT_TOKEN")
 * @param opts.value       - Plaintext secret value
 * @param opts.provider    - Optional provider tag (auto-detected by caller)
 * @param opts.dataDir     - Absolute path to the Comis data directory (~/.comis)
 * @param opts.envFilePath - Absolute path to the .env file containing SECRETS_MASTER_KEY
 *
 * @returns ok(void) on success, err(Error) when key absent or store fails
 */
export function offlineSecretSet(opts: {
  name: string;
  value: string;
  provider?: string;
  dataDir: string;
  envFilePath: string;
}): Result<void, Error> {
  // Load env from the .env file into a fresh record — NOT into process.env
  // (avoids contaminating the process environment and is compatible with the
  // lint:security "no process.env" rule).
  const freshEnv: Record<string, string | undefined> = {};
  loadEnvFile(opts.envFilePath, freshEnv);

  // Resolve master key and open crypto engine + dbPath
  const setupResult = setupSecrets({ env: freshEnv, dataDir: opts.dataDir });
  if (!setupResult.ok) {
    return err(setupResult.error);
  }
  if (setupResult.value === null) {
    return err(
      new Error(
        "SECRETS_MASTER_KEY is absent in ~/.comis/.env. " +
          "Run `comis secrets init --write` first to generate the master encryption key.",
      ),
    );
  }

  const { crypto, dbPath } = setupResult.value;
  const store = createSqliteSecretStore(dbPath, crypto);
  try {
    return store.set(opts.name, opts.value, {
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    });
  } finally {
    store.close();
  }
}

/**
 * List secret metadata from the encrypted SQLite store directly,
 * without a running daemon.
 *
 * @param opts.dataDir     - Absolute path to the Comis data directory (~/.comis)
 * @param opts.envFilePath - Absolute path to the .env file containing SECRETS_MASTER_KEY
 *
 * @returns ok(SecretMetadata[]) on success, err(Error) when key absent or store fails
 */
/**
 * Daemon-free decrypted read of ONE secret.
 *
 * Enables daemon-free gateway-token discovery because authenticating the RPC
 * requires that token. Same trust model as the store itself — the caller must
 * hold SECRETS_MASTER_KEY (read from `envFilePath`, never process.env). Returns
 * ok(undefined) when the name is absent.
 */
export function offlineSecretGet(opts: {
  name: string;
  dataDir: string;
  envFilePath: string;
}): Result<string | undefined, Error> {
  const freshEnv: Record<string, string | undefined> = {};
  loadEnvFile(opts.envFilePath, freshEnv);

  const setupResult = setupSecrets({ env: freshEnv, dataDir: opts.dataDir });
  if (!setupResult.ok) {
    return err(setupResult.error);
  }
  if (setupResult.value === null) {
    return err(
      new Error(
        "SECRETS_MASTER_KEY is absent in ~/.comis/.env. " +
          "Run `comis secrets init --write` first to generate the master encryption key.",
      ),
    );
  }

  const { crypto, dbPath } = setupResult.value;
  const store = createSqliteSecretStore(dbPath, crypto);
  try {
    return store.getDecrypted(opts.name);
  } finally {
    store.close();
  }
}

/**
 * Read one secret from the backend selected by the daemon's raw
 * `security.storage` pre-read. Env mode has no separate store: callers overlay
 * their process/.env snapshot after this returns `undefined`.
 */
export function offlineSecretGetForMode(opts: {
  name: string;
  mode: CredentialStorageMode;
  dataDir: string;
  envFilePath: string;
}): Result<string | undefined, Error> {
  if (opts.mode === "env") return ok(undefined);
  if (opts.mode === "encrypted") {
    return offlineSecretGet({
      name: opts.name,
      dataDir: opts.dataDir,
      envFilePath: opts.envFilePath,
    });
  }

  const store = createFileSecretStore({ dataDir: opts.dataDir });
  try {
    return store.getDecrypted(opts.name);
  } finally {
    store.close();
  }
}

export function offlineSecretsList(opts: {
  dataDir: string;
  envFilePath: string;
}): Result<SecretMetadata[], Error> {
  const freshEnv: Record<string, string | undefined> = {};
  loadEnvFile(opts.envFilePath, freshEnv);

  const setupResult = setupSecrets({ env: freshEnv, dataDir: opts.dataDir });
  if (!setupResult.ok) {
    return err(setupResult.error);
  }
  if (setupResult.value === null) {
    return err(
      new Error(
        "SECRETS_MASTER_KEY is absent in ~/.comis/.env. " +
          "Run `comis secrets init --write` first to generate the master encryption key.",
      ),
    );
  }

  const { crypto, dbPath } = setupResult.value;
  const store = createSqliteSecretStore(dbPath, crypto);
  try {
    return store.list();
  } finally {
    store.close();
  }
}
