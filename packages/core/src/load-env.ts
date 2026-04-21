// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal .env file loader.
 *
 * Parses KEY=VALUE lines from a file and merges them into a target
 * object (defaults to process.env). Skips comments (#) and blank lines.
 * Does NOT override existing values.
 *
 * @module
 */

import { readFileSync } from "node:fs";

/**
 * Module-level initialization guard for loadEnvFile().
 *
 * This singleton boolean at module scope is an intentional exception to
 * the "no module-level mutable state" rule. It serves the same
 * purpose as AsyncLocalStorage in context.ts — a one-time initialization
 * flag that must be set before downstream consumers (SecretManager) run.
 */
let envLoaded = false;

/**
 * Assert that loadEnvFile() has been called before SecretManager creation.
 *
 * Call this at the top of createSecretManager() (or wherever secrets are
 * first accessed) to catch startup ordering bugs early.
 *
 * @throws Error if loadEnvFile() has not been called yet
 */
export function assertEnvLoaded(): void {
  if (!envLoaded) {
    throw new Error(
      "loadEnvFile() must be called before createSecretManager(). " +
        "Ensure loadEnvFile() runs at startup before any secret access.",
    );
  }
}

/**
 * Reset the envLoaded flag for test isolation.
 * Only intended for use in test suites.
 */
export function resetEnvLoadedForTest(): void {
  envLoaded = false;
}

/**
 * Load environment variables from a .env file.
 *
 * @param filePath - Absolute path to the .env file
 * @param target - Object to merge into (default: process.env)
 * @returns Number of variables loaded, or -1 if file not found
 */
export function loadEnvFile(
  filePath: string,
  target: Record<string, string | undefined> = process.env,
): number {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    // File not found is a valid outcome (env file is optional).
    // Still mark as loaded since the caller invoked the function.
    envLoaded = true;
    return -1;
  }

  let count = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Don't override existing values
    if (key && target[key] === undefined) {
      target[key] = value;
      count++;
    }
  }

  envLoaded = true;
  return count;
}
