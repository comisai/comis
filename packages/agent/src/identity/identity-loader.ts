// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs/promises";
import { safePath, PathTraversalError } from "@comis/core";

/**
 * Loaded identity file contents. Each field is present only if
 * the corresponding file exists and was readable.
 *
 * Only AGENTS.md is loaded into the system prompt. SOUL.md, IDENTITY.md,
 * and USER.md are read by the agent via tools as instructed by AGENTS.md.
 */
export interface IdentityFiles {
  agents?: string; // AGENTS.md content (operating instructions)
}

/** Mapping from IdentityFiles key to the on-disk filename. */
const IDENTITY_FILE_MAP: ReadonlyArray<{
  key: keyof IdentityFiles;
  name: string;
}> = [
  { key: "agents", name: "AGENTS.md" },
] as const;

/**
 * Load AGENTS.md from the agent workspace directory.
 *
 * AGENTS.md is the agent's operating manual containing full instructions
 * for session startup, tool usage, and reading other workspace files
 * (SOUL.md, USER.md, etc.) via tools.
 *
 * - Uses `safePath` for each file to prevent path traversal
 * - Missing files are gracefully skipped (not errors)
 * - Path traversal attempts are silently skipped (not errors)
 *
 * @param workspaceDir - Absolute path to the agent workspace directory
 * @returns IdentityFiles with AGENTS.md content if present
 */
export async function loadIdentityFiles(
  workspaceDir: string,
): Promise<IdentityFiles> {
  const result: IdentityFiles = {};

  for (const { key, name } of IDENTITY_FILE_MAP) {
    let filePath: string;
    try {
      filePath = safePath(workspaceDir, name);
    } catch (error) {
      // Path traversal detected -- skip this file
      if (error instanceof PathTraversalError) {
        continue;
      }
      throw error;
    }

    try {
      result[key] = await fs.readFile(filePath, "utf-8");
    } catch {
      // File doesn't exist or not readable -- skip
    }
  }

  return result;
}

/**
 * Section definition for assembling the system prompt.
 * AGENTS.md content is injected directly without a wrapping heading
 * (it already has its own structure with headings).
 */
const SECTION_MAP: ReadonlyArray<{
  key: keyof IdentityFiles;
  heading: string | null;
}> = [
  { key: "agents", heading: null },
] as const;

/**
 * Assemble identity files into a structured system prompt.
 *
 * AGENTS.md content is injected directly (no wrapping heading) since it
 * already contains its own heading structure. Additional sections (e.g.,
 * memory context from RAG) are appended after the AGENTS.md content,
 * separated by horizontal rules.
 *
 * @param identity - Loaded identity files (AGENTS.md content)
 * @param additionalSections - Optional extra sections to append
 * @returns Assembled system prompt, or empty string if no identity files exist
 */
export function assembleSystemPrompt(
  identity: IdentityFiles,
  additionalSections?: string[],
): string {
  const sections: string[] = [];

  // Inject current date/time so the agent can schedule correctly
  const now = new Date();
  const isoTimestamp = now.toISOString();
  const localTime = now.toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  sections.push(
    `## Current Date & Time\n${isoTimestamp} (${localTime}, ${timezone})`,
  );

  for (const { key, heading } of SECTION_MAP) {
    const content = identity[key];
    if (content) {
      sections.push(heading ? `${heading}\n\n${content}` : content);
    }
  }

  if (additionalSections) {
    for (const section of additionalSections) {
      if (section) {
        sections.push(section);
      }
    }
  }

  return sections.join("\n\n---\n\n");
}
