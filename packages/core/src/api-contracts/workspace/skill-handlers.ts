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
 * Acquisition channel for an imported skill (HOW the bytes arrived) — distinct
 * from the trust-tier `source` below. Only `github` / `archive` land in this
 * slice; the registry-resolver channels (`wellknown` / `clawhub`) are modeled
 * ahead of their handlers so the provenance summary is forward-stable.
 */
const AcquisitionSourceSchema = z.enum([
  "github",
  "archive",
  "wellknown",
  "clawhub",
  "upload",
]);

/**
 * Content-free provenance digest surfaced on a listed skill. Populated for
 * imported skills from the durable provenance store; absent for bundled /
 * workspace / local / learned skills.
 */
const ProvenanceSummarySchema = z.object({
  source: AcquisitionSourceSchema,
  registry: z.string().optional(),
  // Whether the source registry vouched for an official publisher — populated
  // for registry imports (clawhub); absent for archive/github/upload.
  officialPublisher: z.boolean().optional(),
  hashPrefix: z.string().optional(),
  importedAt: z.string().optional(),
});

/**
 * PromptSkillDescription wire shape. The `source` enum is the trust tier
 * emitted by the registry; `provenanceSummary` carries the content-free import
 * digest (acquisition channel + hash prefix + timestamp) for imported skills.
 */
const SkillDescriptionSchema = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
  disableModelInvocation: z.boolean().optional(),
  source: z
    .enum(["bundled", "workspace", "local", "learned", "imported"])
    .optional(),
  provenanceSummary: ProvenanceSummarySchema.optional(),
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
  }),
  response: z.object({
    ok: z.literal(true),
    path: z.string(),
  }),
  // skills.* mutating methods are the orchestration/skill surface the
  // capability model owns (orch:skill), NOT control plane. Scoped rpc (not
  // admin) so the deny-by-origin chokepoint (keyed on scopes.includes("admin"))
  // does not deny an agent its own granted orch:skill before the
  // requireCapability gate runs. Admin gateway tokens carry rpc, so the web-UI
  // skills manager is unaffected; the handler still gates on orch:skill.
  scopes: ["rpc"] as const,
});

/**
 * `skills.import` — import a skill from a GitHub directory URL, an archive, or a
 * registry index ({@link AcquisitionSourceSchema}). Every source funnels through
 * the single staged pipeline: the content scan + the MCP Phase-A check run
 * PRE-write, and a rejecting import leaves zero live files. A successful import
 * is stamped the `imported` trust tier and pinned in the provenance store.
 *
 * Request: `{ url? | archiveUrl? | archiveBytes?, source?, registry?, name?,
 * scope?, agentId?, confirm? }`. `source` selects the acquisition channel
 * (defaults to `github` when a `url` is present); `source:"wellknown"` reads a
 * registry index, with `registry` naming the origin and `name` the index-lookup
 * key (which advertised skill to fetch). The installed name is always the mapped
 * manifest name — `name` selects the registry entry, it does NOT override the
 * install name. `confirm` overrides BOTH warnable classes — a non-official
 * registry publisher and a pin-divergence on a provenance-matched re-import —
 * never a collision on an unprovenanced / foreign-source name (there is
 * intentionally NO force override).
 *
 * Response: `{ ok: true, path, name, fileCount, source: "imported",
 * resolvedAgentId, warnings? }`. `resolvedAgentId` is the agent the import acted
 * on; `warnings` enumerates the warnable classes a confirmed import
 * acknowledged (a non-official publisher and/or a pin-divergence re-import).
 */
export const SkillsImportContract = defineContract({
  method: "skills.import",
  request: z.object({
    url: z.string().min(1).optional(),
    source: z.enum(["github", "archive", "wellknown", "clawhub"]).optional(),
    // Registry origin (normalized `https://<host>[:port]`) or the `clawhub`
    // token — read for the registry-resolver sources (wellknown / clawhub).
    registry: z.string().min(1).optional(),
    // Registry index-lookup key: which advertised skill to fetch (the
    // `@owner/slug` reference for clawhub). Selects the registry entry; it does
    // NOT override the installed (manifest) name.
    name: z.string().min(1).optional(),
    archiveUrl: z.string().min(1).optional(),
    archiveBytes: z.string().min(1).optional(),
    scope: SkillScopeSchema.optional(),
    agentId: z.string().optional(),
    confirm: z.boolean().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
    path: z.string(),
    name: z.string(),
    fileCount: z.number(),
    source: z.literal("imported"),
    resolvedAgentId: z.string(),
    // The warnable classes a confirmed import acknowledged (non-official
    // publisher and/or pin-divergence re-import). Absent for a warning-free
    // import.
    warnings: z.array(z.string()).optional(),
  }),
  // orch:skill surface, rpc-scoped (see skills.upload rationale).
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
  // orch:skill surface, rpc-scoped (see skills.upload rationale).
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
    // When the created SKILL.md declares an mcpServers block whose entry name
    // collides with an existing MCP entry, `force: true` archives the prior
    // entry to `_bundleArchive` and installs the bundle entry. Optional —
    // default false (a collision rejects with
    // [bundle_install_rejected:name_collision]).
    force: z.boolean().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
    path: z.string(),
    name: z.string(),
  }),
  // orch:skill surface, rpc-scoped (see skills.upload rationale).
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
  // orch:skill surface, rpc-scoped (see skills.upload rationale).
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
