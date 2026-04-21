// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { DocumentationConfigSchema } from "@comis/core";
import { buildDocumentationSection } from "./docs-sections.js";

/** Helper to create a config with overrides on top of schema defaults. */
function makeConfig(overrides: Record<string, unknown> = {}) {
  return DocumentationConfigSchema.parse({ enabled: true, ...overrides });
}

describe("buildDocumentationSection", () => {
  it("returns empty when enabled is false", () => {
    const config = DocumentationConfigSchema.parse({ enabled: false, publicDocsUrl: "https://docs.example.com" });
    expect(buildDocumentationSection(config, [], false)).toEqual([]);
  });

  it("returns empty when enabled but no URLs configured (all defaults)", () => {
    const config = DocumentationConfigSchema.parse({ enabled: true });
    expect(buildDocumentationSection(config, [], false)).toEqual([]);
  });

  it("renders localDocsPath with code formatting", () => {
    const config = makeConfig({ localDocsPath: "/opt/docs" });
    const result = buildDocumentationSection(config, [], false);
    expect(result).toContain("- Local docs: `/opt/docs`");
  });

  it("includes read tool guidance when toolNames includes 'read' and localDocsPath is set", () => {
    const config = makeConfig({ localDocsPath: "/opt/docs" });
    const result = buildDocumentationSection(config, ["read"], false);
    expect(result).toContain("  Use the `read` tool to browse local documentation files.");
  });

  it("does NOT include read tool guidance when 'read' not in toolNames", () => {
    const config = makeConfig({ localDocsPath: "/opt/docs" });
    const result = buildDocumentationSection(config, ["write"], false);
    expect(result).not.toContain("read");
  });

  it("renders all URL types", () => {
    const config = makeConfig({
      publicDocsUrl: "https://docs.example.com",
      sourceUrl: "https://github.com/org/repo",
      communityUrl: "https://discord.gg/invite",
      skillsMarketplaceUrl: "https://skills.example.com",
      mcpRegistryUrl: "https://mcp.example.com/registry",
    });
    const result = buildDocumentationSection(config, [], false);
    expect(result).toContain("- Public docs: https://docs.example.com");
    expect(result).toContain("- Source code: https://github.com/org/repo");
    expect(result).toContain("- Community: https://discord.gg/invite");
    expect(result).toContain("- Skills marketplace: https://skills.example.com");
    expect(result).toContain("- MCP registry: https://mcp.example.com/registry");
  });

  it("renders custom links with label and URL", () => {
    const config = makeConfig({
      customLinks: [
        { label: "API Reference", url: "https://api.example.com/docs" },
        { label: "Changelog", url: "https://example.com/changelog" },
      ],
    });
    const result = buildDocumentationSection(config, [], false);
    expect(result).toContain("- API Reference: https://api.example.com/docs");
    expect(result).toContain("- Changelog: https://example.com/changelog");
  });

  it("includes gateway tool guidance when 'gateway' in toolNames", () => {
    const config = makeConfig({ publicDocsUrl: "https://docs.example.com" });
    const result = buildDocumentationSection(config, ["gateway"], false);
    expect(result).toContain("Use the `gateway` tool to check system status, read live config, and run diagnostics.");
  });

  it("includes web_fetch guidance when 'web_fetch' in toolNames and URLs exist", () => {
    const config = makeConfig({ publicDocsUrl: "https://docs.example.com" });
    const result = buildDocumentationSection(config, ["web_fetch"], false);
    expect(result).toContain("Use the `web_fetch` tool to retrieve documentation content from the URLs above when users need specific information.");
  });

  it("does NOT include gateway/web_fetch guidance when tools absent", () => {
    const config = makeConfig({ publicDocsUrl: "https://docs.example.com" });
    const result = buildDocumentationSection(config, [], false);
    const joined = result.join("\n");
    expect(joined).not.toContain("gateway");
    expect(joined).not.toContain("web_fetch");
  });

  it("is NOT gated on isMinimal (returns content when isMinimal=true)", () => {
    const config = makeConfig({ publicDocsUrl: "https://docs.example.com" });
    const result = buildDocumentationSection(config, [], true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toBe("## Documentation & Resources");
  });

  it("partial configuration: only configured URLs appear", () => {
    const config = makeConfig({ publicDocsUrl: "https://docs.example.com" });
    const result = buildDocumentationSection(config, [], false);
    expect(result).toContain("- Public docs: https://docs.example.com");
    const joined = result.join("\n");
    expect(joined).not.toContain("Local docs");
    expect(joined).not.toContain("Source code");
    expect(joined).not.toContain("Community");
    expect(joined).not.toContain("Skills marketplace");
    expect(joined).not.toContain("MCP registry");
  });

  it("renders mcpRegistryUrl when configured", () => {
    const config = makeConfig({ mcpRegistryUrl: "https://mcp.example.com/registry" });
    const result = buildDocumentationSection(config, [], false);
    expect(result).toContain("- MCP registry: https://mcp.example.com/registry");
  });

  it("includes mcp_connect tool guidance when tool available and mcpRegistryUrl set", () => {
    const config = makeConfig({ mcpRegistryUrl: "https://mcp.example.com/registry" });
    const result = buildDocumentationSection(config, ["mcp_connect"], false);
    expect(result).toContain("  Use the `mcp_connect` tool to connect to MCP servers listed in the registry.");
  });

  it("does NOT include mcp_connect guidance when tool absent", () => {
    const config = makeConfig({ mcpRegistryUrl: "https://mcp.example.com/registry" });
    const result = buildDocumentationSection(config, [], false);
    const joined = result.join("\n");
    expect(joined).not.toContain("mcp_connect");
  });

  it("starts with correct heading", () => {
    const config = makeConfig({ sourceUrl: "https://github.com/org/repo" });
    const result = buildDocumentationSection(config, [], false);
    expect(result[0]).toBe("## Documentation & Resources");
    expect(result[1]).toBe("");
  });
});
