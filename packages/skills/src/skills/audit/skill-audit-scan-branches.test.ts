// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for skill-audit.ts — skill.scan and skill.scan.reject
 * action branches.
 *
 * The companion skill-audit.test.ts covers only `skill.prompt.load` and
 * `skill.prompt.invoke` action branches. This file adds coverage for the
 * remaining two action branches plus the metadata?.findings
 * nullish-coalescing branches inside each case.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { TypedEventBus } from "@comis/core";
import { emitSkillAudit } from "./skill-audit.js";

function createMockEventBus(): {
  emit: ReturnType<typeof vi.fn>;
  bus: Pick<TypedEventBus, "emit">;
} {
  const emit = vi.fn();
  return { emit, bus: { emit } as Pick<TypedEventBus, "emit"> };
}

describe("emitSkillAudit — skill.scan branches", () => {
  it("emits skill:rejected event with findings array when scan action with metadata is audited", () => {
    const { emit, bus } = createMockEventBus();
    emitSkillAudit(bus as TypedEventBus, {
      agentId: "agent-1",
      tenantId: "default",
      userId: "user-1",
      skillName: "test-skill",
      action: "skill.scan",
      outcome: "denied",
      metadata: {
        findings: [
          { ruleId: "rule-1" },
          { ruleId: "rule-2" },
        ],
      },
    });
    const skillRejectedCall = emit.mock.calls.find(
      (c) => c[0] === "skill:rejected",
    );
    expect(skillRejectedCall).toBeDefined();
    expect(skillRejectedCall![1]).toMatchObject({
      skillName: "test-skill",
      reason: "Content scan findings detected",
      violations: ["rule-1", "rule-2"],
    });
  });

  it("emits skill:rejected with empty violations when scan action has no findings metadata", () => {
    const { emit, bus } = createMockEventBus();
    emitSkillAudit(bus as TypedEventBus, {
      agentId: "agent-1",
      tenantId: "default",
      userId: "user-1",
      skillName: "test-skill",
      action: "skill.scan",
      outcome: "denied",
      // metadata omitted — exercises the ?? [] fallback
    });
    const skillRejectedCall = emit.mock.calls.find(
      (c) => c[0] === "skill:rejected",
    );
    expect(skillRejectedCall).toBeDefined();
    expect(skillRejectedCall![1]).toMatchObject({
      reason: "Content scan findings detected",
      violations: [],
    });
  });

  it("emits skill:rejected with CRITICAL reason when scan.reject action is audited", () => {
    const { emit, bus } = createMockEventBus();
    emitSkillAudit(bus as TypedEventBus, {
      agentId: "agent-1",
      tenantId: "default",
      userId: "user-1",
      skillName: "blocked-skill",
      action: "skill.scan.reject",
      outcome: "denied",
      metadata: {
        findings: [{ ruleId: "critical-rule-x" }],
      },
    });
    const skillRejectedCall = emit.mock.calls.find(
      (c) => c[0] === "skill:rejected",
    );
    expect(skillRejectedCall).toBeDefined();
    expect(skillRejectedCall![1]).toMatchObject({
      skillName: "blocked-skill",
      reason: "Skill blocked: CRITICAL content scan findings",
      violations: ["critical-rule-x"],
    });
  });

  it("emits skill:rejected with empty violations when scan.reject has no findings metadata", () => {
    const { emit, bus } = createMockEventBus();
    emitSkillAudit(bus as TypedEventBus, {
      agentId: "agent-1",
      tenantId: "default",
      userId: "user-1",
      skillName: "blocked-skill",
      action: "skill.scan.reject",
      outcome: "denied",
    });
    const skillRejectedCall = emit.mock.calls.find(
      (c) => c[0] === "skill:rejected",
    );
    expect(skillRejectedCall).toBeDefined();
    expect(skillRejectedCall![1]).toMatchObject({
      violations: [],
    });
  });

  it("does not emit any skill-specific event when validation.coercion action is audited", () => {
    const { emit, bus } = createMockEventBus();
    emitSkillAudit(bus as TypedEventBus, {
      agentId: "agent-1",
      tenantId: "default",
      userId: "user-1",
      skillName: "coerced-skill",
      action: "skill.validation.coercion",
      outcome: "success",
    });
    const skillCalls = emit.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].startsWith("skill:"),
    );
    expect(skillCalls).toHaveLength(0);
    // audit:event still emitted for generic audit trail
    const auditCalls = emit.mock.calls.filter((c) => c[0] === "audit:event");
    expect(auditCalls).toHaveLength(1);
  });
});
