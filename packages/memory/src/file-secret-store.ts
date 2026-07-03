// SPDX-License-Identifier: Apache-2.0
// @allow-throw: createFileSecretStore path-containment guard; dataDir escaping the resolved base is a hard precondition violation (path traversal attack guard); the factory return type is SecretStorePort (not Result), so err() cannot be used here — this throw fires only for programmer errors at wiring time, never for user-supplied secret values.
/**
 * FileSecretStore — SecretStorePort implementation with plaintext JSON storage.
 * File-mode is the documented plaintext-at-rest bargain.
 * Writes are sync-atomic: unique-temp → O_NOFOLLOW open → fsync → rename → parent-dir fsync.
 * Single-writer invariant: all writes route through daemon-RPC.
 *
 * Threat model:
 *  - O_CREAT|O_EXCL|O_NOFOLLOW on temp path prevents symlink injection at temp location.
 *  - safePath-equivalent path validation + single-writer daemon-RPC invariant.
 *  - Schema version check prevents silent misparse of future/corrupted file.
 *  - list() maps only metadata fields — value never returned (residency invariant).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { ok, err, isFsyncDisabledByPermissionModel } from "@comis/shared";
import type { Result } from "@comis/shared";
import type { SecretStorePort, SecretMetadata } from "@comis/core";
import { systemNowMs } from "@comis/core";

// ---------------------------------------------------------------------------
// Internal data structures
// ---------------------------------------------------------------------------

interface SecretEntry {
  value: string;
  provider?: string;
  description?: string;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface SecretsFile {
  schemaVersion: 1;
  secrets: Record<string, SecretEntry>;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function loadSecretsFile(canonicalPath: string): Result<SecretsFile, Error> {
  let raw: string;
  try {
    raw = fs.readFileSync(canonicalPath, "utf-8");
  } catch (e) {
    if (
      e !== null &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code: string }).code === "ENOENT"
    ) {
      return ok({ schemaVersion: 1, secrets: {} });
    }
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).schemaVersion !== 1
  ) {
    return err(new Error("Unknown schema version in secrets.json"));
  }

  return ok(parsed as SecretsFile);
}

function persistSecretsFile(
  dataDir: string,
  canonicalPath: string,
  data: SecretsFile,
): Result<void, Error> {
  // Step 1: ensure data dir exists with correct mode
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // Step 2: cryptographically random suffix avoids collision and prevents
  // predictable-suffix DoS (O_EXCL EEXIST if attacker pre-creates the path).
  const tmpSuffix = randomBytes(8).toString("hex");
  const tmpPath = path.resolve(dataDir, `secrets.json.${tmpSuffix}.tmp`);

  let tmpFd: number | undefined;

  try {
    const json = JSON.stringify(data, null, 2);

    // Step 3: open with O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW — prevents clobbering
    // an existing temp via symlink and prevents symlink attack on the temp location.
    tmpFd = fs.openSync(
      tmpPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );

    // Step 4: write the JSON content
    fs.writeSync(tmpFd, json);

    // Step 5: fsync the file to ensure data is durable on disk. Node's
    // Permission Model disables the fsync API — swallow that refusal (the
    // bytes are written) while surfacing genuine I/O errors.
    try {
      fs.fsyncSync(tmpFd);
    } catch (fsyncErr) {
      if (!isFsyncDisabledByPermissionModel(fsyncErr)) throw fsyncErr;
    }
    fs.closeSync(tmpFd);
    tmpFd = undefined;

    // Step 6: atomic rename — readers see either the old or new complete file
    fs.renameSync(tmpPath, canonicalPath);

    // Step 7: fsync the parent directory to make the rename durable
    const dirFd = fs.openSync(dataDir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(dirFd);
    } catch (fsyncErr) {
      if (!isFsyncDisabledByPermissionModel(fsyncErr)) throw fsyncErr;
    } finally {
      fs.closeSync(dirFd);
    }

    return ok(undefined);
  } catch (e) {
    // Cleanup on failure
    if (tmpFd !== undefined) {
      try {
        fs.closeSync(tmpFd);
      } catch {
        // ignore close error — already in error path
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort: unlink may fail if the temp was never created
    }
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Remove any leftover .tmp files from prior crash to prevent O_EXCL stalls.
 * This is best-effort — errors are silently ignored (dir may not exist yet).
 */
