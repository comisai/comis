// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { buildPromptingSnapshot } from "./pi-executor-prompting.js";

// ---------------------------------------------------------------------------
// Unit tests for buildPromptingSnapshot (WR-02, Plan 05-04)
// ---------------------------------------------------------------------------

describe("buildPromptingSnapshot", () => {
  describe("empty input", () => {
    it("returns empty object when no fields provided", () => {
      const result = buildPromptingSnapshot({});
      expect(result).toEqual({});
    });
  });

  describe("non-PII envelope fields", () => {
    it("passes systemPromptDigest through unchanged", () => {
      const result = buildPromptingSnapshot({ systemPromptDigest: "sha256:abc" });
      expect(result.systemPromptDigest).toBe("sha256:abc");
      expect(result.userPromptPrefixText).toBeUndefined();
    });

    it("passes systemPromptByteLen through unchanged", () => {
      const result = buildPromptingSnapshot({ systemPromptByteLen: 1234 });
      expect(result.systemPromptByteLen).toBe(1234);
      expect(result.userPromptPrefixText).toBeUndefined();
    });

    it("preserves both byteLen and digest together", () => {
      const result = buildPromptingSnapshot({
        systemPromptDigest: "sha256:abc",
        systemPromptByteLen: 5678,
      });
      expect(result.systemPromptDigest).toBe("sha256:abc");
      expect(result.systemPromptByteLen).toBe(5678);
    });
  });

  describe("userPromptPrefixText redaction", () => {
    it("redacts long decimal IDs from userPromptPrefixText", () => {
      // 123456789012 is 12 digits — matches long-decimal-id pattern (≥9 digits).
      const result = buildPromptingSnapshot({
        userPromptPrefixText: "User connected 123456789012 now",
      });
      expect(result.userPromptPrefixText).toBeDefined();
      expect(result.userPromptPrefixText).toContain("<REDACTED:");
      expect(result.userPromptPrefixText).not.toContain("123456789012");
    });

    it("returns unchanged text when no PII matches", () => {
      const result = buildPromptingSnapshot({
        userPromptPrefixText: "Hello there",
      });
      expect(result.userPromptPrefixText).toBe("Hello there");
    });

    it("substitutes $HOME in userPromptPrefixText when homeDir is provided", () => {
      const result = buildPromptingSnapshot({
        userPromptPrefixText: "Read /Users/alice/foo first",
        pathOpts: { homeDir: "/Users/alice" },
      });
      expect(result.userPromptPrefixText).toContain("$HOME/foo");
      expect(result.userPromptPrefixText).not.toContain("/Users/alice/foo");
    });

    it("substitutes $WORKSPACE_DIR before $HOME (longest-first precedence)", () => {
      const result = buildPromptingSnapshot({
        userPromptPrefixText: "See /Users/alice/.comis/workspace/project",
        pathOpts: { homeDir: "/Users/alice", workspaceDir: "/Users/alice/.comis/workspace" },
      });
      expect(result.userPromptPrefixText).toContain("$WORKSPACE_DIR/project");
      expect(result.userPromptPrefixText).not.toContain("/Users/alice/.comis/workspace");
    });

    it("omits userPromptPrefixText from result when not provided", () => {
      const result = buildPromptingSnapshot({ systemPromptByteLen: 42 });
      expect(Object.prototype.hasOwnProperty.call(result, "userPromptPrefixText")).toBe(false);
    });
  });
});
