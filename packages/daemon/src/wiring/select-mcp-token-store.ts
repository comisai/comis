// SPDX-License-Identifier: Apache-2.0
// @allow-throw: partial-encrypted-config guard (a wiring defect, fail-fast at composition root). Mirrors oauth-credential-store-selector.ts.
/**
 * MCP OAuth token store selector.
 *
 * Single mode→store function that decides the MCP OAuth token backend from
 * `appConfig.security.storage`, mirroring `selectOAuthCredentialStore` and
 * `selectSecretStore`. MCP tokens were the lone credential family NOT routed
 * through a unified selector: the login path wrote a plaintext disk store
 * UNCONDITIONALLY while the MCP client manager read the mode-selected store,
 * producing an encrypted-mode split-brain (login-saved tokens invisible to
 * `manager.connect`). This selector closes that gap — the daemon constructs the
 * store ONCE at the composition root and threads the SAME instance into both
 * consumers (the login handler + the manager wiring).
 *
 * Backends by mode:
 *  - `encrypted` → `createMcpTokenStoreEncrypted` (AES-256-GCM rows in the
 *    `mcp_credentials` table; zero disk files). REQUIRES both `secretsDb` and
 *    `secretsCrypto` — exactly one present is a wiring defect and THROWS (the
 *    partial-config guard, fail-fast at the synchronous bootstrap boundary).
 *  - `file` → `createPortBackedMcpTokenStore` over the file-mode
 *    `OAuthCredentialStorePort` (chokidar disk store at `<dataDir>/mcp-tokens/`,
 *    0o600 files, synced to the unified credential port).
 *  - `env` → `undefined`. Env mode has no writable MCP OAuth persistence
 *    (consistent with `selectOAuthCredentialStore`'s env policy of no writable
 *    store); consumers guard on `undefined` and fail loudly rather than falling
 *    back to a plaintext disk store.
 *
 * Throws (NOT a Result — daemon bootstrap is a synchronous trust boundary where
 * fail-fast is the right policy) only on the encrypted partial-config defect.
 * The throw surfaces to the daemon bootstrap catch boundary.
 *
 * @module
 */

import { safePath, createFileLock, selectOAuthCredentialStore } from "@comis/core";
import type { CredentialStorageMode, SecretsCrypto } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { TokenStore as McpTokenStore } from "@comis/skills";
import type Database from "better-sqlite3";
import { createPortBackedMcpTokenStore } from "./mcp-token-port-adapter.js";
import { createMcpTokenStoreEncrypted } from "./mcp-token-store-encrypted.js";

/**
 * Inputs for {@link selectMcpTokenStore}. Extracted to a typed shape so the
 * selector can be unit-tested without spinning up the full daemon wiring.
 */
export interface SelectMcpTokenStoreInput {
  /** Storage backend selector from `appConfig.security.storage`. */
  readonly storage: CredentialStorageMode;
  /** Logger for the port-backed (file-mode) adapter's non-fatal sync WARN. */
  readonly logger: ComisLogger;
  /**
   * Absolute data directory (e.g. ~/.comis). The file-mode token store roots at
   * `<dataDir>/mcp-tokens/` and confines the fs-safe substrate to `dataDir`.
   * Constructed via `safePath` upstream.
   */
  readonly dataDir: string;
  /**
   * Pre-opened `secrets.db` handle from the encrypted `selectSecretStore`
   * variant. REQUIRED when `storage === "encrypted"`; absent in file/env mode.
   */
  readonly secretsDb?: Database.Database;
  /**
   * `SecretsCrypto` from the encrypted `selectSecretStore` variant. REQUIRED
   * when `storage === "encrypted"`; absent in file/env mode.
   */
  readonly secretsCrypto?: SecretsCrypto;
}

/**
 * Select and instantiate the MCP OAuth token store for the active storage mode.
 * Returns `undefined` in `env` mode (no writable MCP OAuth persistence).
 *
 * The encrypted-mode store consumes the daemon-owned `secretsDb` + `secretsCrypto`
 * (constructed by the secrets bootstrap). The file-mode store wraps the file
 * `OAuthCredentialStorePort` with the chokidar disk-backed token store.
 */
export function selectMcpTokenStore(
  input: SelectMcpTokenStoreInput,
): McpTokenStore | undefined {
  const { storage, logger, dataDir, secretsDb, secretsCrypto } = input;

  if (storage === "encrypted") {
    // Bootstrap precondition: encrypted mode requires BOTH the daemon-owned
    // secrets.db handle and the crypto instance. Exactly one present (or
    // neither) is a wiring defect that would silently disable MCP OAuth with no
    // diagnostic — fail fast with an operator-actionable message. Mirrors the
    // guard folded out of setup-mcp.ts.
    if (!secretsDb || !secretsCrypto) {
      throw new Error(
        "MCP token storage mode is 'encrypted' but secretsDb and/or secretsCrypto " +
          "was not injected. Both are required for encrypted MCP token storage. " +
          "Daemon composition must construct the encrypted secrets store " +
          "(selectSecretStore in 'encrypted' mode) and thread its secretsDb + " +
          "secretsCrypto into selectMcpTokenStore. This is a wiring defect.",
      );
    }
    // AES-256-GCM TokenStore on the mcp_credentials table; zero disk files.
    return createMcpTokenStoreEncrypted(secretsDb, secretsCrypto);
  }

  if (storage === "file") {
    // File mode: chokidar disk store at <dataDir>/mcp-tokens/ (0o600 files),
    // synced to the unified file OAuthCredentialStorePort. Absorbs the
    // oauthCredentialStoreForceMcp logic that previously lived in daemon.ts.
    // confinedBaseDir is pinned to dataDir so the fs-safe substrate confines to
    // the actual data directory (robust for non-default dataDir values, not just
    // the homedir default).
    return createPortBackedMcpTokenStore(
      selectOAuthCredentialStore({
        storage: "file",
        dataDir,
        fileLock: createFileLock(),
        encryptedStore: undefined,
      }),
      {
        tokensDir: safePath(dataDir, "mcp-tokens"),
        confinedBaseDir: dataDir,
        logger,
      },
    );
  }

  if (storage === "env") {
    // Env mode has no writable MCP OAuth token store. Consumers guard on
    // undefined and fail loudly — never fall back to a plaintext disk store.
    return undefined;
  }

  // Exhaustiveness: every CredentialStorageMode member is handled above. A new
  // member must be wired here explicitly — this assignment fails `tsc` if not.
  const _exhaustive: never = storage;
  return _exhaustive;
}
