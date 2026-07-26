// SPDX-License-Identifier: Apache-2.0
/**
 * Shared types for the skill-install vetting gate.
 *
 * Held in a leaf module (no imports beyond the scanner's finding types) so
 * `bundle-structure.ts` / `bundle-hash.ts` and `vet-bundle.ts` can share them
 * without a module cycle. `vet-bundle.ts` re-exports the public surface, so
 * callers import from there.
 *
 * @module
 */

import type { ScanCategory, ScanSeverity } from "../prompt/content-scanner.js";

/** A single member of a skill bundle, as produced by any install source. */
export interface SkillBundleFile {
  /** Path relative to the skill directory, POSIX separators. */
  readonly path: string;
  /** Text members arrive as a string; members of unknown type arrive as bytes. */
  readonly content: string | Uint8Array;
  /** Unix mode from archive/fs metadata when the source can express it. */
  readonly mode?: number;
  /**
   * Member type from the source's metadata; defaults to `"file"`.
   *
   * An archive reader MUST set this: a link's *content* is indistinguishable
   * from a text file's, so `BUNDLE_SYMLINK_MEMBER` cannot be inferred from
   * bytes. The GitHub Contents walk and an uploaded file map only ever produce
   * regular files and may omit it.
   */
  readonly type?: "file" | "symlink" | "hardlink";
}

/** Content risk of a bundle, aggregated from its findings. */
export type SkillBundleVerdict = "safe" | "caution" | "dangerous";

/** What the gate decided to do about the bundle. */
export type SkillBundleDecision = "allow" | "confirm" | "block";

/**
 * A finding's category: one of the content-scanner categories, or the
 * structural pseudo-category for the bundle-shape rules.
 */
export type SkillBundleFindingCategory = ScanCategory | "structural";

/** One vetting finding, from either the structural rules or the content scan. */
export interface SkillBundleFinding {
  /** Member path the finding belongs to; `""` for whole-bundle findings. */
  readonly file: string;
  /** Structural rule id (`BUNDLE_*`) or content-scanner rule id. */
  readonly ruleId: string;
  readonly category: SkillBundleFindingCategory;
  readonly severity: ScanSeverity;
  readonly description: string;
  /** Present for content findings; capped at 100 chars by the scanner. */
  readonly matchedText?: string;
  /** 1-based line number within `file`, for content findings. */
  readonly lineNumber?: number;
}

/** Bundle-shape bounds. Overridable per call; defaults in `./bundle-structure.ts`. */
export interface SkillBundleLimits {
  /** Maximum member count, ignore-file matches excluded. */
  readonly maxEntries: number;
  /** Maximum bytes for a single member. */
  readonly maxEntryBytes: number;
  /** Maximum total bytes across all counted members. */
  readonly maxBundleBytes: number;
  /** Maximum path depth (segment count) for any member. */
  readonly maxPathDepth: number;
}

/** One frontmatter key the mapper remapped or dropped. Keys and actions only — never values. */
export interface MappingWarning {
  /** The frontmatter key this warning is about. */
  readonly key: string;
  /**
   * - `duplicate_key` — a kebab-case alias lost to its camelCase twin.
   * - `dropped_executable` — a key implying code execution; the prompt body was kept.
   * - `dropped_unmappable` — no Comis equivalent; dropped rather than reinterpreted.
   */
  readonly action: "duplicate_key" | "dropped_executable" | "dropped_unmappable";
}
