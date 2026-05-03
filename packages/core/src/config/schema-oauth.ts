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
   * - "file" (default): plaintext JSON at ${dataDir}/auth-profiles.json with mode 0o600
   * - "encrypted": AES-256-GCM SQLite (requires SECRETS_MASTER_KEY)
   */
  storage: z.enum(["file", "encrypted"]).default("file"),
});

/** Inferred OAuth configuration type. */
export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;
