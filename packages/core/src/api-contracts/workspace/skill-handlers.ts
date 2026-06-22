// SPDX-License-Identifier: Apache-2.0
/**
 * Skill-handlers contract slice.
 *
 * Mirrors `packages/daemon/src/api/skill-handlers.ts` (6 methods).
 * Spread order in `SKILL_HANDLERS_CONTRACTS` is determinism-critical for
 * codegen output stability — keep `contracts.generated.*` artifacts
 * byte-identical when reordering.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "../types.js";

// ===========================================================================
// Shared sub-schemas (allowlist shapes only).
// ===========================================================================

/**
 * PromptSkillDescription wire shape. Tight model — the source type at
 * `packages/skills/src/skills/prompt/processor.ts:19-28` is fully
 * allowlist-shaped (5 primitive fields, no nested records). The
 * `source` enum mirrors the source-tag emitted by the registry.
 */
const SkillDescriptionSchema = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
  disableModelInvocation: z.boolean().optional(),
  source: z.enum(["bundled", "workspace", "local"]).optional(),
});

/**
 * Uploaded-file entry for `skills.upload`. The handler reads
 * `path: string` (relative within the skill folder) + `content: string`
 * (skill-handlers.ts:182-193).
 */
const SkillUploadFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

/**
 * Skill scope literal — `local` (agent's own workspace) or `shared`
 * (default-agent-only data-dir global skills directory). Modeled as
 * `z.enum` (allowlist).
 */
const SkillScopeSchema = z.enum(["local", "shared"]);

// ===========================================================================
// --- skill-handlers.ts ---
// ===========================================================================

/**
 * `skills.list` — list prompt-skill descriptions for an agent (or the
 * default agent's registry when `agentId` is omitted). RPC scope.
 *
 * Request: `{ agentId? }`. The handler also reads `_agentId` from
 * internals as a fallback (skill-handlers.ts:96-98) — the contract
 * models only the user-facing `agentId` (internals are stripped before
 * parse).
 *
 * Response: `{ skills: PromptSkillDescription[] }`.
 */
