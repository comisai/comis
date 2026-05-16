// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { getConfigSchema, getConfigSections } from "./schema-serializer.js";
import { getFieldMetadata } from "./field-metadata.js";
import { MANAGED_SECTIONS, getManagedSectionRedirect } from "./managed-sections.js";
import { stableStringify } from "../../../../test/support/stable-stringify.js";

/**
 * Phase 30 parity protection — CONFIG-DELIV-03.
 *
 * These snapshots lock the byte-identical output of the four config-metadata
 * public-API functions BEFORE the Phase 30 SECTION_REGISTRY refactor lands.
 *
 * The post-refactor behavior MUST match these snapshots exactly. Any byte
 * change to `getConfigSchema`, `getConfigSections`, `getFieldMetadata`,
 * `MANAGED_SECTIONS`, or `getManagedSectionRedirect` outputs alters
 * agent-visible behavior (gateway/patch error hints, configure wizard
 * field rendering, RPC config.get/config.list-sections surface) and FAILS
 * this test — see managed-sections.ts formatRedirectHint for the error-hint
 * flow that cannot drift.
 *
 * Captured: at end of Phase 30 plan 01 (after the worktree base is on the
 * architecture-redesign branch which already contains every Phase 28 + 29
 * change). Subsequent Phase 30 plans (02-07) must keep this test green.
 *
 * Phase 43 Wave 1 update (FILE-SPLIT-17): the inline `stableStringify`
 * helper was extracted to `test/support/stable-stringify.ts` per AGENTS.md
 * §2.3 rule-of-three (17 total consumers after Phase 43 adds 16 parity
 * test files). The helper is byte-identical to the prior inline body —
 * snapshots remain stable.
 */

describe("section-registry parity (CONFIG-DELIV-03)", () => {
  describe("schema-serializer view", () => {
    it("getConfigSchema() — full schema", () => {
      expect(stableStringify(getConfigSchema())).toMatchSnapshot();
    });
    it("getConfigSections()", () => {
      expect(stableStringify(getConfigSections())).toMatchSnapshot();
    });
    // The 16 schema-serializer-view sections — each as its own snapshot for reviewability.
    for (const section of [
      "agents",
      "channels",
      "memory",
      "security",
      "routing",
      "daemon",
      "scheduler",
      "gateway",
      "integrations",
      "monitoring",
      "browser",
      "models",
      "providers",
      "messages",
      "approvals",
      "tooling",
    ]) {
      it(`getConfigSchema("${section}")`, () => {
        expect(stableStringify(getConfigSchema(section))).toMatchSnapshot();
      });
    }
  });

  describe("field-metadata view", () => {
    it("getFieldMetadata() — full flat array", () => {
      expect(stableStringify(getFieldMetadata())).toMatchSnapshot();
    });
    // The 18 field-metadata-view sections.
    for (const section of [
      "agents",
      "channels",
      "memory",
      "security",
      "routing",
      "daemon",
      "scheduler",
      "gateway",
      "integrations",
      "monitoring",
      "plugins",
      "queue",
      "streaming",
      "autoReplyEngine",
      "sendPolicy",
      "embedding",
      "envelope",
      "tooling",
    ]) {
      it(`getFieldMetadata("${section}")`, () => {
        expect(stableStringify(getFieldMetadata(section))).toMatchSnapshot();
      });
    }
  });

  describe("managed-sections view", () => {
    it("MANAGED_SECTIONS — 5-entry array", () => {
      expect(stableStringify(MANAGED_SECTIONS)).toMatchSnapshot();
    });
    // Per-entry redirect lookup — covers the longest-prefix-match contract.
    for (const probe of [
      { section: "integrations", key: "mcp.servers" },
      { section: "gateway", key: "tokens" },
      { section: "providers", key: undefined },
      { section: "channels", key: undefined },
      { section: "agents", key: undefined },
      // Negative-case probes — these MUST return undefined post-refactor too.
      { section: "memory", key: undefined },
      { section: "security", key: undefined },
      { section: "nonexistent", key: undefined },
    ]) {
      it(`getManagedSectionRedirect("${probe.section}", "${probe.key ?? "(no key)"}")`, () => {
        expect(stableStringify(getManagedSectionRedirect(probe.section, probe.key))).toMatchSnapshot();
      });
    }
  });
});
