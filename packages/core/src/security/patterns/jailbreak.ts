/**
 * Jailbreak phrase detection patterns.
 *
 * Covers both narrow tool-sanitizer patterns and broad external-content variants,
 * plus expanded patterns for role escalation, token delimiters,
 * context resets, rule replacement, and safety overrides.
 *
 * @module jailbreak
 */

/** Exact tool-sanitizer.ts original: ignore (all) previous instructions (no optional quantifier group for ReDoS safety) */
export const IGNORE_PREV_INSTRUCTIONS = /ignore\s{1,20}(?:all )?previous\s{1,10}instructions/gi;

/** Exact tool-sanitizer.ts original: you are now */
export const YOU_ARE_NOW = /you\s+are\s+now\s+/gi;

/** Exact tool-sanitizer.ts original: forget (everything|all|your) */
export const FORGET_EVERYTHING = /forget\s+(everything|all|your)\s/gi;

/** Exact tool-sanitizer.ts original: new instructions: */
export const NEW_INSTRUCTIONS = /new\s+instructions?\s*:/gi;

/** Exact tool-sanitizer.ts original: IMPORTANT: override */
export const IMPORTANT_OVERRIDE = /IMPORTANT\s*:\s*override/gi;

/** Broader external-content.ts variant: ignore (previous|prior|above) (instructions|prompts) (no optional quantifier group for ReDoS safety) */
export const IGNORE_INSTRUCTIONS_BROAD = /ignore\s{1,20}(?:all )?(previous|prior|above)\s{1,10}(instructions?|prompts?)/gi;

/** Broader external-content.ts variant: disregard (previous|prior|above) (no optional quantifier group for ReDoS safety) */
export const DISREGARD_PREVIOUS = /disregard\s{1,20}(?:all )?(previous|prior|above)/gi;

/** Broader external-content.ts variant: forget (everything|all|your) (instructions|rules|guidelines) */
export const FORGET_INSTRUCTIONS_BROAD = /forget\s+(everything|all|your)\s+(instructions?|rules?|guidelines?)/gi;

/** Broader external-content.ts variant: you are now (a|an) */
export const YOU_ARE_NOW_ARTICLE = /you\s+are\s+now\s+(a|an)\s+/gi;

/** Broader external-content.ts variant: new instructions: */
export const NEW_INSTRUCTIONS_COLON = /new\s+instructions?:/gi;

// ---------------------------------------------------------------------------
// Expanded Jailbreak Patterns
// ---------------------------------------------------------------------------

/** "disregard (all) (previous|prior|above) instructions" -- narrower than DISREGARD_PREVIOUS */
export const DISREGARD_INSTRUCTIONS = /disregard\s{1,20}(?:all )?(?:previous|prior|above)\s{1,10}instructions?/gi;

/** "act as root/admin/sudo/superuser/system" role escalation */
export const ACT_AS_ROLE = /\bact\s{1,10}as\s{1,10}(?:root|admin|sudo|superuser|system)\b/gi;

/** Role boundary markers: "assistant:" or "user:" */
export const ASSISTANT_ROLE_MARKER = /\b(?:assistant|user)\s*:/gi;

/** Special token delimiters: <|im_start|>, <|endoftext|>, etc. */
export const SPECIAL_TOKEN_DELIMITERS = /<\|[^|]{1,30}\|>/g;

/** Context reset: "context/conversation reset/cleared/restart" */
export const CONTEXT_RESET = /(?:context|conversation)\s{1,10}(?:reset|cleared?|restart)/gi;

/** Rule replacement: "new/updated/revised rules/guidelines/policies:" */
export const RULE_REPLACEMENT = /(?:new|updated?|revised?)\s{1,10}(?:rules?|guidelines?|policies?)\s*:/gi;

/** Safety override: "override/bypass/disable safety/security/filters/restrictions" */
export const OVERRIDE_SAFETY = /(?:override|bypass|disable)\s{1,10}(?:safety|security|filters?|restrictions?)/gi;

/** All jailbreak patterns (both narrow tool-sanitizer and broad external-content variants). */
export const JAILBREAK_PATTERNS: readonly RegExp[] = [
  IGNORE_PREV_INSTRUCTIONS,
  YOU_ARE_NOW,
  FORGET_EVERYTHING,
  NEW_INSTRUCTIONS,
  IMPORTANT_OVERRIDE,
  IGNORE_INSTRUCTIONS_BROAD,
  DISREGARD_PREVIOUS,
  FORGET_INSTRUCTIONS_BROAD,
  YOU_ARE_NOW_ARTICLE,
  NEW_INSTRUCTIONS_COLON,
  DISREGARD_INSTRUCTIONS,
  ACT_AS_ROLE,
  ASSISTANT_ROLE_MARKER,
  SPECIAL_TOKEN_DELIMITERS,
  CONTEXT_RESET,
  RULE_REPLACEMENT,
  OVERRIDE_SAFETY,
];
