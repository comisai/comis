// SPDX-License-Identifier: Apache-2.0
/**
 * Skills management tool: multi-action tool for prompt skill lifecycle.
 *
 * Supports 5 actions: list, import, delete, create, update.
 * Destructive/mutating actions (import, delete, create, update) require
 * approval via the ApprovalGate.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to skills.* RPC handlers via rpcCall.
 *
 * @module
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ApprovalGate } from "@comis/core";
import { registerActivityLabelSpec } from "@comis/core";
import { readStringParam, readBooleanParam } from "../tool-helpers.js";
import { createAdminManageTool } from "../admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

// Activity label spec (§17.6). Descriptor name == emitted name.
// Per-action overrides use the tool's REAL action enum.
registerActivityLabelSpec("skills_manage", {
  semanticPhase: "tool",
  label: "managing skills",
  actions: {
    list: { label: "listing skills" },
    import: { label: "importing skill" },
    delete: { label: "deleting skill" },
    create: { label: "creating skill" },
    update: { label: "updating skill" },
  },
});

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const SkillsManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("import"),
      Type.Literal("delete"),
      Type.Literal("create"),
      Type.Literal("update"),
    ],
    { description: "Skill management action. Valid values: list (show installed skills), import (install from GitHub URL), delete (remove skill by name), create (create new skill from content), update (modify existing skill content)" },
  ),
  url: Type.Optional(
    Type.String({
      description: "GitHub directory URL to import from (import action, source=github). One of url or archiveUrl is required for import.",
    }),
  ),
  source: Type.Optional(
    Type.Union(
      [Type.Literal("github"), Type.Literal("archive"), Type.Literal("wellknown"), Type.Literal("clawhub")],
      {
        description: "Import acquisition channel (import action). 'github' fetches a directory URL; 'archive' fetches a .skill/zip/tar archive URL; 'wellknown' resolves a skill by name from an allowlisted registry's well-known index; 'clawhub' resolves an @owner/slug identifier from ClawHub via the install-resolver — the scan verdict is checked before the release downloads. Defaults to github when a url is given.",
      },
    ),
  ),
  archiveUrl: Type.Optional(
    Type.String({
      description: "Archive URL to import from (import action, source=archive). Fetched size-capped over the SSRF guard, then safely unpacked.",
    }),
  ),
  registry: Type.Optional(
    Type.String({
      description: "Registry origin (https://host[:port]) — required with source=wellknown. Must be allowlisted in skills.import.registries; a non-allowlisted registry refuses flatly.",
    }),
  ),
  confirm: Type.Optional(
    Type.Boolean({
      description: "Import action: confirm the warnable classes on an import — a re-import that diverges from the pinned content hash of a prior import of the same source, and/or an import from a non-official registry publisher. A single confirm acknowledges both. Does NOT override a name collision on an unprovenanced or foreign-source skill (delete it first), nor a blocking registry scan verdict.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: "Skill name. Required for delete, create, and update actions. For import with source=wellknown it is the registry index-lookup key (which advertised skill to fetch) and does not override the installed manifest name. For import with source=clawhub it is the @owner/slug ClawHub identifier.",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description: "Full SKILL.md content including frontmatter. Required for create and update actions. The agent should generate complete SKILL.md content with --- frontmatter --- and body.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Skill description for frontmatter. Optional for create (overrides frontmatter description if provided).",
    }),
  ),
  scope: Type.Optional(
    Type.Union(
      [Type.Literal("local"), Type.Literal("shared")],
      {
        default: "local",
        description:
          "Skill scope (default: local). Valid values: local (calling agent's workspace), " +
          "shared (global skills visible to all agents).",
      },
    ),
  ),
});

const VALID_ACTIONS = ["list", "import", "delete", "create", "update"] as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a skills management tool with 5 actions.
 *
 * Actions:
 * - **list** -- List all installed prompt skills with metadata
 * - **import** -- Import skills from a GitHub directory URL (requires approval)
 * - **delete** -- Delete a skill by name (requires approval)
 * - **create** -- Create a new skill from SKILL.md content (requires approval)
 * - **update** -- Update an existing non-bundled skill's content (requires approval)
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @param approvalGate - Optional approval gate for mutating actions
 * @returns AgentTool implementing the skills management interface
 */
export function createSkillsManageTool(
  rpcCall: RpcCall,
  approvalGate?: ApprovalGate,
): AgentTool<typeof SkillsManageToolParams> {
  return createAdminManageTool(
    {
      name: "skills_manage",
      label: "Skills Management",
      description:
        "Manage prompt skills: list, import, delete, create, update.",
      parameters: SkillsManageToolParams,
      validActions: VALID_ACTIONS,
      rpcPrefix: "skills",
      gatedActions: ["import", "delete", "create", "update"],
      actionOverrides: {
        async list(_p, rpcCall, ctx) {
          return rpcCall("skills.list", { _trustLevel: ctx.trustLevel });
        },
        async import(p, rpcCall, ctx) {
          // Archive/registry imports carry no url, so every field is optional
          // here; the handler validates that a usable source is present. For
          // source=wellknown the registry origin + name (the index-lookup key)
          // are forwarded. No `force` is threaded — the collision override runs
          // only via confirm.
          const url = readStringParam(p, "url", false);
          const source = readStringParam(p, "source", false);
          const archiveUrl = readStringParam(p, "archiveUrl", false);
          const registry = readStringParam(p, "registry", false);
          const name = readStringParam(p, "name", false);
          const scope = readStringParam(p, "scope", false) ?? "local";
          const confirm = readBooleanParam(p, "confirm", false);
          return rpcCall("skills.import", {
            ...(url !== undefined && { url }),
            ...(source !== undefined && { source }),
            ...(archiveUrl !== undefined && { archiveUrl }),
            ...(registry !== undefined && { registry }),
            ...(name !== undefined && { name }),
            scope,
            ...(confirm !== undefined && { confirm }),
            _trustLevel: ctx.trustLevel,
          });
        },
        async delete(p, rpcCall, ctx) {
          const name = readStringParam(p, "name");
          const scope = readStringParam(p, "scope", false) ?? "local";
          return rpcCall("skills.delete", { name, scope, _trustLevel: ctx.trustLevel });
        },
        async create(p, rpcCall, ctx) {
          const name = readStringParam(p, "name");
          const content = readStringParam(p, "content");
          const scope = readStringParam(p, "scope", false) ?? "local";
          const description = readStringParam(p, "description", false);
          return rpcCall("skills.create", {
            name, content, scope, description,
            _trustLevel: ctx.trustLevel,
          });
        },
        async update(p, rpcCall, ctx) {
          const name = readStringParam(p, "name");
          const content = readStringParam(p, "content");
          const scope = readStringParam(p, "scope", false) ?? "local";
          return rpcCall("skills.update", {
            name, content, scope,
            _trustLevel: ctx.trustLevel,
          });
        },
      },
    },
    rpcCall,
    approvalGate,
  );
}
