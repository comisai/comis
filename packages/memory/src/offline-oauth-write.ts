// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI bootstrap offline path; errors propagate to CLI error handler.
/**
 * Offline OAuth-profile write helper.
 *
 * Opens the encrypted SQLite store DIRECTLY without a running daemon and
 * seals an OAuthProfile into the `oauth_profiles` table. ONLY to be called
 * when the daemon is provably not running (daemon-free first-time bootstrap
 * path for `comis init` / `comis auth login`).
 *
 * Single-writer invariant: this function MUST only be invoked after
 * isDaemonRunning() returns false. The daemon is the sole writer when running;
 * when it is up, OAuth persistence routes through the auth.set RPC instead.
 *
 * Mirrors offline-secrets-write.ts. The difference: createOAuthProfileStoreEncrypted
 * takes a pre-opened Database (it does NOT own the lifecycle), so we open the
 * db here via openSqliteDatabase and close it in a finally block.
 *
 * @module
 */

import type { OAuthProfile } from "@comis/core";
import { loadEnvFile } from "@comis/core";
import type { Result } from "@comis/shared";
import { err } from "@comis/shared";
import { setupSecrets } from "./setup-secrets.js";
import { openSqliteDatabase } from "./sqlite-adapter-base.js";
import { createOAuthProfileStoreEncrypted } from "./oauth-profile-store-encrypted.js";

/**
 * Write (or overwrite) an OAuth profile in the encrypted SQLite store
 * directly, without a running daemon.
 *
 * @param opts.profile     - The OAuthProfile to seal (access/refresh NEVER logged)
 * @param opts.dataDir     - Absolute path to the Comis data directory (~/.comis)
 * @param opts.envFilePath - Absolute path to the .env file containing SECRETS_MASTER_KEY
 *
 * @returns ok(void) on success, err(Error) when key absent or store fails
 */
export async function offlineOAuthProfileSet(opts: {
  profile: OAuthProfile;
  dataDir: string;
  envFilePath: string;
}): Promise<Result<void, Error>> {
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
  // createOAuthProfileStoreEncrypted does NOT own the db lifecycle — we open
  // it here (parent dir 0o700, db chmod 0o600) and close it in finally.
  const db = openSqliteDatabase({ dbPath });
  try {
    const store = createOAuthProfileStoreEncrypted(db, crypto);
    return await store.set(opts.profile.profileId, opts.profile);
  } finally {
    db.close();
  }
}
