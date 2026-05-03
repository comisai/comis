// SPDX-License-Identifier: Apache-2.0
/**
 * RED baseline (Phase 7 SPEC R4) — pure-function tests for oauth-identity.ts.
 *
 * The source module `./oauth-identity.js` does not yet exist. This file is
 * committed FAILING-TO-COMPILE on purpose: downstream plan 04 creates the
 * source module and turns these tests green.
 *
 * Coverage groups:
 *   1. decodeCodexJwtPayload — JWT structure handling and bijectivity
 *   2. resolveCodexAuthIdentity — email path + subject-fallback chain
 *   3. resolveCodexStableSubject — claim priority chain
 *   4. resolveCodexAccessTokenExpiry — ms-not-seconds invariant
 *   5. redactEmailForLog — D-14 semi-redaction algorithm
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
  // Test 1.1
  it("decodes a valid 3-segment JWT and returns the payload object", () => {
    const jwt = encodeJwtForTest({ email: "user_a@example.com", exp: 1714680000 });
    expect(decodeCodexJwtPayload(jwt)).toEqual({ email: "user_a@example.com", exp: 1714680000 });
  });

  // Test 1.2
  it("returns null for JWT with !== 3 segments", () => {
    expect(decodeCodexJwtPayload("only.two")).toBeNull();
    expect(decodeCodexJwtPayload("a.b.c.d")).toBeNull();
  });

  // Test 1.3
  it("returns null for malformed base64url payload", () => {
    expect(decodeCodexJwtPayload("header.!!!!.sig")).toBeNull();
  });

  // Test 1.4
  it("returns null for non-object payload (e.g. JSON string)", () => {
    const jwt = encodeJwtForTest("just-a-string" as unknown as Record<string, unknown>);
    expect(decodeCodexJwtPayload(jwt)).toBeNull();
  });

  // Test 1.5
  it("returns null for invalid JSON in payload", () => {
    const malformedPayload = Buffer.from("not-json{").toString("base64url");
    expect(decodeCodexJwtPayload(`header.${malformedPayload}.sig`)).toBeNull();
  });

  // Test 1.6 — bijectivity property (table-driven)
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
  // Test 2.1 — email path
  it("returns email when payload contains the OpenAI profile claim", () => {
    const accessToken = encodeJwtForTest({
      "https://api.openai.com/profile": { email: "user_a@example.com" },
    });
    expect(resolveCodexAuthIdentity({ accessToken })).toEqual({
      email: "user_a@example.com",
      profileName: "user_a@example.com",
    });
  });

  // Test 2.2 — explicit-email override
  it("uses caller-supplied email even when payload contains a different email", () => {
    const accessToken = encodeJwtForTest({
      "https://api.openai.com/profile": { email: "user_a@example.com" },
    });
    expect(resolveCodexAuthIdentity({ accessToken, email: "explicit_b@example.com" })).toEqual({
      email: "explicit_b@example.com",
      profileName: "explicit_b@example.com",
    });
  });

  // Test 2.3 — subject-fallback path
  it("falls back to id-<base64url(stableSubject)> when payload has no email", () => {
    const expectedB64 = Buffer.from("acct_test_001").toString("base64url");
    expect(expectedB64).toBe("YWNjdF90ZXN0XzAwMQ");
    const accessToken = encodeJwtForTest({ chatgpt_account_user_id: "acct_test_001" });
    expect(resolveCodexAuthIdentity({ accessToken })).toEqual({
      email: undefined,
      profileName: "id-YWNjdF90ZXN0XzAwMQ",
    });
  });

  // Test 2.4 — each fallback level produces an `id-<base64url>` profileName
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

  // Test 2.5 — missing all identity claims
  it("returns undefined for both email and profileName when payload has no identity claims", () => {
    const accessToken = encodeJwtForTest({});
    expect(resolveCodexAuthIdentity({ accessToken })).toEqual({
      email: undefined,
      profileName: undefined,
    });
  });

  // Test 2.6 — malformed JWT
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
  // Test 3.1 — priority: chatgpt_account_user_id wins over later claims
  it("picks chatgpt_account_user_id over later claims", () => {
    expect(
      resolveCodexStableSubject({ chatgpt_account_user_id: "acct_a", sub: "sub_b" }),
    ).toBe("acct_a");
  });

  // Test 3.2 — falls through to iss|sub when only iss + sub present
  it("falls through to iss|sub when only iss + sub are present", () => {
    expect(
      resolveCodexStableSubject({ iss: "https://example.com", sub: "user_z" }),
    ).toBe("https://example.com|user_z");
  });

  // Test 3.3 — returns undefined when no candidates present
  it("returns undefined when payload has no candidate claims", () => {
    expect(resolveCodexStableSubject({})).toBeUndefined();
  });

  // Test 3.4 — trims whitespace + rejects empty strings (falls to next level)
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
  // Test 4.1 — ms (not seconds) invariant
  it("returns expiry in milliseconds, not seconds", () => {
    const accessToken = encodeJwtForTest({ exp: 1714680000 });
    expect(resolveCodexAccessTokenExpiry(accessToken)).toBe(1714680000_000);
  });

  // Test 4.2 — accepts numeric exp
  it("accepts numeric exp claim", () => {
    const accessToken = encodeJwtForTest({ exp: 1900000000 });
    expect(resolveCodexAccessTokenExpiry(accessToken)).toBe(1900000000_000);
  });

  // Test 4.3 — accepts digit-only string exp
  it("accepts digit-only string exp claim and converts to ms", () => {
    const accessToken = encodeJwtForTest({ exp: "1714680000" });
    expect(resolveCodexAccessTokenExpiry(accessToken)).toBe(1714680000_000);
  });

  // Test 4.4 — rejects non-numeric string exp
  it("returns undefined for non-numeric string exp", () => {
    const accessToken = encodeJwtForTest({ exp: "tomorrow" });
    expect(resolveCodexAccessTokenExpiry(accessToken)).toBeUndefined();
  });

  // Test 4.5 — returns undefined when exp claim is missing
  it("returns undefined when exp claim is missing", () => {
    const accessToken = encodeJwtForTest({ sub: "user_a" });
    expect(resolveCodexAccessTokenExpiry(accessToken)).toBeUndefined();
  });

  // Test 4.6 — returns undefined for malformed JWT
  it("returns undefined for malformed JWT", () => {
    expect(resolveCodexAccessTokenExpiry("not-a-jwt")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 5 — redactEmailForLog (D-14 semi-redaction)
// ---------------------------------------------------------------------------

describe("redactEmailForLog", () => {
  // Test 5.1 — standard email
  it("semi-redacts a standard email: first 2 + … + last 1 of local part", () => {
    expect(redactEmailForLog("moshe.anconina@gmail.com")).toBe("mo…a@gmail.com");
  });

  // Test 5.2 — short local-part
  it("semi-redacts a short two-char local part as a…b", () => {
    expect(redactEmailForLog("ab@x.com")).toBe("a…b@x.com");
  });

  // Test 5.3 — single-char local-part
  it("semi-redacts a single-char local part as …", () => {
    expect(redactEmailForLog("a@x.com")).toBe("…@x.com");
  });

  // Test 5.4 — undefined input
  it("returns undefined when input is undefined", () => {
    expect(redactEmailForLog(undefined)).toBeUndefined();
  });

  // Test 5.5 — input has no @ → returned unchanged
  it("returns input unchanged when it does not contain @", () => {
    expect(redactEmailForLog("not-an-email")).toBe("not-an-email");
  });
});
