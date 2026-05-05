// SPDX-License-Identifier: Apache-2.0
/**
 * Pure-function tests for oauth-identity.ts.
 *
 * Coverage groups:
 *   1. decodeCodexJwtPayload — JWT structure handling and bijectivity
 *   2. resolveCodexAuthIdentity — email path + subject-fallback chain
 *   3. resolveCodexStableSubject — claim priority chain
 *   4. resolveCodexAccessTokenExpiry — ms-not-seconds invariant
 *   5. redactEmailForLog — semi-redaction algorithm
 */

import { describe, it, expect } from "vitest";
import {
  decodeCodexJwtPayload,
  resolveCodexAuthIdentity,
  resolveCodexStableSubject,
  resolveCodexAccessTokenExpiry,
  redactEmailForLog,
} from "./oauth-identity.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Hand-roll a JWT structure for tests. Header is constant, payload is
 * the supplied object, signature is a dummy string. Verifying the
 * signature is out of scope — pi-ai's token exchange validated source.
 */
function encodeJwtForTest(payload: Record<string, unknown>): string {
  const headerB64 = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${headerB64}.${payloadB64}.fake-signature`;
}

// ---------------------------------------------------------------------------
// Group 1 — decodeCodexJwtPayload
// ---------------------------------------------------------------------------

describe("decodeCodexJwtPayload", () => {
  it("decodes a valid 3-segment JWT and returns the payload object", () => {
    const jwt = encodeJwtForTest({ email: "user_a@example.com", exp: 1714680000 });
    expect(decodeCodexJwtPayload(jwt)).toEqual({ email: "user_a@example.com", exp: 1714680000 });
  });

  it("returns null for JWT with !== 3 segments", () => {
    expect(decodeCodexJwtPayload("only.two")).toBeNull();
    expect(decodeCodexJwtPayload("a.b.c.d")).toBeNull();
  });

  it("returns null for malformed base64url payload", () => {
    expect(decodeCodexJwtPayload("header.!!!!.sig")).toBeNull();
  });

  it("returns null for non-object payload (e.g. JSON string)", () => {
    const jwt = encodeJwtForTest("just-a-string" as unknown as Record<string, unknown>);
    expect(decodeCodexJwtPayload(jwt)).toBeNull();
  });

  it("returns null for invalid JSON in payload", () => {
    const malformedPayload = Buffer.from("not-json{").toString("base64url");
    expect(decodeCodexJwtPayload(`header.${malformedPayload}.sig`)).toBeNull();
  });

  // bijectivity property (table-driven)
  it.each([
    { name: "minimal", payload: { sub: "user_a" } },
    { name: "with email + exp", payload: { email: "user_b@example.com", exp: 1714680000 } },
    {
      name: "Codex profile claim",
      payload: {
        "https://api.openai.com/profile": { email: "user_c@example.com" },
        chatgpt_account_user_id: "acct_test_001",
      },
    },
    {
      name: "nested + numeric",
      payload: { iss: "https://example.com", sub: "user_d", exp: 1714683600, custom: { a: 1, b: [1, 2, 3] } },
    },
    { name: "empty object", payload: {} },
  ])("decodeCodexJwtPayload(encode($name)) deep-equals input", ({ payload }) => {
    expect(decodeCodexJwtPayload(encodeJwtForTest(payload))).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — resolveCodexAuthIdentity
// ---------------------------------------------------------------------------

describe("resolveCodexAuthIdentity", () => {
  // email path
  it("returns email when payload contains the OpenAI profile claim", () => {
    const accessToken = encodeJwtForTest({
      "https://api.openai.com/profile": { email: "user_a@example.com" },
    });
    expect(resolveCodexAuthIdentity({ accessToken })).toEqual({
      email: "user_a@example.com",
      profileName: "user_a@example.com",
    });
  });

  // explicit-email override
  it("uses caller-supplied email even when payload contains a different email", () => {
    const accessToken = encodeJwtForTest({
      "https://api.openai.com/profile": { email: "user_a@example.com" },
    });
    expect(resolveCodexAuthIdentity({ accessToken, email: "explicit_b@example.com" })).toEqual({
      email: "explicit_b@example.com",
      profileName: "explicit_b@example.com",
    });
  });

  // subject-fallback path
  it("falls back to id-<base64url(stableSubject)> when payload has no email", () => {
    const expectedB64 = Buffer.from("acct_test_001").toString("base64url");
    expect(expectedB64).toBe("YWNjdF90ZXN0XzAwMQ");
    const accessToken = encodeJwtForTest({ chatgpt_account_user_id: "acct_test_001" });
    expect(resolveCodexAuthIdentity({ accessToken })).toEqual({
      email: undefined,
      profileName: "id-YWNjdF90ZXN0XzAwMQ",
    });
  });

  // each fallback level produces an `id-<base64url>` profileName
  it.each([
    { level: "chatgpt_account_user_id", payload: { chatgpt_account_user_id: "acct_lvl1" } },
    { level: "chatgpt_user_id", payload: { chatgpt_user_id: "user_lvl2" } },
    { level: "user_id", payload: { user_id: "user_lvl3" } },
    { level: "iss|sub", payload: { iss: "https://example.com", sub: "user_lvl4" } },
    { level: "sub", payload: { sub: "user_lvl5" } },
  ])("subject-fallback level $level produces id- prefixed profileName", ({ payload }) => {
    const accessToken = encodeJwtForTest(payload);
    const result = resolveCodexAuthIdentity({ accessToken });
    expect(result.email).toBeUndefined();
    expect(result.profileName).toMatch(/^id-/);
  });

  // missing all identity claims
  it("returns undefined for both email and profileName when payload has no identity claims", () => {
    const accessToken = encodeJwtForTest({});
    expect(resolveCodexAuthIdentity({ accessToken })).toEqual({
      email: undefined,
      profileName: undefined,
    });
  });

  // malformed JWT
  it("returns undefined for both fields when accessToken is not a valid JWT", () => {
    expect(resolveCodexAuthIdentity({ accessToken: "not-a-jwt" })).toEqual({
      email: undefined,
      profileName: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Group 3 — resolveCodexStableSubject
// ---------------------------------------------------------------------------

describe("resolveCodexStableSubject", () => {
  // priority: chatgpt_account_user_id wins over later claims
  it("picks chatgpt_account_user_id over later claims", () => {
    expect(
      resolveCodexStableSubject({ chatgpt_account_user_id: "acct_a", sub: "sub_b" }),
    ).toBe("acct_a");
  });

  // falls through to iss|sub when only iss + sub present
  it("falls through to iss|sub when only iss + sub are present", () => {
    expect(
      resolveCodexStableSubject({ iss: "https://example.com", sub: "user_z" }),
    ).toBe("https://example.com|user_z");
  });

  // returns undefined when no candidates present
  it("returns undefined when payload has no candidate claims", () => {
    expect(resolveCodexStableSubject({})).toBeUndefined();
  });

  // trims whitespace + rejects empty strings (falls to next level)
  it("rejects whitespace-only values and falls through to the next priority level", () => {
    // chatgpt_account_user_id is whitespace → fall through to chatgpt_user_id
    expect(
      resolveCodexStableSubject({ chatgpt_account_user_id: "  ", chatgpt_user_id: "user_lvl2" }),
    ).toBe("user_lvl2");
  });
});

// ---------------------------------------------------------------------------
// Group 4 — resolveCodexAccessTokenExpiry (returns MS, not seconds)
// ---------------------------------------------------------------------------

describe("resolveCodexAccessTokenExpiry", () => {
  // ms (not seconds) invariant
  it("returns expiry in milliseconds, not seconds", () => {
    const accessToken = encodeJwtForTest({ exp: 1714680000 });
    expect(resolveCodexAccessTokenExpiry(accessToken)).toBe(1714680000_000);
  });

  // accepts numeric exp
  it("accepts numeric exp claim", () => {
    const accessToken = encodeJwtForTest({ exp: 1900000000 });
    expect(resolveCodexAccessTokenExpiry(accessToken)).toBe(1900000000_000);
  });

  // accepts digit-only string exp
  it("accepts digit-only string exp claim and converts to ms", () => {
    const accessToken = encodeJwtForTest({ exp: "1714680000" });
    expect(resolveCodexAccessTokenExpiry(accessToken)).toBe(1714680000_000);
  });

  // rejects non-numeric string exp
  it("returns undefined for non-numeric string exp", () => {
    const accessToken = encodeJwtForTest({ exp: "tomorrow" });
    expect(resolveCodexAccessTokenExpiry(accessToken)).toBeUndefined();
  });

  // returns undefined when exp claim is missing
  it("returns undefined when exp claim is missing", () => {
    const accessToken = encodeJwtForTest({ sub: "user_a" });
    expect(resolveCodexAccessTokenExpiry(accessToken)).toBeUndefined();
  });

  // returns undefined for malformed JWT
  it("returns undefined for malformed JWT", () => {
    expect(resolveCodexAccessTokenExpiry("not-a-jwt")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 5 — redactEmailForLog (semi-redaction)
// ---------------------------------------------------------------------------

describe("redactEmailForLog", () => {
  // standard email
  it("semi-redacts a standard email: first 2 + … + last 1 of local part", () => {
    expect(redactEmailForLog("moshe.anconina@gmail.com")).toBe("mo…a@gmail.com");
  });

  // short local-part
  it("semi-redacts a short two-char local part as a…b", () => {
    expect(redactEmailForLog("ab@x.com")).toBe("a…b@x.com");
  });

  // single-char local-part
  it("semi-redacts a single-char local part as …", () => {
    expect(redactEmailForLog("a@x.com")).toBe("…@x.com");
  });

  // undefined input
  it("returns undefined when input is undefined", () => {
    expect(redactEmailForLog(undefined)).toBeUndefined();
  });

  // input has no @ → returned unchanged
  it("returns input unchanged when it does not contain @", () => {
    expect(redactEmailForLog("not-an-email")).toBe("not-an-email");
  });
});
