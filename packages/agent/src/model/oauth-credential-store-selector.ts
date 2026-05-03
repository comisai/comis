// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth credential store selector (Phases 7 + 8).
 *
 * Origin: Phase 7 plan 08 (B5 + W3 + W6 — daemon-side OAuth wiring). Moved
 * to @comis/agent in Phase 8 plan 01 per RESEARCH §4 landmine override 4 —
 * the CLI process needs to instantiate the same adapter the daemon uses,
 * but @comis/cli cannot import from @comis/daemon (dep direction). Daemon
 * and CLI both consume from @comis/agent.
 *
 * Throws (NOT a Result — daemon bootstrap is a synchronous trust boundary
 * where fail-fast is the right policy) when:
 *  - storage === "encrypted" AND either secretsCrypto or secretsDb is missing
 *    (operator forgot to set SECRETS_MASTER_KEY but selected encrypted mode)
 *
 * For the encrypted branch the adapter SHARES the supplied secretsDb handle
 * (Phase 7 W6 fix — single connection serves both `secrets` and
 * `oauth_profiles` tables in the same file).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { SecretsCrypto, OAuthCredentialStorePort } from "@comis/core";
import { createOAuthProfileStoreEncrypted } from "@comis/memory";
import { createOAuthCredentialStoreFile } from "./oauth-credential-store-file.js";

/** Storage backend selector from `appConfig.oauth.storage`. */
export type OAuthStorageMode = "file" | "encrypted";

/**
 * Inputs for selectOAuthCredentialStore. Extracted to a typed shape so the
 * helper can be unit-tested without spinning up a full setupSingleAgent path.
 */
export interface SelectOAuthCredentialStoreInput {
  /** Storage backend selector from `appConfig.oauth.storage`. */
  storage: OAuthStorageMode;
  /** Absolute data directory (e.g. ~/.comis). Constructed via `safePath` upstream. */
  dataDir: string;
  /** Optional SecretsCrypto engine — REQUIRED when storage === "encrypted". */
  secretsCrypto?: SecretsCrypto;
  /** Optional shared better-sqlite3 handle — REQUIRED when storage === "encrypted". */
  secretsDb?: Database.Database;
  /** Optional injection points for unit tests (defaults to the real factories). */
  factories?: {
    file?: typeof createOAuthCredentialStoreFile;
    encrypted?: typeof createOAuthProfileStoreEncrypted;
  };
}

/**
 * Select and instantiate the right OAuthCredentialStorePort adapter from
 * `appConfig.oauth.storage`. Used by both the daemon (setup-agents.ts) and
 * the Phase 8 CLI commands (`comis auth login/list/logout/status`).
 */
export function selectOAuthCredentialStore(
  input: SelectOAuthCredentialStoreInput,
): OAuthCredentialStorePort {
  const { storage, dataDir, secretsCrypto, secretsDb, factories } = input;
  const fileFactory = factories?.file ?? createOAuthCredentialStoreFile;
  const encryptedFactory = factories?.encrypted ?? createOAuthProfileStoreEncrypted;

  if (storage === "encrypted") {
    // Bootstrap precondition: encrypted-mode requires BOTH a SecretsCrypto
    // engine and the shared secrets.db handle. No silent fallback to file
    // mode — fail fast with operator hint.
    if (!secretsCrypto || !secretsDb) {
      throw new Error(
        "OAuth storage mode is 'encrypted' but the secrets DB / crypto engine " +
          "is not initialized. Hint: set SECRETS_MASTER_KEY env var (and restart " +
          "the daemon) so the encrypted secrets store boots, or change " +
          "appConfig.oauth.storage to 'file' to use the plaintext file backend.",
      );
    }
    // SHARE the existing better-sqlite3 connection from createSqliteSecretStore
    // (NOT a second handle to the same file). initOAuthProfileSchema (called
    // inside createOAuthProfileStoreEncrypted) is idempotent (CREATE TABLE IF
    // NOT EXISTS), so it's safe to call from this adapter on a db that already
    // has the secrets table.
    return encryptedFactory(secretsDb, secretsCrypto);
  }

  // Default: plaintext file-backed adapter at ${dataDir}/auth-profiles.json.
  return fileFactory({ dataDir });
}
