// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { scriptTokenFactor } from "@comis/core";
import { estimateBlockTokens } from "./token-estimation.js";

// Script-aware token estimation for the request-body/TTL-split root (TOK-01).
//
// Pre-patch: estimateBlockTokens divides by the bare CHARS_PER_TOKEN_RATIO
// (3.5) with no script awareness, so dense non-Latin blocks (Hebrew chat
// measured ~2.2-2.9 chars/token) under-count roughly 2x. The Hebrew bounds
// below FAIL on the pre-patch code (RED); the ASCII pin passes pre/post
// byte-identically (I1 — factor is exactly 1.0 for pure-ASCII text).
describe("estimateBlockTokens — script-aware factors (TOK-01)", () => {
  // 22 Hebrew letters + 5 neutral spaces = 27 UTF-16 units. The shipped
  // hebrew-letters factor is 0.50 (TOK-02 same-commit lowering; pinned in
  // core's token-factor.test.ts) — the bound below was computed at the
  // pre-lowering 0.55 and is deliberately looser than the shipped value.
  const he = "שלום עולם זה מבחן ארוך מאוד";

  it("bounds Hebrew text blocks from below by chars/(3.5*0.55) instead of flat chars/3.5", () => {
    // Pre-patch: ceil(27/3.5) = 8 < ceil(27/(3.5*0.55)) = 15 -> RED.
    expect(estimateBlockTokens({ text: he })).toBeGreaterThanOrEqual(
      Math.ceil(he.length / (3.5 * 0.55)),
    );
  });

  it("keeps pure-ASCII text blocks byte-identical to ceil(len/3.5) (I1 exact pin)", () => {
    const text = "plain ascii text";
    expect(estimateBlockTokens({ text })).toBe(Math.ceil(text.length / 3.5));
  });

  it("factors the JSON.stringify fallback for non-text blocks carrying Hebrew payloads", () => {
    // For blocks without a string `text` field the divisor text is the
    // stringified block itself — the factor must scan that exact string
    // (Latin JSON syntax + Hebrew values blend harmonically; Pitfall 6:
    // never factor an aggregate with a factor computed over different text).
    // Pre-patch: ceil(len/3.5) with no factor -> RED.
    const block = { type: "tool_use", payload: he };
    const json = JSON.stringify(block);
    expect(estimateBlockTokens(block)).toBeGreaterThanOrEqual(
      Math.ceil(json.length / (3.5 * scriptTokenFactor(json))),
    );
  });
});
