// SPDX-License-Identifier: Apache-2.0
/**
 * Skill registry factory + closure-state.
 *
 * Owns:
 *   - createSkillRegistry factory body
 *   - Closure state: metadataMap, promptCache, cachedSnapshot, snapshotVersion
 *   - Closure helpers: checkRuntimeEligibility, doInit
 *   - Methods returned in the factory's object literal: init, getPromptSkill*,
 *     getUserInvocableSkillNames, getRelevantPromptSkills, getMetadataCount,
 *     getSnapshot, getSnapshotVersion, startWatching, getEligibleSkillNames,
 *     getPromptSkillCapabilities, initFromSdkSkills
 *
 * The level-2 loader (loadPromptSkillImpl) is delegated to
 * skill-registry-discovery.ts to keep this file under the per-leaf 500-line
 * cap.
 *
 * @module
 */

import type {
  PromptSkillCapability,
  SkillsConfig,
  ToolCapabilityMetadata,
  TypedEventBus,
} from "@comis/core";
import type { Result } from "@comis/shared";
import * as fs from "node:fs";
import { systemNowMs } from "@comis/core";
import { parseComisCapabilityDefensively } from "../../manifest/capability-parser.js";
import { liftAuthoredFrontmatter } from "../../manifest/lift.js";
import { parseFrontmatter } from "../../manifest/parser.js";
import {
  formatAvailableSkillsXml,
  type PromptSkillDescription,
} from "../../prompt/processor.js";
import { discoverSkills, type SkillMetadata, type SkillSource } from "../discovery.js";
import {
  evaluateSkillEligibility,
  type RuntimeEligibilityContext,
} from "../eligibility.js";
import {
  createSkillWatcher,
  type SkillWatcherHandle,
} from "../skill-watcher.js";
import {
  isSkillEligible,
  loadPromptSkillImpl,
  scoreRelevance,
  tokenize,
} from "./skill-registry-discovery.js";
import type {
  OperatorSkillHint,
  PromptSkillContent,
  SdkSkill,
  SkillRegistry,
  SkillSnapshot,
  SkillsLogger,
} from "./skill-registry-types.js";

/**
 * Resolve the EFFECTIVE `enableDynamicContext` for a single skill — the
 * authoritative per-skill resolution point.
 *
 * An imported skill's SKILL.md body is remote-authored and untrusted, so its
 * dynamic-context (shell-in-body) expansion is forced OFF regardless of the
 * global `promptSkills.enableDynamicContext` toggle: the imported trust tier
 * never runs body-expansion. Every other source defers to the global config
 * value.
 *
 * Any consumer that acts on dynamic-context expansion MUST read the effective
 * value from here rather than the raw global config, so the imported-tier
 * force-off cannot be bypassed by a caller that reads the global toggle
 * directly. Co-located with the `imported` source stamping (the same trust-tier
 * discriminator) so the two stay in lock-step.
 *
 * @param skillSource - The skill's resolved trust-tier source (the value
 *   `getPromptSkillDescriptions` stamps — `imported` for a provenance match).
 * @param config - The skills config carrying the global `promptSkills` toggle.
 * @returns `false` for an imported skill; otherwise the global config value.
 */
export function resolveEffectiveDynamicContext(
  skillSource: SkillSource | undefined,
  config: SkillsConfig,
): boolean {
  if (skillSource === "imported") return false;
  return config.promptSkills.enableDynamicContext;
}

/**
 * Create a skill registry with progressive disclosure.
 *
 * @param config - Skills configuration (discovery paths)
 * @param eventBus - Typed event bus for audit events
 * @param auditContext - Identity context for audit trail
 * @param logger - Optional discovery logger
 * @param eligibilityContext - Optional runtime-eligibility context
 * @param importedSkillNames - Optional lookup of skill names recorded in the
 *   provenance store (for this scope/agent). A matched skill is stamped
 *   `source: "imported"` — advisory DOWNWARD only: it can demote a skill to the
 *   imported tier, but its absence NEVER elevates one (an unmatched skill keeps
 *   its path-derived source). Evaluated fresh per description build so a just-
 *   completed import (which re-inits the registry) is reflected.
 * @returns SkillRegistry instance
 */
/** Shared empty imported-name set (avoids a per-build allocation when unwired). */
const EMPTY_IMPORTED_SET: ReadonlySet<string> = new Set<string>();

