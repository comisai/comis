// SPDX-License-Identifier: Apache-2.0
/**
 * The skill-install vetting gate.
 *
 * One pure function, called by every skill-install path between scope
 * resolution and the first file write. It composes three passes into a single
 * verdict + decision + content hash:
 *
 *   1. **Structural** (`./bundle-structure.ts`) — counts, sizes, path shape,
 *      member type, binary bytes, exec bits. Runs FIRST and SHORT-CIRCUITS on
 *      any CRITICAL: a bundle we refuse to hold is a bundle we never scan, so a
 *      bomb-shaped input costs no regex passes to reject.
 *   2. **Manifest** — locate `SKILL.md`, parse frontmatter, map foreign keys
 *      (`./frontmatter-map.ts`), validate against `SkillManifestSchema`, assert
 *      `type === "prompt"`. A parse failure BLOCKS, rather than installing a
 *      skill that then goes invisible at discovery.
 *   3. **Content** — sanitize then scan every text member with the SAME
 *      `CONTENT_SCAN_RULES` the load-time scanner uses. Only the surface widens
 *      (whole bundle, not just the body); the rules do not change, so the two
 *      sites cannot drift.
 *
 * Decision policy here is fixed and fail-closed — any CRITICAL blocks, WARN
 * informs — which preserves the shipped `skills.create` / `skills.update`
 * behavior exactly while extending it to `import` / `upload` and to the whole
 * bundle. A trust × verdict matrix replaces this one function later; `decision`
 * is already on the result and already consumed by the call sites, so nothing
 * else moves when it does.
 *
 * Pure: no fs, no net, no clock, no mutation of the caller's input.
 *
 * @module
 */

import { parseFrontmatter } from "../manifest/parser.js";
import { SkillManifestSchema, type SkillManifestParsed } from "../manifest/schema.js";
import { scanSkillContent } from "../prompt/content-scanner.js";
import { sanitizeSkillBody } from "../prompt/sanitizer.js";
import { hashSkillBundle } from "./bundle-hash.js";
import { checkBundleStructure, MANIFEST_FILENAME } from "./bundle-structure.js";
import { mapForeignFrontmatter } from "./frontmatter-map.js";
import type { SkillTrustTier } from "./trust-tier.js";
import type {
  MappingWarning,
  SkillBundleDecision,
  SkillBundleFile,
  SkillBundleFinding,
  SkillBundleLimits,
  SkillBundleVerdict,
} from "./bundle-types.js";

// Re-exported so callers have one import site for the gate's surface.
export type {
  MappingWarning,
  SkillBundleDecision,
  SkillBundleFile,
  SkillBundleFinding,
  SkillBundleFindingCategory,
  SkillBundleLimits,
  SkillBundleVerdict,
} from "./bundle-types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input to {@link vetSkillBundle}. */
export interface VetSkillBundleInput {
  /** Bundle members. Relative paths; `SKILL.md` required at the root. */
  readonly files: readonly SkillBundleFile[];
  /**
   * The tier from `deriveSkillTrustTier`. Carried onto the result and into the
   * audit record; the current decision policy is deliberately tier-agnostic, so
   * a later matrix swap is an observable, intentional change.
   */
  readonly trust: SkillTrustTier;
  /** Partial bound overrides merged over `DEFAULT_BUNDLE_LIMITS`. */
  readonly limits?: Partial<SkillBundleLimits>;
}

