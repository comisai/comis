// SPDX-License-Identifier: Apache-2.0
/**
 * Skill registry discovery + matching algorithms.
 *
 * Owns:
 *   - Tokenization (tokenize)
 *   - allowed/denied filter (isSkillEligible)
 *   - Relevance scoring against a tokenized query (scoreRelevance)
 *   - loadPromptSkillImpl — the file-IO + manifest + content-scan + audit
 *     pipeline for level-2 (load) progressive disclosure
 *
 * These are the deterministic, reusable helpers — no closure state, all
 * inputs are passed explicitly (cache map is mutated as the documented
 * side effect of a successful load).
 *
 * @module
 */

import type {
  SkillsConfig,
  TypedEventBus,
} from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import * as fs from "node:fs";
import { emitSkillAudit } from "../../audit/skill-audit.js";
import { parseComisCapabilityDefensively } from "../../manifest/capability-parser.js";
import { liftAuthoredFrontmatter } from "../../manifest/lift.js";
import { parseFrontmatter } from "../../manifest/parser.js";
import { SkillManifestSchema } from "../../manifest/schema.js";
import { sanitizeSkillBody } from "../../prompt/sanitizer.js";
import { scanSkillContent } from "../../prompt/content-scanner.js";
import type { SkillMetadata } from "../discovery.js";
import type { PromptSkillContent, SkillsLogger } from "./skill-registry-types.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Tokenize a string into lowercase words (split on whitespace and common punctuation). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}<>/\\|@#$%^&*+=~`"'-]+/)
    .filter((t) => t.length > 0);
}

/**
 * Check if a skill is eligible based on allowedSkills/deniedSkills config.
 *
 * - If allowedSkills is non-empty, skill must be in the list.
 * - If skill is in deniedSkills, it is excluded (deny takes precedence within allowed set).
 * - Null-safe: uses `?? []` because test/legacy configs may omit these fields.
 */
export function isSkillEligible(
  name: string,
  promptSkillsConfig: { allowedSkills?: string[]; deniedSkills?: string[] },
): boolean {
  const allowed = promptSkillsConfig.allowedSkills ?? [];
  const denied = promptSkillsConfig.deniedSkills ?? [];
  // If allowedSkills is non-empty, skill must be in the list
  if (allowed.length > 0 && !allowed.includes(name)) {
    return false;
  }
  // If skill is in deniedSkills, it's excluded
  if (denied.includes(name)) {
    return false;
  }
  return true;
}

/**
 * Score a skill's metadata against a query using keyword overlap.
 * Returns the count of overlapping tokens between query and description.
 */
