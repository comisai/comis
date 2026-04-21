// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Send action: allow or deny an outbound message.
 */
export const SendActionSchema = z.enum(["allow", "deny"]).default("allow");

/**
 * A single send policy rule.
 *
 * Rules are evaluated in order (first match wins). Each field is optional;
 * omitted fields match any value. At least one matching field should be
 * present for the rule to be meaningful.
 */
export const SendPolicyRuleSchema = z.strictObject({
    /** Channel ID to match (exact string match, or omit for any) */
    channelId: z.string().min(1).optional(),
    /** Chat type to match: dm, group, thread, channel, forum (or omit for any) */
    chatType: z.string().min(1).optional(),
    /** Channel type to match: telegram, discord, slack, whatsapp (or omit for any) */
    channelType: z.string().min(1).optional(),
    /** Action when this rule matches */
    action: SendActionSchema,
    /** Human-readable description for config readability */
    description: z.string().optional(),
  });

/**
 * Send policy configuration.
 *
 * Controls whether the agent is allowed to send outbound messages to a
 * given channel/chatType/channelType combination. Rules are evaluated in
 * order; first match wins. If no rule matches, the defaultAction applies.
 */
export const SendPolicyConfigSchema = z.strictObject({
    /** Enable send policy enforcement (default: true) */
    enabled: z.boolean().default(true),
    /** Default action when no rules match */
    defaultAction: SendActionSchema,
    /** Ordered list of rules (first match wins) */
    rules: z.array(SendPolicyRuleSchema).default([]),
  });

export type SendPolicyConfig = z.infer<typeof SendPolicyConfigSchema>;
export type SendPolicyRule = z.infer<typeof SendPolicyRuleSchema>;
export type SendAction = z.infer<typeof SendActionSchema>;
