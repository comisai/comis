// SPDX-License-Identifier: Apache-2.0
/**
 * CI-03 — schema-snapshot architecture test.
 *
 * Pins the JSON-Schema shape of McpConfigSchema + McpServerEntrySchema
 * to a per-schema snapshot file under __snapshots__/. Detects accidental
 * field reordering, removal, or rename across parallel phase worktrees.
 * Mitigates X-P2 (schema-additions race per Phase 63 RESEARCH.md para 11).
 *
 * Phase 63 lands the MCP-only shape; Phase 68 BUNDLE-01 will extend to
 * SkillManifestSchema when that schema lands. The `it.skip` placeholder
 * below is the structured extension hook — Phase 68 replaces it with a
 * real `it(...)` that mirrors the McpConfigSchema / McpServerEntrySchema
 * snapshot assertions.
 *
 * `z.toJSONSchema` options match the canonical production call in
 * `packages/core/src/config/schema-serializer.ts` so the snapshot equals
 * what `getConfigSchema()` emits to web clients.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpConfigSchema, McpServerEntrySchema } from "@comis/core";

describe("CI-03 — schema-snapshot pins JSON-Schema shape across phases", () => {
  it("McpConfigSchema JSON-Schema is stable (additive changes require snapshot update)", async () => {
    const schema = z.toJSONSchema(McpConfigSchema, { reused: "inline", unrepresentable: "any" });
    await expect(JSON.stringify(schema, null, 2)).toMatchFileSnapshot(
      "./__snapshots__/McpConfigSchema.json",
    );
  });

  it("McpServerEntrySchema JSON-Schema is stable (additive changes require snapshot update)", async () => {
    const schema = z.toJSONSchema(McpServerEntrySchema, { reused: "inline", unrepresentable: "any" });
    await expect(JSON.stringify(schema, null, 2)).toMatchFileSnapshot(
      "./__snapshots__/McpServerEntrySchema.json",
    );
  });

  // CI-03 future extension: SkillManifestSchema is introduced in Phase 68 (BUNDLE-01).
  // When that schema lands, replace this `it.skip` with a full `it()` that mirrors
  // the McpConfigSchema / McpServerEntrySchema snapshot assertions above (same
  // `z.toJSONSchema(..., { reused: "inline", unrepresentable: "any" })` options;
  // same `toMatchFileSnapshot("./__snapshots__/SkillManifestSchema.json")` shape).
  // DO NOT delete this placeholder — it is the structured TODO hook required by
  // CI-03 in REQUIREMENTS.md.
  it.skip("pins SkillManifestSchema (Phase 68 BUNDLE-01 wires this)", () => {
    // placeholder — see Phase 68 BUNDLE-01
  });
});
