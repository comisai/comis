// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract tests for the secrets-domain RPC contracts.
 *
 * Mirrors the structure of `packages/core/src/api-contracts/auth.test.ts`.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  SecretsSetContract,
  SecretsGetContract,
  SecretsListContract,
  SecretsDeleteContract,
  SECRETS_CONTRACTS,
} from "./secrets.js";

describe("secrets-domain contracts", () => {
  it("SECRETS_CONTRACTS has exactly 4 entries (the 4 methods in secrets-handlers.ts)", () => {
    expect(SECRETS_CONTRACTS.length).toBe(4);
  });

  it("secrets.set: method name is correct", () => {
    expect(SecretsSetContract.method).toBe("secrets.set");
  });

  it("secrets.get: method name is correct", () => {
    expect(SecretsGetContract.method).toBe("secrets.get");
  });

  it("secrets.list: method name is correct", () => {
    expect(SecretsListContract.method).toBe("secrets.list");
  });

  it("secrets.delete: method name is correct", () => {
    expect(SecretsDeleteContract.method).toBe("secrets.delete");
  });

  it("all 4 contracts are admin-scoped", () => {
    expect(SecretsSetContract.scopes).toEqual(["admin"]);
    expect(SecretsGetContract.scopes).toEqual(["admin"]);
    expect(SecretsListContract.scopes).toEqual(["admin"]);
    expect(SecretsDeleteContract.scopes).toEqual(["admin"]);
  });

  // --- secrets.set ---------------------------------------------------------

  it("secrets.set: request requires both name and value", () => {
    expect(() => SecretsSetContract.request.parse({})).toThrow();
    expect(() =>
      SecretsSetContract.request.parse({ name: "FOO" }),
    ).toThrow();
    expect(() =>
      SecretsSetContract.request.parse({ value: "v" }),
    ).toThrow();
  });

  it("secrets.set: request rejects empty-string name / value (min(1))", () => {
    expect(() =>
      SecretsSetContract.request.parse({ name: "", value: "v" }),
    ).toThrow();
    expect(() =>
      SecretsSetContract.request.parse({ name: "FOO", value: "" }),
    ).toThrow();
  });

  it("secrets.set: request accepts name + value (minimal)", () => {
    expect(() =>
      SecretsSetContract.request.parse({
        name: "OPENAI_API_KEY",
        value: "sk-test",
      }),
    ).not.toThrow();
  });

  it("secrets.set: request accepts optional provider, description, expiresAt", () => {
    expect(() =>
      SecretsSetContract.request.parse({
        name: "OPENAI_API_KEY",
        value: "sk-test",
        provider: "openai",
        description: "Primary OpenAI key for production",
        expiresAt: 1_800_000_000_000,
      }),
    ).not.toThrow();
  });

  it("secrets.set: request rejects non-string value", () => {
    expect(() =>
      SecretsSetContract.request.parse({ name: "FOO", value: 42 }),
    ).toThrow();
  });

  it("secrets.set: response shape requires { name, stored: boolean }", () => {
    expect(() =>
      SecretsSetContract.response.parse({
        name: "FOO",
        stored: true,
        restarting: false,
      }),
    ).not.toThrow();
    expect(() =>
      SecretsSetContract.response.parse({
        name: "FOO",
        stored: false,
        restarting: true,
      }),
    ).not.toThrow();
    expect(() =>
      SecretsSetContract.response.parse({ name: "FOO", stored: "yes" }),
    ).toThrow();
    expect(() =>
      SecretsSetContract.response.parse({ name: "FOO" }),
    ).toThrow();
  });

  // --- secrets.get ---------------------------------------------------------

  it("secrets.get: request requires name", () => {
    expect(() => SecretsGetContract.request.parse({})).toThrow();
  });

  it("secrets.get: request rejects empty-string name (min(1))", () => {
    expect(() => SecretsGetContract.request.parse({ name: "" })).toThrow();
  });

  it("secrets.get: request accepts non-empty name", () => {
    expect(() =>
      SecretsGetContract.request.parse({ name: "OPENAI_API_KEY" }),
    ).not.toThrow();
  });

  it("secrets.get: response accepts exists=true with value (decrypted plaintext)", () => {
    expect(() =>
      SecretsGetContract.response.parse({
        name: "FOO",
        exists: true,
        value: "sk-test",
      }),
    ).not.toThrow();
  });

  it("secrets.get: response accepts exists=false without value (not found)", () => {
    expect(() =>
      SecretsGetContract.response.parse({
        name: "FOO",
        exists: false,
      }),
    ).not.toThrow();
  });

  it("secrets.get: response rejects non-boolean exists", () => {
    expect(() =>
      SecretsGetContract.response.parse({
        name: "FOO",
        exists: "yes",
      }),
    ).toThrow();
  });

  // --- secrets.list --------------------------------------------------------

  it("secrets.list: request accepts an empty object", () => {
    expect(() => SecretsListContract.request.parse({})).not.toThrow();
  });

  it("secrets.list: response accepts an empty secrets array (no encrypted store configured)", () => {
    expect(() =>
      SecretsListContract.response.parse({ secrets: [] }),
    ).not.toThrow();
  });

  it("secrets.list: response accepts a value-free SecretMetadata row", () => {
    expect(() =>
      SecretsListContract.response.parse({
        secrets: [
          {
            name: "OPENAI_API_KEY",
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_001_000_000,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("secrets.list: response accepts optional provider, description, expiresAt", () => {
    expect(() =>
      SecretsListContract.response.parse({
        secrets: [
          {
            name: "OPENAI_API_KEY",
            provider: "openai",
            description: "Primary key",
            expiresAt: 1_800_000_000_000,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_001_000_000,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("secrets.list: response rejects rows missing required createdAt / updatedAt", () => {
    expect(() =>
      SecretsListContract.response.parse({
        secrets: [{ name: "FOO" }],
      }),
    ).toThrow();
  });

  it("secrets.list: residency-canary projection — `value` field on a row is STRIPPED on parse", () => {
    // SecretMetadataSchema intentionally omits `value` / `plaintext` and
    // does NOT call `.passthrough()`. Default Zod behavior for unknown
    // keys is STRIP (not reject) — so a well-shaped row that ALSO
    // carries a leaked `value` field has the `value` removed by the
    // parse step. The parsed result is value-free.
    //
    // This is the structural defense the daemon's dev-mode
    // `SecretsListContract.response.parse(...)` provides: even if a
    // future bug accidentally adds a `value` field to a SecretMetadata
    // row in the handler, the parse output that crosses the daemon →
    // CLI boundary does not carry the leaked value. Production skips
    // the parse for cold-start budget, but the structural canary
    // defense applies in dev + test, where leaks would surface first.
    const parsed = SecretsListContract.response.parse({
      secrets: [
        {
          name: "OPENAI_API_KEY",
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_001_000_000,
          value: "sk-leaked-MUST-NOT-CROSS-BOUNDARY",
        },
      ],
    });
    expect(parsed.secrets).toHaveLength(1);
    // The leaked value is stripped from the parsed output.
    expect(parsed.secrets[0]).not.toHaveProperty("value");
    expect(JSON.stringify(parsed)).not.toContain("sk-leaked");
  });

  // --- secrets.delete ------------------------------------------------------

  it("secrets.delete: request requires name", () => {
    expect(() => SecretsDeleteContract.request.parse({})).toThrow();
  });

  it("secrets.delete: request rejects empty-string name (min(1))", () => {
    expect(() =>
      SecretsDeleteContract.request.parse({ name: "" }),
    ).toThrow();
  });

  it("secrets.delete: request accepts non-empty name", () => {
    expect(() =>
      SecretsDeleteContract.request.parse({ name: "OPENAI_API_KEY" }),
    ).not.toThrow();
  });

  it("secrets.delete: response shape requires { name, deleted: boolean }", () => {
    expect(() =>
      SecretsDeleteContract.response.parse({
        name: "FOO",
        deleted: true,
        restarting: false,
      }),
    ).not.toThrow();
    expect(() =>
      SecretsDeleteContract.response.parse({
        name: "FOO",
        deleted: false,
        restarting: true,
      }),
    ).not.toThrow();
    expect(() =>
      SecretsDeleteContract.response.parse({ name: "FOO", deleted: "yes" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Restart-truth contract fields
// ---------------------------------------------------------------------------

describe("restart-truth contract fields", () => {
  // --- SecretsSetContract restarting field ----------------------------------

  it("SecretsSetContract response parses an object with name, stored, and restarting fields", () => {
    expect(() =>
      SecretsSetContract.response.parse({
        name: "OPENAI_API_KEY",
        stored: true,
        restarting: false,
      }),
    ).not.toThrow();
  });

  it("SecretsSetContract response rejects an object missing the restarting field", () => {
    const result = SecretsSetContract.response.safeParse({
      name: "OPENAI_API_KEY",
      stored: true,
    });
    expect(result.success).toBe(false);
  });

  it("SecretsSetContract response restarting field accepts true (restart scheduled)", () => {
    const result = SecretsSetContract.response.safeParse({
      name: "OPENAI_API_KEY",
      stored: true,
      restarting: true,
    });
    expect(result.success).toBe(true);
  });

  it("SecretsSetContract response restarting field accepts false (live applied)", () => {
    const result = SecretsSetContract.response.safeParse({
      name: "OPENAI_API_KEY",
      stored: true,
      restarting: false,
    });
    expect(result.success).toBe(true);
  });

  it("SecretsSetContract response rejects non-boolean restarting", () => {
    const result = SecretsSetContract.response.safeParse({
      name: "OPENAI_API_KEY",
      stored: true,
      restarting: "yes",
    });
    expect(result.success).toBe(false);
  });

  // --- SecretsDeleteContract restarting field -------------------------------

  it("SecretsDeleteContract response parses an object with name, deleted, and restarting fields", () => {
    expect(() =>
      SecretsDeleteContract.response.parse({
        name: "OPENAI_API_KEY",
        deleted: true,
        restarting: false,
      }),
    ).not.toThrow();
  });

  it("SecretsDeleteContract response rejects an object missing the restarting field", () => {
    const result = SecretsDeleteContract.response.safeParse({
      name: "OPENAI_API_KEY",
      deleted: true,
    });
    expect(result.success).toBe(false);
  });

  it("SecretsDeleteContract response restarting field accepts true", () => {
    const result = SecretsDeleteContract.response.safeParse({
      name: "OPENAI_API_KEY",
      deleted: true,
      restarting: true,
    });
    expect(result.success).toBe(true);
  });

  it("SecretsDeleteContract response restarting field accepts false", () => {
    const result = SecretsDeleteContract.response.safeParse({
      name: "OPENAI_API_KEY",
      deleted: false,
      restarting: false,
    });
    expect(result.success).toBe(true);
  });

  it("SecretsDeleteContract response rejects non-boolean restarting", () => {
    const result = SecretsDeleteContract.response.safeParse({
      name: "OPENAI_API_KEY",
      deleted: true,
      restarting: 1,
    });
    expect(result.success).toBe(false);
  });
});
