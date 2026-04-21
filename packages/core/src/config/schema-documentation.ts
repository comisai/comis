// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Custom documentation link entry.
 */
export const DocumentationLinkSchema = z.strictObject({
  /** Human-readable label for the link */
  label: z.string(),
  /** URL for the documentation resource */
  url: z.string(),
});

/**
 * Documentation configuration schema.
 *
 * Provides the agent with links to project documentation, source code,
 * and community resources. When enabled, these are injected into the
 * system prompt so the agent can reference and share them with users.
 */
export const DocumentationConfigSchema = z.strictObject({
  /** Whether documentation links are injected into the system prompt */
  enabled: z.boolean().default(false),
  /** Filesystem path to local documentation (for file-based lookup) */
  localDocsPath: z.string().default(""),
  /** Public documentation URL */
  publicDocsUrl: z.string().default(""),
  /** Source code repository URL */
  sourceUrl: z.string().default(""),
  /** Community or support URL */
  communityUrl: z.string().default(""),
  /** Skills marketplace URL for browsing and installing agent skills */
  skillsMarketplaceUrl: z.string().default(""),
  /** MCP server registry URL for browsing and installing MCP integrations */
  mcpRegistryUrl: z.string().default(""),
  /** Additional custom documentation links */
  customLinks: z.array(DocumentationLinkSchema).default([]),
});

export type DocumentationConfig = z.infer<typeof DocumentationConfigSchema>;
export type DocumentationLink = z.infer<typeof DocumentationLinkSchema>;
