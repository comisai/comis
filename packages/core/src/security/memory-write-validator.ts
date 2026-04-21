// SPDX-License-Identifier: Apache-2.0
/**
 * MemoryWriteValidator -- pre-storage security scan for memory content.
 *
 * Prevents memory poisoning attacks where adversaries store prompt injection
 * payloads in agent memory for later retrieval and execution via RAG.
 *
 * Classification:
 *   - CLEAN: No suspicious patterns detected, content stored normally
 *   - WARN: Jailbreak/role patterns detected, trust downgraded to "external"
 *   - CRITICAL: Dangerous command patterns detected, storage blocked entirely
 *
 * Pure function with no side effects -- caller handles logging and events.
 *
 * @module memory-write-validator
 */

import { detectSuspiciousPatterns } from "./external-content.js";
import { DANGEROUS_COMMAND_PATTERNS } from "./injection-patterns.js";

/**
 * Result of memory write validation.
 *
 * - `severity`: classification level determining storage behavior
 * - `patterns`: all matched suspicious pattern sources
 * - `criticalPatterns`: subset of patterns matching dangerous commands
 */
export interface MemoryWriteValidationResult {
  readonly severity: "clean" | "warn" | "critical";
  readonly patterns: string[];
  readonly criticalPatterns: string[];
}

/**
 * Module-level constant: Set of regex source strings for CRITICAL classification.
 * These are execution-oriented patterns dangerous when stored in memory for later
 * RAG retrieval: EXEC_COMMAND, ELEVATED_TRUE, RM_RF, DELETE_ALL.
 */
const CRITICAL_PATTERN_SOURCES: ReadonlySet<string> = new Set(
  DANGEROUS_COMMAND_PATTERNS.map((p) => p.source),
);

/**
 * Validates memory content before storage, classifying suspicious patterns
 * as WARN (trust downgrade) or CRITICAL (block storage).
 *
 * @param content - The memory content string to validate
 * @returns Validation result with severity classification and matched patterns
 */
export function validateMemoryWrite(content: string): MemoryWriteValidationResult {
  const patterns = detectSuspiciousPatterns(content);

  if (patterns.length === 0) {
    return { severity: "clean", patterns: [], criticalPatterns: [] };
  }

  const criticalPatterns = patterns.filter((p) => CRITICAL_PATTERN_SOURCES.has(p));

  if (criticalPatterns.length > 0) {
    return { severity: "critical", patterns, criticalPatterns };
  }

  return { severity: "warn", patterns, criticalPatterns: [] };
}
