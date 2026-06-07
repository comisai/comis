// SPDX-License-Identifier: Apache-2.0
/**
 * Shared stable digest util: a 12-hex sha256 prefix of a string (D4).
 *
 * Canonical home in @comis/core so it is importable from @comis/agent
 * (which is forbidden from depending on @comis/infra). @comis/infra
 * re-exports it for the daemon/skills/cli runtime path + Phase 155 H2
 * withDedup. NON-security digest (a dedup/correlation key — collision-
 * resistance is not required; never hash a secret that has not already
 * been redacted/bounded upstream).
 *
 * @module
 */
import { createHash } from "node:crypto";

export function fingerprint(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}
