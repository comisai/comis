// SPDX-License-Identifier: Apache-2.0
/**
 * CI-03 — schema-snapshot architecture test.
 *
 * Pins the JSON-Schema shape of McpConfigSchema + McpServerEntrySchema
 * to a per-schema snapshot file under __snapshots__/. Detects accidental
 * field reordering, removal, or rename across parallel phase worktrees.
 * Mitigates X-P2 (schema-additions race per Phase 63 RESEARCH.md para 11).
 *
 * Phase 63 lands the MCP-only shape; Phase 68 BUNDLE-01 extended this to
 * SkillManifestSchema (Plan 02 Task 4). The pre-Phase-68 placeholder was a
 * structured TODO hook that mirrored the McpConfigSchema / McpServerEntrySchema
 * snapshot assertions; the live SkillManifestSchema pin below replaces it.
 *
 * `z.toJSONSchema` options match the canonical production call in
 * `packages/core/src/config/schema-serializer.ts` so the snapshot equals
 * what `getConfigSchema()` emits to web clients.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  GatewayTokenSchema,
  McpConfigSchema,
  McpServerEntrySchema,
} from "@comis/core";
import { SkillManifestSchema } from "@comis/skills";

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

  // Phase 68 BUNDLE-01 wired this in Plan 02 Task 4. The pre-Phase-68 form of
  // this test was the structured TODO hook required by CI-03 in REQUIREMENTS.md.
  // Now that SkillManifestSchema lives in @comis/skills (with the optional
  // mcpServers field added in Plan 02 Task 1), the snapshot pin is real.
  it("SkillManifestSchema JSON-Schema is stable (additive changes require snapshot update)", async () => {
    const schema = z.toJSONSchema(SkillManifestSchema, { reused: "inline", unrepresentable: "any" });
    await expect(JSON.stringify(schema, null, 2)).toMatchFileSnapshot(
      "./__snapshots__/SkillManifestSchema.json",
    );
  });

  // Phase 69 SERVE-02 (Plan 01 Task 3) — pin the new mcp-client shape.
  // The JSON-Schema output here captures the additive `mcpClient` block with its
  // three sub-fields. NOTE: Zod's `.refine` is a runtime predicate and is NOT
  // representable in JSON-Schema — the `[scope_disjointness]` rule is regression-
  // tested separately in `packages/core/src/config/schema-gateway.test.ts`. This
  // snapshot guards the shape; the unit test guards the refine.
  it("GatewayTokenSchema JSON-Schema is stable (additive changes require snapshot update)", async () => {
    const schema = z.toJSONSchema(GatewayTokenSchema, { reused: "inline", unrepresentable: "any" });
    await expect(JSON.stringify(schema, null, 2)).toMatchFileSnapshot(
      "./__snapshots__/GatewayTokenSchema.json",
    );
  });
});
