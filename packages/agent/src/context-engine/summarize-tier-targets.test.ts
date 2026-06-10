// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { LEAF_FALLBACK_SUMMARY_MARKER } from "./constants.js";
import { resolveSummaryTargetTokens, buildNanoStructuredExtraction } from "./summarize-tier-targets.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMsg(role: string, content: string): AgentMessage {
  return { role, content } as unknown as AgentMessage;
}

// ---------------------------------------------------------------------------
// resolveSummaryTargetTokens — SUM-02 tier floors
// ---------------------------------------------------------------------------

describe("resolveSummaryTargetTokens — SUM-02 tier-aware token floors", () => {
  describe("nano tier — capped at 256", () => {
    it("nano configured=1200 returns 256 (nano floor applied)", () => {
      expect(resolveSummaryTargetTokens("nano", 0, 1200)).toBe(256);
    });

    it("nano configured=100 returns 100 (below nano floor, configured wins)", () => {
      expect(resolveSummaryTargetTokens("nano", 0, 100)).toBe(100);
    });

    it("nano configured=256 returns 256 (exactly at nano floor)", () => {
      expect(resolveSummaryTargetTokens("nano", 0, 256)).toBe(256);
    });
  });

  describe("small tier — capped at 400", () => {
    it("small configured=1200 returns 400 (small floor applied)", () => {
      expect(resolveSummaryTargetTokens("small", 0, 1200)).toBe(400);
    });

    it("small configured=300 returns 300 (below small floor, configured wins)", () => {
      expect(resolveSummaryTargetTokens("small", 0, 300)).toBe(300);
    });
  });

  describe("mid tier — capped at 800", () => {
    it("mid configured=1200 returns 800 (mid floor applied)", () => {
      expect(resolveSummaryTargetTokens("mid", 0, 1200)).toBe(800);
    });

    it("mid configured=600 returns 600 (below mid floor, configured wins)", () => {
      expect(resolveSummaryTargetTokens("mid", 0, 600)).toBe(600);
    });
  });

  describe("frontier tier — uncapped", () => {
    it("frontier configured=1200 returns 1200 (no cap for frontier)", () => {
      expect(resolveSummaryTargetTokens("frontier", 0, 1200)).toBe(1200);
    });

    it("frontier configured=2000 returns 2000 (frontier always uncapped)", () => {
      expect(resolveSummaryTargetTokens("frontier", 0, 2000)).toBe(2000);
    });
  });

  describe("fail-closed: unknown capabilityClass returns nano floor", () => {
    it("unknown capabilityClass configured=1200 returns 256 (fail-closed to nano)", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(resolveSummaryTargetTokens("unknown" as any, 0, 1200)).toBe(256);
    });
  });
});

// ---------------------------------------------------------------------------
// buildNanoStructuredExtraction — SUM-02 nano deterministic extractor
// ---------------------------------------------------------------------------

describe("buildNanoStructuredExtraction — SUM-02 nano structured extractor", () => {
  it("output carries LEAF_FALLBACK_SUMMARY_MARKER prefix", () => {
    const messages = [
      makeMsg("user", "We decided to use TypeScript for the project."),
      makeMsg("assistant", "Agreed. Modified packages/core/src/index.ts to add types."),
      makeMsg("user", "We must always run tests before merging."),
    ];
    const result = buildNanoStructuredExtraction(messages, 500);
    expect(result.content).toContain(LEAF_FALLBACK_SUMMARY_MARKER);
  });

  it("output tokenCount is strictly less than chunkTokens (shrink invariant)", () => {
    // Create a realistically large chunk with meaningful content
    const messages = [
      makeMsg("user", "We decided to refactor the authentication module. Changed auth.ts and user.ts. The new approach uses JWT tokens with 30-minute expiry. Must never store passwords in plaintext. Entity: AuthManager. Agreed on this approach with the team."),
      makeMsg("assistant", "Updated packages/auth/src/auth.ts, packages/auth/src/user.ts. The AuthManager class now handles token rotation. Constraint: tokens must be verified on every request. Decision: use RS256 signing."),
      makeMsg("user", "We also need to update packages/auth/src/middleware.ts. The middleware must validate tokens before passing to handlers. EntityClass: TokenValidator. Decided to add rate limiting as well."),
    ];
    // Use a large chunkTokens value that the structured extraction should beat
    const chunkTokens = 800;
    const result = buildNanoStructuredExtraction(messages, chunkTokens);
    expect(result.tokenCount).toBeLessThan(chunkTokens);
  });

  it("fallback to bare count-note when structured JSON exceeds shrinkCeilingTokens", () => {
    // We need to test the fallback by using a VERY small chunk (so shrinkCeilingTokens is tiny)
    // A tiny chunk: 1 short message, chunkTokens = 5
    const messages = [
      makeMsg("user", "hi"),
    ];
    // chunkTokens=5 means shrinkCeilingTokens from computeShrinkBounds("hi" chars) will be tiny
    // The structured JSON output for any extraction will exceed this ceiling → fallback to count-note
    const result = buildNanoStructuredExtraction(messages, 5);
    // If the structured extraction exceeds shrinkCeilingTokens, falls back to count-note pattern
    // The fallback still carries LEAF_FALLBACK_SUMMARY_MARKER (part of the count-note pattern)
    expect(result.content).toContain(LEAF_FALLBACK_SUMMARY_MARKER);
    // The fallback should have a reasonable token count
    expect(result.tokenCount).toBeGreaterThan(0);
  });
});