export function scoreRelevance(queryTokens: Set<string>, skill: SkillMetadata): number {
  const descTokens = tokenize(skill.description);
  let score = 0;
  for (const token of descTokens) {
    if (queryTokens.has(token)) {
      score++;
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// Factory-body extraction: loadPromptSkillImpl
// ---------------------------------------------------------------------------

/**
 * Level-2 (load) progressive-disclosure entry point.
 *
 * Reads the skill body from disk, parses frontmatter, defensively strips a
 * malformed `comis.capability` block, validates the manifest, sanitizes the
 * body, runs content scanning, emits audit events, and caches the resulting
 * {@link PromptSkillContent} in `promptCache`.
 *
 * Side effects: on `ok()`, `promptCache.set(name, ...)` is called. On any
 * `err()` return, the cache is NOT mutated.
 *
 * @returns `ok(PromptSkillContent)` on success; `err(Error)` when metadata
 *          missing, file read fails, frontmatter invalid, body empty, manifest
 *          validation fails, sanitization yields empty body, or content scan
 *          flags a CRITICAL finding under `blockOnCritical`.
 */
export async function loadPromptSkillImpl(params: {
  name: string;
  metadataMap: Map<string, SkillMetadata>;
  promptCache: Map<string, PromptSkillContent>;
  config: SkillsConfig;
  eventBus: TypedEventBus;
  auditContext: { agentId: string; tenantId: string; userId: string };
  logger?: SkillsLogger;
}): Promise<Result<PromptSkillContent, Error>> {
  const { name, metadataMap, promptCache, config, eventBus, auditContext, logger } = params;

  // Check metadata exists
  const metadata = metadataMap.get(name);
  if (!metadata) {
    return err(new Error(`Prompt skill not found: ${name}`));
  }

  // Check prompt cache
  const cached = promptCache.get(name);
  if (cached) {
    return ok(cached);
  }

  // Read the file from disk
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(metadata.filePath, "utf-8");
  } catch (e) {
    return err(
      new Error(
        `Failed to read prompt skill file for ${name}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  // Parse frontmatter; defensively strip a malformed comis.capability
  // block before strict validation so a typo in capability does NOT hide
  // the skill at load time. Mirrors the discovery-side enrichment in
  // discovery.ts.
  const fmResult = parseFrontmatter<Record<string, unknown>>(fileContent);
  if (!fmResult.ok) {
    return err(fmResult.error);
  }
  const rawBody = fmResult.value.body;

  // Validate body is non-empty
  if (!rawBody.trim()) {
    return err(new Error(`Prompt skill "${name}" has no body content`));
  }

  // Normalize the authored carrier into the internal manifest shape BEFORE the
  // capability strip and the strict schema. Both the spec-pure form (extensions
  // under metadata.comis) and the pre-migration top-level form converge here.
  // This site carries the real logger, so a pre-migration skill draws its single
  // deprecation warning here; the discovery/cache passes lift normalize-only. A
  // malformed metadata.comis fails the lift with an error naming the key.
  const rawFrontmatter = fmResult.value.frontmatter;
  const lifted = liftAuthoredFrontmatter(rawFrontmatter, { logger, skillName: name });
  if (!lifted.ok) {
    return err(lifted.error);
  }
  const frontmatter = lifted.value;
  const ns =
    typeof frontmatter["comis"] === "object" &&
    frontmatter["comis"] !== null &&
    !Array.isArray(frontmatter["comis"])
      ? (frontmatter["comis"] as Record<string, unknown>)
      : undefined;
  if (ns && ns["capability"] !== undefined) {
    // Logger omitted: discovery enrichment already emitted the WARN for
    // this file; a second identical line at load time is just noise.
    const cap = parseComisCapabilityDefensively(ns["capability"], name, undefined);
    if (cap === undefined) {
      delete (ns as Record<string, unknown>)["capability"];
    }
  }

  const manifestValidation = SkillManifestSchema.safeParse(frontmatter);
  if (!manifestValidation.success) {
    const issues = manifestValidation.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return err(new Error(`Manifest validation failed: ${issues}`));
  }
  const manifest = manifestValidation.data;

  // Sanitize body content
  const sanitized = sanitizeSkillBody(rawBody, config.promptSkills.maxBodyLength);

  // Validate sanitized body is non-empty
  if (!sanitized.body.trim()) {
    return err(new Error(`Prompt skill "${name}" has no content after sanitization`));
  }

  // Content scanning at load time only, not per-request
  const scanEnabled = config.contentScanning?.enabled ?? true;
  if (scanEnabled) {
    const scanResult = scanSkillContent(sanitized.body);
    if (!scanResult.clean) {
      // Diagnostic -- log warnings for each finding
      for (const finding of scanResult.findings) {
        logger?.warn(
          {
            skillName: name,
            ruleId: finding.ruleId,
            category: finding.category,
            severity: finding.severity,
            hint: "Review skill body for suspicious content",
            errorKind: "validation" as const,
          },
          `Content scan finding: ${finding.description}`,
        );
      }

      // Determine if any CRITICAL findings exist
      const hasCritical = scanResult.findings.some(f => f.severity === "CRITICAL");

      // Emit scan audit event with findings in metadata
      const scanAction = (config.contentScanning?.blockOnCritical && hasCritical)
        ? "skill.scan.reject" as const
        : "skill.scan" as const;

      emitSkillAudit(eventBus, {
        ...auditContext,
        skillName: name,
        action: scanAction,
        outcome: scanAction === "skill.scan.reject" ? "denied" : "success",
        metadata: {
          findingCount: scanResult.findings.length,
          hasCritical,
          findings: scanResult.findings.map(f => ({
            ruleId: f.ruleId,
            category: f.category,
            severity: f.severity,
          })),
        },
      });

      // blockOnCritical: return err() to prevent loading when explicitly enabled
      if (config.contentScanning?.blockOnCritical && hasCritical) {
        const criticalDetails = scanResult.findings
          .filter(f => f.severity === "CRITICAL")
          .map(f => `${f.ruleId} at line ${f.lineNumber}: "${f.matchedText}"`)
          .join("; ");
        return err(new Error(
          `Skill "${name}" blocked: CRITICAL content scan findings [${criticalDetails}]`,
        ));
      }
    }
  }

  // Emit audit event
  emitSkillAudit(eventBus, {
    ...auditContext,
    skillName: name,
    action: "skill.prompt.load",
    outcome: "success",
    metadata: {
      source: metadata.source,
      bodyLength: sanitized.body.length,
      htmlCommentsStripped: sanitized.htmlCommentsStripped,
      truncated: sanitized.truncated,
    },
  });

  // Construct and cache PromptSkillContent
  const promptSkill: PromptSkillContent = {
    name: metadata.name,
    description: metadata.description,
    body: sanitized.body,
    location: metadata.path,
    userInvocable: metadata.userInvocable,
    disableModelInvocation: metadata.disableModelInvocation,
    allowedTools: manifest.allowedTools,
    argumentHint: metadata.argumentHint,
    source: metadata.source,
  };

  promptCache.set(name, promptSkill);
  return ok(promptSkill);
}
