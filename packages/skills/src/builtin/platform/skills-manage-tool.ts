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

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { ApprovalGate } from "@comis/core";
import { readStringParam } from "./tool-helpers.js";
import { createAdminManageTool } from "./admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

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
      description: "GitHub directory URL to import skills from. Required for import action.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: "Skill name. Required for delete, create, and update actions.",
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

type SkillsManageToolParamsType = Static<typeof SkillsManageToolParams>;

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
          const url = readStringParam(p, "url");
          const scope = readStringParam(p, "scope", false) ?? "local";
          return rpcCall("skills.import", { url, scope, _trustLevel: ctx.trustLevel });
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
