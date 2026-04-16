/**
 * Prompt skill registry with progressive disclosure (2 levels).
 *
 * Level 1 (init): Discover prompt skills from filesystem, store metadata in Map.
 * Level 2 (loadPromptSkill): Load prompt skill body, sanitize, cache.
 *
 * All skills are type "prompt".
 * Progressive disclosure ensures only relevant skills appear in the tool list,
 * and full loading only happens at execution time.
 *
 * @module
 */

import type { SkillsConfig, TypedEventBus } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import * as fs from "node:fs";
import { emitSkillAudit } from "../audit/skill-audit.js";
import { parseFrontmatter, parseSkillManifest } from "../manifest/parser.js";
import { formatAvailableSkillsXml, type PromptSkillDescription } from "../prompt/processor.js";
import { sanitizeSkillBody } from "../prompt/sanitizer.js";
import { scanSkillContent } from "../prompt/content-scanner.js";
import { discoverSkills, type SkillMetadata, type SkillSource } from "./discovery.js";
import { evaluateSkillEligibility, type RuntimeEligibilityContext } from "./eligibility.js";
import { createSkillWatcher, type SkillWatcherHandle } from "./skill-watcher.js";

/** Minimal pino-compatible logger interface for skills subsystem logging. */
interface SkillsLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Re-export SkillMetadata for consumers who import from the registry module. */
export type { SkillMetadata } from "./discovery.js";

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
   * Populate the registry from SDK-discovered skills instead of filesystem discovery.
   * Clears existing metadata, maps SDK Skill fields to Comis SkillMetadata,
   * enriches from comis: namespace in skill files, applies eligibility filtering,
   * and emits registry_reset event.
   * Uses SDK discovery as the base with Comis eligibility filtering applied.
   */
  initFromSdkSkills(sdkSkills: SdkSkill[]): void;
}

