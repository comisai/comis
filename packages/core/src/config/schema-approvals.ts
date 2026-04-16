import { z } from "zod";

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
    /** Trust level required to auto-approve (default: "verified") */
    minTrustLevel: z.enum(["untrusted", "basic", "verified", "admin"]).default("verified"),
  });

export const ApprovalsConfigSchema = z.strictObject({
    /** Enable the approval workflow for classified actions (default: false) */
    enabled: z.boolean().default(false),
    /** Default approval mode for unmatched actions (default: "auto") */
    defaultMode: z.enum(["auto", "require", "deny"]).default("auto"),
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
 * Returns a warning message if rules are defined but approvals are disabled.
 * Returns undefined if configuration is consistent.
 */
export function checkApprovalsConfig(config: ApprovalsConfig): string | undefined {
  if (!config.enabled && config.rules.length > 0) {
    return `Approvals have ${config.rules.length} rule(s) configured but approvals.enabled is false — rules will not be evaluated. Set approvals.enabled: true or remove the rules.`;
  }
  return undefined;
}
