// SPDX-License-Identifier: Apache-2.0
/**
 * Skill registry types.
 *
 * Owns:
 *   - Public type surface: PromptSkillContent, SkillSnapshot, SdkSkill, SkillRegistry
 *   - Module-private types: OperatorSkillHint, SkillsLogger
 *   - Re-exports of SkillMetadata + SkillWatcherHandle (kept on the registry
 *     public surface — these names are imported directly from `@comis/skills`
 *     via the package barrel and the registry module is the canonical
 *     declaration site).
 *
 * Type-only file (no-cycles invariant). No runtime code.
 *
 * @module
 */

import type {
  PromptSkillCapability,
} from "@comis/core";
import type { Result } from "@comis/shared";
import type { PromptSkillDescription } from "../../prompt/processor.js";
import type { SkillMetadata, SkillSource } from "../discovery.js";
import type { SkillWatcherHandle } from "../skill-watcher.js";

// ---------------------------------------------------------------------------
// Public type re-exports
// ---------------------------------------------------------------------------

/** Re-export SkillMetadata for consumers who import from the registry module. */
export type { SkillMetadata } from "../discovery.js";

/** Re-export SkillWatcherHandle for consumers who import from the registry module. */
export type { SkillWatcherHandle } from "../skill-watcher.js";

// ---------------------------------------------------------------------------
// Module-private types (consumed by the cache + discovery split leaves)
// ---------------------------------------------------------------------------

/**
 * Operator hint shape consumed by `getPromptSkillCapabilities`.
 *
 * Mirrors the return shape of `ToolCapabilityPort.getSkillHint` in
 * `@comis/core/ports/tool-capability.ts`. The registry stays decoupled from
 * the port itself -- daemon-side wiring passes the port's `getSkillHint`
 * method as the callback.
 */
export type OperatorSkillHint = {
  readonly cluster: string;
  readonly description?: string;
  readonly replacesPackages: readonly string[];
};

/** Minimal pino-compatible logger interface for skills subsystem logging. */
export interface SkillsLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Content and metadata of a loaded prompt skill (cached in promptCache). */
export interface PromptSkillContent {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly location: string;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly allowedTools: string[];
  readonly argumentHint?: string;
  readonly source: SkillSource;
}

/** Cached snapshot of prompt skill XML and metadata for a single reload cycle. */
export interface SkillSnapshot {
  /** Pre-computed available_skills XML string (or empty string if no visible skills). */
  readonly prompt: string;
  /** Descriptions used to build the XML (frozen at snapshot time). */
  readonly skills: readonly PromptSkillDescription[];
  /** Monotonic version counter. Increments on each init()/reload(). */
  readonly version: number;
}

/** SDK Skill shape for initFromSdkSkills (matches pi-coding-agent Skill type). */
export interface SdkSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation: boolean;
}

/** Skill registry interface implementing progressive disclosure. */
export interface SkillRegistry {
  /** Level 1: Discover and store skill metadata from configured paths. */
  init(): void;

  /**
   * Load a prompt skill by name (read body, sanitize, cache).
   * @param name - Skill name from metadata
   * @returns PromptSkillContent on success, Error on failure
   */
  loadPromptSkill(name: string): Promise<Result<PromptSkillContent, Error>>;

  /**
   * Get descriptions of all prompt skills for system prompt listing.
   * Returns all prompt skills including disableModelInvocation field -- consumers filter.
   */
  getPromptSkillDescriptions(): PromptSkillDescription[];

  /**
   * Get names of prompt skills where userInvocable === true.
   * Used by slash command matcher.
   */
  getUserInvocableSkillNames(): Set<string>;

  /**
   * Find prompt skills relevant to a query using keyword overlap.
   * Only considers prompt skills.
   * @param query - Natural language task description
   * @param maxResults - Maximum results (default: config.promptSkills.maxAutoInject)
   */
  getRelevantPromptSkills(query: string, maxResults?: number): SkillMetadata[];

  /** Number of skills discovered (Level 1 metadata). */
  getMetadataCount(): number;

  /** Get cached snapshot of available skills XML, building lazily if needed. */
  getSnapshot(): SkillSnapshot;
  /** Get the current snapshot version without triggering a rebuild. */
  getSnapshotVersion(): number;

  /**
   * Start watching discovery paths for file changes.
   * Returns a handle for stopping the watcher on shutdown.
   * Returns a disposable handle for stopping the watcher on shutdown.
   */
  startWatching(debounceMs: number): SkillWatcherHandle;

  /**
   * Get names of all skills that pass Comis's eligibility filters
   * (allowedSkills/deniedSkills + runtime eligibility). Used by PiExecutor's
   * skillsOverride callback to filter SDK-discovered skills.
   * Acts as the Comis eligibility gate for SDK discovery.
   */
  getEligibleSkillNames(): Set<string>;

  /**
   * Return all visible eligible prompt skills with merged capability metadata.
   *
   * Applies the same `allowedSkills`/`deniedSkills` and runtime-eligibility
   * filters as `getPromptSkillDescriptions`, PLUS an extra
   * `disableModelInvocation !== true` filter -- skills hidden from the model
   * are not surfaced as capability index entries.
   *
   * Capability merge precedence:
   *   1. operator hint by `skillKey` (when the skill declares one)
   *   2. operator hint by skill name (always available as fallback)
   *   3. `comis.capability` from the skill manifest (already in
   *      `metadata.capability`)
   *   4. Fallback: `cluster` undefined (renderer falls back to the literal
   *      `"prompt-skills"` cluster); `summary` = `description`;
   *      `replacesPackages` = `[]`.
   *
   * The `getOperatorHint` callback keeps the registry decoupled from
   * `ToolCapabilityPort` -- daemon-side adapters pass the port's
   * `getSkillHint` method here.
   *
   * Fresh-per-call (no memoization). Returns a frozen array of frozen entries.
   *
   * IMPORTANT -- cache fence:
   * This method MUST NOT be consumed by `assembleRichSystemPrompt`'s
   * `assemblerParams` in `packages/agent/src/executor/prompt-assembly.ts`.
   * If a skill discovery sweep runs between turns, the cached system-prompt
   * prefix MUST stay byte-identical. An architecture-grep test enforces this
   * invariant.
   */
  getPromptSkillCapabilities(
    getOperatorHint: (skillName: string, skillKey?: string) => OperatorSkillHint | undefined,
  ): readonly PromptSkillCapability[];

  /**
   * Populate the registry from SDK-discovered skills instead of filesystem discovery.
   * Clears existing metadata, maps SDK Skill fields to Comis SkillMetadata,
   * enriches from comis: namespace in skill files, applies eligibility filtering,
   * and emits registry_reset event.
   * Uses SDK discovery as the base with Comis eligibility filtering applied.
   */
  initFromSdkSkills(sdkSkills: SdkSkill[]): void;
}
