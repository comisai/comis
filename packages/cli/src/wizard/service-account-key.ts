// SPDX-License-Identifier: Apache-2.0
/**
 * Shared resolver for a Google Chat service-account key supplied as either a
 * path to the JSON key file or the pasted/piped JSON itself.
 *
 * Reused by the interactive channel step and the non-interactive builder so a
 * `--googlechat-sa-key <path>` flag and an interactive path entry behave
 * identically — a single helper keeps the two collection paths from drifting.
 * The value is never logged.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";

/**
 * Resolve a service-account key from either a path to the JSON key file or the
 * pasted JSON itself. When the input names an existing file it is read;
 * otherwise it is treated as the JSON blob verbatim. The value is never logged.
 */
export function readServiceAccountKey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length > 0 && existsSync(trimmed)) {
    return readFileSync(trimmed, "utf-8");
  }
  return input;
}