export const SkillsListContract = defineContract({
  method: "skills.list",
  request: z.object({
    agentId: z.string().optional(),
  }),
  response: z.object({
    skills: z.array(SkillDescriptionSchema),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `skills.upload` — create a skill folder from operator-uploaded
 * files. ADMIN scope (gateway router registers at line 295). Bespoke
 * guards (skill-handlers.ts:130-148) enforce name format, file count,
 * SKILL.md presence, and the shared-scope default-agent guard.
 *
 * Request: `{ name, scope?, files[], agentId? }`. `scope` defaults to
 * `"local"` when absent or invalid (skill-handlers.ts:117). `agentId`
 * falls back to `_agentId` then errors with "Agent ID is required..."
 * when both are missing.
 *
 * Response: `{ ok: true, path: string }`.
 */
export const SkillsUploadContract = defineContract({
  method: "skills.upload",
  request: z.object({
    name: z.string().min(1),
    scope: SkillScopeSchema.optional(),
    files: z.array(SkillUploadFileSchema),
    agentId: z.string().optional(),
    // When the uploaded SKILL.md declares an mcpServers block whose entry name
    // collides with an existing user-owned or cross-bundle MCP entry,
    // `force: true` archives the prior entry to `_bundleArchive` and installs
    // the bundle entry. Optional — default false (collision rejects with
    // [bundle_install_rejected:name_collision]).
    force: z.boolean().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
    path: z.string(),
  }),
  // 210-GAP CR-01: skills.* mutating methods are the orchestration/skill surface
  // the capability model owns (orch:skill), NOT control plane. Re-scoped
  // admin→rpc so the deny-by-origin chokepoint (keyed on scopes.includes("admin"))
  // no longer denies an agent its own granted orch:skill before the
  // requireCapability gate runs. Admin gateway tokens carry rpc, so the web-UI
  // skills manager is unaffected; the handler still gates on orch:skill.
  scopes: ["rpc"] as const,
});

/**
 * `skills.import` — import a skill from a GitHub directory URL. ADMIN
 * scope. The handler fetches the directory tree from the GitHub
 * Contents API and writes each file into the resolved skill folder.
 *
 * Request: `{ url, scope?, agentId? }`.
 *
 * Response: `{ ok: true, path, name, fileCount }`.
 */
export const SkillsImportContract = defineContract({
  method: "skills.import",
  request: z.object({
    url: z.string().min(1),
    scope: SkillScopeSchema.optional(),
    agentId: z.string().optional(),
    // See SkillsUploadContract.request.force comment.
    force: z.boolean().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
    path: z.string(),
    name: z.string(),
    fileCount: z.number(),
  }),
  // 210-GAP CR-01: orch:skill surface, rpc-scoped (see skills.upload rationale).
  scopes: ["rpc"] as const,
});

/**
 * `skills.delete` — remove a skill folder. ADMIN scope. Performs
 * scope-aware containment checks against the agent's workspace skills
 * directory + the shared skills directory (skill-handlers.ts:354-367).
 *
 * Request: `{ name, scope?, agentId? }`.
 *
 * Response: `{ ok: true }`.
 */
export const SkillsDeleteContract = defineContract({
  method: "skills.delete",
  request: z.object({
    name: z.string().min(1),
    scope: SkillScopeSchema.optional(),
    agentId: z.string().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
  }),
  // 210-GAP CR-01: orch:skill surface, rpc-scoped (see skills.upload rationale).
  scopes: ["rpc"] as const,
});

/**
 * `skills.create` — create a new skill from operator-supplied
 * SKILL.md content. ADMIN scope (by intent; the handler is NOT
 * registered in setup-gateway-api.ts — same registration-plane
 * exception as admin.approval.resolveAll). Bespoke guards
 * (skill-handlers.ts:399-419) enforce name format + content scan
 * (rejects CRITICAL `scanSkillContent` findings).
 *
 * Note: `skills.create` and `skills.update` are NOT registered in
 * setup-gateway-api.ts (gateway-tool / agent-tool dispatch path only),
 * but the bidirectional 1:1 architecture test walks handler-factory
 * PropertyAssignment keys (registration-plane-agnostic), so contracts
 * are MANDATORY for the 1:1 mapping to pass.
 *
 * Request: `{ name, content, scope?, agentId? }`.
 *
 * Response: `{ ok: true, path, name }`.
 */
export const SkillsCreateContract = defineContract({
  method: "skills.create",
  request: z.object({
    name: z.string().min(1),
    content: z.string().min(1),
    scope: SkillScopeSchema.optional(),
    agentId: z.string().optional(),
    // See SkillsUploadContract.request.force comment.
    force: z.boolean().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
    path: z.string(),
    name: z.string(),
  }),
  // 210-GAP CR-01: orch:skill surface, rpc-scoped (see skills.upload rationale).
  scopes: ["rpc"] as const,
});

/**
 * `skills.update` — overwrite a skill's SKILL.md content. ADMIN
 * scope (by intent; same registration-plane exception as
 * `skills.create`). Re-runs the security scan before writing.
 *
 * Request: `{ name, content, scope?, agentId? }`.
 *
 * Response: `{ ok: true, name }`.
 */
export const SkillsUpdateContract = defineContract({
  method: "skills.update",
  request: z.object({
    name: z.string().min(1),
    content: z.string().min(1),
    scope: SkillScopeSchema.optional(),
    agentId: z.string().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
    name: z.string(),
  }),
  // 210-GAP CR-01: orch:skill surface, rpc-scoped (see skills.upload rationale).
  scopes: ["rpc"] as const,
});

/**
 * skill-handlers slice (6 contracts). Spread order is
 * determinism-critical for codegen output stability.
 */
export const SKILL_HANDLERS_CONTRACTS = [
  SkillsListContract,
  SkillsUploadContract,
  SkillsImportContract,
  SkillsDeleteContract,
  SkillsCreateContract,
  SkillsUpdateContract,
] as const;
