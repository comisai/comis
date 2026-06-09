// SPDX-License-Identifier: Apache-2.0
/**
 * Characterization (regression-guard) tests for the B-1 token-authority question:
 * is the LCD budget CEILING (H = W − S − O − M − R − P) computed with the SAME
 * token authority as the history items it bounds?
 *
 * THE TWO AUTHORITIES (the apparent "mismatch" the real-LLM review flagged):
 *   - S and P are produced at the executor call sites
 *     (executor-tool-assembly.ts:518-519 / :530-531) by dividing CHAR counts by
 *     `CHARS_PER_TOKEN_RATIO` = 3.5.
 *   - the history items the budget evicts carry their STORED `tokenCount`, computed
 *     at ingest by `estimateMessageTokens` = 4:1 for text (and 3:1 for structured
 *     tool content).
 *
 * THE REVIEW'S CLAIM was "H comes out LARGER than the true free budget → overflow
 * risk on small windows". This test makes the DIRECTION executable rather than
 * argued-from-prose, and pins what ACTUALLY holds:
 *
 *   For the SAME text content, dividing by the SMALLER divisor 3.5 yields MORE
 *   tokens than dividing by 4. So S and P (at 3.5) OVER-reserve relative to how the
 *   SAME bytes would be counted as history (at 4:1). The result is that H comes out
 *   SMALLER (more conservative) for text — the OPPOSITE direction from the review.
 *   This is the same reversal the B-4 fix already corrected (260605-ney): the
 *   review's ratio intuition runs backwards.
 *
 * CONSEQUENCE (the B-1 disposition): the unit mismatch is real but its direction is
 * CONSERVATIVE — S/P over-reserve, H under-fills, the assembled prompt stays UNDER
 * the real free window. Aligning S/P from 3.5 → 4 would make them SMALLER, WIDENING
 * H — the UNSAFE direction (it is exactly what the recall-dag-budget-partition
 * invariant guards against). So B-1 is a documented NON-ISSUE: this test is the
 * regression guard that pins the safe/conservative direction, plus a code comment at
 * the two S/P production sites. NO behavior change ships; S/P stay at 3.5.
 *
 * These tests use the REAL pure functions (the budget algebra + the estimator) — no
 * mocks — so the relationship is exercised, not asserted from comments.
 */
import { describe, it, expect } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { computeTokenBudget } from "../../context-engine/token-budget.js";
import { computeTokenBudgetForProfile } from "../../context-engine/budget-capacity-cap.js";
import { estimateMessageTokens } from "../../safety/token-estimator.js";
import {
  CHARS_PER_TOKEN_RATIO,
  OUTPUT_RESERVE_TOKENS,
} from "../../context-engine/constants.js";
import type { ModelProfile } from "../../executor/model-profile.js";

/**
 * The S/P production-site formula, verbatim from executor-tool-assembly.ts:518-519
 * (`Math.ceil(chars / CHARS_PER_TOKEN_RATIO)`). Inlined here so the characterization
 * exercises the SAME arithmetic the executor uses to produce S and P, without
 * importing the whole assembly module.
 */
function systemTokensAtProductionRatio(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN_RATIO);
}

/** A plain user-role text message of `n` chars (counted at 4:1 by the estimator). */
function textMsg(n: number): Message {
  return { role: "user", content: "x".repeat(n), timestamp: 0 } as Message;
}

