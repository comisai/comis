// SPDX-License-Identifier: Apache-2.0
/**
 * selectSecretStore — discriminated SecretStore factory.
 * Returns SelectedSecretStore per security.storage mode.
 * encrypted → SqliteSecretStoreHandle (owns the db handle; caller must close last)
 * file      → FileSecretStore (sync-atomic secrets.json, plaintext-at-rest)
 * env       → EnvSecretStore (read-only snapshot, set/delete → err)
 *
 * NOTE: dbPath is NOT a parameter. security.secrets.dbPath was a dead config knob
 * (never read by any caller). The encrypted path uses setupSecrets, whose
 * "secrets.db" hardcode is now the canonical, no-longer-configurable filename.
 */

import type Database from "better-sqlite3";
import { ok, err } from "@comis/shared";
import type { Result } from "@comis/shared";
import type {
  SecretStorePort,
  SecretMetadata,
  SecretsCrypto,
  CredentialStorageMode,
} from "@comis/core";
import type { SqliteSecretStoreHandle } from "./sqlite-secret-store.js";
import { createSqliteSecretStore } from "./sqlite-secret-store.js";
import { createFileSecretStore } from "./file-secret-store.js";
import { setupSecrets } from "./setup-secrets.js";

// ---------------------------------------------------------------------------
// Discriminated union return type
// ---------------------------------------------------------------------------

/**
 * Discriminated return type of selectSecretStore.
 *
 * - "encrypted": SqliteSecretStore with exposed db + crypto for adapter sharing.
 *   secretStore.close() OWNS the shared db handle; OAuth/MCP adapters built on it
 *   must NOT close it directly.
 * - "file": FileSecretStore (sync-atomic, plaintext-at-rest).
 * - "env": Read-only snapshot adapter. set()/delete() return err with actionable hint.
 */
export type SelectedSecretStore =
  | {
      kind: "encrypted";
      secretStore: SqliteSecretStoreHandle;
      secretsDb: Database.Database;
      secretsCrypto: SecretsCrypto;
    }
  | { kind: "file"; secretStore: SecretStorePort }
  | { kind: "env"; secretStore: SecretStorePort };

// ---------------------------------------------------------------------------
// Env-mode read-only adapter (internal — not exported)
// ---------------------------------------------------------------------------

/**
 * Snapshot-based read-only SecretStorePort for env mode.
 *
 * At construction time, snapshots only the names from `sensitiveNames` that
 * are present in `env`. list() and decryptAll() are scoped to this snapshot —
 * PATH, HOME, and any other env var not in sensitiveNames are never exposed.
 *
 * set() and delete() always return err with an actionable upgrade hint.
 */
function createEnvSecretStore(opts: {
  env: Record<string, string | undefined>;
  sensitiveNames: Set<string>;
}): SecretStorePort {
  // Build name-scoped snapshot at construction time.
  // Only keys in sensitiveNames that are defined in env are included.
  const snapshot = new Map<string, string>();
  for (const name of opts.sensitiveNames) {
    const value = opts.env[name];
    if (value !== undefined) {
      snapshot.set(name, value);
    }
  }

  const store: SecretStorePort = {
    set(_name: string, _plaintext: string): Result<void, Error> {
      return err(
        new Error(
          "Storage mode is 'env' (read-only). " +
            "To persist secrets, set security.storage: file or encrypted in config.yaml " +
            "and restart the daemon.",
        ),
      );
    },

    delete(_name: string): Result<boolean, Error> {
      return err(
        new Error(
          "Storage mode is 'env' (read-only). " +
            "To delete secrets, switch to a writable storage mode " +
            "(security.storage: file or encrypted).",
        ),
      );
    },

    getDecrypted(name: string): Result<string | undefined, Error> {
      return ok(snapshot.get(name));
    },

    list(): Result<SecretMetadata[], Error> {
      const result: SecretMetadata[] = [...snapshot.keys()].map((name) => ({
        name,
        createdAt: 0,
        updatedAt: 0,
      }));
      return ok(result);
    },

    decryptAll(): Result<Map<string, string>, Error> {
      return ok(new Map(snapshot));
    },

    close(): void {
      // no-op — env adapter has no open handles
    },
  };

  return Object.freeze(store);
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Select and construct the appropriate SecretStore based on the configured
 * credential storage mode.
 *
 * @param input.mode     - Credential storage mode from security.storage config
 * @param input.dataDir  - Data directory (used by file and encrypted modes)
 * @param input.env      - Environment snapshot (used by encrypted key resolution + env-mode snapshot)
 * @param input.sensitiveNames - Name set for env-mode scoping (default: empty set)
 *
 * @returns ok(SelectedSecretStore) on success, err on encrypted mode key failure.
 */
export function selectSecretStore(input: {
  mode: CredentialStorageMode;
  dataDir: string;
  env: Record<string, string | undefined>;
  sensitiveNames?: Set<string>;
}): Result<SelectedSecretStore, Error> {
  if (input.mode === "encrypted") {
    const setupResult = setupSecrets({ env: input.env, dataDir: input.dataDir });
    if (!setupResult.ok) {
      return err(setupResult.error);
    }
    if (setupResult.value === null) {
      return err(
        new Error(
          "SECRETS_MASTER_KEY is absent — cannot open encrypted secret store. " +
            "Set SECRETS_MASTER_KEY in the environment or switch to security.storage: file.",
        ),
      );
    }
    const { crypto, dbPath } = setupResult.value;
    const store = createSqliteSecretStore(dbPath, crypto);
    return ok({
      kind: "encrypted",
      secretStore: store,
      secretsDb: store.db,
      secretsCrypto: crypto,
    });
  }

  if (input.mode === "file") {
    const store = createFileSecretStore({ dataDir: input.dataDir });
    return ok({ kind: "file", secretStore: store });
  }

  // Default: "env" — read-only snapshot adapter
  const store = createEnvSecretStore({
    env: input.env,
    sensitiveNames: input.sensitiveNames ?? new Set(),
  });
  return ok({ kind: "env", secretStore: store });
}
