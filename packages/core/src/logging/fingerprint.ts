// SPDX-License-Identifier: Apache-2.0
/**
 * Shared stable digest util: a 12-hex sha256 prefix of a string.
 *
 * Canonical (and ONLY) home is @comis/core — import it directly from here
 * everywhere, including @comis/agent (which is forbidden from depending on
 * @comis/infra). It is NOT re-exported by @comis/infra; do not write
 * `import { fingerprint } from "@comis/infra"`. (withDedup, in this same
 * directory, consumes it like every other caller; re-export from infra
 * only if a future consumer genuinely needs it.)
 * NON-security digest (a dedup/correlation key — collision-resistance is not
 * required; never hash a secret that has not already been redacted/bounded
 * upstream).
 *
 * @module
 */
import { createHash } from "node:crypto";

export function fingerprint(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}
