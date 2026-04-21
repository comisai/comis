// SPDX-License-Identifier: Apache-2.0
/**
 * Silent Execution Planner (SEP): Plan extraction from LLM responses.
 *
 * Extracts multi-step plan structures from the LLM's natural language
 * response using lightweight regex heuristics (no additional LLM call).
 * Supports numbered lists, markdown bullets, and sequential markers.
 *
 * @module
 */

import type { PlanStep } from "./types.js";

/**
 * Extract plan steps from the LLM's first assistant response.
 *
 * Looks for numbered lists, bullet points, or "First... Then... Finally..."
 * patterns. Returns undefined if no plan structure is detected (single-step task).
 *
 * Strategies are tried in priority order: numbered list > markdown bullets >
 * sequential markers. The first strategy that yields >= 2 matches wins.
 *
 * @param text - The LLM's assistant response text
 * @param maxSteps - Maximum number of steps to extract (prevents runaway extraction)
 * @returns Array of PlanStep objects, or undefined if no multi-step plan detected
 */
export function extractPlanFromResponse(text: string, maxSteps: number): PlanStep[] | undefined {
  if (!text || maxSteps < 2) return undefined;

  // Strategy 1: Numbered list ("1. Do X\n2. Do Y\n3. Do Z")
  const numberedMatches = text.match(/^\s*(\d+)[.)]\s+(.+)$/gm);
  if (numberedMatches && numberedMatches.length >= 2) {
    return numberedMatches.slice(0, maxSteps).map((line, i) => ({
      index: i + 1,
      description: line.replace(/^\s*\d+[.)]\s+/, "").trim(),
      status: "pending" as const,
    }));
  }

  // Strategy 2: Markdown bullets ("- Do X\n- Do Y")
  const bulletMatches = text.match(/^\s*[-*]\s+(.+)$/gm);
  if (bulletMatches && bulletMatches.length >= 2) {
    return bulletMatches.slice(0, maxSteps).map((line, i) => ({
      index: i + 1,
      description: line.replace(/^\s*[-*]\s+/, "").trim(),
      status: "pending" as const,
    }));
  }

  // Strategy 3: Sequential markers ("First, I'll do X. Then, I'll do Y. Finally, I'll do Z.")
  // Use a non-consuming boundary pattern to avoid consuming the period+space that
  // separates consecutive markers (e.g., "logs. Then," -- the period belongs to the
  // previous match but is also needed as the boundary for the next).
  const sequentialRegex = /\b(First|Then|Next|After that|Finally|Lastly),?\s+([^.!?]+[.!?]?)/gi;
  const seqMatches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = sequentialRegex.exec(text)) !== null) {
    const description = match[2]!.replace(/[.!?]+$/, "").trim();
    if (description.length > 0) {
      seqMatches.push(description);
    }
  }
  if (seqMatches.length >= 2) {
    return seqMatches.slice(0, maxSteps).map((desc, i) => ({
      index: i + 1,
      description: desc,
      status: "pending" as const,
    }));
  }

  return undefined; // Not a multi-step task
}
