/**
 * Markdown section extraction utility.
 *
 * Extracts named H2/H3 sections from markdown content while
 * respecting fenced code blocks. Used by post-compaction recovery
 * to re-inject critical AGENTS.md sections into the system prompt.
 *
 * @module
 */

/**
 * Maximum characters for combined extracted sections.
 * Prevents large user-customized AGENTS.md sections from
 * inflating the system prompt beyond a reasonable budget.
 */
export const MAX_POST_COMPACTION_CHARS = 3000;

/**
 * Extract named markdown sections from content.
 *
 * Matches H2 (`##`) and H3 (`###`) headings case-insensitively.
 * Headings inside fenced code blocks (`` ``` ``) are ignored.
 * A section extends from its heading to the next heading of
 * equal or higher level, or end of content.
 *
 * @param content - Markdown content to extract from
 * @param sectionNames - Section heading names to match (case-insensitive)
 * @returns Array of matched section strings (heading + body), trimEnd-ed
 */
export function extractMarkdownSections(
  content: string,
  sectionNames: string[],
): string[] {
  if (!content || sectionNames.length === 0) return [];

  const lowerNames = new Set(sectionNames.map((n) => n.toLowerCase()));
  const lines = content.split("\n");
  const results: string[] = [];
  let inFence = false;
  let currentSection: string[] | null = null;
  let currentLevel = 0;

  for (const line of lines) {
    // Track fenced code blocks (including indented fences)
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
    }

    if (!inFence) {
      const headingMatch = /^(#{2,3})\s+(.+)/.exec(line);
      if (headingMatch) {
        const level = headingMatch[1]!.length; // 2 or 3
        const title = headingMatch[2]!.trim();

        // Close current section if heading is same or higher level
        if (currentSection !== null && level <= currentLevel) {
          results.push(currentSection.join("\n").trimEnd());
          currentSection = null;
        }

        // Start new section if title matches
        if (lowerNames.has(title.toLowerCase())) {
          currentSection = [line];
          currentLevel = level;
          continue;
        }
      }
    }

    if (currentSection !== null) {
      currentSection.push(line);
    }
  }

  // Flush last section
  if (currentSection !== null) {
    results.push(currentSection.join("\n").trimEnd());
  }

  return results;
}
