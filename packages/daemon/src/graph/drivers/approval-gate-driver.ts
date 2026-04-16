/**
 * Human approval checkpoint node type driver.
 * Pauses pipeline execution by returning a `wait_for_input` action. The
 * coordinator sends a message to the user's channel and blocks until the
 * user replies or timeout. The user's reply is classified as approve, deny,
 * or ambiguous using tiered keyword matching.
 * @module
 */

import { z } from "zod";
import type { NodeTypeDriver, NodeDriverContext, NodeDriverAction } from "@comis/core";

const configSchema = z.strictObject({
  message: z.string().optional(),
  timeout_minutes: z.number().min(1).max(1440).default(60),
});

const APPROVE_KEYWORDS = [
  "approve", "yes", "go", "confirm", "proceed",
  "ok", "sure", "yeah", "sounds good", "do it", "lgtm",
];

const DENY_KEYWORDS = [
  "deny", "no", "stop", "reject", "cancel",
  "abort", "hold", "wait", "don't",
];

export function createApprovalGateDriver(): NodeTypeDriver {
  return {
    typeId: "approval-gate",
    name: "Human Approval Checkpoint",
    description:
      "Pauses pipeline execution and asks the user for approval before continuing.",
    configSchema,
    defaultTimeoutMs: 3_600_000, // 1 hour -- approval waits are long
    estimateDurationMs(config) {
      const c = config as z.infer<typeof configSchema>;
      return (c.timeout_minutes ?? 60) * 60_000;
    },
    initialize(ctx: NodeDriverContext): NodeDriverAction {
      const config = ctx.typeConfig as z.infer<typeof configSchema>;
      const message = config.message ?? buildDefaultMessage(ctx);
      return {
        action: "wait_for_input",
        message,
        timeoutMs: (config.timeout_minutes ?? 60) * 60_000,
      };
    },
    onTurnComplete(_ctx: NodeDriverContext, agentOutput: string): NodeDriverAction {
      // agentOutput is the user's reply text from wait_for_input
      const classification = classifyResponse(agentOutput);

      if (classification === "approve") {
        return { action: "complete", output: `Approved. User response: ${agentOutput}` };
      }
      if (classification === "deny") {
        return { action: "fail", error: `Denied by user: ${agentOutput}` };
      }
      // Ambiguous
      return {
        action: "fail",
        error: `Could not determine approval from your response: "${agentOutput}". Reply with 'yes' to approve or 'no' to deny.`,
      };
    },
    onAbort(_ctx: NodeDriverContext): void {
      // No cleanup needed -- coordinator handles listener cleanup
    },
  };
}

/** Build default approval message from node context. */
function buildDefaultMessage(ctx: NodeDriverContext): string {
  const label = ctx.graphLabel ? ` for "${ctx.graphLabel}"` : "";
  return `Approval required${label}. Reply 'yes' to approve or 'no' to deny.`;
}

/** Classify user response using tiered keyword matching. */
function classifyResponse(response: string): "approve" | "deny" | "ambiguous" {
  const normalized = response.toLowerCase().trim();
  if (APPROVE_KEYWORDS.some((kw) => normalized.includes(kw))) return "approve";
  if (DENY_KEYWORDS.some((kw) => normalized.includes(kw))) return "deny";
  return "ambiguous";
}
