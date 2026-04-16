import { describe, it, expect } from "vitest";
import { validatePartial } from "./partial-validator.js";

describe("config/partial-validator", () => {
  describe("validatePartial", () => {
    it("valid config returns all sections with no errors", () => {
      const raw = {
        tenantId: "my-tenant",
        logLevel: "info",
        dataDir: "/data",
        security: {},
        gateway: {},
      };

      const result = validatePartial(raw);

      expect(result.errors).toHaveLength(0);
      expect(result.validSections).toContain("tenantId");
      expect(result.validSections).toContain("logLevel");
      expect(result.validSections).toContain("dataDir");
      expect(result.validSections).toContain("security");
      expect(result.validSections).toContain("gateway");
      expect(result.config.tenantId).toBe("my-tenant");
      expect(result.config.logLevel).toBe("info");
      expect(result.config.dataDir).toBe("/data");
    });

    it("one invalid section returns error for that section, other sections are valid with defaults", () => {
      const raw = {
        tenantId: "my-tenant",
        logLevel: "info",
        // security expects an object, not a string
        security: "invalid-value",
        gateway: {},
      };

      const result = validatePartial(raw);

      // security should be in errors
      const securityError = result.errors.find((e) => e.section === "security");
      expect(securityError).toBeDefined();
      expect(securityError!.error.code).toBe("VALIDATION_ERROR");

      // Valid sections should still be present
      expect(result.validSections).toContain("tenantId");
      expect(result.validSections).toContain("logLevel");
      expect(result.validSections).toContain("gateway");
      expect(result.validSections).not.toContain("security");
      expect(result.config.tenantId).toBe("my-tenant");
    });

    it("multiple invalid sections return multiple errors, all valid sections preserved", () => {
      const raw = {
        tenantId: "my-tenant",
        security: "not-an-object",
        gateway: "also-not-an-object",
        memory: {},
      };

      const result = validatePartial(raw);

      expect(result.errors.length).toBeGreaterThanOrEqual(2);
      const errorSections = result.errors.map((e) => e.section);
      expect(errorSections).toContain("security");
      expect(errorSections).toContain("gateway");

      // Valid sections preserved
      expect(result.validSections).toContain("tenantId");
      expect(result.validSections).toContain("memory");
      expect(result.config.tenantId).toBe("my-tenant");
    });

    it("unknown top-level keys are ignored (not treated as errors)", () => {
      const raw = {
        tenantId: "my-tenant",
        unknownKey: "should-be-ignored",
        anotherUnknown: { nested: true },
      };

      const result = validatePartial(raw);

      // Unknown keys should not appear in errors
      const errorSections = result.errors.map((e) => e.section);
      expect(errorSections).not.toContain("unknownKey");
      expect(errorSections).not.toContain("anotherUnknown");

      // Valid sections should still work
      expect(result.validSections).toContain("tenantId");
    });

    it("scalar top-level fields (tenantId, logLevel, dataDir) are validated independently", () => {
      const raw = {
        tenantId: 12345, // Should be a string, not number
        logLevel: "invalid-level", // Not a valid enum value
        dataDir: "/data",
      };

      const result = validatePartial(raw);

      // dataDir should be valid
      expect(result.validSections).toContain("dataDir");
      expect(result.config.dataDir).toBe("/data");

      // tenantId and/or logLevel should have errors
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      const errorSections = result.errors.map((e) => e.section);
      // At least logLevel should fail (invalid enum)
      expect(errorSections).toContain("logLevel");
    });

    it("return type includes validSections, config, and errors arrays", () => {
      const result = validatePartial({});

      expect(Array.isArray(result.validSections)).toBe(true);
      expect(typeof result.config).toBe("object");
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });
});
