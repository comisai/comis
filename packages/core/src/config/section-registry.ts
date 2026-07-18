// SPDX-License-Identifier: Apache-2.0
/**
 * Single source of truth for config-section metadata.
 *
 * Each section gets one canonical entry; per-view flags
 * (`schemaSerializable`, `fieldMetadataVisible`) determine subset
 * membership, and `managedRedirect` carries top-level redirect metadata
 * for the 3 fully-managed sections (providers, channels, agents).
 *
 * Sub-path redirects (`integrations.mcp.servers`, `gateway.tokens`)
 * remain in `SUB_PATH_MANAGED_REDIRECTS` because their keys are not
 * top-level section names.
 *
 * NOT a public export — implementation detail. Public API surface remains
 * `getConfigSchema`, `getConfigSections`, `getFieldMetadata`,
 * `getManagedSectionRedirect`, `formatRedirectHint` (minimal-surface rule).
 *
 * @module
 */

import type { z } from "zod";

import { PerAgentConfigSchema, RoutingConfigSchema } from "./schema-agent/index.js";
import { ApprovalsConfigSchema } from "./schema-approvals.js";
import { AutoReplyEngineConfigSchema } from "./schema-auto-reply-engine.js";
import { BrowserConfigSchema } from "./schema-browser.js";
import { ChannelConfigSchema } from "./schema-channel.js";
import { DaemonConfigSchema } from "./schema-daemon.js";
import { DiagnosticsConfigSchema } from "./schema-diagnostics.js";
import { EmbeddingConfigSchema } from "./schema-embedding.js";
import { EnvelopeConfigSchema } from "./schema-envelope.js";
import { GatewayConfigSchema } from "./schema-gateway.js";
import { IntegrationsConfigSchema } from "./schema-integrations.js";
import { MemoryConfigSchema } from "./schema-memory.js";
import { MessagesConfigSchema } from "./schema-messages.js";
import { ModelsConfigSchema } from "./schema-models.js";
import { MonitoringConfigSchema } from "./schema-observability.js";
import { OrchestrationConfigSchema } from "./schema-orchestration.js";
import { PluginsConfigSchema } from "./schema-plugins.js";
import { ProvidersConfigSchema } from "./schema-providers.js";
import { QueueConfigSchema } from "./schema-queue.js";
import { SchedulerConfigSchema } from "./schema-scheduler.js";
import { SecurityConfigSchema } from "./schema-security.js";
import { SendPolicyConfigSchema } from "./schema-send-policy.js";
import { StreamingConfigSchema } from "./schema-streaming.js";
import { ToolingConfigSchema } from "./schema-tooling.js";

// ---------------------------------------------------------------------------
// ManagedSectionRedirect lives here to break the source-level cycle that the
// no-cycles architecture invariant rejects. managed-sections.ts re-exports
// the type for back-compat with existing
// `import type { ManagedSectionRedirect } from "./managed-sections.js"`
// consumers and the public config index.
// ---------------------------------------------------------------------------

/** A single redirect entry: which tool, and a parameter-correct example. */
export interface ManagedSectionRedirect {
  /** Path prefix that triggers this redirect (e.g., "agents", "integrations.mcp.servers"). */
  pathPrefix: string;
  /** Tool name (matches the registered AgentTool name). */
  tool: string;
  /** One-line description that includes the tool's full action list. */
  description: string;
  /**
   * Concrete example arguments for the most common create-equivalent action.
   * Shape MUST match the tool's TypeBox parameter schema exactly -- verified
   * against the tool source as of this commit. Omit when the tool has no
   * "create" semantics (e.g., channels_manage cannot add new platform types).
   */
  exampleArgs?: Record<string, unknown>;
  /**
   * True when the tool fully replaces gateway-patch for this section
   * (create + update + delete). False when it can only operate on entries
   * already present in config.
   */
  fullyManaged: boolean;
  /**
   * Compact schema fragment so the LLM can call the tool without a separate
   * discover_tools round-trip. Populated when the action enum + required
   * fields fit in < 20 lines of hint text. Verified against the tool's
   * TypeBox parameter schema as of this commit.
   *
   * Without the inline fragment, an agent hitting an immutable-path
   * rejection has been observed burning ~30s × 4 LLM calls re-loading the
   * agents_manage schema. Surfacing the fragment inline closes that
   * round-trip tax.
   */
  schemaFragment?: {
    /** Valid `action` enum values (pinned to the tool's TypeBox Union literals). */
    actions: readonly string[];
    /**
     * Required field names per action -- only entries that are strictly
     * required by the tool's handler (omitting Type.Optional fields with
     * sensible defaults). Omit the whole property when no action has
     * required-beyond-action fields (e.g., channels_manage operates on
     * existing entries only).
     */
    requiredByAction?: Record<string, readonly string[]>;
  };
}

