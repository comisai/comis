/**
 * Chrome profile decoration.
 *
 * Writes Chrome "Local State" and "Default/Preferences" JSON files
 * to configure profile identity (name, visual appearance).
 *
 * All path construction uses safePath() to prevent directory traversal.
 *
 * @module
 */

import * as fs from "node:fs";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { safePath } from "@comis/core";

// ── Types ─────────────────────────────────────────────────────────────

/** Options for profile decoration. */
export interface DecorateProfileOptions {
  /** Profile display name. */
  name: string;
  /** Hex color string for visual identity. */
  color: string;
}

// ── Functions ─────────────────────────────────────────────────────────

/**
 * Decorate a Chrome profile directory with identity metadata.
 *
 * Writes:
 * - `Local State` JSON with profile name and user_name
 * - `Default/Preferences` JSON with browser theme defaults
 *
 * @param profileDir - Absolute path to the profile's user data directory
 * @param opts - Profile name and color for decoration
 * @returns ok(void) on success, err on write failure
 */
export async function decorateProfile(
  profileDir: string,
  opts: DecorateProfileOptions,
): Promise<Result<void, Error>> {
  try {
    // Ensure the profile directory exists
    await fs.promises.mkdir(profileDir, { recursive: true });

    // Write Local State JSON
    const localStatePath = safePath(profileDir, "Local State");
    const localState = {
      profile: {
        info_cache: {
          Default: {
            name: opts.name,
            user_name: `${opts.name}@comis`,
          },
        },
      },
    };
    await fs.promises.writeFile(localStatePath, JSON.stringify(localState, null, 2), "utf-8");

    // Ensure Default subdirectory exists
    const defaultDir = safePath(profileDir, "Default");
    await fs.promises.mkdir(defaultDir, { recursive: true });

    // Write Default/Preferences JSON
    const prefsPath = safePath(profileDir, "Default", "Preferences");
    const preferences = {
      browser: {
        theme: { color: -1 },
      },
      ntp: {
        custom_background_dict: {},
      },
    };
    await fs.promises.writeFile(prefsPath, JSON.stringify(preferences, null, 2), "utf-8");

    return ok(undefined);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
