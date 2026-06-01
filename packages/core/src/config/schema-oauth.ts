// SPDX-License-Identifier: Apache-2.0
/**
 * @module
 * @deprecated The `oauth` root config section and `OAuthConfigSchema` have been
 * removed in v1.5 (P0 — unified storage mode). The storage backend is now
 * controlled by `security.storage: encrypted | file | env` (a single switch
 * governing all credential stores). There is no replacement export from this file.
 *
 * Consumers that previously imported `OAuthConfigSchema` or `OAuthConfig` should
 * remove those imports — they are no longer part of the public config surface.
 */
