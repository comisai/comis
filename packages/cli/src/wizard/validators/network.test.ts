// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { validateIpAddress, validateBindMode } from "./network.js";

describe("validateIpAddress", () => {
  describe("valid addresses", () => {
    it("accepts 192.168.1.1", () => {
      expect(validateIpAddress("192.168.1.1")).toBeUndefined();
    });

    it("accepts 0.0.0.0", () => {
      expect(validateIpAddress("0.0.0.0")).toBeUndefined();
    });

    it("accepts 255.255.255.255", () => {
      expect(validateIpAddress("255.255.255.255")).toBeUndefined();
    });

    it("accepts 127.0.0.1", () => {
      expect(validateIpAddress("127.0.0.1")).toBeUndefined();
    });
  });

  describe("invalid addresses", () => {
    it("rejects octet > 255", () => {
      const result = validateIpAddress("256.1.1.1");
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid IPv4");
    });

    it("rejects too few octets", () => {
      const result = validateIpAddress("1.2.3");
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid IPv4");
    });

    it("rejects non-numeric", () => {
      const result = validateIpAddress("abc");
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid IPv4");
    });

    it("rejects empty string", () => {
      const result = validateIpAddress("");
      expect(result).toBeDefined();
      expect(result!.message).toContain("required");
    });

    it("rejects whitespace only", () => {
      const result = validateIpAddress("  ");
      expect(result).toBeDefined();
      expect(result!.message).toContain("required");
    });
  });
});

describe("validateBindMode", () => {
  describe("valid modes", () => {
    it("accepts loopback", () => {
      expect(validateBindMode("loopback")).toBeUndefined();
    });

    it("accepts lan", () => {
      expect(validateBindMode("lan")).toBeUndefined();
    });

    it("accepts custom", () => {
      expect(validateBindMode("custom")).toBeUndefined();
    });
  });

  describe("invalid modes", () => {
    it("rejects 'public'", () => {
      const result = validateBindMode("public");
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid bind mode");
    });

    it("rejects 'external'", () => {
      const result = validateBindMode("external");
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid bind mode");
    });

    it("rejects empty string", () => {
      const result = validateBindMode("");
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid bind mode");
    });
  });
});
