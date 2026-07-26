// SPDX-License-Identifier: Apache-2.0
/**
 * Structural rules for a skill bundle.
 *
 * These catch what a regex cannot: a native payload, a symlink, a traversal
 * path, a bomb-shaped member count. They run FIRST in the gate so an oversized
 * or malformed bundle is refused before any NFKC normalization or regex pass —
 * a bundle we refuse to hold in memory is a bundle we never scan.
 *
 * Severity discipline: **limit breaches are CRITICAL**, because a cap that is
 * exceeded and then allowed anyway is not a cap; tunability comes from the
 * config knobs, not from downgrading the breach. Only three genuinely-advisory
 * rules are WARN: `BUNDLE_MANIFEST_CASE`, `BUNDLE_EXEC_BIT`, `BUNDLE_DEEP_NEST`.
 *
 * Pure: no fs, no net, no clock, no mutation of the caller's array.
 *
 * @module
 */

import ignore from "ignore";
import { isBinaryContent } from "../../tools/integrations/document/binary-detector.js";
import type { SkillBundleFile, SkillBundleFinding, SkillBundleLimits } from "./bundle-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default bundle bounds. Two reuse the caps the shipped GitHub Contents walk
 * already enforces (`packages/daemon/src/api/github-skill-fetch.ts`), so a
 * bundle that passes the existing fetch bounds passes these too and the new
 * caps bite only where the fetch bounds never reached.
 */
export const DEFAULT_BUNDLE_LIMITS: SkillBundleLimits = {
  maxEntries: 200, // = GITHUB_FETCH_MAX_FILES
  maxEntryBytes: 4 * 1024 * 1024,
  maxBundleBytes: 32 * 1024 * 1024,
  maxPathDepth: 10, // = GITHUB_FETCH_MAX_DEPTH
};

/** The canonical manifest filename. */
export const MANIFEST_FILENAME = "SKILL.md";

/** Optional per-bundle ignore file, honored for structural rules only. */
export const BUNDLE_IGNORE_FILENAME = ".skillignore";

/** Path depth beyond which nesting is advisory-flagged (still inside `maxPathDepth`). */
const DEEP_NEST_DEPTH = 6;

/** Extensions whose exec bit is expected rather than suspicious. */
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".rb",
  ".pl",
]);

/**
 * Executable-image magic prefixes. Checked explicitly so a null-free binary is
 * still caught; `isBinaryContent` is the general net behind them.
 */
const EXECUTABLE_MAGIC: readonly (readonly number[])[] = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32 BE
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64 BE
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32 LE
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64 LE
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal / Java class
  [0x4d, 0x5a], // PE/COFF (MZ)
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finding(
  file: string,
  ruleId: string,
  severity: "CRITICAL" | "WARN",
  description: string,
): SkillBundleFinding {
  return { file, ruleId, category: "structural", severity, description };
}

/** Byte length of a member's content (NOT character count — a cap is a byte cap). */
function byteLength(content: string | Uint8Array): number {
  return typeof content === "string" ? Buffer.byteLength(content, "utf-8") : content.byteLength;
}

/** First bytes of a member, for magic-prefix matching. */
function leadingBytes(content: string | Uint8Array, count: number): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content.slice(0, count));
  return content.subarray(0, count);
}

function hasExecutableMagic(content: string | Uint8Array): boolean {
  const head = leadingBytes(content, 8);
  return EXECUTABLE_MAGIC.some((magic) => magic.every((byte, i) => head[i] === byte));
}

function looksBinary(content: string | Uint8Array): boolean {
  if (hasExecutableMagic(content)) return true;
  const bytes = typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content);
  return isBinaryContent(bytes);
}

/**
 * Classify a member path. Returns `null` when the path is structurally unsafe,
 * otherwise the normalized POSIX segments.
 *
 * Rejects: absolute paths, `..` at any position, Windows drive prefixes, and
 * empty paths. Backslashes are normalized to `/` first so a
 * `references\..\..\escape.md` member cannot slip past a `/`-only check.
 */
function normalizeSegments(rawPath: string): string[] | null {
  const normalized = rawPath.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(normalized)) return null;

  const segments = normalized.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return null;
  if (segments.some((s) => s === "..")) return null;
  if (segments.some((s) => s.includes("\0"))) return null;
  return segments;
}

