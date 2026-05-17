// SPDX-License-Identifier: Apache-2.0
// OAuth profile-ID validation. Lives in the security domain as a distinct
// file (rather than folded into oauth-helpers.ts) so it can be reverted /
// audited independently.
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

/**
 * Profile-ID format regex: <provider>:<identity>.
 * Provider must start with letter; alphanumeric + hyphen only.
 * Identity is non-empty and may contain @, ., etc.
 */
export const PROFILE_ID_RE = /^[a-z][a-z0-9-]*:.+$/i;

/**
 * Validate a profile-ID string against the <provider>:<identity> shape.
 * Returns parsed parts on success; an Error describing the violation otherwise.
 * Defense-in-depth: also rejects identities containing path-traversal or
 * control characters (newline, null, slash, backslash, ..).
 */
export function validateProfileId(
  id: string,
): Result<{ provider: string; identity: string }, Error> {
  if (typeof id !== "string" || id.length === 0) {
    return err(new Error("Invalid profile ID: empty or non-string"));
  }
  if (!PROFILE_ID_RE.test(id)) {
    return err(new Error('Invalid profile ID "' + id + '": expected "<provider>:<identity>"'));
  }
  const colonIdx = id.indexOf(":");
  const provider = id.slice(0, colonIdx);
  const identity = id.slice(colonIdx + 1);
  if (!provider) return err(new Error('Invalid profile ID "' + id + '": empty provider'));
  if (!identity) return err(new Error('Invalid profile ID "' + id + '": empty identity'));
  if (
    identity.includes("\0") ||
    identity.includes("\n") ||
    identity.includes("\r") ||
    identity.includes("..") ||
    identity.includes("/") ||
    identity.includes("\\")
  ) {
    return err(new Error('Invalid profile ID "' + id + '": identity contains forbidden characters'));
  }
  return ok({ provider, identity });
}
