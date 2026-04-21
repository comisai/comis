// SPDX-License-Identifier: Apache-2.0
/**
 * InputSecurityGuard — Semantic jailbreak detection with weighted 0.0-1.0 threat scoring.
 *
 * Factory function that creates a guard object with a `scan()` method. Detects
 * jailbreak attempts using weighted compound phrase patterns imported from
 * `injection-patterns.ts`, typoglycemia detection for 8 key terms, and code
 * block exclusion to minimize false positives on technical content.
 *
 * Returns scored results that PiExecutor uses for policy decisions:
 * - low risk (< mediumThreshold) -> action "pass"
 * - medium risk (>= mediumThreshold, < highThreshold) -> action "reinforce"
 * - high risk (>= highThreshold) -> action "warn" (default) or "block" (config)
 *
 * @module input-security-guard
 */

import {
  IGNORE_PREV_INSTRUCTIONS,
  IGNORE_INSTRUCTIONS_BROAD,
  DISREGARD_PREVIOUS,
  DISREGARD_INSTRUCTIONS,
  FORGET_EVERYTHING,
  FORGET_INSTRUCTIONS_BROAD,
  YOU_ARE_NOW,
  YOU_ARE_NOW_ARTICLE,
  NEW_INSTRUCTIONS,
  NEW_INSTRUCTIONS_COLON,
  IMPORTANT_OVERRIDE,
  OVERRIDE_SAFETY,
  ACT_AS_ROLE,
  CONTEXT_RESET,
  RULE_REPLACEMENT,
  SYSTEM_TAG,
  SYSTEM_BRACKET,
  SYSTEM_COMMAND,
  SPECIAL_TOKEN_DELIMITERS,
  ROLE_BOUNDARY,
  ASSISTANT_ROLE_MARKER,
} from "./injection-patterns.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface InputSecurityGuardConfig {
  /** Threat score threshold for "medium" risk (triggers reinforcement). Default: 0.4. */
  readonly mediumThreshold: number;
  /** Threat score threshold for "high" risk (triggers warn/block). Default: 0.7. */
  readonly highThreshold: number;
  /** Action for high-risk detections. Default: "warn". "block" requires explicit config. */
  readonly action: "warn" | "block";
}

export interface InputSecurityGuardResult {
  /** Threat score clamped to 0.0-1.0. */
  readonly score: number;
  /** Risk level derived from score vs thresholds. */
  readonly riskLevel: "low" | "medium" | "high";
  /** Matched pattern category names. */
  readonly patterns: string[];
  /** Recommended policy action. */
  readonly action: "pass" | "warn" | "reinforce" | "block";
}

export interface InputSecurityGuard {
  scan(text: string): InputSecurityGuardResult;
}

// ---------------------------------------------------------------------------
// Weighted pattern categories
// ---------------------------------------------------------------------------

/**
 * Each category groups related regex patterns with a single weight.
 * If ANY pattern in a category matches, the weight is added once (boolean per category).
 * Multiple matches within the same category do NOT multiply the weight.
 */
const PATTERN_WEIGHTS: ReadonlyArray<{
  readonly patterns: readonly RegExp[];
  readonly weight: number;
  readonly name: string;
}> = [
  { patterns: [IGNORE_PREV_INSTRUCTIONS, IGNORE_INSTRUCTIONS_BROAD], weight: 0.6, name: "ignore_instructions" },
  { patterns: [DISREGARD_PREVIOUS, DISREGARD_INSTRUCTIONS], weight: 0.5, name: "disregard_previous" },
  { patterns: [FORGET_EVERYTHING, FORGET_INSTRUCTIONS_BROAD], weight: 0.5, name: "forget_instructions" },
  { patterns: [YOU_ARE_NOW, YOU_ARE_NOW_ARTICLE], weight: 0.4, name: "role_assumption" },
  { patterns: [NEW_INSTRUCTIONS, NEW_INSTRUCTIONS_COLON], weight: 0.5, name: "new_instructions" },
  { patterns: [IMPORTANT_OVERRIDE], weight: 0.5, name: "important_override" },
  { patterns: [OVERRIDE_SAFETY], weight: 0.6, name: "override_safety" },
  { patterns: [ACT_AS_ROLE], weight: 0.4, name: "act_as_role" },
  { patterns: [CONTEXT_RESET], weight: 0.4, name: "context_reset" },
  { patterns: [RULE_REPLACEMENT], weight: 0.4, name: "rule_replacement" },
  { patterns: [SYSTEM_TAG, SYSTEM_BRACKET, SYSTEM_COMMAND], weight: 0.3, name: "system_markers" },
  { patterns: [SPECIAL_TOKEN_DELIMITERS], weight: 0.3, name: "special_tokens" },
  { patterns: [ROLE_BOUNDARY, ASSISTANT_ROLE_MARKER], weight: 0.2, name: "role_markers" },
];