export function createSkillRegistry(
  config: SkillsConfig,
  eventBus: TypedEventBus,
  auditContext: { agentId: string; tenantId: string; userId: string },
  logger?: SkillsLogger,
  eligibilityContext?: RuntimeEligibilityContext,
  importedSkillNames?: () => ReadonlySet<string>,
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
      timestamp: systemNowMs(),
    });
  }

  return {
    init: doInit,

    async loadPromptSkill(name: string): Promise<Result<PromptSkillContent, Error>> {
      return loadPromptSkillImpl({
        name,
        metadataMap,
        promptCache,
        config,
        eventBus,
        auditContext,
        logger,
      });
    },

    getPromptSkillDescriptions(): PromptSkillDescription[] {
      const descriptions: PromptSkillDescription[] = [];
      // Provenance enrichment: a matched name is stamped `imported` (advisory
      // downward only — absence keeps the path-derived source). Read once per
      // build; a fail-safe empty store simply stamps nothing.
      const imported = importedSkillNames?.() ?? EMPTY_IMPORTED_SET;
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
          source: imported.has(metadata.name) ? "imported" : metadata.source,
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

    getAllMetadata(): readonly SkillMetadata[] {
      // Defensive shallow copy — consumers MUST NOT observe live mutations
      // when init() reruns discovery. The SkillMetadata elements themselves
      // are immutable per the readonly declaration in discovery.ts:53.
      return Array.from(metadataMap.values());
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
          // Re-discovery calls init() to refresh metadata and clear caches.
          // emitSkillAudit -> audit:event captures the per-skill reload lifecycle.
          doInit();
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

    getPromptSkillCapabilities(
      getOperatorHint: (skillName: string, skillKey?: string) => OperatorSkillHint | undefined,
    ): readonly PromptSkillCapability[] {
      const out: PromptSkillCapability[] = [];
      for (const metadata of metadataMap.values()) {
        // Filter chain -- mirrors getPromptSkillDescriptions PLUS the extra
        // disableModelInvocation filter (skills hidden from the model are
        // not capability-index entries).
        if (!isSkillEligible(metadata.name, config.promptSkills)) continue;
        if (!checkRuntimeEligibility(metadata)) continue;
        if (metadata.disableModelInvocation) continue;

        // Precedence:
        //   operator(skillKey) > operator(skillName) > comis.capability > fallback.
        const opByKey = metadata.skillKey
          ? getOperatorHint(metadata.name, metadata.skillKey)
          : undefined;
        const opByName = !opByKey ? getOperatorHint(metadata.name) : undefined;
        const operatorHint = opByKey ?? opByName;
        const comisHint: ToolCapabilityMetadata | undefined = metadata.capability;

        const cluster = operatorHint?.cluster ?? comisHint?.cluster;
        const summary =
          operatorHint?.description ?? comisHint?.summary ?? metadata.description;
        const rawReplaces =
          operatorHint?.replacesPackages ?? comisHint?.replacesPackages ?? [];

        out.push(
          Object.freeze({
            name: metadata.name,
            skillKey: metadata.skillKey,
            description: metadata.description,
            cluster,
            summary,
            replacesPackages: Object.freeze([...rawReplaces]),
            source: metadata.source,
          }),
        );
      }
      return Object.freeze(out);
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
        // Map SDK Skill source to Comis SkillSource. `learned` + `imported` are
        // carried through (both are stamped explicitly upstream, never derived);
        // anything else falls back to `workspace`.
        const source: SkillSource =
          sdkSkill.source === "bundled" ? "bundled"
            : sdkSkill.source === "local" ? "local"
              : sdkSkill.source === "learned" ? "learned"
                : sdkSkill.source === "imported" ? "imported"
                  : "workspace";

        // Start with SDK-provided fields
        let userInvocable = true;
        let argumentHint: string | undefined;
        let os: string[] | undefined;
        let requires: { bins: string[]; env: string[] } | undefined;
        let skillKey: string | undefined;
        let primaryEnv: string | undefined;
        let commandDispatch: string | undefined;
        let capability: ToolCapabilityMetadata | undefined;

        // Enrichment: read comis: namespace from skill file frontmatter
        try {
          const content = fs.readFileSync(sdkSkill.filePath, "utf-8");
          const fmResult = parseFrontmatter<Record<string, unknown>>(content);
          if (fmResult.ok) {
            // Normalize the authored carrier into the internal top-level shape
            // so the hand-reads below resolve for spec-pure skills too. No
            // logger: the load path owns the deprecation warning. A malformed
            // metadata.comis fails the lift; skip enrichment (SDK-provided fields
            // stand), matching the existing parse-failure path.
            const liftResult = liftAuthoredFrontmatter(fmResult.value.frontmatter, {});
            const obj: Record<string, unknown> = liftResult.ok ? liftResult.value : {};
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

            // Capability layer -- defensive parse. A typo or type mismatch
            // in the inner block returns undefined + emits a WARN; the skill
            // itself is NEVER hidden by malformed capability metadata.
            capability = parseComisCapabilityDefensively(
              ns?.["capability"],
              sdkSkill.name,
              logger,
            );
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
          capability,
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
        timestamp: systemNowMs(),
      });
    },
  };
}