/**
 * Section metadata. Each registry entry encodes which views the section
 * participates in and (for fully-managed sections) the redirect metadata.
 */
export interface SectionRegistryEntry {
  /** Canonical Zod schema for the section. Same object shared across views. */
  readonly schema: z.ZodType;
  /** True if section appears in the schema-serializer view (18 sections). */
  readonly schemaSerializable: boolean;
  /** True if section appears in the field-metadata view (20 sections). */
  readonly fieldMetadataVisible: boolean;
  /**
   * Set on the 3 top-level fully-managed sections (providers, channels,
   * agents). Sub-path redirects (integrations.mcp.servers, gateway.tokens)
   * live in SUB_PATH_MANAGED_REDIRECTS because their key is not a
   * top-level section name.
   */
  readonly managedRedirect?: ManagedSectionRedirect;
}

/**
 * The 25 unique config sections. Bool flags select per-view membership.
 *
 * - 18 sections have schemaSerializable=true
 * - 20 sections have fieldMetadataVisible=true
 * - 13 sections appear in both views (intersection)
 * - 3 sections (providers, channels, agents) have managedRedirect (top-level managed)
 *
 * Insertion order is significant: schema-serializer.ts and field-metadata.ts
 * derive their SECTION_SCHEMAS maps via Object.fromEntries(Object.entries(...)),
 * which preserves this order, which in turn drives getConfigSections() output
 * order. The 18 schemaSerializable=true entries appear in this order:
 *   agents, channels, memory, security, routing, daemon, scheduler, gateway,
 *   integrations, monitoring, diagnostics, browser, models, providers,
 *   messages, approvals, tooling, orchestration.
 * The 20 fieldMetadataVisible=true entries appear in this order:
 *   agents, channels, memory, security, routing, daemon, scheduler, gateway,
 *   integrations, monitoring, diagnostics, plugins, queue, streaming,
 *   autoReplyEngine, sendPolicy, embedding, envelope, tooling, orchestration.
 * The 7 fieldMetadata-only entries (plugins → envelope) are inserted between
 * `diagnostics` and `tooling` so both filtered subsequences are stable.
 * `orchestration` (both views, gated-off by default) is appended last after
 * `tooling`, so it extends both subsequences consistently with insertion order.
 */
