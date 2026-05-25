// SPDX-License-Identifier: Apache-2.0
/**
 * Schema-snapshot architecture test.
 *
 * Pins the JSON-Schema shape of McpConfigSchema + McpServerEntrySchema
 * to a per-schema snapshot file under __snapshots__/. Detects accidental
 * field reordering, removal, or rename across parallel worktrees.
 *
 * The MCP-only shape lands first; the `it.skip` placeholder below is the
 * structured extension hook for SkillManifestSchema when that schema lands.
 * Replace it with a real `it(...)` that mirrors the McpConfigSchema /
 * McpServerEntrySchema snapshot assertions.
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

describe("schema-snapshot pins JSON-Schema shape across versions", () => {
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

  // Future extension: when SkillManifestSchema lands, replace this `it.skip`
  // with a full `it()` that mirrors the McpConfigSchema / McpServerEntrySchema
  // snapshot assertions above (same
  // `z.toJSONSchema(..., { reused: "inline", unrepresentable: "any" })` options;
  // same `toMatchFileSnapshot("./__snapshots__/SkillManifestSchema.json")` shape).
  // DO NOT delete this placeholder — it is the structured TODO hook for the
  // skill manifest schema.
  it.skip("pins SkillManifestSchema (wires once the schema lands)", () => {
    // placeholder — see future skill manifest work
  });
});
