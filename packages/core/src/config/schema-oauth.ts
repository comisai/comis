// SPDX-License-Identifier: Apache-2.0
/**
 * @module
 * The `oauth` root config section and `OAuthConfigSchema` have been removed in
 * v1.5 (P0 — unified storage mode). The storage backend is now controlled by
 * `security.storage: encrypted | file | env` (a single switch governing all
 * credential stores). This file is intentionally empty — there is no replacement
 * export from here.
 *
 * Consumers that previously imported `OAuthConfigSchema` or `OAuthConfig` should
 * remove those imports — they are no longer part of the public config surface.
 */
