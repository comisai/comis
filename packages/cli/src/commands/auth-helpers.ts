// SPDX-License-Identifier: Apache-2.0
/**
 * Helpers for the `comis auth` command tree — extracted from `auth.ts` to keep
 * that file under the ≤800-line production cap (#217 file-split debt; behavior
 * byte-identical). Re-imported by `auth.ts`; this module imports only CLI
 * output utils + the `OAuthError` type, so there is no import cycle.
 *
 * Lives under `packages/cli/src/commands/` (a sanctioned bootstrap path), so the
 * `Date.now()` in `profileStatus` keeps the same globals-invariant exemption it
 * had in `auth.ts`.
 *
 * @module
 */

import type { OAuthError } from "@comis/core";
import { error, info } from "../output/format.js";
import { renderTable } from "../output/table.js";
import { formatRelativeExpiry } from "../output/relative-time.js";

/** Active-vs-expired threshold (5 min) — shared by `profileStatus` + the status subcommand logic. */
export const ACTIVE_THRESHOLD_MS = 5 * 60_000;

/**
 * Print a class-appropriate diagnostic for a structured {@link OAuthError} and
 * exit. `refresh_token_reused` / `invalid_grant` get the re-login hint; others
 * print code + message + any hint. Returns `never` — always exits the process.
 */
export function exitOnOAuthError(err: OAuthError): never {
  if (err.errorKind === "refresh_token_reused") {
    error(
      "Refresh token was reused. The OpenAI account has been auto-locked for security.",
    );
    info(`Re-authenticate with: comis auth login --provider ${err.providerId}`);
    process.exit(1);
  }
  if (err.errorKind === "invalid_grant") {
    const profileSlug = err.profileId ?? "unknown";
    error(
      `Refresh token was rejected by OpenAI (invalid_grant) for profile "${profileSlug}".`,
    );
    info(`Re-authenticate with: comis auth login --provider ${err.providerId}`);
    process.exit(1);
  }
  error(`OAuthError (${err.code}): ${err.message}`);
  if (err.hint) info(err.hint);
  process.exit(1);
}

/**
 * Type guard: detect an OAuthError shape on a caught unknown value.
 * Distinguishes the structured error from generic JS errors so the CLI can
 * route through `exitOnOAuthError` (above). Match against the 5 known
 * `OAuthError.code` values to avoid false positives on third-party errors
 * that happen to carry `code`/`providerId`/`message` keys.
 */
export function isOAuthError(value: unknown): value is OAuthError {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    typeof v.message === "string" &&
    typeof v.providerId === "string" &&
    [
      "NO_PROVIDER",
      "NO_CREDENTIALS",
      "REFRESH_FAILED",
      "STORE_FAILED",
      "PROFILE_NOT_FOUND",
    ].includes(v.code)
  );
}

/** Build a status string from an absolute expiry timestamp. */
export function profileStatus(expiresAtMs: number): "active" | "expired" {
  return expiresAtMs - Date.now() > ACTIVE_THRESHOLD_MS ? "active" : "expired";
}

/**
 * The token-free profile shape rendered by `auth list` in both file and
 * encrypted modes (the file branch's OAuthProfile[] is structurally assignable).
 */
export interface DisplayProfile {
  provider: string;
  profileId: string;
  expires: number;
  email?: string;
  displayName?: string;
}

/** Render the 5-column profile table used by `auth list` (file + encrypted modes). */
export function renderAuthProfileTable(
  profiles: DisplayProfile[],
  providerFilter?: string,
): void {
  if (profiles.length === 0) {
    if (providerFilter) {
      info(`No OAuth profiles stored for provider "${providerFilter}".`);
    } else {
      info("No OAuth profiles stored.");
    }
    return;
  }
  renderTable(
    ["Provider", "ProfileId", "Identity", "ExpiresIn", "Status"],
    profiles.map((p) => [
      p.provider,
      p.profileId,
      p.email ?? p.profileId.split(":")[1] ?? "—",
      formatRelativeExpiry(p.expires),
      profileStatus(p.expires),
    ]),
  );
}
