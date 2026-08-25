// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { UserTrustLevelSchema } from "../context/context.js";

/**
 * Action approval workflow configuration schema.
 *
 * Controls the approval pipeline for agent-initiated actions. Rules are
 * evaluated in order (first match wins) to determine whether an action
 * should be auto-approved, require human confirmation, or be denied.
 *
 * @module
 */

/**
 * A single approval rule matching action types to approval behavior.
 */
export const ApprovalRuleSchema = z.strictObject({
    /** Pattern matching action types that require approval */
    actionPattern: z.string().min(1),
    /** Approval mode: auto-approve, require-human, deny (default: "auto") */
    mode: z.enum(["auto", "require", "deny"]).default("auto"),
    /** Timeout in milliseconds for human approval (0 = no timeout, default: 300000) */
    timeoutMs: z.number().int().nonnegative().default(300_000),
    /** Trust level a requester must reach for an "auto" rule to approve without a human (default: "admin") */
    minTrustLevel: UserTrustLevelSchema.default("admin"),
  });

export const ApprovalsConfigSchema = z.strictObject({
    /** Enable the approval workflow for classified actions (default: false) */
    enabled: z.boolean().default(false),
    /**
     * Approval mode for actions no rule matches (default: "require").
     *
     * The gate is reached only for actions the classifier already routed to a
     * human, so "require" preserves that decision. Setting "auto" turns the
     * rule list into a denylist: every unmatched action proceeds unprompted.
     */
    defaultMode: z.enum(["auto", "require", "deny"]).default("require"),
    /** Ordered list of approval rules (first match wins) */
    rules: z.array(ApprovalRuleSchema).default([]),
    /** Approval request timeout in milliseconds (default: 300000) */
    defaultTimeoutMs: z.number().int().nonnegative().default(300_000),
    /** How long a denial is cached before expiring, in milliseconds (default: 60000). When a user denies an action, subsequent identical requests (same sessionKey + action) within this window are auto-denied instantly. */
    denialCacheTtlMs: z.number().int().nonnegative().default(60_000),
    /** How long an approval is cached before expiring, in milliseconds (default: 30000). When a user approves an action, subsequent identical requests (same sessionKey + action) within this window are auto-approved instantly. Set to 0 to disable the approval cache. */
    batchApprovalTtlMs: z.number().int().nonnegative().default(30_000),
  });

/** Inferred approvals configuration type. */
export type ApprovalsConfig = z.infer<typeof ApprovalsConfigSchema>;

/** Inferred approval rule type. */
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

/**
 * Check for potentially misconfigured approvals.
 * Returns a warning message when the configuration does not enforce what it appears to.
 * Returns undefined if configuration is consistent.
 */
export function checkApprovalsConfig(config: ApprovalsConfig): string | undefined {
  if (!config.enabled && config.rules.length > 0) {
    return `Approvals have ${config.rules.length} rule(s) configured but approvals.enabled is false — rules will not be evaluated. Set approvals.enabled: true or remove the rules.`;
  }
  if (config.enabled && config.defaultMode === "auto") {
    return `Approvals are enabled but approvals.defaultMode is "auto" — every action no rule matches is approved without a human. Set approvals.defaultMode: "require" to ask, or keep "auto" only if the rule list is a deliberate denylist.`;
  }
  return undefined;
}
