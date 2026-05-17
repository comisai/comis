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
  AUTH_CONTRACTS,
} from "./auth.js";

describe("auth-domain contracts", () => {
  it("AUTH_CONTRACTS has exactly 2 entries (the 2 methods in auth-handlers.ts)", () => {
    expect(AUTH_CONTRACTS.length).toBe(2);
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
