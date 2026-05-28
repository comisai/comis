// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * OAuth credential storage configuration.
 *
 * Forward-room to later add clientId, scopes, profileSelectors etc.
 * without scattering OAuth config across the codebase. Today only the
 * storage-backend selector is meaningful.
 *
 * @module
 */

export const OAuthConfigSchema = z.strictObject({
  /**
   * Storage backend for refreshed OAuth credentials.
   * - "encrypted" (default): AES-256-GCM SQLite (requires SECRETS_MASTER_KEY)
   * - "file": plaintext JSON at ${dataDir}/auth-profiles.json with mode 0o600
   *
   * Provider tokens are stored AES-256-GCM encrypted at rest by default.
   */
  storage: z.enum(["file", "encrypted"]).default("encrypted"),
});

/** Inferred OAuth configuration type. */
export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;
