// SPDX-License-Identifier: Apache-2.0
/**
 * schema-oauth.test.ts
 *
 * The `OAuthConfigSchema` and root `oauth` config section were removed in v1.5
 * (P0 — unified storage mode). The storage backend is now controlled by
 * `security.storage: encrypted | file | env`.
 *
 * The old tests for `OAuthConfigSchema` have been removed along with the schema
 * itself. The behavior they covered (credential storage mode) is now tested in
 * `schema-security.test.ts`.
 */
import { describe, it } from "vitest";

describe("OAuthConfigSchema removal (v1.5 P0)", () => {
  it("root oauth config section removed — credential storage unified under security.storage", () => {
    // No assertions needed: the entire OAuthConfigSchema has been removed.
    // This placeholder ensures vitest finds a valid test suite.
    // See schema-security.test.ts for CredentialStorageMode tests.
  });
});
