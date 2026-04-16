import { z } from "zod";
import { SecretRefSchema } from "../domain/secret-ref.js";

/**
 * Match conditions for a webhook mapping.
 *
 * If both `path` and `source` are provided, both must match (AND logic).
 * If neither is provided, the mapping matches all requests.
 */
export const WebhookMappingMatchSchema = z.strictObject({
    /** URL path segment to match (normalized: leading/trailing slashes stripped) */
    path: z.string().min(1).optional(),
    /** Source identifier to match (from payload or header) */
    source: z.string().min(1).optional(),
  });

/**
 * A single webhook mapping configuration.
 *
 * Maps an incoming webhook request to either a "wake" action (trigger
 * daemon heartbeat) or an "agent" action (invoke agent with rendered
 * message template).
 */
export const WebhookMappingConfigSchema = z.strictObject({
    /** Unique identifier for this mapping */
    id: z.string().min(1).optional(),
    /** Match conditions (path and/or source) */
    match: WebhookMappingMatchSchema.optional(),
    /** Action to take: "wake" triggers heartbeat, "agent" invokes agent */
    action: z.enum(["wake", "agent"]).default("agent"),
    /** Wake mode: "now" fires immediately, "next-heartbeat" waits for next cycle */
    wakeMode: z.enum(["now", "next-heartbeat"]).default("now"),
    /** Human-readable name for this mapping */
    name: z.string().optional(),
    /** Target agent ID for agent actions */
    agentId: z.string().optional(),
    /** Session key template (supports {{expr}} placeholders) */
    sessionKey: z.string().optional(),
    /** Message template for agent actions (supports {{expr}} placeholders) */
    messageTemplate: z.string().optional(),
    /** Alternative text template (plain text version) */
    textTemplate: z.string().optional(),
    /** Whether to deliver the message to a channel */
    deliver: z.boolean().optional(),
    /** Target channel for delivery */
    channel: z.string().optional(),
    /** Target recipient for delivery */
    to: z.string().optional(),
    /** Model override for agent execution */
    model: z.string().optional(),
    /** Timeout in seconds for agent execution */
    timeoutSeconds: z.number().int().positive().optional(),
  });

/**
 * Top-level webhooks configuration.
 *
 * Controls the webhook subsystem: base path, authentication token,
 * body size limits, preset mappings, and custom mappings.
 */
export const WebhooksConfigSchema = z.strictObject({
    /** Enable the webhook subsystem (default: false) */
    enabled: z.boolean().default(false),
    /** Base path for webhook endpoints (default: "/hooks") */
    path: z.string().default("/hooks"),
    /** Optional bearer token for webhook authentication (min 32 chars when provided; string or SecretRef) */
    token: z.union([z.string().min(32), SecretRefSchema]).optional(),
    /** Maximum request body size in bytes (default: 256KB) */
    maxBodyBytes: z.number().int().positive().default(256 * 1024),
    /** Preset mapping names to load (e.g., ["gmail", "github"]) */
    presets: z.array(z.string()).default([]),
    /** Custom webhook mappings */
    mappings: z.array(WebhookMappingConfigSchema).default([]),
  });

export type WebhooksConfig = z.infer<typeof WebhooksConfigSchema>;
export type WebhookMappingConfig = z.infer<typeof WebhookMappingConfigSchema>;
