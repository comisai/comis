// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `rewriteOAuthError` (Phase 10 SC-10-3).
 *
 * 13 tests covering all 6 discriminated cases + ordering invariant +
 * defensive non-Error inputs + the `errorKind === code` mirror invariant
 * (CLAUDE.md Pino log field convention).
 *
 * Test fixtures are neutral — no real emails, tokens, or proprietary
 * error_description strings (AGENTS.md §2.2).
 */

import { describe, it, expect } from "vitest";
import { rewriteOAuthError, type OAuthErrorCode } from "./oauth-errors.js";

describe("rewriteOAuthError", () => {
  // -------------------------------------------------------------------------
  // refresh_token_reused — 3 OpenClaw substring matchers (verbatim port from
  // openclaw/src/agents/auth-profiles/oauth.ts:117-123)
  // -------------------------------------------------------------------------
  describe("refresh_token_reused (3 OpenClaw substring matchers)", () => {
    // Test 1
    it("matches the literal 'refresh_token_reused' substring", () => {
      const result = rewriteOAuthError(new Error("refresh_token_reused"));
      expect(result.code).toBe("refresh_token_reused");
      expect(result.errorKind).toBe("refresh_token_reused");
      expect(result.userMessage).toContain(
        "comis auth login --provider openai-codex",
      );
      expect(result.hint).toContain("re-login required");
    });

    // Test 2
    it("matches 'refresh token has already been used' phrasing", () => {
      const result = rewriteOAuthError(
        new Error("refresh token has already been used"),
      );
      expect(result.code).toBe("refresh_token_reused");
    });

    // Test 3
    it("matches 'already been used to generate a new access token' phrasing", () => {
      const result = rewriteOAuthError(
        new Error(
          "this token has already been used to generate a new access token",
        ),
      );
      expect(result.code).toBe("refresh_token_reused");
    });
  });

  // -------------------------------------------------------------------------
  // invalid_grant
  // -------------------------------------------------------------------------
  describe("invalid_grant", () => {
    // Test 4
    it("classifies a generic invalid_grant error", () => {
      const result = rewriteOAuthError(new Error("invalid_grant"));
      expect(result.code).toBe("invalid_grant");
      expect(result.errorKind).toBe("invalid_grant");
      expect(result.userMessage).toContain(
        "comis auth login --provider openai-codex",
      );
      expect(result.hint).toContain("re-login required");
    });
  });

  // -------------------------------------------------------------------------
  // Priority ordering — RESEARCH §Q3 critical invariant
  // -------------------------------------------------------------------------
  describe("priority ordering (RESEARCH §Q3 critical invariant)", () => {
    // Test 5
    it("classifies refresh_token_reused even when message also contains invalid_grant", () => {
      const err = new Error(
        '{"error":"invalid_grant","error_description":"refresh_token_reused"}',
      );
      expect(rewriteOAuthError(err).code).toBe("refresh_token_reused");
    });
  });

  // -------------------------------------------------------------------------
  // unsupported_region
  // -------------------------------------------------------------------------
  describe("unsupported_region", () => {
    // Test 6
    it("classifies unsupported_country_region_territory and surfaces HTTPS_PROXY hint", () => {
      const result = rewriteOAuthError(
        new Error("unsupported_country_region_territory"),
      );
      expect(result.code).toBe("unsupported_region");
      expect(result.errorKind).toBe("unsupported_region");
      expect(result.userMessage).toContain("HTTPS_PROXY");
    });
  });

  // -------------------------------------------------------------------------
  // callback_validation_failed — 2 substring forms
  // -------------------------------------------------------------------------
  describe("callback_validation_failed", () => {
    // Test 7
    it("classifies 'state mismatch' as callback_validation_failed", () => {
      const result = rewriteOAuthError(new Error("state mismatch"));
      expect(result.code).toBe("callback_validation_failed");
    });

    // Test 8
    it("classifies 'missing authorization code' as callback_validation_failed", () => {
      const result = rewriteOAuthError(new Error("missing authorization code"));
      expect(result.code).toBe("callback_validation_failed");
    });
  });

  // -------------------------------------------------------------------------
  // identity_decode_failed
  // -------------------------------------------------------------------------
  describe("identity_decode_failed", () => {
    // Test 9
    it("classifies pi-ai's accountId-extraction failure", () => {
      const result = rewriteOAuthError(
        new Error("Failed to extract accountId from token"),
      );
      expect(result.code).toBe("identity_decode_failed");
    });
  });

  // -------------------------------------------------------------------------
  // Default fallback (callback_timeout)
  // -------------------------------------------------------------------------
  describe("default fallback (callback_timeout)", () => {
    // Test 10
    it("falls back to callback_timeout for unknown error and echoes the original message", () => {
      const result = rewriteOAuthError(new Error("some other error"));
      expect(result.code).toBe("callback_timeout");
      expect(result.userMessage).toBe("some other error");
    });

    // Test 11
    it("coerces a non-Error string input via String()", () => {
      const result = rewriteOAuthError("oops");
      expect(result.code).toBe("callback_timeout");
      expect(result.userMessage).toBe("oops");
    });

    // Test 12
    it("coerces null input via String() (defensive)", () => {
      const result = rewriteOAuthError(null);
      expect(result.code).toBe("callback_timeout");
      expect(result.userMessage).toBe("null");
    });
  });

  // -------------------------------------------------------------------------
  // Invariants
  // -------------------------------------------------------------------------
  describe("invariants", () => {
    // Test 13
    it("errorKind mirrors code for every classified case (CLAUDE.md Pino log field convention)", () => {
      const cases: Array<{ input: unknown; expectedCode: OAuthErrorCode }> = [
        {
          input: new Error("refresh_token_reused"),
          expectedCode: "refresh_token_reused",
        },
        { input: new Error("invalid_grant"), expectedCode: "invalid_grant" },
        {
          input: new Error("unsupported_country_region_territory"),
          expectedCode: "unsupported_region",
        },
        {
          input: new Error("state mismatch"),
          expectedCode: "callback_validation_failed",
        },
        {
          input: new Error("Failed to extract accountId"),
          expectedCode: "identity_decode_failed",
        },
        {
          input: new Error("totally unknown error"),
          expectedCode: "callback_timeout",
        },
      ];
      for (const { input, expectedCode } of cases) {
        const result = rewriteOAuthError(input);
        expect(result.code).toBe(expectedCode);
        expect(result.errorKind).toBe(result.code);
      }
    });
  });
});
