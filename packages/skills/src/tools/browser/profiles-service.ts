// SPDX-License-Identifier: Apache-2.0
/**
 * Browser profile manager service.
 *
 * Provides CRUD operations for named Chrome profiles with unique CDP
 * port allocation, color assignment, and directory isolation. Profile
 * metadata is persisted in a profiles.json file within the profiles
 * directory.
 *
 * All path operations use safePath() to prevent directory traversal.
 *
 * @module
 */

import * as fs from "node:fs";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { safePath } from "@comis/core";
import { validateProfileName, allocateCdpPort, getProfileColor } from "./profiles.js";
import { decorateProfile } from "./profile-decoration.js";

// ── Types ─────────────────────────────────────────────────────────────

/** Dependencies for creating a profile manager. */
export interface ProfileManagerDeps {
  baseCdpPort: number;
  maxProfiles: number;
  profilesDir: string;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
  };
}

/** Information about a registered profile. */
export interface ProfileInfo {
  name: string;
  cdpPort: number;
  profileDir: string;
  color: string;
  index: number;
}

/** Profile manager interface for CRUD operations on named profiles. */
export interface ProfileManager {
  /** List all registered profiles. */
  list(): Promise<Result<ProfileInfo[], Error>>;
  /** Create a new named profile. */
  create(params: { name: string }): Promise<Result<ProfileInfo, Error>>;
  /** Delete (deregister) a profile by name. Does not remove Chrome data. */
  delete(name: string): Promise<Result<void, Error>>;
  /** Synchronous lookup of a profile by name from cached state. */
  resolve(name: string): Result<ProfileInfo, Error>;
}

// ── Internal types ────────────────────────────────────────────────────

interface ProfilesJson {
  profiles: ProfileInfo[];
}

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Create a profile manager for named Chrome profiles.
 *
 * @param deps - Dependencies including base CDP port, max profiles, directory, and logger
 * @returns ProfileManager instance
 */
export function createProfileManager(deps: ProfileManagerDeps): ProfileManager {
  let cache: ProfileInfo[] | null = null;

  function manifestPath(): string {
    return safePath(deps.profilesDir, "profiles.json");
  }

  async function loadProfiles(): Promise<ProfileInfo[]> {
    if (cache !== null) return cache;

    try {
      const raw = await fs.promises.readFile(manifestPath(), "utf-8");
      const parsed = JSON.parse(raw) as ProfilesJson;
      cache = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    } catch {
      // File doesn't exist or is invalid -- start fresh
      cache = [];
    }

    return cache;
  }

  async function saveProfiles(profiles: ProfileInfo[]): Promise<void> {
    await fs.promises.mkdir(deps.profilesDir, { recursive: true });
    const data: ProfilesJson = { profiles };
    await fs.promises.writeFile(manifestPath(), JSON.stringify(data, null, 2), "utf-8");
    cache = profiles;
  }

  function findNextIndex(profiles: ProfileInfo[]): number {
    const usedIndices = new Set(profiles.map((p) => p.index));
    let index = 0;
    while (usedIndices.has(index)) {
      index++;
    }
    return index;
  }

  const manager: ProfileManager = {
    async list(): Promise<Result<ProfileInfo[], Error>> {
      try {
        const profiles = await loadProfiles();
        return ok([...profiles]);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async create(params: { name: string }): Promise<Result<ProfileInfo, Error>> {
      try {
        // Validate name
        const nameResult = validateProfileName(params.name);
        if (!nameResult.ok) return nameResult;
        const name = nameResult.value;

        // Load existing profiles
        const profiles = await loadProfiles();

        // Check max profiles limit
        if (profiles.length >= deps.maxProfiles) {
          return err(
            new Error(`Maximum profiles (${deps.maxProfiles}) reached`),
          );
        }

        // Check name uniqueness
        if (profiles.some((p) => p.name === name)) {
          return err(new Error(`Profile "${name}" already exists`));
        }

        // Allocate next available index
        const index = findNextIndex(profiles);
        const cdpPort = allocateCdpPort(deps.baseCdpPort, index);
        const color = getProfileColor(index);
        const profileDir = safePath(deps.profilesDir, name);

        // Create directory and decorate
        await fs.promises.mkdir(profileDir, { recursive: true });
        const decorateResult = await decorateProfile(profileDir, { name, color });
        if (!decorateResult.ok) {
          return decorateResult;
        }

        // Build profile info
        const info: ProfileInfo = { name, cdpPort, profileDir, color, index };

        // Persist
        profiles.push(info);
        await saveProfiles(profiles);
        deps.logger.info(`Created profile "${name}" on CDP port ${cdpPort}`);

        return ok(info);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async delete(name: string): Promise<Result<void, Error>> {
      try {
        const profiles = await loadProfiles();
        const idx = profiles.findIndex((p) => p.name === name);
        if (idx === -1) {
          return err(new Error(`Profile "${name}" not found`));
        }

        profiles.splice(idx, 1);
        await saveProfiles(profiles);
        deps.logger.info(`Deleted profile "${name}"`);
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    resolve(name: string): Result<ProfileInfo, Error> {
      if (cache === null) {
        return err(new Error("Profile manager not initialized -- call list() or create() first"));
      }
      const found = cache.find((p) => p.name === name);
      if (!found) {
        return err(new Error(`Profile "${name}" not found`));
      }
      return ok(found);
    },
  };

  return manager;
}
