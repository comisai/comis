// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI bootstrap offline path; errors propagate to CLI error handler.
/**
 * Offline secrets write helpers.
 *
 * Opens the encrypted SQLite store DIRECTLY without a running daemon.
 * ONLY to be called when the daemon is provably not running (daemon-free
 * first-time bootstrap path for `comis secrets set/import/list`).
 *
 * Single-writer invariant: these functions MUST only be invoked after
 * isDaemonRunning() returns false. The daemon is the sole writer when running.
 *
 * @module
 */

import type { SecretMetadata } from "@comis/core";
import { loadEnvFile } from "@comis/core";
import type { Result } from "@comis/shared";
import { err } from "@comis/shared";
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
 * W15 (obs-llm-troubleshooting): daemon-free decrypted read of ONE secret.
 *
 * Breaks the gateway-token chicken-and-egg: `comis secrets get
 * COMIS_GATEWAY_TOKEN` previously required the daemon RPC, which required the
 * very token being fetched. Same trust model as the store itself — the caller
 * must hold SECRETS_MASTER_KEY (read from `envFilePath`, never process.env).
 * Returns ok(undefined) when the name is absent.
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
