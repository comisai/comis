// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime eligibility evaluation for prompt skills.
 *
 * Determines whether a skill's OS, binary, and environment prerequisites
 * are satisfied on the current machine. Used by skill-registry to exclude
 * ineligible skills from agent system prompts.
 *
 * Security: Uses safePath() for binary path construction (not path.join),
 * SecretManager for env var checks (not process.env), fs.accessSync for
 * binary detection (no subprocess spawning).
 *
 * @module
 */

import { safePath } from "@comis/core";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SecretManager } from "@comis/core";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Context providing runtime environment checks for skill eligibility. */
export interface RuntimeEligibilityContext {
  /** Current OS platform (e.g., "linux", "darwin", "win32"). */
  readonly platform: string;
  /** Check whether a binary is available on PATH. */
  hasBin(name: string): boolean;
  /** Check whether an environment variable is set. */
  hasEnv(key: string): boolean;
  /** Pre-populate the binary availability cache for a set of binary names. */
  populateBinaryCache(binNames: string[]): void;
}

/** Result of evaluating a skill's runtime eligibility. */
export interface EligibilityResult {
  /** Whether the skill is eligible to run on this machine. */
  readonly eligible: boolean;
  /** Human-readable reason for ineligibility (only set when eligible is false). */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a named binary exists and is executable in any of the given
 * PATH directories. Uses safePath() to prevent traversal from malicious
 * binary names, and fs.accessSync with X_OK for detection (no subprocess).
 */
function checkBinaryOnPath(name: string, pathDirs: string[]): boolean {
  for (const dir of pathDirs) {
    try {
      const candidate = safePath(dir, name);
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // Not found or not executable in this directory -- continue
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a RuntimeEligibilityContext backed by the given SecretManager.
 *
 * Reads PATH from SecretManager (not process.env), splits it into
 * directories, and provides binary/env checks delegating to the
 * appropriate secure primitives.
 *
 * @param secretManager - SecretManager for env var and PATH access
 * @returns RuntimeEligibilityContext ready for use in evaluateSkillEligibility
 */
export function createRuntimeEligibilityContext(
  secretManager: SecretManager,
): RuntimeEligibilityContext {
  const binaryCache = new Map<string, boolean>();

  // Get PATH from SecretManager (NOT process.env -- banned by ESLint)
  const rawPath = secretManager.get("PATH") ?? "";
  const pathDirs = rawPath.split(path.delimiter).filter((d) => d.length > 0);

  return {
    platform: process.platform,

    hasBin(name: string): boolean {
      const cached = binaryCache.get(name);
      if (cached !== undefined) return cached;
      // Fallback for uncached names: check PATH and cache result
      const found = checkBinaryOnPath(name, pathDirs);
      binaryCache.set(name, found);
      return found;
    },

    hasEnv(key: string): boolean {
      return secretManager.has(key);
    },

    populateBinaryCache(binNames: string[]): void {
      binaryCache.clear();
      for (const name of binNames) {
        binaryCache.set(name, checkBinaryOnPath(name, pathDirs));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pure evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a skill is eligible to run on the current machine.
 *
 * Checks OS platform, required binaries, and required env vars in that
 * order (fail-fast). Returns eligible:true when all constraints pass or
 * when the skill has no constraints.
 *
 * @param metadata - Skill metadata with optional os and requires fields
 * @param ctx - Runtime eligibility context for environment checks
 * @returns EligibilityResult indicating eligible/ineligible with reason
 */
export function evaluateSkillEligibility(
  metadata: { os?: string[]; requires?: { bins: string[]; env: string[] } },
  ctx: RuntimeEligibilityContext,
): EligibilityResult {
  // OS check: platform must be in the skill's os array (if specified)
  if (metadata.os && metadata.os.length > 0) {
    if (!metadata.os.includes(ctx.platform)) {
      return {
        eligible: false,
        reason: `os mismatch: platform "${ctx.platform}" not in [${metadata.os.join(", ")}]`,
      };
    }
  }

  // Binary check: all required binaries must be available on PATH
  if (metadata.requires?.bins?.length) {
    const missing = metadata.requires.bins.filter((b) => !ctx.hasBin(b));
    if (missing.length > 0) {
      return {
        eligible: false,
        reason: `missing binary: ${missing.join(", ")}`,
      };
    }
  }

  // Env var check: all required env vars must be set
  if (metadata.requires?.env?.length) {
    const missing = metadata.requires.env.filter((k) => !ctx.hasEnv(k));
    if (missing.length > 0) {
      return {
        eligible: false,
        reason: `missing env var: ${missing.join(", ")}`,
      };
    }
  }

  return { eligible: true };
}
