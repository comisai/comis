// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { validateInput } from "./input-validator.js";
import type { InputValidationResult } from "./input-validator.js";

describe("validateInput", () => {
  // --- Null bytes ---

  describe("null byte detection", () => {
    it("detects embedded null bytes and returns sanitized copy without them", () => {
      const input = "hello\0world";
      const result: InputValidationResult = validateInput(input);

      expect(result.valid).toBe(false);
      expect(result.reasons).toContain("null_bytes_detected");
      expect(result.sanitized).toBe("helloworld");
    });

    it("removes all null bytes from sanitized copy when multiple present", () => {
      const input = "\0abc\0def\0";
      const result = validateInput(input);

      expect(result.valid).toBe(false);
      expect(result.reasons).toContain("null_bytes_detected");
      expect(result.sanitized).toBe("abcdef");
    });
  });

  // --- Length exceeded ---

  describe("length exceeded detection", () => {
    it("flags messages exceeding 100,000 characters", () => {
      const input = "a".repeat(100_001);
      const result = validateInput(input);

      expect(result.valid).toBe(false);
      expect(result.reasons).toContain("length_exceeded:100001");
    });

    it("allows messages of exactly 100,000 characters", () => {
      const input = "a".repeat(100_000);
      const result = validateInput(input);

      // Should not contain any length_exceeded reason
      const lengthReasons = result.reasons.filter((r) => r.startsWith("length_exceeded"));
      expect(lengthReasons).toHaveLength(0);
    });
  });

  // --- Whitespace ratio ---

  describe("whitespace ratio detection", () => {
    it("flags messages with whitespace ratio above 0.7", () => {
      // "a" + " ".repeat(10) = 11 chars, 10 whitespace = 90.9% whitespace
      const input = "a" + " ".repeat(10);
      const result = validateInput(input);

      expect(result.valid).toBe(false);
      const wsReason = result.reasons.find((r) => r.startsWith("whitespace_ratio:"));
      expect(wsReason).toBeDefined();
    });

    it("allows messages with exactly 70% whitespace (> not >=)", () => {
      // 3 non-whitespace + 7 whitespace = 10 chars, ratio = 0.70 exactly
      const input = "abc" + " ".repeat(7);
      const result = validateInput(input);

      const wsReasons = result.reasons.filter((r) => r.startsWith("whitespace_ratio:"));
      expect(wsReasons).toHaveLength(0);
    });

    it("handles empty string without division by zero", () => {
      const result = validateInput("");

      expect(result.valid).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });
  });

  // --- Consecutive character repetition ---

  describe("consecutive repetition detection", () => {
    it("flags 50 consecutive identical characters", () => {
      const input = "a".repeat(50);
      const result = validateInput(input);

      expect(result.valid).toBe(false);
      expect(result.reasons).toContain("excessive_repetition");
    });

    it("allows 49 consecutive identical characters", () => {
      const input = "a".repeat(49);
      const result = validateInput(input);

      const repReasons = result.reasons.filter((r) => r === "excessive_repetition");
      expect(repReasons).toHaveLength(0);
    });

    it("detects non-alpha character repetition", () => {
      const input = "!".repeat(50);
      const result = validateInput(input);

      expect(result.valid).toBe(false);
      expect(result.reasons).toContain("excessive_repetition");
    });
  });

  // --- Valid messages (false positive resistance) ---

  describe("valid messages (false positive resistance)", () => {
    it("accepts normal English text", () => {
      const input = "Hello, how are you doing today? I wanted to ask about the project status.";
      const result = validateInput(input);

      expect(result.valid).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it("accepts code snippet with mixed indentation", () => {
      const input = `function hello() {
  if (true) {
    console.log("hello");
  }
  return null;
}`;
      const result = validateInput(input);

      expect(result.valid).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it("accepts JSON payload with moderate whitespace", () => {
      const input = JSON.stringify({ name: "test", value: 42, nested: { key: "data" } }, null, 2);
      const result = validateInput(input);

      expect(result.valid).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });
  });

  // --- Multiple violations ---

  describe("multiple violations", () => {
    it("reports both null bytes AND excessive length", () => {
      const input = "\0" + "a".repeat(100_001);
      const result = validateInput(input);

      expect(result.valid).toBe(false);
      expect(result.reasons).toContain("null_bytes_detected");
      // Length is 100_002 (null byte + 100_001 a's)
      expect(result.reasons).toContain("length_exceeded:100002");
    });
  });

  // --- Sanitized field ---

  describe("sanitized field behavior", () => {
    it("removes null bytes from sanitized copy but preserves rest", () => {
      const input = "hel\0lo wo\0rld";
      const result = validateInput(input);

      expect(result.sanitized).toBe("hello world");
    });

    it("returns original text as sanitized for non-null-byte violations", () => {
      // Excessive whitespace but no null bytes -- sanitized should equal original
      const input = "a" + " ".repeat(20);
      const result = validateInput(input);

      expect(result.valid).toBe(false);
      expect(result.sanitized).toBe(input);
    });
  });
});
