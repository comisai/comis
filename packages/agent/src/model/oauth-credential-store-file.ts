// SPDX-License-Identifier: Apache-2.0
/**
 * Plaintext file-backed OAuthCredentialStorePort adapter.
 *
 * Default storage backend for OAuth credentials (CONTEXT.md D-06: derives
 * from existing dataDir, no separate config key). Stores all profiles in
 * a single JSON file at ${dataDir}/auth-profiles.json with mode 0o600.
 *
 * Atomic write sequence (RESEARCH Q6 — full POSIX crash safety on ext4):
 *   write tmp 0o600 → fsync(tmpFd) → close(tmpFd) → rename(tmp, canonical)
 *   → fsync(parentDirFd) → close(parentDirFd)
 *
 * cron-store.ts does NOT fsync the parent directory; this adapter MUST
 * because OAuth credentials are security-critical (a lost rename due to
 * power-loss-after-data-write would silently log the user out).
 *
 * Per-profile-ID locking via withExecutionLock (CONTEXT.md D-02):
 * different providers and different identities for the same provider can
 * refresh in parallel.
 *
 * Schema versioning (CONTEXT.md D-07/D-08): single integer version at top
 * level. Hard-fail on mismatch — pre-1.0 software, no migration plumbing.
 *
 * @module
 */

import * as fs from "node:fs/promises";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise, suppressError } from "@comis/shared";
import { safePath } from "@comis/core";
import {
  validateProfileId,
  type OAuthCredentialStorePort,
  type OAuthProfile,
} from "@comis/core";
import { withExecutionLock } from "@comis/scheduler";

const SCHEMA_VERSION = 1;
const FILE_NAME = "auth-profiles.json";
const LOCKS_SUBDIR = ".locks";
const LOCK_OPTIONS = { staleMs: 30_000, updateMs: 5_000 };

interface AuthProfilesFile {
  version: number;
  profiles: Record<string, OAuthProfile>;
}

export interface OAuthCredentialStoreFileConfig {
  /** Comis data directory (e.g. ~/.comis). The adapter writes to ${dataDir}/auth-profiles.json. */
  dataDir: string;
}

/**
 * Per-profile in-process serialization queue.
 *
 * `withExecutionLock` uses `retries: 0` so two concurrent same-profile writes
 * within the SAME Node process would race the cross-process file lock and the
 * second caller would get `err("locked")`. The in-process mutex serializes
 * same-profile writes BEFORE they reach the file lock — different profiles
 * still proceed in parallel (each gets its own queue), preserving D-02
 * per-profile lock granularity. Mirrors cron-store.ts:181.
 */
function createPerProfileMutex(): {
  serialize<T>(profileId: string, fn: () => Promise<T>): Promise<T>;
} {
  const chains = new Map<string, Promise<unknown>>();
  return {
    serialize<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
      const prior = chains.get(profileId) ?? Promise.resolve();
      const next = prior.then(fn, fn);
      // Swallow rejections in the chain so subsequent serialize() calls keep running.
      chains.set(
        profileId,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    },
  };
}

/**
 * Sanitize a profile-ID for safe inclusion in a lock-file path.
 * One-way transformation, lock-file name only — the canonical profile-ID
 * stored in the JSON file keeps its original form.
 *
 * Mappings: ":" → "__", "@" → "_at_".
 */
function sanitizeProfileIdForLockPath(profileId: string): string {
  return profileId.replace(/:/g, "__").replace(/@/g, "_at_");
}

function lockSentinelPath(dataDir: string, profileId: string): string {
  return safePath(
    dataDir,
    LOCKS_SUBDIR,
    "auth-profile__" + sanitizeProfileIdForLockPath(profileId) + ".lock",
  );
}

function authProfilesFilePath(dataDir: string): string {
  return safePath(dataDir, FILE_NAME);
}

/**
 * Atomic write with parent-dir fsync (RESEARCH Q6).
 * Sequence: write tmp 0o600 → fsync(tmp) → close(tmp) → rename(tmp, canonical)
 *           → fsync(parentDir) → close(parentDir).
 *
 * Tmp filename includes pid + random suffix so concurrent writes (different
 * profile-IDs holding different per-profile locks) don't race on the same
 * tmp path. Mirrors cron-store.ts:103.
 */
async function atomicWriteJson(
  canonicalPath: string,
  parentDir: string,
  data: unknown,
): Promise<void> {
  const tmpPath =
    canonicalPath + "." + String(process.pid) + "." + Math.random().toString(16).slice(2) + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  const tmpFd = await fs.open(tmpPath, "r");
  try {
    await tmpFd.sync();
  } finally {
    await tmpFd.close();
  }
  await fs.rename(tmpPath, canonicalPath);
  const dirFd = await fs.open(parentDir, "r");
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
}

/**
 * Load the auth-profiles file. Hard-fails on schema-version mismatch (D-07).
 * ENOENT → returns ok({ version: 1, profiles: {} }) (empty store).
 */
