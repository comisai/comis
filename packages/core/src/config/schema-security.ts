import { z } from "zod";
import { SecretsConfigSchema } from "./schema-secrets.js";
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
    subAgentSessionPersistence: z.boolean().default(false),
    /** Per-graph node concurrency limit (how many nodes run in parallel within a single graph) */
    graphMaxConcurrency: z.number().int().positive().optional(),
    /** Maximum result text length per node output (characters) */
    graphMaxResultLength: z.number().int().positive().optional(),
    /** Cross-graph global sub-agent cap (max concurrent sub-agents across all graphs) */
    graphMaxGlobalSubAgents: z.number().int().positive().optional(),
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
    /** Encrypted secrets store configuration */
    secrets: SecretsConfigSchema.default(() => SecretsConfigSchema.parse({})),
  });

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;
export type ActionConfirmationConfig = z.infer<typeof ActionConfirmationConfigSchema>;
