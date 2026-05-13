// SPDX-License-Identifier: Apache-2.0
import type { TypedEventBus } from "@comis/core";
import { createAuditEvent, classifyAction } from "@comis/core";

/**
 * Skill audit action types.
 */
export type SkillAuditAction =
  | "skill.prompt.load"
  | "skill.prompt.invoke"
  | "skill.validation.coercion"
  | "skill.scan"
  | "skill.scan.reject";

/**
 * Options for emitting a skill audit event.
 */
export interface SkillAuditOptions {
  /** The agent performing the action */
  agentId: string;
  /** Tenant context */
  tenantId: string;
  /** User who owns the action */
  userId: string;
  /** Name of the skill being audited */
  skillName: string;
  /** The action being performed */
  action: SkillAuditAction;
  /** Outcome of the action */
  outcome: "success" | "failure" | "denied";
  /** Optional metadata (e.g., violations for rejected skills) */
  metadata?: Record<string, unknown>;
  /** Optional duration in milliseconds */
  duration?: number;
}

/**
 * Emit a skill-related audit event on the typed event bus.
 *
 * Produces both a generic `audit:event` and a specific skill event
 * (`skill:prompt_loaded` or `skill:prompt_invoked`) on the bus.
 *
 * @param eventBus - The typed event bus to emit on
 * @param opts - Audit event options
 */
export function emitSkillAudit(eventBus: TypedEventBus, opts: SkillAuditOptions): void {
  const classification = classifyAction(opts.action);

  // Emit the generic audit:event
  const auditEvent = createAuditEvent({
    agentId: opts.agentId,
    tenantId: opts.tenantId,
    userId: opts.userId,
    actionType: opts.action,
    classification,
    outcome: opts.outcome,
    metadata: {
      skillName: opts.skillName,
      ...opts.metadata,
    },
    duration: opts.duration,
  });

  eventBus.emit("audit:event", {
    timestamp: Date.now(),
    agentId: auditEvent.agentId,
    tenantId: auditEvent.tenantId,
    actionType: auditEvent.actionType,
    classification: auditEvent.classification,
    outcome: auditEvent.outcome,
    metadata: auditEvent.metadata,
  });

  // Emit the specific skill event
  const now = Date.now();
  switch (opts.action) {
    case "skill.prompt.load":
      eventBus.emit("skill:prompt_loaded", {
        skillName: opts.skillName,
        source: (opts.metadata?.["source"] as string) ?? "unknown",
        bodyLength: (opts.metadata?.["bodyLength"] as number) ?? 0,
        timestamp: now,
      });
      break;
    case "skill.prompt.invoke":
      eventBus.emit("skill:prompt_invoked", {
        skillName: opts.skillName,
        invokedBy: (opts.metadata?.["invokedBy"] as "user" | "model") ?? "user",
        args: (opts.metadata?.["args"] as string) ?? "",
        timestamp: now,
      });
      break;
    case "skill.scan":
      eventBus.emit("skill:rejected", {
        skillName: opts.skillName,
        reason: "Content scan findings detected",
        violations: (opts.metadata?.["findings"] as Array<{ ruleId: string }> | undefined)?.map(f => f.ruleId) ?? [],
        timestamp: now,
      });
      break;
    case "skill.scan.reject":
      eventBus.emit("skill:rejected", {
        skillName: opts.skillName,
        reason: "Skill blocked: CRITICAL content scan findings",
        violations: (opts.metadata?.["findings"] as Array<{ ruleId: string }> | undefined)?.map(f => f.ruleId) ?? [],
        timestamp: now,
      });
      break;
  }
}