function cleanupStaleTmps(dataDir: string): void {
  try {
    const entries = fs.readdirSync(dataDir);
    for (const name of entries) {
      // Scope to secrets-specific temps only — do not clobber other components' .tmp files.
      if (name.startsWith("secrets.json.") && name.endsWith(".tmp")) {
        try {
          fs.unlinkSync(path.resolve(dataDir, name));
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // dir may not exist yet — ignore
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a FileSecretStore backed by a plaintext JSON file at
 * `<dataDir>/secrets.json`. The file and directory are created on first write
 * with restricted permissions (0o600 / 0o700).
 *
 * All methods are synchronous. This adapter is safe for single-writer use
 * (daemon-RPC routing guarantees no concurrent writes).
 *
 * @param opts.dataDir - Absolute path to the data directory. Will be created
 *   on first write with mode 0o700.
 */
export function createFileSecretStore(opts: { dataDir: string }): SecretStorePort {
  const dataDir = path.resolve(opts.dataDir);
  const canonicalPath = path.resolve(dataDir, "secrets.json");

  // Validate the canonical path to prevent path traversal
  if (!canonicalPath.startsWith(dataDir + path.sep) && canonicalPath !== dataDir) {
    throw new Error(`secrets.json path '${canonicalPath}' is outside dataDir '${dataDir}'`);
  }

  // Best-effort cleanup of any stale temp files from a prior crash
  cleanupStaleTmps(dataDir);

  const store: SecretStorePort = {
    set(
      name: string,
      plaintext: string,
      opts?: { provider?: string; description?: string; expiresAt?: number },
    ): Result<void, Error> {
      const loadResult = loadSecretsFile(canonicalPath);
      if (!loadResult.ok) return loadResult;

      const now = systemNowMs();
      const existing = loadResult.value.secrets[name];
      loadResult.value.secrets[name] = {
        value: plaintext,
        provider: opts?.provider,
        description: opts?.description,
        expiresAt: opts?.expiresAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      return persistSecretsFile(dataDir, canonicalPath, loadResult.value);
    },

    getDecrypted(name: string): Result<string | undefined, Error> {
      const loadResult = loadSecretsFile(canonicalPath);
      if (!loadResult.ok) return loadResult;
      return ok(loadResult.value.secrets[name]?.value ?? undefined);
    },

    decryptAll(): Result<Map<string, string>, Error> {
      const loadResult = loadSecretsFile(canonicalPath);
      if (!loadResult.ok) return loadResult;
      return ok(
        new Map(
          Object.entries(loadResult.value.secrets).map(([n, e]) => [n, e.value]),
        ),
      );
    },

    list(): Result<SecretMetadata[], Error> {
      const loadResult = loadSecretsFile(canonicalPath);
      if (!loadResult.ok) return loadResult;
      return ok(
        Object.entries(loadResult.value.secrets).map(([name, e]) => ({
          name,
          provider: e.provider,
          description: e.description,
          expiresAt: e.expiresAt,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
        })),
      );
    },

    delete(name: string): Result<boolean, Error> {
      const loadResult = loadSecretsFile(canonicalPath);
      if (!loadResult.ok) return loadResult;

      if (!(name in loadResult.value.secrets)) {
        return ok(false);
      }

      delete loadResult.value.secrets[name];
      const persistResult = persistSecretsFile(dataDir, canonicalPath, loadResult.value);
      if (!persistResult.ok) return persistResult;
      return ok(true);
    },

    close(): void {
      // no-op — file store has no open handles to close
    },
  };

  return Object.freeze(store);
}
