// SPDX-License-Identifier: Apache-2.0
/**
 * Agents + models + providers-domain RPC contracts. Mirrors the three daemon
 * handler factory files that share the `AgentsApiDeps` cluster slice:
 *
 *   - `packages/daemon/src/api/agent-handlers.ts`     ( 7 methods — agents.*
 *                                                       + agent.getOperationModels)
 *   - `packages/daemon/src/api/model-handlers.ts`     ( 3 methods — models.*)
 *   - `packages/daemon/src/api/provider-handlers.ts`  ( 7 methods — providers.*)
 *
 * One contract file per logical domain mirroring the `*ApiDeps` slices: all
 * three handler files map to the SAME ApiDeps slice (`AgentsApiDeps`) and so
 * share one contract file. The aggregator below preserves per-handler
 * grouping via `// --- xxx-handlers.ts ---` comment blocks; the order within
 * the array is documentation-only (the bidirectional 1:1 test treats it as
 * an unordered set).
 *
 * **Scope assignments** (mirror `setup-gateway-api.ts` registrations + the
 * registration-plane-agnostic principle — all `providers.*` methods are
 * admin-scoped via the in-handler `_trustLevel === "admin"` check, NOT via
 * an explicit gateway router registration):
 *
 *   agent-handlers.ts (all admin per setup-gateway-api.ts:215-219):
 *   - `agents.create`             (admin)
 *   - `agents.get`                (admin)
 *   - `agents.update`             (admin)
 *   - `agents.delete`             (admin)
 *   - `agents.suspend`            (admin)
 *   - `agents.resume`             (admin)
 *   - `agent.getOperationModels`  (admin)
 *
 *   model-handlers.ts (all admin per setup-gateway-api.ts:242):
 *   - `models.list`               (admin)
 *   - `models.list_providers`     (admin)
 *   - `models.test`               (admin)
 *
 *   provider-handlers.ts (all admin — registration-plane-agnostic; per-handler
 *   `_trustLevel === "admin"` check at body entry):
 *   - `providers.list`            (admin)
 *   - `providers.get`             (admin)
 *   - `providers.create`          (admin)
 *   - `providers.update`          (admin)
 *   - `providers.delete`          (admin)
 *   - `providers.enable`          (admin)
 *   - `providers.disable`         (admin)
 *
 * Note: `agents.list` is NOT in this contract file. The `agents.list` method
 * exists at `packages/daemon/src/api/session-handlers.ts:272`, NOT in
 * agent-handlers.ts — it belongs to the session handler factory.
 *
 * **Loose-record use** (escape hatch). The `config` patch fields on
 * `agents.update` and `providers.update` carry user-supplied
 * Partial<PerAgentConfig> / Partial<ProviderEntry> patches — the same
 * loose-tree precedent as `config.patch.value`:
 *
 *   - `agents.update.request.config` — Partial<PerAgentConfig>. The handler
 *     calls `PerAgentConfigSchema.parse(merged)` AFTER merging with the
 *     existing config, so the contract layer carries arbitrary user-supplied
 *     partial shapes.
 *   - `providers.update.request.config` — Partial<ProviderEntry>. The handler
 *     calls `ProviderEntrySchema.parse(merged)` AFTER merging.
 *
 * Response shapes that carry the FULL parsed schema also use loose record:
 *   - `agents.create.response.config` — full PerAgentConfig (after Zod parse).
 *   - `agents.get.response.config`    — full PerAgentConfig.
 *   - `agents.update.response.config` — full PerAgentConfig.
 *   - `providers.create.response.config` — full ProviderEntry (after Zod parse).
 *   - `providers.update.response.config` — full ProviderEntry.
 *   - `providers.get.response.config`    — full ProviderEntry.
 *
 * Modelling these tighter would re-encode the entire PerAgentConfig /
 * ProviderEntry surface in the contract — pinning the wire format across
 * daemon restarts on every minor schema field addition. The authoritative
 * validation is the handler's PerAgentConfigSchema / ProviderEntrySchema; the
 * contract is type narrowing + dev-mode shape-regression canary.
 *
 * **Allowlist compliance.** All schemas use the 12-shape allowlist:
 * z.object, z.string (no `.url()` / `.regex()` refinements — bare `z.string()`
 * everywhere), z.number, z.boolean, z.literal, z.enum, z.array, z.nullable,
 * z.optional, z.record (loose-record value-type), z.union (where used).
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ===========================================================================
// --- agent-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// agents.create
// ---------------------------------------------------------------------------

/**
 * `agents.create` — Create a new runtime agent with validated config.
 * Admin-only. Handler path: agent-handlers.ts:62-230.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → throws `"Admin access required for agent creation"`.
 *   - Missing `agentId` → `"Missing required parameter: agentId"`.
 *   - Duplicate agentId → `"Agent already exists: <id>"`.
 *
 * Pre-Zod logic mutates `config.skills.builtinTools` with the
 * DEFAULT_BUILTIN_TOOLS overlay BEFORE `PerAgentConfigSchema.parse(config)`,
 * then runs the credential guard (`resolveProviderCredential`), then commits
 * to `deps.agents`, then runs best-effort persistence + hot-add + inline
 * workspace writes.
 *
 * Request: `{ agentId, config?, inlineContent? }`. `config` is the loose
 * Partial<PerAgentConfig> patch; `inlineContent` carries optional
 * `{ role?, identity? }` for ROLE.md / IDENTITY.md side-effects (NEVER
 * persisted to config).
 *
 * Response: `{ agentId, config, created: true, workspaceDir, inlineWritesResult? }`.
 * `config` is the FULL parsed PerAgentConfig (loose-record). `inlineWritesResult`
 * is present only when ROLE.md / IDENTITY.md writes were attempted.
 */
