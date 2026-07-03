// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { getConfigSchema, getConfigSections } from "./schema-serializer.js";
import { getFieldMetadata } from "./field-metadata.js";
import { MANAGED_SECTIONS, getManagedSectionRedirect } from "./managed-sections.js";
import { stableStringify } from "../../../../test/support/stable-stringify.js";

/**
 * Section-registry parity snapshots.
 *
 * Lock the byte-identical output of the four config-metadata public-API
 * functions. Any byte change to `getConfigSchema`, `getConfigSections`,
 * `getFieldMetadata`, `MANAGED_SECTIONS`, or `getManagedSectionRedirect`
 * outputs alters agent-visible behavior (gateway/patch error hints,
 * configure wizard field rendering, RPC config.get/config.list-sections
 * surface) and FAILS this test — see managed-sections.ts
 * formatRedirectHint for the error-hint flow that cannot drift.
 *
 * The snapshots pin the exact byte output of the shared `stableStringify`
 * helper from `test/support/stable-stringify.ts` — a format change there
 * fails every snapshot here.
 */

describe("section-registry parity", () => {
  describe("schema-serializer view", () => {
    it("getConfigSchema() — full schema", () => {
      expect(stableStringify(getConfigSchema())).toMatchSnapshot();
    });
    it("getConfigSections() returns the canonical section list", () => {
      expect(stableStringify(getConfigSections())).toMatchSnapshot();
    });
    // The 17 schema-serializer-view sections — each as its own snapshot for reviewability.
    // `diagnostics` sits between `monitoring` and `browser`.
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
      "diagnostics",
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
    // The 19 field-metadata-view sections.
    // `diagnostics` sits between `monitoring` and `plugins`.
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
      "diagnostics",
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
    it("MANAGED_SECTIONS exposes the canonical 5-entry array", () => {
      expect(stableStringify(MANAGED_SECTIONS)).toMatchSnapshot();
    });
    // Per-entry redirect lookup — covers the longest-prefix-match contract.
    for (const probe of [
      { section: "integrations", key: "mcp.servers" },
      { section: "gateway", key: "tokens" },
      { section: "providers", key: undefined },
      { section: "channels", key: undefined },
      { section: "agents", key: undefined },
      // Negative-case probes — these MUST return undefined.
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
