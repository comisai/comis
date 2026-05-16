// SPDX-License-Identifier: Apache-2.0
/**
 * Skill registry module (Phase 43 split per FILE-SPLIT-11).
 *
 * Barrel re-export of the canonical public API of the former
 * skill-registry.ts (813L) monolith. No aliases — every export keeps its
 * canonical name. Layer order:
 *   - skill-registry-types.ts (pure type declarations + SkillMetadata /
 *     SkillWatcherHandle re-exports)
 *   - skill-registry-discovery.ts (pure helpers: tokenize, isSkillEligible,
 *     scoreRelevance) + loadPromptSkillImpl (factory-body extraction for the
 *     level-2 loader to keep cache.ts under the 500-line cap)
 *   - skill-registry-cache.ts (createSkillRegistry factory + closure state
 *     + remaining methods)
 *
 * @module
 */

// Types layer
export type {
  PromptSkillContent,
  SkillSnapshot,
  SdkSkill,
  SkillRegistry,
  SkillMetadata,
  SkillWatcherHandle,
} from "./skill-registry-types.js";

// Factory + closure state
export { createSkillRegistry } from "./skill-registry-cache.js";