/** Re-export SkillWatcherHandle for consumers who import from the registry module. */
export type { SkillWatcherHandle } from "./skill-watcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tokenize a string into lowercase words (split on whitespace and common punctuation). */
function tokenize(text: string): string[] {
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
function isSkillEligible(
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
function scoreRelevance(queryTokens: Set<string>, skill: SkillMetadata): number {
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
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a skill registry with progressive disclosure.
 *
 * @param config - Skills configuration (discovery paths)
 * @param eventBus - Typed event bus for audit events
 * @param auditContext - Identity context for audit trail
 * @returns SkillRegistry instance
 */
export function createSkillRegistry(
  config: SkillsConfig,
  eventBus: TypedEventBus,
  auditContext: { agentId: string; tenantId: string; userId: string },
  logger?: SkillsLogger,
  eligibilityContext?: RuntimeEligibilityContext,
): SkillRegistry {
  // Level 1: metadata storage
  const metadataMap = new Map<string, SkillMetadata>();

  // Prompt skill cache (no AST/sandbox)
  const promptCache = new Map<string, PromptSkillContent>();

  // Snapshot cache: lazily built on first getSnapshot() call, invalidated on init()/reload()
  let cachedSnapshot: SkillSnapshot | null = null;
  let snapshotVersion = 0;

  /** Check runtime eligibility if context is available and enabled. Returns false if skill should be excluded. */
  function checkRuntimeEligibility(metadata: SkillMetadata): boolean {
    if (!eligibilityContext) return true;
    const runtimeEnabled = config.runtimeEligibility?.enabled ?? true;
    if (!runtimeEnabled) return true;
    const result = evaluateSkillEligibility(metadata, eligibilityContext);
    if (!result.eligible) {
      logger?.debug({ skillName: metadata.name, reason: result.reason }, "Skill excluded by runtime eligibility");
      return false;
    }
    return true;
  }

  /** Init implementation extracted for reuse by startWatching onReload callback. */
  function doInit(): void {
    const prevMetadataCount = metadataMap.size;
    const prevCacheCount = promptCache.size;
    metadataMap.clear();
    promptCache.clear();
    logger?.debug({ clearedMetadata: prevMetadataCount, clearedPromptCache: prevCacheCount }, "Registry caches cleared");

    const { skills: discovered, diagnostics } = discoverSkills(config.discoveryPaths, logger);
    for (const skill of discovered) {
      metadataMap.set(skill.name, skill);
    }
    logger?.info({ skillCount: discovered.length }, "Skills discovered");
    for (const diag of diagnostics) {
      if (diag.type === "collision") {
        logger?.warn({ collision: { winnerPath: diag.collision?.winnerPath, loserPath: diag.collision?.loserPath }, hint: "Remove duplicate skill definitions or rename to avoid collision", errorKind: "config" as const }, "Skill name collision");
      } else if (diag.type === "warning") {
        logger?.warn({ skillPath: diag.path, hint: "Check skill file format and manifest structure", errorKind: "validation" as const }, diag.message);
      }
    }

    // Pre-populate binary cache at init time (computed once, reused across requests)
    if (eligibilityContext) {
      const allBins = new Set<string>();
      for (const skill of discovered) {
        if (skill.requires?.bins) {
          for (const bin of skill.requires.bins) allBins.add(bin);
        }
      }
      if (allBins.size > 0) {
        eligibilityContext.populateBinaryCache([...allBins]);
        logger?.debug({ binCount: allBins.size, bins: [...allBins] }, "Binary availability cache populated");
      }
    }

    cachedSnapshot = null;
    snapshotVersion++;

    eventBus.emit("skill:registry_reset", {
      clearedMetadata: prevMetadataCount,
      clearedPromptCache: prevCacheCount,
      timestamp: Date.now(),
    });
  }

  return {
    init: doInit,

    async loadPromptSkill(name: string): Promise<Result<PromptSkillContent, Error>> {
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

      // Parse frontmatter to extract body
      const fmResult = parseFrontmatter(fileContent);
      if (!fmResult.ok) {
        return err(fmResult.error);
      }
      const rawBody = fmResult.value.body;

      // Validate body is non-empty
      if (!rawBody.trim()) {
        return err(new Error(`Prompt skill "${name}" has no body content`));
      }

      // Parse full manifest for allowedTools
      const manifestResult = parseSkillManifest(fileContent);
      if (!manifestResult.ok) {
        return err(manifestResult.error);
      }

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
        allowedTools: manifestResult.value.allowedTools,
        argumentHint: metadata.argumentHint,
        source: metadata.source,
      };

      promptCache.set(name, promptSkill);
      return ok(promptSkill);
    },

    getPromptSkillDescriptions(): PromptSkillDescription[] {
      const descriptions: PromptSkillDescription[] = [];
      for (const metadata of metadataMap.values()) {
        // Eligibility filtering: allowedSkills/deniedSkills from config
        if (!isSkillEligible(metadata.name, config.promptSkills)) continue;
        // Runtime eligibility: os, binary, env var checks
        if (!checkRuntimeEligibility(metadata)) continue;
        descriptions.push({
          name: metadata.name,
          description: metadata.description,
          location: metadata.path,
          disableModelInvocation: metadata.disableModelInvocation || undefined,
          source: metadata.source,
        });
      }
      return descriptions;
    },

    getUserInvocableSkillNames(): Set<string> {
      const names = new Set<string>();
      for (const metadata of metadataMap.values()) {
        if (metadata.userInvocable) {
          // Eligibility filtering: allowedSkills/deniedSkills from config
          if (!isSkillEligible(metadata.name, config.promptSkills)) continue;
          // Runtime eligibility: os, binary, env var checks
          if (!checkRuntimeEligibility(metadata)) continue;
          names.add(metadata.name);
        }
      }
      return names;
    },

    getRelevantPromptSkills(query: string, maxResults?: number): SkillMetadata[] {
      const limit = maxResults ?? config.promptSkills.maxAutoInject;
      if (metadataMap.size === 0) return [];
      const queryTokens = new Set(tokenize(query));
      const queryLower = query.toLowerCase();
      const scored: { skill: SkillMetadata; score: number }[] = [];

      for (const skill of metadataMap.values()) {
        // Eligibility filtering: allowedSkills/deniedSkills from config
        if (!isSkillEligible(skill.name, config.promptSkills)) continue;
        // Runtime eligibility: os, binary, env var checks
        if (!checkRuntimeEligibility(skill)) continue;
        let score = scoreRelevance(queryTokens, skill);
        if (queryLower.includes(skill.name.toLowerCase())) score += 10;
        if (score > 0) scored.push({ skill, score });
      }

      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.skill.name.localeCompare(b.skill.name);
      });
      return scored.slice(0, limit).map((s) => s.skill);
    },

    getMetadataCount(): number {
      return metadataMap.size;
    },

    getSnapshot(): SkillSnapshot {
      if (cachedSnapshot === null) {
        const descriptions = this.getPromptSkillDescriptions();
        const prompt = formatAvailableSkillsXml(descriptions);
        cachedSnapshot = { prompt, skills: descriptions, version: snapshotVersion };
      }
      return cachedSnapshot;
    },

    getSnapshotVersion(): number {
      return snapshotVersion;
    },

    startWatching(debounceMs: number): SkillWatcherHandle {
      return createSkillWatcher({
        discoveryPaths: config.discoveryPaths,
        debounceMs,
        onReload: () => {
          // Re-discovery calls init() to refresh metadata and clear caches
          doInit();
          // Emit skills:reloaded event after successful re-discovery
          eventBus.emit("skills:reloaded", {
            agentId: auditContext.agentId,
            skillCount: metadataMap.size,
            timestamp: Date.now(),
          });
        },
        logger,
      });
    },

    getEligibleSkillNames(): Set<string> {
      const names = new Set<string>();
      for (const metadata of metadataMap.values()) {
        if (!isSkillEligible(metadata.name, config.promptSkills)) continue;
        if (!checkRuntimeEligibility(metadata)) continue;
        names.add(metadata.name);
      }
      return names;
    },

    initFromSdkSkills(sdkSkills: SdkSkill[]): void {
      const prevMetadataCount = metadataMap.size;
      const prevCacheCount = promptCache.size;
      metadataMap.clear();
      promptCache.clear();
      logger?.debug(
        { clearedMetadata: prevMetadataCount, clearedPromptCache: prevCacheCount },
        "Registry caches cleared (SDK init)",
      );

      for (const sdkSkill of sdkSkills) {
        // Map SDK Skill source to Comis SkillSource
        const source: SkillSource =
          sdkSkill.source === "bundled" ? "bundled"
            : sdkSkill.source === "local" ? "local"
              : "workspace";

        // Start with SDK-provided fields
        let userInvocable = true;
        let argumentHint: string | undefined;
        let os: string[] | undefined;
        let requires: { bins: string[]; env: string[] } | undefined;
        let skillKey: string | undefined;
        let primaryEnv: string | undefined;
        let commandDispatch: string | undefined;

        // Enrichment: read comis: namespace from skill file frontmatter
        try {
          const content = fs.readFileSync(sdkSkill.filePath, "utf-8");
          const fmResult = parseFrontmatter<Record<string, unknown>>(content);
          if (fmResult.ok) {
            const obj = fmResult.value.frontmatter;
            const ns =
              typeof obj["comis"] === "object" &&
              obj["comis"] !== null &&
              !Array.isArray(obj["comis"])
                ? (obj["comis"] as Record<string, unknown>)
                : undefined;

            // userInvocable from top-level frontmatter
            if (typeof obj["userInvocable"] === "boolean") {
              userInvocable = obj["userInvocable"];
            }

            // argumentHint from top-level frontmatter
            if (typeof obj["argumentHint"] === "string") {
              argumentHint = obj["argumentHint"];
            }

            // os -- from comis: namespace only
            const rawOs = ns?.["os"];
            if (typeof rawOs === "string") {
              os = [rawOs.toLowerCase()];
            } else if (Array.isArray(rawOs)) {
              os = rawOs
                .filter((v): v is string => typeof v === "string")
                .map((v) => v.toLowerCase());
            }

            // requires -- from comis: namespace only
            const rawRequires = ns?.["requires"];
            if (
              rawRequires &&
              typeof rawRequires === "object" &&
              !Array.isArray(rawRequires)
            ) {
              const r = rawRequires as Record<string, unknown>;
              const bins = Array.isArray(r["bins"])
                ? r["bins"].filter((v): v is string => typeof v === "string")
                : [];
              const env = Array.isArray(r["env"])
                ? r["env"].filter((v): v is string => typeof v === "string")
                : [];
              requires = { bins, env };
            }

            // skill-key -- from comis: namespace only
            const rawSkillKey = ns?.["skill-key"];
            if (typeof rawSkillKey === "string") {
              skillKey =
                rawSkillKey
                  .toLowerCase()
                  .replace(/\s+/g, "-")
                  .replace(/[^a-z0-9-]/g, "")
                  .replace(/^-+|-+$/g, "") || undefined;
            }

            // primary-env -- from comis: namespace only
            const rawPrimaryEnv = ns?.["primary-env"];
            if (typeof rawPrimaryEnv === "string") primaryEnv = rawPrimaryEnv;

            // command-dispatch -- from comis: namespace only
            const rawCommandDispatch = ns?.["command-dispatch"];
            if (typeof rawCommandDispatch === "string") {
              commandDispatch = rawCommandDispatch;
            }
          }
        } catch {
          // Non-fatal: enrichment failure means we use SDK-provided fields only
          logger?.debug(
            { skillName: sdkSkill.name, filePath: sdkSkill.filePath },
            "Skill file enrichment failed (non-fatal)",
          );
        }

        const metadata: SkillMetadata = {
          name: sdkSkill.name,
          description: sdkSkill.description,
          path: sdkSkill.baseDir,
          source,
          type: "prompt",
          userInvocable,
          disableModelInvocation: sdkSkill.disableModelInvocation,
          argumentHint,
          filePath: sdkSkill.filePath,
          os,
          requires,
          skillKey,
          primaryEnv,
          commandDispatch,
        };

        // Apply eligibility filtering during population
        if (!isSkillEligible(metadata.name, config.promptSkills)) continue;
        if (!checkRuntimeEligibility(metadata)) continue;

        metadataMap.set(metadata.name, metadata);
      }

      logger?.info(
        { sdkSkillCount: sdkSkills.length, eligibleCount: metadataMap.size },
        "Registry populated from SDK skills",
      );

      // Pre-populate binary cache (same as doInit)
      if (eligibilityContext) {
        const allBins = new Set<string>();
        for (const skill of metadataMap.values()) {
          if (skill.requires?.bins) {
            for (const bin of skill.requires.bins) allBins.add(bin);
          }
        }
        if (allBins.size > 0) {
          eligibilityContext.populateBinaryCache([...allBins]);
        }
      }

      cachedSnapshot = null;
      snapshotVersion++;

      eventBus.emit("skill:registry_reset", {
        clearedMetadata: prevMetadataCount,
        clearedPromptCache: prevCacheCount,
        timestamp: Date.now(),
      });
    },
  };
}