/** Result of {@link vetSkillBundle}. */
export interface VetSkillBundleResult {
  readonly verdict: SkillBundleVerdict;
  readonly decision: SkillBundleDecision;
  readonly findings: readonly SkillBundleFinding[];
  /** Present only when the manifest parsed and validated. */
  readonly manifest?: SkillManifestParsed;
  /** Frontmatter keys remapped-with-conflict or dropped. */
  readonly warnings: readonly MappingWarning[];
  /** Canonical `"sha256:…"` digest — present even on a blocked bundle (the audit needs it). */
  readonly contentHash: string;
  /** Echoed for the caller's log/audit line. */
  readonly trust: SkillTrustTier;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Aggregate findings into a content-risk verdict. */
function verdictFor(findings: readonly SkillBundleFinding[]): SkillBundleVerdict {
  if (findings.some((f) => f.severity === "CRITICAL")) return "dangerous";
  if (findings.length > 0) return "caution";
  return "safe";
}

/**
 * Fixed fail-closed policy: CRITICAL blocks, everything else allows.
 *
 * Deliberately ignores `trust`. The tier is threaded through so the matrix that
 * replaces this function has everything it needs without touching a call site.
 */
function decisionFor(verdict: SkillBundleVerdict, _trust: SkillTrustTier): SkillBundleDecision {
  return verdict === "dangerous" ? "block" : "allow";
}

/** Decode a member for scanning. Binary members never reach here. */
function asText(content: string | Uint8Array): string {
  return typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
}

/** The manifest member, matched canonically first then case-insensitively. */
function findManifest(files: readonly SkillBundleFile[]): SkillBundleFile | undefined {
  return (
    files.find((f) => f.path === MANIFEST_FILENAME) ??
    files.find((f) => f.path.toLowerCase() === MANIFEST_FILENAME.toLowerCase())
  );
}

/**
 * Members eligible for the content scan.
 *
 * Links never reach here in practice — `BUNDLE_SYMLINK_MEMBER` is CRITICAL and
 * short-circuits pass 1 — but the guard keeps this total rather than relying on
 * that ordering. Byte members that survived pass 1 are text by construction
 * (`BUNDLE_BINARY_MEMBER` is also CRITICAL), so they are decoded and scanned.
 */
function isScannable(file: SkillBundleFile): boolean {
  return file.type !== "symlink" && file.type !== "hardlink";
}

function result(
  partial: Omit<VetSkillBundleResult, "verdict" | "decision">,
): VetSkillBundleResult {
  const verdict = verdictFor(partial.findings);
  return { ...partial, verdict, decision: decisionFor(verdict, partial.trust) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Vet a skill bundle before any byte of it is written.
 *
 * @param input See {@link VetSkillBundleInput}.
 * @returns A verdict, a decision, every finding tagged with its originating
 *   member, the parsed manifest when it validated, mapping warnings, and the
 *   canonical content hash.
 */
export function vetSkillBundle(input: VetSkillBundleInput): VetSkillBundleResult {
  const contentHash = hashSkillBundle(input.files);
  const base = { contentHash, trust: input.trust };

  // PASS 1 — structure. Short-circuit on CRITICAL so a refused bundle costs no
  // sanitize/regex work and no partial findings imply a scan that never ran.
  const structural = checkBundleStructure({
    files: input.files,
    ...(input.limits !== undefined && { limits: input.limits }),
  });
  if (structural.some((f) => f.severity === "CRITICAL")) {
    return result({ ...base, findings: structural, warnings: [] });
  }

  // PASS 2 — manifest. Structure already guaranteed a manifest member exists.
  const manifestFile = findManifest(input.files);
  if (manifestFile === undefined) {
    // Defensive: unreachable while BUNDLE_MANIFEST_MISSING is CRITICAL.
    return result({
      ...base,
      findings: [
        ...structural,
        {
          file: "",
          ruleId: "BUNDLE_MANIFEST_MISSING",
          category: "structural" as const,
          severity: "CRITICAL" as const,
          description: `Bundle has no ${MANIFEST_FILENAME} at its root`,
        },
      ],
      warnings: [],
    });
  }

  const manifestText = asText(manifestFile.content);
  const parsedFrontmatter = parseFrontmatter<Record<string, unknown>>(manifestText);
  if (!parsedFrontmatter.ok) {
    return result({
      ...base,
      findings: [
        ...structural,
        {
          file: manifestFile.path,
          ruleId: "BUNDLE_MANIFEST_UNPARSEABLE",
          category: "structural" as const,
          severity: "CRITICAL" as const,
          description: `Frontmatter could not be parsed: ${parsedFrontmatter.error.message}`,
        },
      ],
      warnings: [],
    });
  }

  const mapped = mapForeignFrontmatter(parsedFrontmatter.value.frontmatter);
  const validated = SkillManifestSchema.safeParse(mapped.frontmatter);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    // A `type` mismatch gets its own rule id so INV-V4 is greppable in an audit.
    const isTypeViolation = validated.error.issues.some((issue) => issue.path[0] === "type");
    return result({
      ...base,
      findings: [
        ...structural,
        {
          file: manifestFile.path,
          ruleId: isTypeViolation ? "BUNDLE_MANIFEST_NOT_PROMPT" : "BUNDLE_MANIFEST_UNPARSEABLE",
          category: "structural" as const,
          severity: "CRITICAL" as const,
          description: isTypeViolation
            ? `Skill declares a non-prompt type; Comis skills are prompt-only (${issues})`
            : `Manifest validation failed: ${issues}`,
        },
      ],
      warnings: mapped.warnings,
    });
  }

  // PASS 3 — content. Same rules as the load-time scanner; wider surface.
  const findings: SkillBundleFinding[] = [...structural];
  for (const file of input.files) {
    if (!isScannable(file)) continue;
    const text = asText(file.content);
    // Pass the member's own length as the cap so sanitization never truncates
    // and creates a scan blind spot. Per-member size is already bounded by the
    // CRITICAL `BUNDLE_FILE_TOO_LARGE` rule that short-circuited above.
    const sanitized = sanitizeSkillBody(text, text.length);
    for (const hit of scanSkillContent(sanitized.body).findings) {
      findings.push({
        file: file.path,
        ruleId: hit.ruleId,
        category: hit.category,
        severity: hit.severity,
        description: hit.description,
        matchedText: hit.matchedText,
        lineNumber: hit.lineNumber,
      });
    }
  }

  return result({ ...base, findings, manifest: validated.data, warnings: mapped.warnings });
}