async function loadAuthProfiles(
  filePath: string,
): Promise<Result<AuthProfilesFile, Error>> {
  return fromPromise(
    (async () => {
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf-8");
      } catch (e) {
        if (
          e !== null &&
          typeof e === "object" &&
          "code" in e &&
          (e as { code: string }).code === "ENOENT"
        ) {
          return { version: SCHEMA_VERSION, profiles: {} };
        }
        throw e;
      }
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          "auth-profiles.json: malformed (expected object). Hint: Delete " +
            filePath +
            " and re-login to recreate.",
        );
      }
      const obj = parsed as Record<string, unknown>;
      const version = obj.version;
      if (version !== SCHEMA_VERSION) {
        throw new Error(
          "OAuth profile store version mismatch: expected " +
            SCHEMA_VERSION +
            ", got " +
            String(version) +
            ". Hint: Delete " +
            filePath +
            " and re-run `comis auth login` to recreate the profile. Stored profiles for unknown schema versions cannot be migrated.",
        );
      }
      const profilesRaw = obj.profiles;
      if (
        profilesRaw === null ||
        typeof profilesRaw !== "object" ||
        Array.isArray(profilesRaw)
      ) {
        throw new Error(
          "auth-profiles.json: profiles field malformed. Hint: Delete " +
            filePath +
            " and re-login.",
        );
      }
      return {
        version,
        profiles: profilesRaw as Record<string, OAuthProfile>,
      };
    })(),
  );
}

/**
 * Cleanup orphaned *.tmp files from previous crashed writes (RESEARCH Q6 hygiene).
 * Best-effort — failures are silent; this is housekeeping, not correctness.
 */
async function cleanupStaleTmpFiles(parentDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(parentDir);
    const tmpFiles = entries.filter(
      (n) => n.startsWith(FILE_NAME) && n.endsWith(".tmp"),
    );
    for (const name of tmpFiles) {
      try {
        await fs.unlink(safePath(parentDir, name));
      } catch {
        // best-effort cleanup
      }
    }
  } catch {
    // dir may not exist yet
  }
}

/**
 * Create a plaintext file-backed OAuthCredentialStorePort adapter.
 *
 * Atomic, lock-protected, version-validated. Lifecycle:
 * - On factory call: ensures dataDir exists (mkdir 0o700 recursive); cleans up stale .tmp files.
 * - On every set/delete: per-profile-ID file lock → load → mutate → atomic-write.
 * - On every get/has/list: load (no lock — readers see snapshot per POSIX rename atomicity).
 */
export function createOAuthCredentialStoreFile(
  config: OAuthCredentialStoreFileConfig,
): OAuthCredentialStorePort {
  const { dataDir } = config;
  const filePath = authProfilesFilePath(dataDir);
  const parentDir = dataDir;
  const mutex = createPerProfileMutex();

  // Best-effort startup hygiene — do not block factory return.
  suppressError(
    cleanupStaleTmpFiles(parentDir),
    "oauth-credential-store-file: stale .tmp cleanup",
  );

  async function ensureParentDir(): Promise<void> {
    await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
  }

  const port: OAuthCredentialStorePort = {
    async get(
      profileId: string,
    ): Promise<Result<OAuthProfile | undefined, Error>> {
      const validation = validateProfileId(profileId);
      if (!validation.ok) return err(validation.error);
      const loadRes = await loadAuthProfiles(filePath);
      if (!loadRes.ok) return err(loadRes.error);
      return ok(loadRes.value.profiles[profileId]);
    },

    async set(
      profileId: string,
      profile: OAuthProfile,
    ): Promise<Result<void, Error>> {
      const validation = validateProfileId(profileId);
      if (!validation.ok) return err(validation.error);
      await ensureParentDir();
      const lockPath = lockSentinelPath(dataDir, profileId);
      return mutex.serialize(profileId, async () => {
        const lockResult = await withExecutionLock(
          lockPath,
          async () => {
            const loadRes = await loadAuthProfiles(filePath);
            if (!loadRes.ok) throw loadRes.error;
            const data = loadRes.value;
            data.profiles[profileId] = {
              ...profile,
              profileId,
              version: SCHEMA_VERSION,
            };
            await atomicWriteJson(filePath, parentDir, data);
          },
          LOCK_OPTIONS,
        );
        if (!lockResult.ok) {
          return err(
            new Error(
              "OAuth file adapter set(" +
                profileId +
                ") failed: lock " +
                lockResult.error,
            ),
          );
        }
        return ok(undefined);
      });
    },

    async delete(profileId: string): Promise<Result<boolean, Error>> {
      const validation = validateProfileId(profileId);
      if (!validation.ok) return err(validation.error);
      await ensureParentDir();
      const lockPath = lockSentinelPath(dataDir, profileId);
      return mutex.serialize(profileId, async () => {
        let deleted = false;
        const lockResult = await withExecutionLock(
          lockPath,
          async () => {
            const loadRes = await loadAuthProfiles(filePath);
            if (!loadRes.ok) throw loadRes.error;
            const data = loadRes.value;
            if (profileId in data.profiles) {
              delete data.profiles[profileId];
              deleted = true;
              await atomicWriteJson(filePath, parentDir, data);
            }
          },
          LOCK_OPTIONS,
        );
        if (!lockResult.ok) {
          return err(
            new Error(
              "OAuth file adapter delete(" +
                profileId +
                ") failed: lock " +
                lockResult.error,
            ),
          );
        }
        return ok(deleted);
      });
    },

    async list(filter?: {
      provider?: string;
    }): Promise<Result<OAuthProfile[], Error>> {
      const loadRes = await loadAuthProfiles(filePath);
      if (!loadRes.ok) return err(loadRes.error);
      const all = Object.values(loadRes.value.profiles);
      if (filter?.provider) {
        return ok(all.filter((p) => p.provider === filter.provider));
      }
      return ok(all);
    },

    async has(profileId: string): Promise<Result<boolean, Error>> {
      const validation = validateProfileId(profileId);
      if (!validation.ok) return err(validation.error);
      const loadRes = await loadAuthProfiles(filePath);
      if (!loadRes.ok) return err(loadRes.error);
      return ok(profileId in loadRes.value.profiles);
    },
  };
  return Object.freeze(port);
}
