// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Unknown storage-backend guard; consumed at bootstrap composition-root (daemon.ts catch boundary).
/**
 * OAuth credential store selector.
 *
 * Decides between file-backed and encrypted (daemon-supplied) OAuth credential
 * stores based on configuration. The memory value-import
 * (`createOAuthProfileStoreEncrypted`) is not imported here; the encrypted-mode
 * branch consumes a daemon-injected `OAuthCredentialStorePort` instead
 * of constructing one via memory's factory.
 *
 * Daemon composition (`packages/daemon/src/wiring/setup-agents.ts`) is
 * the sole site that imports `createOAuthProfileStoreEncrypted` — it owns
 * `secretsDb` + `secretsCrypto` and constructs the encrypted store at the
 * call site, then passes it into this selector via `encryptedStore`.
 *
 * Throws (NOT a Result — daemon bootstrap is a synchronous trust boundary
 * where fail-fast is the right policy) when:
 *  - storage === "encrypted" AND `encryptedStore` is undefined
 *    (operator forgot to set SECRETS_MASTER_KEY but selected encrypted mode,
 *    or daemon composition did not pass the injected port)
 *
 * @module
 */

import type { OAuthCredentialStorePort } from "../ports/oauth-credential-store.js";
import type { FileLockPort } from "../ports/file-lock.js";
import { createOAuthCredentialStoreFile } from "./oauth-credential-store-file.js";
import type { CredentialStorageMode } from "../config/schema-security.js";

export type { CredentialStorageMode };

/**
 * Inputs for selectOAuthCredentialStore. Extracted to a typed shape so the
 * helper can be unit-tested without spinning up a full setupSingleAgent path.
 */
export interface SelectOAuthCredentialStoreInput {
  /** Storage backend selector from `appConfig.security.storage`. */
  storage: CredentialStorageMode;
  /** Absolute data directory (e.g. ~/.comis). Constructed via `safePath` upstream. */
  dataDir: string;
  /**
   * Cross-process filesystem mutex used by the file-backed adapter for
   * per-profile-ID locking. REQUIRED when `storage === "file"`. The file
   * adapter consumes this port so it does not import `@comis/scheduler`
   * directly. Daemon + CLI composition roots construct the port via
   * `createFileLock()` from `@comis/core`.
   *
   * Ignored when `storage === "encrypted"` (the encrypted store has its
   * own SQLite-backed serialization and does not use proper-lockfile).
   */
  fileLock: FileLockPort;
  /**
   * Daemon-supplied encrypted store. REQUIRED when `storage === "encrypted"`.
   * Constructed inline by `daemon/src/wiring/setup-agents.ts` using
   * `createOAuthProfileStoreEncrypted` (the memory value-import lives
   * there — not here).
   *
   * Undefined when `storage === "file"` (the file factory is used instead).
   */
  encryptedStore?: OAuthCredentialStorePort;
  /** Optional injection point for unit tests (defaults to the real file factory). */
  factories?: {
    file?: typeof createOAuthCredentialStoreFile;
  };
}

/**
 * Select and instantiate the right OAuthCredentialStorePort adapter from
 * `appConfig.security.storage`. Used by both the daemon (setup-agents.ts) and
 * the CLI commands (`comis auth login/list/logout/status`).
 *
 * The encrypted-mode store is constructed by the daemon composition root
 * (which owns `secretsDb` + `secretsCrypto`) and injected via `encryptedStore`.
 * CLI consumers can only pass `storage: "file"`.
 */
export function selectOAuthCredentialStore(
  input: SelectOAuthCredentialStoreInput,
): OAuthCredentialStorePort {
  const { storage, dataDir, fileLock, encryptedStore, factories } = input;
  const fileFactory = factories?.file ?? createOAuthCredentialStoreFile;

  if (storage === "encrypted") {
    // Bootstrap precondition: encrypted-mode requires the daemon-injected
    // encryptedStore. No silent fallback to file mode — fail fast with
    // operator hint pointing at the daemon-side construction site.
    if (!encryptedStore) {
      throw new Error(
        "OAuth storage mode is 'encrypted' but no encrypted store was injected. " +
          "Daemon composition (setup-agents.ts) must construct the encrypted store " +
          "via createOAuthProfileStoreEncrypted(secretsDb, secretsCrypto) and pass " +
          "it via deps.encryptedStore. CLI commands cannot supply this.",
      );
    }
    return encryptedStore;
  }

  // Env mode has no writable OAuth credential store. The CLI rejects
  // OAuth login before reaching this point; the daemon should never attempt
  // to write OAuth profiles in env mode. Fail fast rather than silently
  // falling through to the file adapter (which would write credentials to
  // a file that is never read in env mode).
  if (storage === "env") {
    throw new Error(
      "OAuth credential store is read-only in 'env' storage mode. " +
        "Set security.storage to 'file' or 'encrypted' in config.yaml to enable OAuth login.",
    );
  }

  // Default: plaintext file-backed adapter at ${dataDir}/auth-profiles.json.
  return fileFactory({ dataDir, fileLock });
}
