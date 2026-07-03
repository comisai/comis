// SPDX-License-Identifier: Apache-2.0
/**
 * Type-shape smoke tests for the oauth-token-manager type contracts.
 *
 * The runtime implementation (`createOAuthTokenManager`) lives on the
 * agent side — only the TYPES live in core (see oauth-token-manager.ts
 * module JSDoc). The agent's runtime test drives the production
 * behavior; here we pin the structural shape so a drift (e.g., dropping
 * `errorKind` from `OAuthError`) surfaces as a TypeScript compile error.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  OAuthError,
  OAuthTokenManager,
  OAuthTokenManagerDeps,
  OAuthCredentials,
} from "./oauth-token-manager.js";

describe("oauth-token-manager — public type contracts", () => {
  it("OAuthError carries the discriminated `code` union the CLI pattern-matches on", () => {
    const valid: OAuthError = {
      code: "REFRESH_FAILED",
      message: "boom",
      providerId: "openai-codex",
      errorKind: "refresh_token_reused",
      profileId: "openai-codex:fixture@example.com",
      hint: "Re-authenticate via comis auth login",
    };
    expect(valid.code).toBe("REFRESH_FAILED");
    expect(valid.errorKind).toBe("refresh_token_reused");
    expectTypeOf<OAuthError["code"]>().toEqualTypeOf<
      "NO_PROVIDER" | "NO_CREDENTIALS" | "REFRESH_FAILED" | "STORE_FAILED" | "PROFILE_NOT_FOUND"
    >();
    expectTypeOf<OAuthError["errorKind"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<OAuthError["profileId"]>().toEqualTypeOf<string | undefined>();
  });

  it("OAuthCredentials structurally matches pi-ai 0.71's shape", () => {
    const creds: OAuthCredentials = {
      refresh: "refresh-token-abc",
      access: "access-token-xyz",
      expires: 1_700_000_000_000,
    };
    expectTypeOf(creds.refresh).toEqualTypeOf<string>();
    expectTypeOf(creds.access).toEqualTypeOf<string>();
    expectTypeOf(creds.expires).toEqualTypeOf<number>();
    // Pi-ai's open-ended index signature is preserved for forward-compat.
    expectTypeOf<OAuthCredentials[string]>().toEqualTypeOf<unknown>();
  });

  it("OAuthTokenManager surface exposes the daemon-facing methods", () => {
    expectTypeOf<OAuthTokenManager["getApiKey"]>().toBeFunction();
    expectTypeOf<OAuthTokenManager["hasCredentials"]>().toBeFunction();
    expectTypeOf<OAuthTokenManager["storeCredentials"]>().toBeFunction();
    expectTypeOf<OAuthTokenManager["getSupportedProviders"]>().toBeFunction();
    expectTypeOf<OAuthTokenManager["dispose"]>().toBeFunction();
  });

  it("OAuthTokenManagerDeps requires the daemon-injected ports + logger + dataDir", () => {
    // Type-level audit — fail-compile if a required dep is removed.
    type Required = Pick<
      OAuthTokenManagerDeps,
      "secretManager" | "eventBus" | "credentialStore" | "logger" | "dataDir" | "fileLock"
    >;
    expectTypeOf<Required>().toMatchTypeOf<{
      secretManager: OAuthTokenManagerDeps["secretManager"];
      eventBus: OAuthTokenManagerDeps["eventBus"];
      credentialStore: OAuthTokenManagerDeps["credentialStore"];
      logger: OAuthTokenManagerDeps["logger"];
      dataDir: string;
      fileLock: OAuthTokenManagerDeps["fileLock"];
    }>();
  });
});
