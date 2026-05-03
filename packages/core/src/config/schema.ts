// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { PerAgentConfigSchema, RoutingConfigSchema } from "./schema-agent.js";
import { ApprovalsConfigSchema } from "./schema-approvals.js";
import { AutoReplyEngineConfigSchema } from "./schema-auto-reply-engine.js";
import { BrowserConfigSchema } from "./schema-browser.js";
import { ChannelConfigSchema } from "./schema-channel.js";
import { CoalescerConfigSchema } from "./schema-coalescer.js";
import { DaemonConfigSchema } from "./schema-daemon.js";
import { DeliveryMirrorConfigSchema, DeliveryQueueConfigSchema, DeliveryTimingConfigSchema } from "./schema-delivery.js";
import { DocumentationConfigSchema } from "./schema-documentation.js";
import { EmbeddingConfigSchema } from "./schema-embedding.js";
import { EnvelopeConfigSchema } from "./schema-envelope.js";
import { GatewayConfigSchema } from "./schema-gateway.js";
import { IntegrationsConfigSchema } from "./schema-integrations.js";
import { LifecycleReactionsConfigSchema } from "./schema-lifecycle-reactions.js";
import { MemoryConfigSchema } from "./schema-memory.js";
import { MessagesConfigSchema } from "./schema-messages.js";
import { ModelsConfigSchema } from "./schema-models.js";
import { MonitoringConfigSchema } from "./schema-observability.js";
import { ObservabilityConfigSchema } from "./schema-observability.js";
import { OAuthConfigSchema } from "./schema-oauth.js";
import { PluginsConfigSchema } from "./schema-plugins.js";
import { ProvidersConfigSchema } from "./schema-providers.js";
import { QueueConfigSchema } from "./schema-queue.js";
import { ResponsePrefixConfigSchema } from "./schema-response-prefix.js";
import { SchedulerConfigSchema } from "./schema-scheduler.js";
import { SecurityConfigSchema } from "./schema-security.js";
import { SenderTrustDisplayConfigSchema } from "./schema-sender-trust-display.js";
import { SendPolicyConfigSchema } from "./schema-send-policy.js";
import { StreamingConfigSchema } from "./schema-streaming.js";
import { TelegramFileRefGuardConfigSchema } from "./schema-telegram-file-guard.js";
import { WebhooksConfigSchema } from "./schema-webhooks.js";

/**
 * Root application configuration schema.
 *
 * Composes all domain-specific config sections into a single validated
 * config object. Each section has sensible defaults so a minimal config
 * file (or even empty object) produces a valid AppConfig.
 */
