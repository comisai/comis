// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { validatePort } from "./port.js";

describe("validatePort", () => {
  describe("valid ports", () => {
    it("accepts 1024 (minimum)", () => {
      expect(validatePort(1024)).toBeUndefined();
    });

    it("accepts 4766 (common)", () => {
      expect(validatePort(4766)).toBeUndefined();
    });

    it("accepts 65535 (maximum)", () => {
      expect(validatePort(65535)).toBeUndefined();
    });

    it("accepts string '4766'", () => {
      expect(validatePort("4766")).toBeUndefined();
    });
  });

  describe("below range", () => {
    it("rejects port 1023 as below valid range (must be in 1024-65535)", () => {
      const result = validatePort(1023);
      expect(result).toBeDefined();
      expect(result!.message).toContain("1024-65535");
    });

    it("rejects port 0 as below valid range (must be in 1024-65535)", () => {
      const result = validatePort(0);
      expect(result).toBeDefined();
      expect(result!.message).toContain("1024-65535");
    });

    it("rejects 80 (privileged port)", () => {
      const result = validatePort(80);
      expect(result).toBeDefined();
      expect(result!.message).toContain("1024-65535");
    });
  });

  describe("above range", () => {
    it("rejects port 65536 as above valid range (must be in 1024-65535)", () => {
      const result = validatePort(65536);
      expect(result).toBeDefined();
      expect(result!.message).toContain("1024-65535");
    });

    it("rejects port 99999 as above valid range (must be in 1024-65535)", () => {
      const result = validatePort(99999);
      expect(result).toBeDefined();
      expect(result!.message).toContain("1024-65535");
    });
  });

  describe("not a number", () => {
    it("rejects non-numeric port string 'abc' per number-format contract", () => {
      const result = validatePort("abc");
      expect(result).toBeDefined();
      expect(result!.message).toContain("must be a number");
    });

    it("rejects literal 'NaN' string as not a valid number per port-format contract", () => {
      const result = validatePort("NaN");
      expect(result).toBeDefined();
      expect(result!.message).toContain("must be a number");
    });
  });

  describe("float", () => {
    it("rejects fractional port 4766.5 as not a whole-number value per contract", () => {
      const result = validatePort(4766.5);
      expect(result).toBeDefined();
      expect(result!.message).toContain("whole number");
    });
  });

  describe("empty string", () => {
    it("rejects empty string", () => {
      const result = validatePort("");
      expect(result).toBeDefined();
      expect(result!.message).toContain("required");
    });
  });
});
