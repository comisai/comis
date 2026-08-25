// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { evaluateApprovalPolicy } from "./approval-policy.js";
import { ApprovalsConfigSchema } from "../config/schema-approvals.js";
import type { ApprovalsConfig } from "../config/schema-approvals.js";

function policy(overrides: Partial<ApprovalsConfig> = {}): ApprovalsConfig {
  return ApprovalsConfigSchema.parse({ enabled: true, ...overrides });
}

describe("rule matching", () => {
  it("selects the first matching rule and ignores later ones", () => {
    const decision = evaluateApprovalPolicy(
      policy({
        rules: [
          { actionPattern: "memory.*", mode: "deny" },
          { actionPattern: "memory.delete", mode: "auto", minTrustLevel: "guest" },
        ],
      }),
      { action: "memory.delete", trustLevel: "admin" },
    );

    expect(decision.mode).toBe("deny");
    expect(decision.matchedPattern).toBe("memory.*");
  });

  it("expands a wildcard across any run of characters", () => {
    const p = policy({ rules: [{ actionPattern: "mcp.*.write", mode: "deny" }] });

    expect(evaluateApprovalPolicy(p, { action: "mcp.github.write", trustLevel: "admin" }).mode)
      .toBe("deny");
    expect(evaluateApprovalPolicy(p, { action: "mcp.a.b.c.write", trustLevel: "admin" }).mode)
      .toBe("deny");
    expect(evaluateApprovalPolicy(p, { action: "mcp.github.read", trustLevel: "admin" }).mode)
      .toBe("require");
  });

  it("anchors the pattern so a prefix match alone does not fire the rule", () => {
    const decision = evaluateApprovalPolicy(
      policy({ rules: [{ actionPattern: "file.read", mode: "auto", minTrustLevel: "guest" }] }),
      { action: "file.read_secret", trustLevel: "admin" },
    );

    expect(decision.mode).toBe("require");
  });

  it("treats regular-expression metacharacters in a pattern as literal text", () => {
    const decision = evaluateApprovalPolicy(
      policy({ rules: [{ actionPattern: "agents.delete", mode: "deny" }] }),
      { action: "agentsXdelete", trustLevel: "admin" },
    );

    expect(decision.mode).toBe("require");
  });
});

describe("auto-approval trust floor", () => {
  it("auto-approves when the requester meets the rule's minimum trust", () => {
    const decision = evaluateApprovalPolicy(
      policy({ rules: [{ actionPattern: "cron.remove", mode: "auto", minTrustLevel: "user" }] }),
      { action: "cron.remove", trustLevel: "admin" },
    );

    expect(decision.mode).toBe("auto");
    expect(decision.matchedPattern).toBe("cron.remove");
  });

  it("falls back to a human decision when the requester is below the rule's minimum trust", () => {
    const decision = evaluateApprovalPolicy(
      policy({ rules: [{ actionPattern: "cron.remove", mode: "auto", minTrustLevel: "admin" }] }),
      { action: "cron.remove", trustLevel: "guest" },
    );

    expect(decision.mode).toBe("require");
    expect(decision.matchedPattern).toBe("cron.remove");
  });

  it("requires admin trust for auto-approval unless the rule lowers the floor", () => {
    const decision = evaluateApprovalPolicy(
      policy({ rules: [{ actionPattern: "cron.remove", mode: "auto" }] }),
      { action: "cron.remove", trustLevel: "user" },
    );

    expect(decision.mode).toBe("require");
  });
});

describe("unmatched actions", () => {
  it("asks a human when no rule matches and no default is configured", () => {
    expect(evaluateApprovalPolicy(policy(), { action: "system.exec", trustLevel: "admin" }).mode)
      .toBe("require");
  });

  it("applies an explicitly configured default mode to unmatched actions", () => {
    const decision = evaluateApprovalPolicy(
      policy({ defaultMode: "deny", rules: [{ actionPattern: "file.*", mode: "auto" }] }),
      { action: "system.exec", trustLevel: "admin" },
    );

    expect(decision.mode).toBe("deny");
    expect(decision.matchedPattern).toBeUndefined();
  });
});

describe("timeout override", () => {
  it("carries a matching rule's timeout so the operator prompt uses it", () => {
    const decision = evaluateApprovalPolicy(
      policy({ rules: [{ actionPattern: "system.exec", mode: "require", timeoutMs: 900 }] }),
      { action: "system.exec", trustLevel: "admin" },
    );

    expect(decision.mode).toBe("require");
    expect(decision.timeoutMs).toBe(900);
  });
});
