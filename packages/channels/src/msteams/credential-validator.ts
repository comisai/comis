// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams Credential Validator: fail-fast guard that the bot
 * credentials required to authenticate the adapter are present.
 *
 * Synchronous, transport-free, and secret-safe — it verifies appId and tenantId
 * are non-empty plus the per-mode credential the configured authMode requires
 * (secret → appPassword, certificate → certPath, managedIdentity →
 * managedIdentityClientId), naming any missing field in the error, never the
 * secret value itself. Live token-mint reachability is a separate operational
 * probe and is intentionally out of scope here.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

/** Credentials required to authenticate the Microsoft Teams adapter. */
export interface MsTeamsValidateOpts {
  /**
   * Credential mode. Selects which per-mode credential is required alongside the
   * always-required appId + tenantId: `secret` → appPassword, `certificate` →
   * certPath, `managedIdentity` → managedIdentityClientId. Absent defaults to
   * `secret`.
   */
  authMode?: "secret" | "certificate" | "managedIdentity";
  /** Bot application (client) id. */
  appId?: string;
  /** Bot application secret — never echoed into errors or logs. Required in secret mode. */
  appPassword?: string;
  /** Single-tenant directory id. */
  tenantId?: string;
  /** Client certificate path — required in certificate mode. */
  certPath?: string;
  /** Managed-identity client id — required in managed-identity mode. */
  managedIdentityClientId?: string;
}

/** A credential is missing when it is absent or all-whitespace. */
function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === "";
}

/**
 * Verify the Microsoft Teams bot credentials required for the configured mode
 * are present. appId + tenantId are always required; the third credential is
 * authMode-branched (secret → appPassword, certificate → certPath,
 * managedIdentity → managedIdentityClientId).
 *
 * @param opts.authMode - Credential mode (default "secret")
 * @param opts.appId - Bot application (client) id
 * @param opts.appPassword - Bot application secret (never named by value; secret mode)
 * @param opts.tenantId - Single-tenant directory id
 * @param opts.certPath - Certificate path (certificate mode)
 * @param opts.managedIdentityClientId - Managed-identity client id (managed-identity mode)
 * @returns ok when all required fields are non-empty; err naming the first missing field
 */
export function validateMsTeamsCredentials(
  opts: MsTeamsValidateOpts,
): Result<void, Error> {
  if (isBlank(opts.appId)) {
    return err(new Error("Teams credentials invalid: appId must not be empty"));
  }
  if (isBlank(opts.tenantId)) {
    return err(new Error("Teams credentials invalid: tenantId must not be empty"));
  }
  const authMode = opts.authMode ?? "secret";
  if (authMode === "certificate") {
    if (isBlank(opts.certPath)) {
      return err(
        new Error("Teams credentials invalid: certPath must not be empty in certificate mode"),
      );
    }
  } else if (authMode === "managedIdentity") {
    if (isBlank(opts.managedIdentityClientId)) {
      return err(
        new Error(
          "Teams credentials invalid: managedIdentityClientId must not be empty in managed-identity mode",
        ),
      );
    }
  } else if (isBlank(opts.appPassword)) {
    return err(new Error("Teams credentials invalid: appPassword must not be empty"));
  }
  return ok(undefined);
}
