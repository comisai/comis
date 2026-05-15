// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { validateIpAddress, validateBindMode } from "./network.js";

describe("validateIpAddress", () => {
  describe("valid addresses", () => {
    it("accepts standard private-network IPv4 address 192.168.1.1 as valid", () => {
      expect(validateIpAddress("192.168.1.1")).toBeUndefined();
    });

    it("accepts wildcard IPv4 address 0.0.0.0 as valid bind target", () => {
      expect(validateIpAddress("0.0.0.0")).toBeUndefined();
    });

    it("accepts 255.255.255.255", () => {
      expect(validateIpAddress("255.255.255.255")).toBeUndefined();
    });

    it("accepts loopback IPv4 address 127.0.0.1 as valid bind target", () => {
      expect(validateIpAddress("127.0.0.1")).toBeUndefined();
    });
  });

  describe("invalid addresses", () => {
    it("rejects IPv4 octet greater than 255 as out-of-range per RFC", () => {
      const result = validateIpAddress("256.1.1.1");
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid IPv4");
    });

    it("rejects too few octets", () => {
      const result = validateIpAddress("1.2.3");
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid IPv4");
    });

    it("rejects non-numeric IPv4 string as invalid per format contract", () => {
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
    it("accepts 'loopback' as a valid bind-mode literal value", () => {
      expect(validateBindMode("loopback")).toBeUndefined();
    });

    it("accepts 'lan' as a valid bind-mode literal value", () => {
      expect(validateBindMode("lan")).toBeUndefined();
    });

    it("accepts 'custom' as a valid bind-mode literal value", () => {
      expect(validateBindMode("custom")).toBeUndefined();
    });
  });

  describe("invalid modes", () => {
    it("rejects 'public' bind-mode value as invalid per bind-mode contract", () => {
      const result = validateBindMode("public");
      expect(result).toBeDefined();
      expect(result!.message).toContain("Invalid bind mode");
    });

    it("rejects 'external' bind-mode value as invalid per bind-mode contract", () => {
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
