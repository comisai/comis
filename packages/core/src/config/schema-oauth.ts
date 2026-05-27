// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * OAuth credential storage configuration.
 *
 * Forward-room for Phases 8-11 to add clientId, scopes, profileSelectors
 * etc. without scattering OAuth config across the codebase. Today only
 * the storage-backend selector is meaningful.
 *
 * @module
 */

export const OAuthConfigSchema = z.strictObject({
  /**
   * Storage backend for refreshed OAuth credentials.
   * - "encrypted" (default, R8): AES-256-GCM SQLite (requires SECRETS_MASTER_KEY)
   * - "file": plaintext JSON at ${dataDir}/auth-profiles.json with mode 0o600
   *
   * Default changed to "encrypted" in R8 (02-04) — provider tokens are now
   * stored AES-256-GCM encrypted at rest by default.
   */
  storage: z.enum(["file", "encrypted"]).default("encrypted"),
});

/** Inferred OAuth configuration type. */
export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;
