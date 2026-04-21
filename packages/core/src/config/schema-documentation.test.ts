// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { DocumentationConfigSchema } from "./schema-documentation.js";

describe("DocumentationConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = DocumentationConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.localDocsPath).toBe("");
      expect(result.data.publicDocsUrl).toBe("");
      expect(result.data.sourceUrl).toBe("");
      expect(result.data.communityUrl).toBe("");
      expect(result.data.skillsMarketplaceUrl).toBe("");
      expect(result.data.mcpRegistryUrl).toBe("");
      expect(result.data.customLinks).toEqual([]);
    }
  });

  it("accepts fully specified config", () => {
    const result = DocumentationConfigSchema.safeParse({
      enabled: true,
      localDocsPath: "/opt/docs",
      publicDocsUrl: "https://docs.example.com",
      sourceUrl: "https://github.com/org/repo",
      communityUrl: "https://discord.gg/invite",
      skillsMarketplaceUrl: "https://skills.example.com",
      mcpRegistryUrl: "https://mcp.example.com/registry",
      customLinks: [
        { label: "API Reference", url: "https://api.example.com/docs" },
        { label: "Changelog", url: "https://example.com/changelog" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.localDocsPath).toBe("/opt/docs");
      expect(result.data.skillsMarketplaceUrl).toBe("https://skills.example.com");
      expect(result.data.mcpRegistryUrl).toBe("https://mcp.example.com/registry");
      expect(result.data.customLinks).toHaveLength(2);
      expect(result.data.customLinks[0]?.label).toBe("API Reference");
    }
  });

  it("rejects unknown keys (strictObject)", () => {
    const result = DocumentationConfigSchema.safeParse({
      enabled: true,
      unknownField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys in customLinks entries (strictObject)", () => {
    const result = DocumentationConfigSchema.safeParse({
      customLinks: [
        { label: "API", url: "https://api.example.com", icon: "book" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects customLinks entry missing required label", () => {
    const result = DocumentationConfigSchema.safeParse({
      customLinks: [{ url: "https://example.com" }],
    });
    expect(result.success).toBe(false);
  });
});