/** True when the member is the manifest, in canonical or case-variant spelling. */
function manifestMatch(segments: string[]): "exact" | "case" | "no" {
  if (segments.length !== 1) return "no";
  const name = segments[0]!;
  if (name === MANIFEST_FILENAME) return "exact";
  if (name.toLowerCase() === MANIFEST_FILENAME.toLowerCase()) return "case";
  return "no";
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

/**
 * Build the ignore matcher from a `.skillignore` member, if present.
 *
 * The matcher is consulted for COUNT and SIZE and per-member advisory rules
 * only. It can never suppress a path-safety or member-type CRITICAL, and it can
 * never exclude the manifest — otherwise the ignore file becomes the bypass
 * (ship `.skillignore` containing `*` and the gate inspects nothing).
 */
function buildIgnoreMatcher(files: readonly SkillBundleFile[]): ((path: string) => boolean) | undefined {
  const entry = files.find((f) => f.path === BUNDLE_IGNORE_FILENAME);
  if (!entry) return undefined;
  const text = typeof entry.content === "string" ? entry.content : Buffer.from(entry.content).toString("utf-8");
  const matcher = ignore().add(text);
  return (path: string) => {
    if (path === MANIFEST_FILENAME) return false; // never ignorable
    try {
      return matcher.ignores(path);
    } catch {
      // `ignore` rejects paths it considers invalid; such a path is already
      // handled by the path-safety rules, so treat it as not-ignored.
      return false;
    }
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Input to {@link checkBundleStructure}. */
export interface CheckBundleStructureInput {
  readonly files: readonly SkillBundleFile[];
  /** Partial overrides merged over {@link DEFAULT_BUNDLE_LIMITS}. */
  readonly limits?: Partial<SkillBundleLimits>;
}

/**
 * Run the structural rules over a bundle.
 *
 * @returns Findings in a deterministic order: whole-bundle rules last, member
 *   rules in member order, so identical input yields an identical array.
 */
export function checkBundleStructure(input: CheckBundleStructureInput): SkillBundleFinding[] {
  const limits: SkillBundleLimits = { ...DEFAULT_BUNDLE_LIMITS, ...input.limits };
  const isIgnored = buildIgnoreMatcher(input.files);

  const memberFindings: SkillBundleFinding[] = [];
  const bundleFindings: SkillBundleFinding[] = [];

  let manifestSeen: "exact" | "case" | "no" = "no";
  let countedFiles = 0;
  let countedBytes = 0;

  for (const file of input.files) {
    const segments = normalizeSegments(file.path);

    // Path safety is NOT ignorable: an attacker who can ship .skillignore must
    // not be able to ship a traversal alongside it.
    if (segments === null) {
      memberFindings.push(
        finding(
          file.path,
          "BUNDLE_PATH_UNSAFE",
          "CRITICAL",
          "Member path is absolute, escapes the bundle root, or is otherwise unsafe",
        ),
      );
      continue;
    }

    if (segments.length > limits.maxPathDepth) {
      memberFindings.push(
        finding(
          file.path,
          "BUNDLE_PATH_UNSAFE",
          "CRITICAL",
          `Member path depth ${segments.length} exceeds maxPathDepth ${limits.maxPathDepth}`,
        ),
      );
      continue;
    }

    const relPath = segments.join("/");
    const match = manifestMatch(segments);
    if (match === "exact" || (match === "case" && manifestSeen === "no")) {
      manifestSeen = match;
    }

    const excludedFromBounds =
      relPath === BUNDLE_IGNORE_FILENAME || isIgnored?.(relPath) === true;

    // Member type: a link cannot be distinguished from text by its bytes, so
    // the source's metadata is the only signal. Ignore patterns cannot suppress
    // this refusal.
    if (file.type === "symlink" || file.type === "hardlink") {
      memberFindings.push(
        finding(
          relPath,
          "BUNDLE_SYMLINK_MEMBER",
          "CRITICAL",
          `Bundle contains a ${file.type} member; skills have no legitimate use for links`,
        ),
      );
      continue;
    }

    const size = byteLength(file.content);
    if (looksBinary(file.content)) {
      memberFindings.push(
        finding(
          relPath,
          "BUNDLE_BINARY_MEMBER",
          "CRITICAL",
          "Member is binary or an executable image; a prompt skill carries text only",
        ),
      );
      continue;
    }

    // The ignore file itself and matched regular text members are excluded
    // from counts, size caps, and advisory metadata checks. Path, member-type,
    // and binary-image refusals above remain non-ignorable.
    if (excludedFromBounds) continue;

    countedFiles += 1;
    countedBytes += size;

    if (size > limits.maxEntryBytes) {
      memberFindings.push(
        finding(
          relPath,
          "BUNDLE_FILE_TOO_LARGE",
          "CRITICAL",
          `Member is ${size} bytes, over maxEntryBytes ${limits.maxEntryBytes}`,
        ),
      );
    }

    if (file.mode !== undefined && (file.mode & 0o111) !== 0 && !SCRIPT_EXTENSIONS.has(extensionOf(relPath))) {
      memberFindings.push(
        finding(
          relPath,
          "BUNDLE_EXEC_BIT",
          "WARN",
          "Member has the executable bit set but is not a recognized script type",
        ),
      );
    }

    if (segments.length > DEEP_NEST_DEPTH) {
      memberFindings.push(
        finding(relPath, "BUNDLE_DEEP_NEST", "WARN", `Member is nested ${segments.length} levels deep`),
      );
    }
  }

  // Whole-bundle rules.
  if (manifestSeen === "no") {
    bundleFindings.push(
      finding("", "BUNDLE_MANIFEST_MISSING", "CRITICAL", `Bundle has no ${MANIFEST_FILENAME} at its root`),
    );
  } else if (manifestSeen === "case") {
    bundleFindings.push(
      finding(
        "",
        "BUNDLE_MANIFEST_CASE",
        "WARN",
        `Manifest matched ${MANIFEST_FILENAME} only case-insensitively`,
      ),
    );
  }

  if (countedFiles > limits.maxEntries) {
    bundleFindings.push(
      finding(
        "",
        "BUNDLE_TOO_MANY_FILES",
        "CRITICAL",
        `Bundle has ${countedFiles} members, over maxEntries ${limits.maxEntries}`,
      ),
    );
  }

  if (countedBytes > limits.maxBundleBytes) {
    bundleFindings.push(
      finding(
        "",
        "BUNDLE_TOO_LARGE",
        "CRITICAL",
        `Bundle totals ${countedBytes} bytes, over maxBundleBytes ${limits.maxBundleBytes}`,
      ),
    );
  }

  return [...memberFindings, ...bundleFindings];
}
