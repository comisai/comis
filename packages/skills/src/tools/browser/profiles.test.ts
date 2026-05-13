// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  validateProfileName,
  allocateCdpPort,
  getProfileColor,
  PROFILE_COLORS,
  PROFILE_NAME_PATTERN,
} from "./profiles.js";

describe("profiles", () => {
  describe("PROFILE_COLORS", () => {
    it("has 10 entries", () => {
      expect(PROFILE_COLORS).toHaveLength(10);
    });

    it("all entries are hex color strings", () => {
      for (const color of PROFILE_COLORS) {
        expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    });
  });

  describe("PROFILE_NAME_PATTERN", () => {
    it("matches valid names", () => {
      expect(PROFILE_NAME_PATTERN.test("my-profile")).toBe(true);
      expect(PROFILE_NAME_PATTERN.test("test123")).toBe(true);
      expect(PROFILE_NAME_PATTERN.test("ab")).toBe(true);
      expect(PROFILE_NAME_PATTERN.test("a0")).toBe(true);
    });

    it("rejects invalid names", () => {
      expect(PROFILE_NAME_PATTERN.test("")).toBe(false);
      expect(PROFILE_NAME_PATTERN.test("a")).toBe(false); // Too short
      expect(PROFILE_NAME_PATTERN.test("A-B")).toBe(false); // Uppercase
      expect(PROFILE_NAME_PATTERN.test("-start")).toBe(false); // Leading hyphen
      expect(PROFILE_NAME_PATTERN.test("end-")).toBe(false); // Trailing hyphen
      expect(PROFILE_NAME_PATTERN.test("with spaces")).toBe(false);
      expect(PROFILE_NAME_PATTERN.test("with!special")).toBe(false);
    });
  });

  describe("validateProfileName", () => {
    it("accepts valid profile names", () => {
      const r1 = validateProfileName("my-profile");
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.value).toBe("my-profile");

      const r2 = validateProfileName("test123");
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.value).toBe("test123");

      const r3 = validateProfileName("ab");
      expect(r3.ok).toBe(true);
      if (r3.ok) expect(r3.value).toBe("ab");
    });

    it("rejects empty string", () => {
      const result = validateProfileName("");
      expect(result.ok).toBe(false);
    });

    it("rejects uppercase names", () => {
      const result = validateProfileName("A-B");
      expect(result.ok).toBe(false);
    });

    it("rejects leading hyphen", () => {
      const result = validateProfileName("-start");
      expect(result.ok).toBe(false);
    });

    it("rejects trailing hyphen", () => {
      const result = validateProfileName("end-");
      expect(result.ok).toBe(false);
    });

    it("rejects single character", () => {
      const result = validateProfileName("a");
      expect(result.ok).toBe(false);
    });

    it("rejects names with spaces", () => {
      const result = validateProfileName("with spaces");
      expect(result.ok).toBe(false);
    });

    it("rejects names with special characters", () => {
      const result = validateProfileName("with!special");
      expect(result.ok).toBe(false);
    });

    it("trims whitespace before validation", () => {
      const result = validateProfileName("  my-profile  ");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("my-profile");
    });
  });

  describe("allocateCdpPort", () => {
    it("returns baseCdpPort + index", () => {
      expect(allocateCdpPort(18800, 0)).toBe(18800);
      expect(allocateCdpPort(18800, 1)).toBe(18801);
      expect(allocateCdpPort(18800, 5)).toBe(18805);
    });

    it("throws when result exceeds 65535", () => {
      expect(() => allocateCdpPort(65535, 1)).toThrow("out of range");
    });

    it("throws when result is below 1", () => {
      expect(() => allocateCdpPort(0, 0)).toThrow("out of range");
    });
  });

  describe("getProfileColor", () => {
    it("returns color at index", () => {
      expect(getProfileColor(0)).toBe(PROFILE_COLORS[0]);
      expect(getProfileColor(3)).toBe(PROFILE_COLORS[3]);
    });

    it("cycles through palette for indices beyond length", () => {
      expect(getProfileColor(10)).toBe(PROFILE_COLORS[0]);
      expect(getProfileColor(11)).toBe(PROFILE_COLORS[1]);
      expect(getProfileColor(23)).toBe(PROFILE_COLORS[3]);
    });
  });
});