// ---------------------------------------------------------------------------
// Code block exclusion
// ---------------------------------------------------------------------------

/**
 * Regex to match fenced code blocks (triple backtick) and inline code (single backtick).
 * ReDoS-safe: [\s\S]*? is non-greedy character class without alternation.
 */
const CODE_BLOCK_REGEX = /```[\s\S]*?```|`[^`\n]+`/g;

function stripCodeBlocks(text: string): string {
  CODE_BLOCK_REGEX.lastIndex = 0;
  return text.replace(CODE_BLOCK_REGEX, " ");
}

// ---------------------------------------------------------------------------
// Typoglycemia detection
// ---------------------------------------------------------------------------

/**
 * The 8 key jailbreak terms to check for scrambled-middle variants.
 * All are 5+ characters long, ensuring sufficient middle-letter entropy
 * to avoid false positives on short words.
 */
const TYPOGLYCEMIA_TERMS = [
  "ignore",
  "previous",
  "instructions",
  "system",
  "bypass",
  "override",
  "forget",
  "delete",
] as const;

/**
 * Check whether a word is a typoglycemia variant of a target term.
 *
 * A word is a variant if:
 * 1. Same length as target
 * 2. Same first character (case-insensitive)
 * 3. Same last character (case-insensitive)
 * 4. NOT an exact match (exact matches are handled by regex patterns)
 * 5. Same sorted middle characters
 *
 * This implements the "Cambridge University effect" where human readers
 * can understand words with scrambled middle letters.
 */
function isTypoglycemiaVariant(word: string, target: string): boolean {
  if (word.length !== target.length) return false;
  const w = word.toLowerCase();
  const t = target.toLowerCase();
  if (w[0] !== t[0] || w[w.length - 1] !== t[t.length - 1]) return false;
  if (w === t) return false; // Exact match is NOT a variant
  const wMiddle = [...w.slice(1, -1)].sort().join("");
  const tMiddle = [...t.slice(1, -1)].sort().join("");
  return wMiddle === tMiddle;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create an InputSecurityGuard that scores user input text for jailbreak risk.
 *
 * Configuration is optional; all fields have sensible defaults:
 * - mediumThreshold: 0.4
 * - highThreshold: 0.7
 * - action: "warn" (operator must explicitly set "block" to enable blocking)
 */
export function createInputSecurityGuard(config?: Partial<InputSecurityGuardConfig>): InputSecurityGuard {
  const mediumThreshold = config?.mediumThreshold ?? 0.4;
  const highThreshold = config?.highThreshold ?? 0.7;
  const action = config?.action ?? "warn";

  return {
    scan(text: string): InputSecurityGuardResult {
      const stripped = stripCodeBlocks(text);
      const matched: string[] = [];
      let score = 0;

      // 1. Weighted pattern category matching
      for (const category of PATTERN_WEIGHTS) {
        let categoryMatched = false;
        for (const pattern of category.patterns) {
          // Reset lastIndex before each test() call (patterns have /g or /gi flags)
          pattern.lastIndex = 0;
          if (pattern.test(stripped)) {
            categoryMatched = true;
            break; // Category is boolean -- one match suffices
          }
        }
        if (categoryMatched) {
          score += category.weight;
          matched.push(category.name);
        }
      }

      // 2. Typoglycemia detection
      const words = stripped.split(/\s+/);
      for (const word of words) {
        if (word.length === 0) continue;
        for (const term of TYPOGLYCEMIA_TERMS) {
          if (isTypoglycemiaVariant(word, term)) {
            matched.push(`typoglycemia:${term}`);
            score += 0.3;
            break; // One word matches at most one term
          }
        }
      }

      // 3. Clamp score to [0.0, 1.0]
      score = Math.min(score, 1.0);

      // 4. Determine risk level
      const riskLevel: InputSecurityGuardResult["riskLevel"] =
        score >= highThreshold ? "high"
          : score >= mediumThreshold ? "medium"
            : "low";

      // 5. Determine action
      let resultAction: InputSecurityGuardResult["action"];
      if (riskLevel === "high") {
        resultAction = action === "block" ? "block" : "warn";
      } else if (riskLevel === "medium") {
        resultAction = "reinforce";
      } else {
        resultAction = "pass";
      }

      return { score, riskLevel, patterns: matched, action: resultAction };
    },
  };
}
