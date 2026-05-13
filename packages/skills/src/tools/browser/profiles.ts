// SPDX-License-Identifier: Apache-2.0
/**
 * Chrome profile utilities.
 *
 * Provides profile name validation, CDP port allocation, and a color
 * palette for visual identity in Chrome's profile switcher.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

// ── Constants ─────────────────────────────────────────────────────────

/**
 * Valid profile name pattern: 2-50 chars, lowercase alphanumeric + hyphens,
 * no leading or trailing hyphen.
 */
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;

/**
 * Color palette for profile visual identity (10 distinct colors).
 * Used in Chrome's profile switcher for quick visual identification.
 */
export const PROFILE_COLORS: readonly string[] = [
  "#4285F4",
  "#EA4335",
  "#FBBC05",
  "#34A853",
  "#FF6D01",
  "#46BDC6",
  "#7B1FA2",
  "#C2185B",
  "#00ACC1",
  "#FFB300",
] as const;

// ── Functions ─────────────────────────────────────────────────────────

/**
 * Validate a profile name against the safe pattern.
 *
 * @param name - Profile name to validate
 * @returns ok(trimmed name) or err describing the validation failure
 */
export function validateProfileName(name: string): Result<string, Error> {
  const trimmed = name.trim();
  if (!PROFILE_NAME_PATTERN.test(trimmed)) {
    return err(
      new Error(
        `Invalid profile name "${trimmed}": must be 2-50 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen`,
      ),
    );
  }
  return ok(trimmed);
}

/**
 * Allocate a CDP port for a profile based on its index.
 *
 * @param baseCdpPort - Base port number
 * @param profileIndex - Zero-based profile index
 * @returns The allocated port number
 * @throws Error if the resulting port exceeds 65535
 */
export function allocateCdpPort(baseCdpPort: number, profileIndex: number): number {
  const port = baseCdpPort + profileIndex;
  if (port < 1 || port > 65535) {
    throw new Error(`Allocated CDP port ${port} is out of range (1-65535)`);
  }
  return port;
}

/**
 * Get the profile color for a given index, cycling through the palette.
 *
 * @param profileIndex - Zero-based profile index
 * @returns Hex color string
 */
export function getProfileColor(profileIndex: number): string {
  return PROFILE_COLORS[profileIndex % PROFILE_COLORS.length];
}
