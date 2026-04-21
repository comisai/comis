// SPDX-License-Identifier: Apache-2.0
/**
 * Documentation & help links section builder.
 *
 * Renders a "Documentation & Resources" prompt section with configurable
 * links and tool-aware guidance. NOT gated on isMinimal --
 * sub-agents need documentation too.
 *
 * @module
 */

import type { DocumentationConfig } from "@comis/core";

/**
 * Build the Documentation & Resources section for the system prompt.
 *
 * @param config - Documentation configuration from AppConfig.documentation
 * @param toolNames - Available tool names for tool-aware guidance
 * @param _isMinimal - Accepted for interface consistency but NOT used
 * @returns Lines of the section, or empty array when disabled or no URLs configured
 */
export function buildDocumentationSection(
  config: DocumentationConfig,
  toolNames: string[],
  _isMinimal: boolean,
): string[] {
  // Section only appears when enabled
  if (!config.enabled) return [];

  // Check if any URLs are actually configured
  const hasAnyUrl =
    config.localDocsPath !== "" ||
    config.publicDocsUrl !== "" ||
    config.sourceUrl !== "" ||
    config.communityUrl !== "" ||
    config.skillsMarketplaceUrl !== "" ||
    config.mcpRegistryUrl !== "" ||
    config.customLinks.length > 0;

  if (!hasAnyUrl) return [];

  const lines: string[] = ["## Documentation & Resources", ""];

  // Render configured URLs
  if (config.localDocsPath) {
    lines.push(`- Local docs: \`${config.localDocsPath}\``);
    // Tool-aware read guidance
    if (toolNames.includes("read")) {
      lines.push("  Use the `read` tool to browse local documentation files.");
    }
  }

  if (config.publicDocsUrl) {
    lines.push(`- Public docs: ${config.publicDocsUrl}`);
  }

  if (config.sourceUrl) {
    lines.push(`- Source code: ${config.sourceUrl}`);
  }

  if (config.communityUrl) {
    lines.push(`- Community: ${config.communityUrl}`);
  }

  if (config.skillsMarketplaceUrl) {
    lines.push(`- Skills marketplace: ${config.skillsMarketplaceUrl}`);
  }

  if (config.mcpRegistryUrl) {
    lines.push(`- MCP registry: ${config.mcpRegistryUrl}`);
    // MCP-specific tool guidance
    if (toolNames.includes("mcp_connect")) {
      lines.push("  Use the `mcp_connect` tool to connect to MCP servers listed in the registry.");
    }
  }

  // Custom links
  for (const link of config.customLinks) {
    lines.push(`- ${link.label}: ${link.url}`);
  }

  // Tool-aware guidance sections
  if (toolNames.includes("gateway")) {
    lines.push("");
    lines.push("Use the `gateway` tool to check system status, read live config, and run diagnostics.");
  }

  if (toolNames.includes("web_fetch") && hasAnyUrl) {
    lines.push("");
    lines.push("Use the `web_fetch` tool to retrieve documentation content from the URLs above when users need specific information.");
  }

  return lines;
}
