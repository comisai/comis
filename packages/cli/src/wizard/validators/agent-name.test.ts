// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { validateAgentName } from "./agent-name.js";

describe("validateAgentName", () => {
  describe("valid names", () => {
    it("accepts lowercase with hyphen", () => {
      expect(validateAgentName("my-agent")).toBeUndefined();
    });

    it("accepts alphanumeric with digits", () => {
      expect(validateAgentName("agent01")).toBeUndefined();
    });

    it("accepts single letter", () => {
      expect(validateAgentName("A")).toBeUndefined();
    });

    it("accepts multiple hyphens", () => {
      expect(validateAgentName("a-b-c-d")).toBeUndefined();
    });

    it("accepts max length (64 chars)", () => {
      expect(validateAgentName("a".repeat(64))).toBeUndefined();
    });

    it("trims whitespace and validates trimmed value", () => {
      expect(validateAgentName("  my-agent  ")).toBeUndefined();
    });
  });

  describe("empty/whitespace", () => {
    it("rejects empty string", () => {
      const result = validateAgentName("");
      expect(result).toBeDefined();
      expect(result!.message).toContain("required");
    });

    it("rejects whitespace only", () => {
      const result = validateAgentName("  ");
      expect(result).toBeDefined();
      expect(result!.message).toContain("required");
    });
  });

  describe("too long", () => {
    it("rejects 65 characters", () => {
      const result = validateAgentName("a".repeat(65));
      expect(result).toBeDefined();
      expect(result!.message).toContain("at most 64");
    });
  });

  describe("invalid start character", () => {
    it("rejects starting with hyphen", () => {
      const result = validateAgentName("-agent");
      expect(result).toBeDefined();
      expect(result!.message).toContain("start with a letter or number");
    });

    it("rejects starting with @", () => {
      const result = validateAgentName("@agent");
      expect(result).toBeDefined();
      expect(result!.message).toContain("start with a letter or number");
    });

    it("rejects starting with space (after trim makes it valid if rest is ok)", () => {
      // " agent" after trim is "agent" which is valid
      // but "@agent" is invalid
      const result = validateAgentName("@agent");
      expect(result).toBeDefined();
    });
  });

  describe("invalid characters", () => {
    it("rejects spaces in name", () => {
      const result = validateAgentName("my agent");
      expect(result).toBeDefined();
      expect(result!.message).toContain("letters, numbers, and hyphens");
    });

    it("rejects underscores", () => {
      const result = validateAgentName("my_agent");
      expect(result).toBeDefined();
      expect(result!.message).toContain("letters, numbers, and hyphens");
    });

    it("rejects dots", () => {
      const result = validateAgentName("my.agent");
      expect(result).toBeDefined();
      expect(result!.message).toContain("letters, numbers, and hyphens");
    });
  });

  describe("trailing hyphen", () => {
    it("rejects trailing hyphen", () => {
      const result = validateAgentName("agent-");
      expect(result).toBeDefined();
      expect(result!.message).toContain("must not end with a hyphen");
    });
  });
});
