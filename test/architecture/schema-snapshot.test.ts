// SPDX-License-Identifier: Apache-2.0
/**
 * Schema-snapshot architecture test.
 *
 * Pins the JSON-Schema shape of McpConfigSchema + McpServerEntrySchema
 * to a per-schema snapshot file under __snapshots__/. Detects accidental
 * field reordering, removal, or rename across parallel worktrees.
 *
 * Mitigates schema-additions races.
 *
 * McpConfigSchema / McpServerEntrySchema cover the MCP-only shape;
 * SkillManifestSchema was added later (with the optional mcpServers field).
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

describe("schema-snapshot pins JSON-Schema shape", () => {
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

  // SkillManifestSchema lives in @comis/skills (with the optional
  // mcpServers field); the snapshot pin below is the live assertion.
  it("SkillManifestSchema JSON-Schema is stable (additive changes require snapshot update)", async () => {
    const schema = z.toJSONSchema(SkillManifestSchema, { reused: "inline", unrepresentable: "any" });
    await expect(JSON.stringify(schema, null, 2)).toMatchFileSnapshot(
      "./__snapshots__/SkillManifestSchema.json",
    );
  });

  // Pin the mcp-client shape — the JSON-Schema output captures the additive
  // `mcpClient` block with its three sub-fields. NOTE: Zod's `.refine` is a
  // runtime predicate and is NOT representable in JSON-Schema — the
  // `[scope_disjointness]` rule is regression-tested separately in
  // `packages/core/src/config/schema-gateway.test.ts`. This snapshot guards
  // the shape; the unit test guards the refine.
  it("GatewayTokenSchema JSON-Schema is stable (additive changes require snapshot update)", async () => {
    const schema = z.toJSONSchema(GatewayTokenSchema, { reused: "inline", unrepresentable: "any" });
    await expect(JSON.stringify(schema, null, 2)).toMatchFileSnapshot(
      "./__snapshots__/GatewayTokenSchema.json",
    );
  });
});
