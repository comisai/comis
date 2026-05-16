// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { stableStringify } from "../../../../../test/support/stable-stringify.js";
import { SkillsConfigSchema } from "@comis/core";
import { createMockEventBus } from "../../../../../test/support/mock-event-bus.js";
import {
  createSkillRegistry,
  type SkillRegistry,
  type SkillSnapshot,
  type SdkSkill,
  type PromptSkillContent,
} from "./skill-registry.js";

/**
 * Phase 43 parity protection (FILE-SPLIT-11).
 *
 * Locks the byte-identical output of `skill-registry.ts`'s public-API
 * functions BEFORE the Phase 43 split refactor lands. Post-refactor
 * behavior MUST match these snapshots exactly. Any byte change fails
 * the per-commit gate.
 *
 * Per FILE-SPLIT-17 + OQ-5 (progressive deletion), this file is DELETED
 * in the same commit as the source-file split, once each new module has
 * ≥1 independent behavior test per leaf.
 */

// Silence the `<reference>` shape check on inert exported types - they're
// already imported (above) for type-only purposes; this ensures TS/ESLint
// don't drop them.
type _SnapshotShapeOnly = SkillSnapshot;
type _SkillRegistryShapeOnly = SkillRegistry;
type _SdkSkillShapeOnly = SdkSkill;
type _PromptSkillContentShapeOnly = PromptSkillContent;

const auditContext = {
  agentId: "agent-parity",
  tenantId: "tenant-parity",
  userId: "user-parity",
};

function buildConfig() {
  return SkillsConfigSchema.parse({});
}

describe("skill-registry parity (FILE-SPLIT-11)", () => {
  describe("public API surface", () => {
    it("createSkillRegistry: factory returns expected handle shape", () => {
      const registry = createSkillRegistry(
        buildConfig(),
        createMockEventBus(),
        auditContext,
      );
      const keys = Object.keys(registry).sort();
      const shape: Record<string, string> = {};
      for (const key of keys) {
        shape[key] = typeof (registry as unknown as Record<string, unknown>)[key];
      }
      expect(stableStringify({ keys, shape })).toMatchSnapshot();
    });
  });

  describe("behavior matrix: representative inputs", () => {
    it("createSkillRegistry: empty registry list returns empty array", () => {
      const registry = createSkillRegistry(
        buildConfig(),
        createMockEventBus(),
        auditContext,
      );
      const result = {
        descriptionsBeforeInit: registry.getPromptSkillDescriptions(),
        metadataCountBeforeInit: registry.getMetadataCount(),
        userInvocableBeforeInit: Array.from(
          registry.getUserInvocableSkillNames(),
        ).sort(),
        eligibleBeforeInit: Array.from(
          registry.getEligibleSkillNames(),
        ).sort(),
      };
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("createSkillRegistry: getRelevantPromptSkills returns empty when no skills discovered", () => {
      const registry = createSkillRegistry(
        buildConfig(),
        createMockEventBus(),
        auditContext,
      );
      const cases = {
        empty_query: registry.getRelevantPromptSkills("", 5),
        short_query: registry.getRelevantPromptSkills("write code", 5),
        long_query: registry.getRelevantPromptSkills(
          "this is a really long natural language description of a task",
          3,
        ),
      };
      expect(stableStringify(cases)).toMatchSnapshot();
    });

    it("createSkillRegistry: initFromSdkSkills with empty list yields empty registry", () => {
      const bus = createMockEventBus();
      const registry = createSkillRegistry(
        buildConfig(),
        bus,
        auditContext,
      );
      registry.initFromSdkSkills([]);
      const result = {
        metadataCount: registry.getMetadataCount(),
        descriptions: registry.getPromptSkillDescriptions(),
        userInvocable: Array.from(registry.getUserInvocableSkillNames()).sort(),
        eligible: Array.from(registry.getEligibleSkillNames()).sort(),
      };
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("createSkillRegistry: getSnapshot returns prompt + skills + version", () => {
      const registry = createSkillRegistry(
        buildConfig(),
        createMockEventBus(),
        auditContext,
      );
      const snap = registry.getSnapshot();
      const result = {
        prompt: snap.prompt,
        skills: snap.skills,
        version: snap.version,
        versionAccessor: registry.getSnapshotVersion(),
      };
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("createSkillRegistry: getPromptSkillCapabilities returns empty array when registry is empty", () => {
      const registry = createSkillRegistry(
        buildConfig(),
        createMockEventBus(),
        auditContext,
      );
      const capabilities = registry.getPromptSkillCapabilities(
        () => undefined,
      );
      expect(
        stableStringify({
          length: capabilities.length,
          frozen: Object.isFrozen(capabilities),
          entries: capabilities,
        }),
      ).toMatchSnapshot();
    });

    it("createSkillRegistry: loadPromptSkill returns error for unknown name", async () => {
      const registry = createSkillRegistry(
        buildConfig(),
        createMockEventBus(),
        auditContext,
      );
      const result = await registry.loadPromptSkill("nonexistent");
      expect(
        stableStringify({
          ok: result.ok,
          errorMessage: result.ok ? null : result.error.message,
        }),
      ).toMatchSnapshot();
    });
  });
});