describe("B-1: token authority — the budget ceiling vs the items it bounds (characterization)", () => {
  it("DIRECTION: counting the SAME text at the 3.5 S/P ratio reserves MORE tokens than counting it as 4:1 history (S/P OVER-reserve)", () => {
    // The crux of the B-1 reversal. Take one body of text. Counted as S/P (÷3.5) it
    // costs MORE tokens than the SAME bytes counted as history (÷4 via the
    // estimator). So the ceiling subtracts MORE for system/preamble text than the
    // history items it is compared against contribute — H is conservative, not
    // inflated.
    const CHARS = 70_000; // a large system prompt + tool-def overhead
    const asSystemTokens = systemTokensAtProductionRatio(CHARS); // ÷3.5
    const asHistoryTokens = estimateMessageTokens(textMsg(CHARS)); // ÷4 (text)

    // 3.5 is the smaller divisor → MORE tokens. The over-reservation is real and in
    // the SAFE direction (it shrinks H). This is the executable proof the review's
    // "H larger" claim is backwards for text (the B-4 pattern again).
    expect(asSystemTokens).toBeGreaterThan(asHistoryTokens);
    // Sanity on the magnitude: 70000/3.5 = 20000 vs 70000/4 = 17500 → a 2500-token
    // CONSERVATIVE cushion, not an overflow.
    expect(asSystemTokens).toBe(20_000);
    expect(asHistoryTokens).toBe(17_500);
  });

  it("SMALL WINDOW: with a large preamble on a 32k window, the assembled tokens at the 4:1/3:1 authority stay UNDER W − OUTPUT_RESERVE (no overflow — H is conservative)", () => {
    // The review's worst case: a SMALL window with a LARGE system prompt + preamble.
    // Construct it and prove the assembled prompt (S + P at 3.5, plus the history
    // the budget KEEPS at the 4:1 authority) does NOT exceed the real free window
    // (W − OUTPUT_RESERVE). If H were inflated (the review's claim) this could
    // overflow; because S/P over-reserve, it cannot.
    //
    // Sizes chosen so H stays POSITIVE (an un-clamped budget) — the clean case that
    // exhibits the conservative identity. (A still-larger preamble simply clamps H
    // to 0, which is MORE conservative, covered by the next assertion.)
    const W = 32_000; // a small-context model
    const SYSTEM_CHARS = 20_000; // a hefty system prompt + tool defs
    const PREAMBLE_CHARS = 15_000; // a heavy fresh-tail preamble (skills/MCP/recall)
    const S = systemTokensAtProductionRatio(SYSTEM_CHARS);
    const P = systemTokensAtProductionRatio(PREAMBLE_CHARS);

    const budget = computeTokenBudget(W, S, -1, P);
    expect(budget.availableHistoryTokens).toBeGreaterThan(0); // the un-clamped case

    // The budget KEEPS at most `availableHistoryTokens` of history. The assembled
    // prompt the model receives ≈ S (system) + P (preamble, riding the fresh tail) +
    // the kept history. By construction of H = W − S − O − M − R − P, the kept
    // history is bounded by H, so:
    //   assembled ≈ S + P + H = W − O − M − R  ≤  W − O   (M, R ≥ 0)
    // i.e. the assembled prompt is bounded by W − OUTPUT_RESERVE with the M + R
    // cushion to spare. Assert that ceiling holds on this small window.
    const assembledCeiling = S + P + budget.availableHistoryTokens;
    expect(assembledCeiling).toBeLessThanOrEqual(W - OUTPUT_RESERVE_TOKENS);

    // And the M + R cushion is the EXTRA conservatism absorbing the 3.5-vs-4 unit
    // mismatch: with H un-clamped, assembled + O = W − M − R, strictly below W by
    // the whole cushion (the identity that proves the direction is conservative).
    expect(assembledCeiling + OUTPUT_RESERVE_TOKENS).toBe(
      W - budget.safetyMarginTokens - budget.contextRotBufferTokens,
    );
    expect(budget.safetyMarginTokens + budget.contextRotBufferTokens).toBeGreaterThan(0);
  });

  it("SMALL WINDOW + EXTREME preamble: H clamps to 0 and the assembled prompt is STILL under W − OUTPUT_RESERVE (the clamp is the harder-conservative case)", () => {
    // Push the system + preamble large enough that H clamps to 0 (no room for any
    // history). Even then the assembled prompt is only S + P + 0, and the over-
    // reservation keeps it under the real free window — there is no overflow, the
    // budget just stops admitting history. This is the case the prior exact-identity
    // could not cover (the identity only holds un-clamped) and is the worst case the
    // review worried about — and it is STILL safe.
    const W = 32_000;
    const SYSTEM_CHARS = 40_000;
    const PREAMBLE_CHARS = 30_000;
    const S = systemTokensAtProductionRatio(SYSTEM_CHARS);
    const P = systemTokensAtProductionRatio(PREAMBLE_CHARS);

    const budget = computeTokenBudget(W, S, -1, P);
    expect(budget.availableHistoryTokens).toBe(0); // clamped — no history admitted

    const assembledCeiling = S + P + budget.availableHistoryTokens;
    // No overflow even at the clamp: S + P alone fit under the real free window.
    expect(assembledCeiling).toBeLessThanOrEqual(W - OUTPUT_RESERVE_TOKENS);
  });

  it("UNSAFE-DIRECTION GUARD: re-deriving S at 4:1 instead of 3.5 would WIDEN H (the move B-1 must NOT make)", () => {
    // Pins WHY the fix shape the review implied (move S/P 3.5 → 4) is wrong: it makes
    // S smaller, so H grows — eroding the very cushion the partition invariant
    // relies on. This guard fails loudly if a future change "aligns" S to 4:1 and
    // someone expects H to stay the same or shrink.
    const W = 32_000;
    const SYSTEM_CHARS = 40_000;
    const S_at_3_5 = systemTokensAtProductionRatio(SYSTEM_CHARS); // current (safe)
    const S_at_4 = Math.ceil(SYSTEM_CHARS / 4); // the tempting "alignment"

    const H_at_3_5 = computeTokenBudget(W, S_at_3_5).availableHistoryTokens;
    const H_at_4 = computeTokenBudget(W, S_at_4).availableHistoryTokens;

    // Aligning to 4:1 makes S smaller → H LARGER (the unsafe direction). The current
    // 3.5 reservation keeps H SMALLER = conservative. Do NOT make this move.
    expect(S_at_4).toBeLessThan(S_at_3_5);
    expect(H_at_4).toBeGreaterThan(H_at_3_5);
  });
});

describe("computeTokenBudgetForProfile — frontier byte-identical guarantee (C1)", () => {
  const frontierProfile: ModelProfile = {
    contextWindow: 200_000, maxOutputTokens: 32_768, capabilityClass: "frontier",
    scaffoldLevel: "light", securityLevel: "standard", supportsVision: true,
    supportsTools: true, supportsPromptCache: true, supportsServerToolSearch: false,
    supportsStructuredOutput: false, reasoningStyle: "none",
  };

  it("frontier 200K: wrapper H == direct computeTokenBudget H", () => {
    const S = 10_000, P = 2_000;
    const direct = computeTokenBudget(200_000, S, -1, P);
    const wrapped = computeTokenBudgetForProfile(frontierProfile, S, P, -1);
    expect(wrapped.availableHistoryTokens).toBe(direct.availableHistoryTokens);
  });
});
