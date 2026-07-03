// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { SubagentContextConfigSchema } from "../domain/subagent-context-config.js";

/**
 * Security configuration schema.
 *
 * Controls log redaction, audit logging, Node.js permission flags,
 * and action confirmation requirements.
 */

export const PermissionConfigSchema = z.strictObject({
    /** Enable Node.js --permission flag enforcement */
    enableNodePermissions: z.boolean().default(false),
    /** Allowed filesystem read/write paths */
    allowedFsPaths: z.array(z.string()).default([]),
    /** Allowed network hosts for outbound connections */
    allowedNetHosts: z.array(z.string()).default([]),
  });

export const ActionConfirmationConfigSchema = z.strictObject({
    /** Require human confirmation for destructive actions */
    requireForDestructive: z.boolean().default(true),
    /** Require human confirmation for sensitive (non-destructive but important) actions */
    requireForSensitive: z.boolean().default(false),
    /** Actions that are always auto-approved (bypass confirmation) */
    autoApprove: z.array(z.string()).default([]),
  });

/**
 * Sub-agent completion delivery resilience config.
 * Nests under `security.agentToAgent.delivery` — joins the already-registered
 * section, so it adds ZERO new SECTION_REGISTRY entries (the same pattern as
 * `tokenBudget`). Every field `.default()` (AGENTS.md §6.4).
 */
const DeliveryConfigSchema = z.strictObject({
    /** Max retry attempts for a transient delivery failure before dead-lettering. 0 = dead-letter on the first transient blip; capped at 10 to bound retry-storm amplification. */
    maxRetries: z.number().int().min(0).max(10).default(3),
  });

const AgentToAgentBaseSchema = z.strictObject({
    /** Enable cross-agent session messaging */
    enabled: z.boolean().default(true),
    /** Maximum ping-pong turns for reply-back loops (0-5) */
    maxPingPongTurns: z.number().int().min(0).max(5).default(3),
    /** Allowlist of agent IDs that can be spawned as sub-agents (empty = allow all) */
    allowAgents: z.array(z.string().min(1)).default([]),
    /** Retention period for completed sub-agent sessions in ms (default 1 hour) */
    subAgentRetentionMs: z.number().int().positive().default(3_600_000),
    /** Default timeout for wait mode in ms (default 60 seconds) */
    waitTimeoutMs: z.number().int().positive().default(60_000),
    /** Default max steps for sub-agent execution (hard cap per-spawn overrides cannot exceed) */
    subAgentMaxSteps: z.number().int().positive().default(50),
    /** Default tool profile groups for sub-agent tool assembly */
    subAgentToolGroups: z.array(z.enum(["minimal", "coding", "messaging", "supervisor", "full"])).default(["coding"]),
    /** MCP tool inheritance policy for sub-agents: "inherit" passes MCP tools, "none" excludes them */
    subAgentMcpTools: z.enum(["inherit", "none"]).default("inherit"),
    /** When true, sub-agents write JSONL session logs to disk instead of using ephemeral in-memory sessions */
    subAgentSessionPersistence: z.boolean().default(true),
    /** Per-graph node concurrency limit (how many nodes run in parallel within a single graph) */
    graphMaxConcurrency: z.number().int().positive().optional(),
    /** Maximum result text length per node output (characters) */
    graphMaxResultLength: z.number().int().positive().optional(),
    /** Cross-graph global sub-agent cap (max concurrent sub-agents across all graphs) */
    graphMaxGlobalSubAgents: z.number().int().positive().optional(),
    /** Per-spawn token budget for graph sub-agents. null (default) = inherit the graph share (graphBudget.maxTokens / total node count) ONLY when a graph budget is set; else unbounded. A graph node's own tokenBudget overrides this. */
    tokenBudget: z.number().int().positive().nullable().default(null),
    /** Sub-agent completion delivery resilience. Joins the existing security.agentToAgent section — ZERO new SECTION_REGISTRY entries. Consumers read security.agentToAgent.delivery.maxRetries — never `?? 3` at the call site (AGENTS.md §6.4). */
    delivery: DeliveryConfigSchema.default(() => DeliveryConfigSchema.parse({})),
    /**
     * Fail-closed sandbox no-downgrade invariant. When true (default — pure safety),
     * a sub-agent spawn is REFUSED before any run/session is created if the child's resolved sandbox
     * posture is LESS confined than its spawner's on any dimension (emitting security:sandbox_downgrade_refused).
     * Joins the existing security.agentToAgent section — ZERO new SECTION_REGISTRY entries.
     * Set false to disable the gate. No compat shim (AGENTS.md §2.9) — the refusal is the intended behavior.
     * Consumers read security.agentToAgent.sandboxNoDowngrade — never `?? true` at the call site (AGENTS.md §6.4).
     */
    sandboxNoDowngrade: z.boolean().default(true),
    /**
     * Real mid-flight steering inject. When true, `subagent.steer`
     * injects the message into the RUNNING child at its next step boundary
     * (transcript + progress preserved) instead of kill+respawn; default false =
     * kill+respawn behavior. Joins the existing
     * security.agentToAgent section — ZERO new SECTION_REGISTRY entries.
     * Ships gated-off; the operator enables it on observed steering demand.
     * Consumers read security.agentToAgent.steerInject — never `?? false` at the
     * call site (AGENTS.md §6.4).
     */
    steerInject: z.boolean().default(false),
  });