export const AgentsCreateContract = defineContract({
  method: "agents.create",
  request: z.object({
    agentId: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
    inlineContent: z.object({
      role: z.string().optional(),
      identity: z.string().optional(),
    }).optional(),
  }),
  response: z.object({
    agentId: z.string(),
    config: z.record(z.string(), z.unknown()),
    created: z.literal(true),
    workspaceDir: z.string(),
    inlineWritesResult: z.record(z.string(), z.unknown()).optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// agents.get
// ---------------------------------------------------------------------------

/**
 * `agents.get` — Retrieve agent config and runtime state.
 * Admin-scoped per setup-gateway-api.ts:215-219. Handler path: agent-handlers.ts:232-250.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `agentId` → `"Missing required parameter: agentId"`.
 *   - Unknown agentId → `"Agent not found: <id>"`.
 *
 * Request: `{ agentId }`.
 * Response: `{ agentId, config, suspended, isDefault, workspaceDir }`. `config` is
 * the FULL PerAgentConfig (loose-record — pinned by PerAgentConfigSchema at
 * the boundary).
 */
export const AgentsGetContract = defineContract({
  method: "agents.get",
  request: z.object({
    agentId: z.string(),
  }),
  response: z.object({
    agentId: z.string(),
    config: z.record(z.string(), z.unknown()),
    suspended: z.boolean(),
    isDefault: z.boolean(),
    workspaceDir: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// agents.update
// ---------------------------------------------------------------------------

/**
 * `agents.update` — Patch an existing agent config. Admin-only.
 * Handler path: agent-handlers.ts:252-421.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for agent modification"`.
 *   - Missing `agentId` → `"Missing required parameter: agentId"`.
 *   - Unknown agentId → `"Agent not found: <id>"`.
 *
 * Pre-Zod logic deep-merges `config.skills`, `config.scheduler.heartbeat`, and
 * `config.modelFailover` from the existing config (to preserve scalar fields
 * on partial patches), then `PerAgentConfigSchema.parse(merged)`, then runs
 * the oauthProfiles store-existence validation, then the
 * provider-change credential guard + probe (only when `config.provider`
 * changes), then commits to `deps.agents`, then runs best-effort persistence.
 *
 * Request: `{ agentId, config?, dryRun? }`. `config` is the loose
 * Partial<PerAgentConfig> patch. `dryRun: true` runs the SAME validation
 * (deep-merge + `PerAgentConfigSchema.parse` + oauthProfiles/credential
 * checks) but skips BOTH the in-memory hot-apply (`deps.agents[id] = …`) and
 * the `persistToConfig` write — the web editor's "Validate" button sends it
 * so validating prod config does not silently mutate config.yaml /
 * config.last-good.yaml. The response shape is identical (`updated: true`);
 * a dry-run that parses clean returns ok, a dry-run that fails parsing throws
 * the same Zod error a real save would.
 *
 * Response: `{ agentId, config, updated: true }`. `config` is the FULL parsed
 * PerAgentConfig (loose-record).
 */
export const AgentsUpdateContract = defineContract({
  method: "agents.update",
  request: z.object({
    agentId: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
    dryRun: z.boolean().optional(),
  }),
  response: z.object({
    agentId: z.string(),
    config: z.record(z.string(), z.unknown()),
    updated: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// agents.delete
// ---------------------------------------------------------------------------

/**
 * `agents.delete` — Remove an agent. Cannot delete default agent. Admin-only.
 * Handler path: agent-handlers.ts:423-480.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for agent deletion"`.
 *   - Missing `agentId` → `"Missing required parameter: agentId"`.
 *   - `agentId === deps.defaultAgentId` → `"Cannot delete default agent: <id>"`.
 *   - Unknown agentId → `"Agent not found: <id>"`.
 *
 * Request: `{ agentId }`.
 * Response: `{ agentId, deleted: true }`.
 */
export const AgentsDeleteContract = defineContract({
  method: "agents.delete",
  request: z.object({
    agentId: z.string(),
  }),
  response: z.object({
    agentId: z.string(),
    deleted: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// agents.suspend
// ---------------------------------------------------------------------------

/**
 * `agents.suspend` — Suspend an agent, preventing execution. Admin-only.
 * Handler path: agent-handlers.ts:482-504.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for agent suspension"`.
 *   - Missing `agentId` → `"Missing required parameter: agentId"`.
 *   - Unknown agentId → `"Agent not found: <id>"`.
 *   - Already suspended → `"Agent already suspended: <id>"`.
 *
 * Request: `{ agentId }`.
 * Response: `{ agentId, suspended: true }`.
 */
export const AgentsSuspendContract = defineContract({
  method: "agents.suspend",
  request: z.object({
    agentId: z.string(),
  }),
  response: z.object({
    agentId: z.string(),
    suspended: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// agents.resume
// ---------------------------------------------------------------------------

/**
 * `agents.resume` — Restore a suspended agent to active state. Admin-only.
 * Handler path: agent-handlers.ts:506-528.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for agent resumption"`.
 *   - Missing `agentId` → `"Missing required parameter: agentId"`.
 *   - Unknown agentId → `"Agent not found: <id>"`.
 *   - Not currently suspended → `"Agent is not suspended: <id>"`.
 *
 * Request: `{ agentId }`.
 * Response: `{ agentId, resumed: true }`.
 */
export const AgentsResumeContract = defineContract({
  method: "agents.resume",
  request: z.object({
    agentId: z.string(),
  }),
  response: z.object({
    agentId: z.string(),
    resumed: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// agent.getOperationModels
// ---------------------------------------------------------------------------

/**
 * `agent.getOperationModels` — Inspect operation model resolutions for an
 * agent across the OPERATION_TIER_MAP types (interactive, cron, heartbeat,
 * subagent, compaction, taskExtraction, condensation). Admin-only.
 * Handler path: agent-handlers.ts:531-579.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `agentId` → `"Missing required parameter: agentId"`.
 *   - Unknown agentId → `"Agent not found: <id>"`.
 *
 * Resolves the per-operation-type model via `resolveOperationModel` from
 * `@comis/agent`, then checks `secretManager.has(keyName)` for each resolved
 * provider's API key to set `apiKeyConfigured` per operation.
 *
 * Request: `{ agentId }`.
 *
 * Response: `{ agentId, primaryModel, primaryProvider, providerFamily,
 * tieringActive, operations: AgentOperationResolution[] }`. Each operation
 * entry has tight primitive-leaf shape (operationType, model, provider,
 * modelId, source, timeoutMs, cacheRetention?, tieringActive, crossProvider,
 * apiKeyConfigured).
 */
export const AgentGetOperationModelsContract = defineContract({
  method: "agent.getOperationModels",
  request: z.object({
    agentId: z.string(),
  }),
  response: z.object({
    agentId: z.string(),
    primaryModel: z.string(),
    primaryProvider: z.string(),
    providerFamily: z.string(),
    tieringActive: z.boolean(),
    operations: z.array(z.object({
      operationType: z.string(),
      model: z.string(),
      provider: z.string(),
      modelId: z.string(),
      source: z.string(),
      timeoutMs: z.number(),
      cacheRetention: z.enum(["none", "short"]).optional(),
      tieringActive: z.boolean(),
      crossProvider: z.boolean(),
      apiKeyConfigured: z.boolean(),
    })),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// --- model-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// models.list
// ---------------------------------------------------------------------------

/**
 * `models.list` — Query the model catalog. Two response shapes discriminated
 * by whether `provider` is supplied:
 *   - With `provider`: returns flat `{ models: ModelEntry[], total }`.
 *   - Without provider: returns nested `{ providers: ProviderGroup[], totalModels }`.
 *
 * Admin-scoped per setup-gateway-api.ts:242. Handler path: model-handlers.ts:41-83.
 *
 * LOOSE-RECORD: response is modeled loose because the two variants carry
 * disjoint top-level keys (`models + total` vs `providers + totalModels`).
 * Tight discriminated-union modeling would require pinning per-variant field
 * sets across daemon restarts on every CatalogEntry shape addition.
 *
 * Request: `{ provider? }`.
 * Response: LooseRecord (either flat or nested variant).
 */
export const ModelsListContract = defineContract({
  method: "models.list",
  request: z.object({
    provider: z.string().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// models.list_providers
// ---------------------------------------------------------------------------

/**
 * `models.list_providers` — Live native pi-ai catalog provider list. Admin-only.
 * Handler path: model-handlers.ts:94-101.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required"`.
 *
 * Request: `{}`.
 * Response: `{ providers: string[], count: number }`.
 */
export const ModelsListProvidersContract = defineContract({
  method: "models.list_providers",
  request: z.object({}),
  response: z.object({
    providers: z.array(z.string()),
    count: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// models.test
// ---------------------------------------------------------------------------

/**
 * `models.test` — Check provider configuration and catalog status.
 * Admin-scoped per setup-gateway-api.ts:242. Handler path: model-handlers.ts:107-171.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `provider` → `"Missing required parameter: provider"`.
 *
 * Response has 4 variants discriminated by `status`: `not_configured`,
 * `available` (catalog), `available` (custom_provider), `no_models`. Each
 * variant carries a disjoint set of optional fields. LOOSE-RECORD for the
 * response — tight modeling would require a 4-arm discriminated union that
 * pins the per-variant field-sets.
 *
 * Request: `{ provider }`.
 * Response: LooseRecord (4 status variants).
 */
export const ModelsTestContract = defineContract({
  method: "models.test",
  request: z.object({
    provider: z.string(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["admin"] as const,
});

// ===========================================================================
// --- provider-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// providers.list
// ---------------------------------------------------------------------------

/**
 * `providers.list` — List all providers with summary + apiKeyConfigured state.
 * Admin-only (in-handler `_trustLevel === "admin"` check; registration-plane-
 * agnostic — NOT in setup-gateway-api.ts but dispatched via
 * rpc-dispatch.ts:184 + admin gate at provider-handlers.ts:174-178).
 * Handler path: provider-handlers.ts:174-194.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for provider listing"`.
 *
 * Each summary entry carries `apiKeyConfigured: boolean | null` (null when
 * the provider has no `apiKeyName` — distinguishes "no key needed" from
 * "key needed but unconfigured").
 *
 * Request: `{}`.
 * Response: `{ providers: ProviderSummary[] }`. Each ProviderSummary is tight-
 * modeled with primitive leaves.
 */
export const ProvidersListContract = defineContract({
  method: "providers.list",
  request: z.object({}),
  response: z.object({
    providers: z.array(z.object({
      id: z.string(),
      type: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      baseUrl: z.string(),
      apiKeyName: z.string().optional(),
      modelCount: z.number(),
      apiKeyConfigured: z.nullable(z.boolean()),
    })),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// providers.get
// ---------------------------------------------------------------------------

/**
 * `providers.get` — Retrieve full provider config + agentsUsing list. Admin-only.
 * Handler path: provider-handlers.ts:196-237.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for provider retrieval"`.
 *   - Missing `providerId` → `"Missing required parameter: providerId"`.
 *   - Unknown providerId → `"Provider not found: <id>"`.
 *
 * `agentsUsing` is computed via `findAgentReferences` across 3 slots: primary
 * provider, fallbackModels, authProfiles.
 *
 * LOOSE-RECORD: `config` is the FULL parsed ProviderEntry — same rationale
 * as `agents.get.response.config` (avoids re-encoding the full ProviderEntry
 * surface in the contract).
 *
 * Request: `{ providerId }`.
 * Response: `{ providerId, config: LooseRecord (full ProviderEntry),
 * apiKeyConfigured: boolean | null, agentsUsing: string[] }`.
 */
export const ProvidersGetContract = defineContract({
  method: "providers.get",
  request: z.object({
    providerId: z.string(),
  }),
  response: z.object({
    providerId: z.string(),
    config: z.record(z.string(), z.unknown()),
    apiKeyConfigured: z.nullable(z.boolean()),
    agentsUsing: z.array(z.string()),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// providers.create
// ---------------------------------------------------------------------------

/**
 * `providers.create` — Register a new provider entry with validation. Admin-only.
 * Handler path: provider-handlers.ts:239-322.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for provider creation"`.
 *   - Missing `providerId` → `"Missing required parameter: providerId"`.
 *   - Reserved name "default" → throws (handler:251-257).
 *   - Duplicate providerId → `"Provider already exists: <id>"`.
 *   - `checkBuiltInProviderRedundancy` failure → throws with guard reason.
 *
 * Pre-Zod logic auto-promotes `type` to native catalog name when
 * `providerId` is a known native catalog entry AND `type` is missing/openai
 * AND `baseUrl` is missing/matches the catalog's. Then
 * `ProviderEntrySchema.parse(normalizedConfig)`, then probes the apiKey
 * against the wire if `secretManager` has it.
 *
 * Request: `{ providerId, config? }`. `config` is the loose
 * Partial<ProviderEntry> patch.
 *
 * Response: `{ providerId, config, created: true }`. `config` is the FULL
 * parsed ProviderEntry (loose-record).
 */
export const ProvidersCreateContract = defineContract({
  method: "providers.create",
  request: z.object({
    providerId: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
  response: z.object({
    providerId: z.string(),
    config: z.record(z.string(), z.unknown()),
    created: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// providers.update
// ---------------------------------------------------------------------------

/**
 * `providers.update` — Patch an existing provider config. Admin-only.
 * Handler path: provider-handlers.ts:324-392.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for provider modification"`.
 *   - Missing `providerId` → `"Missing required parameter: providerId"`.
 *   - Unknown providerId → `"Provider not found: <id>"`.
 *
 * Pre-Zod logic auto-promotes `type` ONLY when explicitly changing the
 * `type` field, shallow-merges `headers` (per-key preserve+overlay), then
 * spread-merges with existing, then `ProviderEntrySchema.parse(merged)`.
 *
 * LOOSE-RECORD: `config` request is Partial<ProviderEntry> — same
 * rationale as `agents.update.request.config`.
 *
 * Request: `{ providerId, config? }`.
 * Response: `{ providerId, config, updated: true }`.
 */
export const ProvidersUpdateContract = defineContract({
  method: "providers.update",
  request: z.object({
    providerId: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
  response: z.object({
    providerId: z.string(),
    config: z.record(z.string(), z.unknown()),
    updated: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// providers.delete
// ---------------------------------------------------------------------------

/**
 * `providers.delete` — Remove a provider. Admin-only. Blocks deletion if any
 * agent references this provider across the 3 reference slots (primary,
 * fallbackModels, authProfiles).
 * Handler path: provider-handlers.ts:394-441.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for provider deletion"`.
 *   - Missing `providerId` → `"Missing required parameter: providerId"`.
 *   - Unknown providerId → `"Provider not found: <id>"`.
 *   - Has agent references → throws with structured reference message.
 *
 * Request: `{ providerId }`.
 * Response: `{ providerId, deleted: true }`.
 */
export const ProvidersDeleteContract = defineContract({
  method: "providers.delete",
  request: z.object({
    providerId: z.string(),
  }),
  response: z.object({
    providerId: z.string(),
    deleted: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// providers.enable
// ---------------------------------------------------------------------------

/**
 * `providers.enable` — Set `enabled: true` on a disabled provider. Admin-only.
 * Handler path: provider-handlers.ts:443-480.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for provider enable"`.
 *   - Missing `providerId` → `"Missing required parameter: providerId"`.
 *   - Unknown providerId → `"Provider not found: <id>"`.
 *
 * Request: `{ providerId }`.
 * Response: `{ providerId, enabled: true }`.
 */
export const ProvidersEnableContract = defineContract({
  method: "providers.enable",
  request: z.object({
    providerId: z.string(),
  }),
  response: z.object({
    providerId: z.string(),
    enabled: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// providers.disable
// ---------------------------------------------------------------------------

/**
 * `providers.disable` — Set `enabled: false` on a provider. Admin-only.
 * Warns but does NOT block when agents reference the provider (vs.
 * `providers.delete` which rejects). Handler path: provider-handlers.ts:482-528.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for provider disable"`.
 *   - Missing `providerId` → `"Missing required parameter: providerId"`.
 *   - Unknown providerId → `"Provider not found: <id>"`.
 *
 * Request: `{ providerId }`.
 * Response: `{ providerId, enabled: false, warning? }`. `warning` is present
 * when the provider is referenced by agents.
 */
export const ProvidersDisableContract = defineContract({
  method: "providers.disable",
  request: z.object({
    providerId: z.string(),
  }),
  response: z.object({
    providerId: z.string(),
    enabled: z.literal(false),
    warning: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// Aggregator
// ===========================================================================

/**
 * Tuple of every contract for the agents + models + providers umbrella.
 * The bidirectional 1:1 architecture test treats this as an unordered set;
 * the per-handler grouping below is documentation-only.
 *
 * Order:
 *   1. agent-handlers.ts (7 entries — agents.* + agent.getOperationModels)
 *   2. model-handlers.ts (3 entries)
 *   3. provider-handlers.ts (7 entries)
 *
 * Total: 17 contracts.
 */
export const AGENTS_CONTRACTS = [
  // agent-handlers.ts
  AgentsCreateContract,
  AgentsGetContract,
  AgentsUpdateContract,
  AgentsDeleteContract,
  AgentsSuspendContract,
  AgentsResumeContract,
  AgentGetOperationModelsContract,
  // model-handlers.ts
  ModelsListContract,
  ModelsListProvidersContract,
  ModelsTestContract,
  // provider-handlers.ts
  ProvidersListContract,
  ProvidersGetContract,
  ProvidersCreateContract,
  ProvidersUpdateContract,
  ProvidersDeleteContract,
  ProvidersEnableContract,
  ProvidersDisableContract,
] as const;