export const SECTION_REGISTRY: Readonly<Record<string, SectionRegistryEntry>> = Object.freeze({
  // The 11 common (both views) at the head — both filtered subsequences share indexes 0-9, then diagnostics at index 10.
  agents: {
    schema: PerAgentConfigSchema,
    schemaSerializable: true,
    fieldMetadataVisible: true,
    managedRedirect: {
      pathPrefix: "agents",
      tool: "agents_manage",
      description: "Manage agent system (create, get, update, delete, suspend, resume).",
      // Verified against agents-manage-tool.ts AgentsManageToolParams.
      exampleArgs: {
        action: "create",
        agent_id: "<new-agent-id>",
        config: {
          name: "<display-name>",
          model: "<model-id>",
          provider: "<provider>",
          maxSteps: 100,
          // Advertise the per-agent OAuth profile preference to the LLM.
          // Maps provider → "<provider>:<identity>" stored profile ID.
          // Validated end-to-end by the Zod refine and daemon-side has()
          // existence check.
          oauthProfiles: { "openai-codex": "openai-codex:user@example.com" },
        },
      },
      fullyManaged: true,
      // Action enum pinned to agents-manage-tool.ts TypeBox Union.
      // agent_id is required on every action (Type.String, not Optional);
      // config is required for create (the action handler rejects create
      // without a config payload, even though the schema marks it Optional
      // to accept the alternate JSON-string fallback shape).
      schemaFragment: {
        actions: ["create", "get", "update", "delete", "suspend", "resume"],
        requiredByAction: {
          create: ["agent_id", "config"],
        },
      },
    },
  },
  channels: {
    schema: ChannelConfigSchema,
    schemaSerializable: true,
    fieldMetadataVisible: true,
    managedRedirect: {
      pathPrefix: "channels",
      tool: "channels_manage",
      description: "Manage channel adapters (list, get, enable, disable, restart, configure).",
      // No exampleArgs -- no create-equivalent action; channels are configured
      // via operator config + media-setting toggles only.
      fullyManaged: false,
      // Action enum pinned to channels-manage-tool.ts TypeBox Union.
      // No requiredByAction -- channels_manage operates on existing entries;
      // all fields beyond `action` are looked up from config or optional.
      schemaFragment: {
        actions: ["list", "get", "enable", "disable", "restart", "configure"],
      },
    },
  },
  memory: { schema: MemoryConfigSchema, schemaSerializable: true, fieldMetadataVisible: true },
  security: { schema: SecurityConfigSchema, schemaSerializable: true, fieldMetadataVisible: true },
  routing: { schema: RoutingConfigSchema, schemaSerializable: true, fieldMetadataVisible: true },
  daemon: { schema: DaemonConfigSchema, schemaSerializable: true, fieldMetadataVisible: true },
  scheduler: { schema: SchedulerConfigSchema, schemaSerializable: true, fieldMetadataVisible: true },
  gateway: { schema: GatewayConfigSchema, schemaSerializable: true, fieldMetadataVisible: true },
  integrations: {
    schema: IntegrationsConfigSchema,
    schemaSerializable: true,
    fieldMetadataVisible: true,
  },
  monitoring: {
    schema: MonitoringConfigSchema,
    schemaSerializable: true,
    fieldMetadataVisible: true,
  },
  // Diagnostics scaffold. Both views visible — placed immediately after
  // monitoring so it groups with the observability-adjacent sections.
  diagnostics: {
    schema: DiagnosticsConfigSchema,
    schemaSerializable: true,
    fieldMetadataVisible: true,
  },

  // The 5 schema-serializer-only sections come BEFORE the 7
  // field-metadata-only sections so that:
  //   (a) the schemaSerializable-filtered subsequence (skipping the 7
  //       field-metadata-only entries) is
  //       [..., monitoring, diagnostics, browser, models, providers, messages,
  //       approvals, tooling], and
  //   (b) the fieldMetadataVisible-filtered subsequence (skipping the 5
  //       schema-serializer-only entries) is
  //       [..., monitoring, diagnostics, plugins, queue, streaming,
  //       autoReplyEngine, sendPolicy, embedding, envelope, tooling].
  browser: { schema: BrowserConfigSchema, schemaSerializable: true, fieldMetadataVisible: false },
  models: { schema: ModelsConfigSchema, schemaSerializable: true, fieldMetadataVisible: false },
  providers: {
    schema: ProvidersConfigSchema,
    schemaSerializable: true,
    fieldMetadataVisible: false,
    managedRedirect: {
      pathPrefix: "providers",
      tool: "providers_manage",
      description:
        "Manage LLM providers (list, get, create, update, delete, enable, disable).",
      // Verified against providers-manage-tool.ts ProvidersManageToolParams.
      exampleArgs: {
        action: "create",
        provider_id: "<any-name>",
        config: {
          type: "<sdk-type>",
          name: "<display-name>",
          baseUrl: "<api-base-url>",
          apiKeyName: "<SECRET_KEY_NAME>",
          models: [{ id: "<model-id>" }],
        },
      },
      fullyManaged: true,
      // Action enum pinned to providers-manage-tool.ts TypeBox Union.
      // provider_id + config are required for create; other actions require
      // only provider_id or nothing (list).
      schemaFragment: {
        actions: ["list", "get", "create", "update", "delete", "enable", "disable"],
        requiredByAction: {
          create: ["provider_id", "config"],
        },
      },
    },
  },
  messages: {
    schema: MessagesConfigSchema,
    schemaSerializable: true,
    fieldMetadataVisible: false,
  },
  approvals: {
    schema: ApprovalsConfigSchema,
    schemaSerializable: true,
    fieldMetadataVisible: false,
  },

  // The 7 field-metadata-only sections.
  plugins: { schema: PluginsConfigSchema, schemaSerializable: false, fieldMetadataVisible: true },
  queue: { schema: QueueConfigSchema, schemaSerializable: false, fieldMetadataVisible: true },
  streaming: {
    schema: StreamingConfigSchema,
    schemaSerializable: false,
    fieldMetadataVisible: true,
  },
  autoReplyEngine: {
    schema: AutoReplyEngineConfigSchema,
    schemaSerializable: false,
    fieldMetadataVisible: true,
  },
  sendPolicy: {
    schema: SendPolicyConfigSchema,
    schemaSerializable: false,
    fieldMetadataVisible: true,
  },
  embedding: {
    schema: EmbeddingConfigSchema,
    schemaSerializable: false,
    fieldMetadataVisible: true,
  },
  envelope: { schema: EnvelopeConfigSchema, schemaSerializable: false, fieldMetadataVisible: true },

  // Tooling sits at the tail of BOTH filtered subsequences — placed before
  // orchestration so each keeps it adjacent to the tail.
  tooling: { schema: ToolingConfigSchema, schemaSerializable: true, fieldMetadataVisible: true },

  // Orchestration authoring gate. Both views (like
  // tooling/approvals); plain boolean flags, so NO managedRedirect (it carries
  // no managed write surface). Appended last so it extends BOTH the
  // schemaSerializable and fieldMetadataVisible subsequences consistently.
  orchestration: {
    schema: OrchestrationConfigSchema,
    schemaSerializable: true,
    fieldMetadataVisible: true,
  },
});

