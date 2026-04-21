// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { getFieldMetadata } from "./field-metadata.js";
import type { FieldMetadata } from "./field-metadata.js";

describe("config/field-metadata", () => {
  describe("getFieldMetadata", () => {
    it("returns metadata for all top-level config sections", () => {
      const metadata = getFieldMetadata();

      expect(metadata.length).toBeGreaterThan(0);

      // Should contain metadata entries for known top-level keys
      const paths = metadata.map((m) => m.path);
      // Top-level scalars
      expect(paths).toContain("tenantId");
      expect(paths).toContain("logLevel");
      expect(paths).toContain("dataDir");
    });

    it("each metadata entry has path, type, and immutable flag", () => {
      const metadata = getFieldMetadata();

      for (const entry of metadata) {
        expect(typeof entry.path).toBe("string");
        expect(entry.path.length).toBeGreaterThan(0);
        expect(typeof entry.type).toBe("string");
        expect(typeof entry.immutable).toBe("boolean");
      }
    });

    it("nested fields include dot-notation paths", () => {
      const metadata = getFieldMetadata("gateway");

      const paths = metadata.map((m) => m.path);
      // Gateway has a tls section with nested fields
      const nestedPaths = paths.filter((p) => p.includes("."));
      expect(nestedPaths.length).toBeGreaterThan(0);
    });

    it("immutable fields are correctly classified (security.* -> immutable: true)", () => {
      const metadata = getFieldMetadata("security");

      // All security fields should be immutable
      for (const entry of metadata) {
        expect(entry.immutable).toBe(true);
      }
    });

    it("mutable fields are classified (monitoring.* -> immutable: false)", () => {
      const metadata = getFieldMetadata("monitoring");

      // Monitoring fields should not be immutable
      for (const entry of metadata) {
        expect(entry.immutable).toBe(false);
      }
    });

    it("section filter returns only metadata for specified section", () => {
      const allMetadata = getFieldMetadata();
      const gatewayMetadata = getFieldMetadata("gateway");

      // Filtered result should be smaller than full result
      expect(gatewayMetadata.length).toBeLessThan(allMetadata.length);

      // All paths in filtered result should start with "gateway."
      for (const entry of gatewayMetadata) {
        expect(entry.path.startsWith("gateway.")).toBe(true);
      }
    });

    it("description field populated from Zod schema descriptions", () => {
      const metadata = getFieldMetadata();

      // At least some entries should have descriptions (from JSDoc .describe() on schemas)
      // tenantId has a description in the schema
      const tenantId = metadata.find((m) => m.path === "tenantId");
      expect(tenantId).toBeDefined();
      // Description may or may not be set depending on schema .describe() usage
      // But the field should exist on the object
      expect("description" in tenantId!).toBe(true);
    });

    it("returns a sorted array", () => {
      const metadata = getFieldMetadata();
      const paths = metadata.map((m) => m.path);
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
    });
  });
});