export const AppConfigSchema = z.strictObject({
    /** Tenant identifier for SaaS multi-tenancy */
    tenantId: z.string().default("default"),
    /** Global log level */
    logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    /** Base data directory for all persistent storage (default: ~/.comis) */
    dataDir: z.string().default(""),
    /** SDK agent directory for persistent settings (default: ~/.pi/agent) */
    agentDir: z.string().default("~/.pi/agent"),
    /** Multi-agent configuration map (agent ID -> per-agent config with optional skills) */
    agents: z.record(z.string().min(1), PerAgentConfigSchema).default(() => ({ default: PerAgentConfigSchema.parse({}) })),
    /** Channel adapter configuration */
    channels: ChannelConfigSchema.default(() => ChannelConfigSchema.parse({})),
    /** Memory system configuration */
    memory: MemoryConfigSchema.default(() => MemoryConfigSchema.parse({})),
    /** Security configuration */
    security: SecurityConfigSchema.default(() => SecurityConfigSchema.parse({})),
    /** Multi-agent routing configuration */
    routing: RoutingConfigSchema.default(() => RoutingConfigSchema.parse({})),
    /** Daemon process configuration */
    daemon: DaemonConfigSchema.default(() => DaemonConfigSchema.parse({})),
    /** Scheduler / proactive automation configuration */
    scheduler: SchedulerConfigSchema.default(() => SchedulerConfigSchema.parse({})),
    /** Gateway HTTPS server configuration */
    gateway: GatewayConfigSchema.default(() => GatewayConfigSchema.parse({})),
    /** External integrations configuration */
    integrations: IntegrationsConfigSchema.default(() => IntegrationsConfigSchema.parse({})),
    /** System monitoring configuration */
    monitoring: MonitoringConfigSchema.default(() => MonitoringConfigSchema.parse({})),
    /** Observability persistence configuration */
    observability: ObservabilityConfigSchema.default(() => ObservabilityConfigSchema.parse({})),
    /** OAuth credential storage configuration (storage backend selector) */
    oauth: OAuthConfigSchema.default(() => OAuthConfigSchema.parse({})),
    /** Plugin system configuration */
    plugins: PluginsConfigSchema.default(() => PluginsConfigSchema.parse({})),
    /** Command queue configuration for session serialization and concurrency control */
    queue: QueueConfigSchema.default(() => QueueConfigSchema.parse({})),
    /** Block streaming and typing indicator configuration */
    streaming: StreamingConfigSchema.default(() => StreamingConfigSchema.parse({})),
    /** Auto-reply engine: controls whether the agent activates for inbound messages */
    autoReplyEngine: AutoReplyEngineConfigSchema.default(() => AutoReplyEngineConfigSchema.parse({})),
    /** Send policy: rules-based outbound message gating */
    sendPolicy: SendPolicyConfigSchema.default(() => SendPolicyConfigSchema.parse({})),
    /** Embedding provider configuration (local GGUF, OpenAI, auto-selection) */
    embedding: EmbeddingConfigSchema.default(() => EmbeddingConfigSchema.parse({})),
    /** Message envelope: enriches inbound messages with provider, timestamp, and elapsed time for LLM context */
    envelope: EnvelopeConfigSchema.default(() => EnvelopeConfigSchema.parse({})),
    /** Browser automation configuration (CDP, headless Chrome) */
    browser: BrowserConfigSchema.default(() => BrowserConfigSchema.parse({})),
    /** Model catalog and alias configuration */
    models: ModelsConfigSchema.default(() => ModelsConfigSchema.parse({})),
    /** LLM provider configuration (API keys via SecretManager, endpoints, retries) */
    providers: ProvidersConfigSchema.default(() => ProvidersConfigSchema.parse({})),
    /** Messaging UX configuration (splitting, typing indicators, receipts) */
    messages: MessagesConfigSchema.default(() => MessagesConfigSchema.parse({})),
    /** Action approval workflow configuration (rules-based gating) */
    approvals: ApprovalsConfigSchema.default(() => ApprovalsConfigSchema.parse({})),
    /** Webhook subsystem configuration (path-based routing, HMAC auth, mappings) */
    webhooks: WebhooksConfigSchema.default(() => WebhooksConfigSchema.parse({})),
    /** Lifecycle status reactions for agent processing phases */
    lifecycleReactions: LifecycleReactionsConfigSchema.default(() => LifecycleReactionsConfigSchema.parse({})),
    /** Response prefix/suffix template injected into agent replies */
    responsePrefix: ResponsePrefixConfigSchema.default(() => ResponsePrefixConfigSchema.parse({})),
    /** Crash-safe outbound delivery queue configuration */
    deliveryQueue: DeliveryQueueConfigSchema.default(() => DeliveryQueueConfigSchema.parse({})),
    /** Session mirroring persistence configuration */
    deliveryMirror: DeliveryMirrorConfigSchema.default(() => DeliveryMirrorConfigSchema.parse({})),
    /** Inter-block delivery timing and pacing configuration */
    deliveryTiming: DeliveryTimingConfigSchema.default(() => DeliveryTimingConfigSchema.parse({})),
    /** Block coalescer: accumulates small streaming blocks before delivery */
    coalescer: CoalescerConfigSchema.default(() => CoalescerConfigSchema.parse({})),
    /** Sender trust display: controls how sender identity is surfaced to the LLM */
    senderTrustDisplay: SenderTrustDisplayConfigSchema.default(() => SenderTrustDisplayConfigSchema.parse({})),
    /** Documentation links injected into system prompt */
    documentation: DocumentationConfigSchema.default(() => DocumentationConfigSchema.parse({})),
    /** Telegram file reference guard: detects hallucinated file paths in responses */
    telegramFileRefGuard: TelegramFileRefGuardConfigSchema.default(() => TelegramFileRefGuardConfigSchema.parse({})),
  }).superRefine((config, ctx) => {
    // Startup invariant: reject the reserved "default" provider name.
    // "default" collides with PerAgentConfigSchema.provider's schema default
    // value, making it impossible to distinguish "user explicitly chose the
    // provider named 'default'" from "user omitted the provider field and got
    // the schema default". Reject at parse time with an actionable rename hint.
    if (config.providers?.entries?.default !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providers", "entries", "default"],
        message:
          "providers.entries.default is reserved (it collides with the PerAgentConfig.provider " +
          "schema default). Rename to a specific identifier like providers.entries.anthropic-default.",
      });
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;
