// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract test for the tokens-domain Wave C contracts.
 *
 * Plan 35-09 (Wave C domain #4). Mirrors the structure of
 * `packages/core/src/api-contracts/secrets.test.ts` (Plan 35-08's
 * template — closest analog by admin-only / 4-method scope).
 *
 * BLOCKER 1 exemption: tokens are managed via the web SPA only (no CLI
 * consumer for `tokens.list|create|revoke|rotate` in
 * `packages/cli/src/commands/`). This test exercises the contract-side
 * surface only; CLI retarget verification is N/A for this domain.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  TokensListContract,
  TokensCreateContract,
  TokensRevokeContract,
  TokensRotateContract,
  TOKENS_CONTRACTS,
} from "./tokens.js";

describe("tokens-domain contracts", () => {
  it("TOKENS_CONTRACTS has exactly 4 entries (the 4 methods in token-handlers.ts)", () => {
    expect(TOKENS_CONTRACTS.length).toBe(4);
  });

  it("tokens.list: method name is correct", () => {
    expect(TokensListContract.method).toBe("tokens.list");
  });

  it("tokens.create: method name is correct", () => {
    expect(TokensCreateContract.method).toBe("tokens.create");
  });

  it("tokens.revoke: method name is correct", () => {
    expect(TokensRevokeContract.method).toBe("tokens.revoke");
  });

  it("tokens.rotate: method name is correct", () => {
    expect(TokensRotateContract.method).toBe("tokens.rotate");
  });

  it("all 4 contracts are admin-scoped (web SPA admin-only invariant; mirrors setup-gateway-api.ts line 248-250)", () => {
    expect(TokensListContract.scopes).toEqual(["admin"]);
    expect(TokensCreateContract.scopes).toEqual(["admin"]);
    expect(TokensRevokeContract.scopes).toEqual(["admin"]);
    expect(TokensRotateContract.scopes).toEqual(["admin"]);
  });

  // --- tokens.list ---------------------------------------------------------

  it("tokens.list: request accepts an empty object", () => {
    expect(() => TokensListContract.request.parse({})).not.toThrow();
  });

  it("tokens.list: response accepts an empty tokens array", () => {
    expect(() =>
      TokensListContract.response.parse({ tokens: [] }),
    ).not.toThrow();
  });

  it("tokens.list: response accepts a secret-free TokenRegistryEntry row", () => {
    expect(() =>
      TokensListContract.response.parse({
        tokens: [
          {
            id: "tok-1",
            scopes: ["rpc", "admin"],
            createdAt: 1_700_000_000_000,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("tokens.list: response rejects rows missing required createdAt", () => {
    expect(() =>
      TokensListContract.response.parse({
        tokens: [{ id: "tok-1", scopes: ["rpc"] }],
      }),
    ).toThrow();
  });

  it("tokens.list: response rejects rows missing required scopes", () => {
    expect(() =>
      TokensListContract.response.parse({
        tokens: [{ id: "tok-1", createdAt: 1_700_000_000_000 }],
      }),
    ).toThrow();
  });

  it("tokens.list: residency-canary projection — `secret` field on a row is STRIPPED on parse", () => {
    // TokenRegistryEntry intentionally omits `secret`. Mirrors the
    // residency canary from Plan 35-08's secrets.list: SecretMetadata
    // omits `value` and does NOT use `.passthrough()`. Default Zod
    // behavior for unknown keys is STRIP (not reject) — so a
    // well-shaped token entry that ALSO carries a leaked `secret`
    // field has the `secret` removed by the parse step.
    //
    // This is the structural defense the daemon's dev-mode
    // `TokensListContract.response.parse(...)` provides: even if a
    // future bug accidentally adds a `secret` field to a token row in
    // the handler, the parse output that crosses the daemon → web SPA
    // boundary does not carry the leaked secret. The TokenRegistry
    // already enforces this by construction (createTokenRegistry never
    // stores secrets — token-handlers.ts line 70-72); the contract
    // parse is a second orthogonal canary.
    const parsed = TokensListContract.response.parse({
      tokens: [
        {
          id: "tok-1",
          scopes: ["rpc", "admin"],
          createdAt: 1_700_000_000_000,
          secret: "leaked-MUST-NOT-CROSS-BOUNDARY",
        },
      ],
    });
    expect(parsed.tokens).toHaveLength(1);
    expect(parsed.tokens[0]).not.toHaveProperty("secret");
    expect(JSON.stringify(parsed)).not.toContain("leaked-MUST");
  });

  // --- tokens.create -------------------------------------------------------

  it("tokens.create: request requires scopes", () => {
    expect(() => TokensCreateContract.request.parse({})).toThrow();
  });

  it("tokens.create: request rejects empty scopes array (min(1))", () => {
    expect(() =>
      TokensCreateContract.request.parse({ scopes: [] }),
    ).toThrow();
  });

  it("tokens.create: request accepts scopes (minimal)", () => {
    expect(() =>
      TokensCreateContract.request.parse({ scopes: ["rpc"] }),
    ).not.toThrow();
  });

  it("tokens.create: request accepts optional id", () => {
    expect(() =>
      TokensCreateContract.request.parse({
        id: "my-custom-token",
        scopes: ["rpc", "admin"],
      }),
    ).not.toThrow();
  });

  it("tokens.create: request rejects non-string scope entries", () => {
    expect(() =>
      TokensCreateContract.request.parse({ scopes: [42] }),
    ).toThrow();
  });

  it("tokens.create: response shape requires { id, secret, scopes, createdAt, message }", () => {
    expect(() =>
      TokensCreateContract.response.parse({
        id: "tok-1",
        secret: "abc123",
        scopes: ["rpc"],
        createdAt: 1_700_000_000_000,
        message: "Token created. Save the secret now -- it will not be shown again.",
      }),
    ).not.toThrow();
  });

  it("tokens.create: response rejects missing secret field (secret-once invariant)", () => {
    expect(() =>
      TokensCreateContract.response.parse({
        id: "tok-1",
        scopes: ["rpc"],
        createdAt: 1_700_000_000_000,
        message: "ok",
      }),
    ).toThrow();
  });

  it("tokens.create: response rejects non-string secret", () => {
    expect(() =>
      TokensCreateContract.response.parse({
        id: "tok-1",
        secret: 42,
        scopes: ["rpc"],
        createdAt: 1_700_000_000_000,
        message: "ok",
      }),
    ).toThrow();
  });

  // --- tokens.revoke -------------------------------------------------------

  it("tokens.revoke: request requires id", () => {
    expect(() => TokensRevokeContract.request.parse({})).toThrow();
  });

  it("tokens.revoke: request rejects empty-string id (min(1))", () => {
    expect(() =>
      TokensRevokeContract.request.parse({ id: "" }),
    ).toThrow();
  });

  it("tokens.revoke: request accepts non-empty id", () => {
    expect(() =>
      TokensRevokeContract.request.parse({ id: "tok-1" }),
    ).not.toThrow();
  });

  it("tokens.revoke: response shape requires { id, revoked: true, message }", () => {
    expect(() =>
      TokensRevokeContract.response.parse({
        id: "tok-1",
        revoked: true,
        message: "Token revoked",
      }),
    ).not.toThrow();
  });

  it("tokens.revoke: response rejects revoked: false (handler ALWAYS returns true; failure paths throw)", () => {
    // The handler returns `{ id, revoked: true, message }` ONLY when the
    // revoke succeeds; non-existent / already-revoked tokens raise
    // "Token not found or already revoked" (handler line 188-190). The
    // contract therefore models the success-path shape with
    // `revoked: z.literal(true)` rather than `z.boolean()`.
    expect(() =>
      TokensRevokeContract.response.parse({
        id: "tok-1",
        revoked: false,
        message: "ok",
      }),
    ).toThrow();
  });

  // --- tokens.rotate -------------------------------------------------------

  it("tokens.rotate: request requires id", () => {
    expect(() => TokensRotateContract.request.parse({})).toThrow();
  });

  it("tokens.rotate: request rejects empty-string id (min(1))", () => {
    expect(() =>
      TokensRotateContract.request.parse({ id: "" }),
    ).toThrow();
  });

  it("tokens.rotate: request accepts non-empty id", () => {
    expect(() =>
      TokensRotateContract.request.parse({ id: "tok-1" }),
    ).not.toThrow();
  });

  it("tokens.rotate: response shape requires { oldId, newId, newSecret, scopes, createdAt, message }", () => {
    expect(() =>
      TokensRotateContract.response.parse({
        oldId: "tok-1",
        newId: "tok-1-abc",
        newSecret: "xyz789",
        scopes: ["rpc", "admin"],
        createdAt: 1_700_000_000_000,
        message: "Token rotated. Save the new secret now.",
      }),
    ).not.toThrow();
  });

  it("tokens.rotate: response rejects missing newSecret (secret-once invariant on rotation)", () => {
    expect(() =>
      TokensRotateContract.response.parse({
        oldId: "tok-1",
        newId: "tok-1-abc",
        scopes: ["rpc"],
        createdAt: 1_700_000_000_000,
        message: "ok",
      }),
    ).toThrow();
  });

  it("tokens.rotate: response rejects non-array scopes", () => {
    expect(() =>
      TokensRotateContract.response.parse({
        oldId: "tok-1",
        newId: "tok-1-abc",
        newSecret: "xyz789",
        scopes: "rpc",
        createdAt: 1_700_000_000_000,
        message: "ok",
      }),
    ).toThrow();
  });
});
