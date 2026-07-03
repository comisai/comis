// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract test for the auth-domain contracts.
 *
 * Mirrors the structure of
 * `packages/core/src/api-contracts/daemon.test.ts`.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  AuthListContract,
  AuthLogoutContract,
  AuthSetContract,
  AUTH_CONTRACTS,
} from "./auth.js";

describe("auth-domain contracts", () => {
  it("AUTH_CONTRACTS has exactly 3 entries (auth.list, auth.logout, auth.set)", () => {
    expect(AUTH_CONTRACTS.length).toBe(3);
  });

  it("auth.list: method name is correct", () => {
    expect(AuthListContract.method).toBe("auth.list");
  });

  it("auth.logout: method name is correct", () => {
    expect(AuthLogoutContract.method).toBe("auth.logout");
  });

  it("both contracts are admin-scoped (encrypted-OAuth profile management)", () => {
    expect(AuthListContract.scopes).toEqual(["admin"]);
    expect(AuthLogoutContract.scopes).toEqual(["admin"]);
  });

  // --- auth.list -----------------------------------------------------------

  it("auth.list: request accepts an empty object (provider filter is optional)", () => {
    expect(() => AuthListContract.request.parse({})).not.toThrow();
  });

  it("auth.list: request accepts a provider filter string", () => {
    expect(() =>
      AuthListContract.request.parse({ provider: "openai-codex" }),
    ).not.toThrow();
  });

  it("auth.list: request rejects non-string provider values", () => {
    expect(() => AuthListContract.request.parse({ provider: 42 })).toThrow();
  });

  it("auth.list: response accepts an empty profiles array (no encrypted store)", () => {
    expect(() =>
      AuthListContract.response.parse({ profiles: [] }),
    ).not.toThrow();
  });

  it("auth.list: response accepts a token-free RedactedOAuthProfile row", () => {
    expect(() =>
      AuthListContract.response.parse({
        profiles: [
          {
            provider: "openai-codex",
            profileId: "openai-codex:user@example.com",
            expires: 1_700_000_000_000,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("auth.list: response accepts optional email + displayName fields", () => {
    expect(() =>
      AuthListContract.response.parse({
        profiles: [
          {
            provider: "openai-codex",
            profileId: "openai-codex:user@example.com",
            expires: 1_700_000_000_000,
            email: "user@example.com",
            displayName: "Example User",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("auth.list: response rejects rows missing the required profileId field", () => {
    expect(() =>
      AuthListContract.response.parse({
        profiles: [
          {
            provider: "openai-codex",
            expires: 1_700_000_000_000,
          },
        ],
      }),
    ).toThrow();
  });

  // --- auth.logout ---------------------------------------------------------

  it("auth.logout: request requires profileId", () => {
    expect(() => AuthLogoutContract.request.parse({})).toThrow();
  });

  it("auth.logout: request rejects empty-string profileId (min(1))", () => {
    expect(() => AuthLogoutContract.request.parse({ profileId: "" })).toThrow();
  });

  it("auth.logout: request accepts a non-empty profileId", () => {
    expect(() =>
      AuthLogoutContract.request.parse({
        profileId: "openai-codex:user@example.com",
      }),
    ).not.toThrow();
  });

  it("auth.logout: response shape requires both profileId and deleted", () => {
    expect(() =>
      AuthLogoutContract.response.parse({
        profileId: "openai-codex:user@example.com",
        deleted: true,
      }),
    ).not.toThrow();
    expect(() =>
      AuthLogoutContract.response.parse({
        profileId: "missing:nobody",
        deleted: false,
      }),
    ).not.toThrow();
    expect(() =>
      AuthLogoutContract.response.parse({ profileId: "x", deleted: "yes" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AuthSetContract — contract shape + residency canaries
// ---------------------------------------------------------------------------

describe("AuthSetContract", () => {
  it("AUTH_CONTRACTS registers AuthSetContract (3 entries total)", () => {
    expect(AUTH_CONTRACTS.length).toBe(3);
  });

  it("AuthSetContract method identifier is auth.set", () => {
    expect(AuthSetContract.method).toBe("auth.set");
  });

  it("AuthSetContract scopes array contains admin for privilege gate", () => {
    expect(AuthSetContract.scopes).toContain("admin");
  });

  it("AuthSetContract request accepts valid OAuthProfile fields with version literal 1", () => {
    expect(() =>
      AuthSetContract.request.parse({
        provider: "openai-codex",
        profileId: "openai-codex:user@example.com",
        access: "tok-access-abc",
        refresh: "tok-refresh-xyz",
        expires: 1_750_000_000_000,
        accountId: "acct-123",
        email: "user@example.com",
        displayName: "Test User",
        version: 1,
      }),
    ).not.toThrow();
  });

  it("AuthSetContract request rejects version value other than literal 1", () => {
    expect(() =>
      AuthSetContract.request.parse({
        provider: "openai-codex",
        profileId: "openai-codex:user@example.com",
        access: "tok-access-abc",
        refresh: "tok-refresh-xyz",
        expires: 1_750_000_000_000,
        version: 2,
      }),
    ).toThrow();
  });

  it("AuthSetContract response parse succeeds with profileId and stored true", () => {
    expect(() =>
      AuthSetContract.response.parse({ profileId: "openai-codex:user@example.com", stored: true as const }),
    ).not.toThrow();
  });

  it("AuthSetContract response parse strips access refresh accountId from result (residency canary)", () => {
    const result = AuthSetContract.response.parse({
      profileId: "openai-codex:user@example.com",
      stored: true as const,
      access: "LEAK",
      refresh: "LEAK",
      accountId: "LEAK",
    });
    expect(result).not.toHaveProperty("access");
    expect(result).not.toHaveProperty("refresh");
    expect(result).not.toHaveProperty("accountId");
    expect(result).toEqual({ profileId: "openai-codex:user@example.com", stored: true });
  });

  it("AuthSetContract response JSON serialization contains no LEAK token strings (residency canary)", () => {
    const result = AuthSetContract.response.parse({
      profileId: "openai-codex:user@example.com",
      stored: true as const,
      access: "LEAK",
      refresh: "LEAK",
      accountId: "LEAK",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("LEAK");
  });
});