export const AgentToAgentConfigSchema = AgentToAgentBaseSchema.extend({
    /** Subagent context lifecycle configuration */
    subagentContext: SubagentContextConfigSchema.default(() => SubagentContextConfigSchema.parse({})),
  });

export type AgentToAgentConfig = z.infer<typeof AgentToAgentConfigSchema>;

export const SecurityConfigSchema = z.strictObject({
    /** Enable structured log redaction of sensitive fields */
    logRedaction: z.boolean().default(true),
    /** Enable audit event logging */
    auditLog: z.boolean().default(true),
    /** Node.js permission model settings */
    permission: PermissionConfigSchema.default(() => PermissionConfigSchema.parse({})),
    /** Action confirmation requirements */
    actionConfirmation: ActionConfirmationConfigSchema.default(() => ActionConfirmationConfigSchema.parse({})),
    /** Agent-to-agent session messaging policy */
    agentToAgent: AgentToAgentConfigSchema.default(() => AgentToAgentConfigSchema.parse({})),
    /**
     * Secret egress guard behavior for file write/edit tools.
     * - "warn"  (default): write proceeds with scrubbed content + redirect hint (safe for .env.example, test fixtures)
     * - "block": write is rejected when secret-shaped values are detected
     * - "off":   no write-time secret scan
     * Default is "warn" — never "block" by default (false-positive risk on .env.example / hex SHAs / ${VAR} refs).
     */
    writeSecretGuard: z.enum(["warn", "block", "off"]).default("warn").optional(),
    /**
     * Credential storage backend for ALL credential stores (secrets, OAuth, MCP tokens).
     * - "encrypted" (default): AES-256-GCM SQLite — requires SECRETS_MASTER_KEY
     * - "file": plaintext JSON/files at 0600
     * - "env": read-only, reads .env/process.env only
     *
     * Runtime-immutable (sits under security.* in IMMUTABLE_CONFIG_PREFIXES).
     * Mode switching requires an operator config-file edit + daemon restart.
     */
    storage: z.enum(["encrypted", "file", "env"]).default("encrypted"),
  });

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;
export type ActionConfirmationConfig = z.infer<typeof ActionConfirmationConfigSchema>;

/**
 * Shared credential storage mode type — derived from the security.storage enum
 * so the type and the valid values stay in sync automatically.
 *
 * Used by all three credential stores: secrets, OAuth profiles, MCP tokens.
 */
export type CredentialStorageMode = z.infer<typeof SecurityConfigSchema.shape.storage>;