/**
 * Sub-prefix managed redirects — keys are NOT top-level section names.
 * Concatenated with SECTION_REGISTRY managedRedirects in managed-sections.ts,
 * then sorted longest-prefix-first.
 *
 * Order here is irrelevant; managed-sections.ts performs the longest-prefix
 * sort. The listing order is arbitrary and kept stable for git-blame
 * friendliness.
 */
const SUB_PATH_MANAGED_REDIRECTS_LITERAL: readonly ManagedSectionRedirect[] = [
  {
    pathPrefix: "integrations.mcp.servers",
    tool: "mcp_manage",
    description:
      "Manage MCP server connections (list, status, connect, disconnect, reconnect).",
    // Flat parameter shape -- verified against mcp-manage-tool.ts McpManageToolParams.
    exampleArgs: {
      action: "connect",
      server_name: "<server-name>",
      transport: "stdio",
      command: "<command>",
      args: [],
    },
    fullyManaged: true,
    // Action enum pinned to mcp-manage-tool.ts TypeBox Union.
    // requiredByAction.connect captures the stdio-transport happy path
    // (transport="sse"|"http" requires `url` instead of `command` -- the
    // exampleArgs above documents the stdio shape, the schema fragment
    // documents required fields for that same shape).
    schemaFragment: {
      actions: ["list", "status", "connect", "disconnect", "reconnect"],
      requiredByAction: {
        connect: ["server_name", "transport", "command"],
      },
    },
  },
  {
    pathPrefix: "gateway.tokens",
    tool: "tokens_manage",
    description: "Manage gateway tokens (list, create, revoke, rotate).",
    // Verified against tokens-manage-tool.ts TokensManageToolParams.
    exampleArgs: { action: "create", token_id: "<token-id>", scopes: ["rpc", "ws"] },
    fullyManaged: true,
    // Action enum pinned to tokens-manage-tool.ts TypeBox Union.
    // token_id is genuinely Type.Optional (auto-generated when omitted, per
    // the schema description); only `scopes` is strictly required for
    // create.
    schemaFragment: {
      actions: ["list", "create", "revoke", "rotate"],
      requiredByAction: {
        create: ["scopes"],
      },
    },
  },
];

export const SUB_PATH_MANAGED_REDIRECTS: readonly ManagedSectionRedirect[] = Object.freeze(
  SUB_PATH_MANAGED_REDIRECTS_LITERAL,
);
