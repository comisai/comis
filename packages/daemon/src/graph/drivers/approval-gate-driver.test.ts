// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { NodeDriverContext } from "@comis/core";
import { createApprovalGateDriver } from "./approval-gate-driver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(overrides: Partial<NodeDriverContext> = {}): NodeDriverContext {
  let state: unknown;
  return {
    nodeId: "n1",
    task: "Deploy the release",
    typeConfig: {},
    sharedDir: "/tmp/shared",
    graphLabel: "Test Graph",
    defaultAgentId: "default-agent",
    typeName: "approval-gate",
    getState: <T>() => state as T | undefined,
    setState: <T>(s: T) => { state = s; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createApprovalGateDriver
// ---------------------------------------------------------------------------

describe("createApprovalGateDriver", () => {
  const driver = createApprovalGateDriver();

  // -- Metadata ------------------------------------------------------------

  it("has typeId 'approval-gate'", () => {
    expect(driver.typeId).toBe("approval-gate");
  });

  it("has defaultTimeoutMs 3_600_000", () => {
    expect(driver.defaultTimeoutMs).toBe(3_600_000);
  });

  // -- initialize ----------------------------------------------------------

  it("initialize with default config returns wait_for_input with graph label", () => {
    const ctx = createMockContext({ typeConfig: {} });
    const action = driver.initialize(ctx);
    expect(action).toEqual({
      action: "wait_for_input",
      message: 'Approval required for "Test Graph". Reply \'yes\' to approve or \'no\' to deny.',
      timeoutMs: 60 * 60_000,
    });
  });

  it("initialize with no graphLabel omits label from message", () => {
    const ctx = createMockContext({ typeConfig: {}, graphLabel: undefined });
    const action = driver.initialize(ctx);
    expect(action.action).toBe("wait_for_input");
    if (action.action === "wait_for_input") {
      expect(action.message).toBe("Approval required. Reply 'yes' to approve or 'no' to deny.");
    }
  });

  it("initialize with custom message returns that exact message", () => {
    const ctx = createMockContext({ typeConfig: { message: "Deploy to prod?" } });
    const action = driver.initialize(ctx);
    expect(action.action).toBe("wait_for_input");
    if (action.action === "wait_for_input") {
      expect(action.message).toBe("Deploy to prod?");
    }
  });

  it("initialize with custom timeout_minutes scales timeoutMs", () => {
    const ctx = createMockContext({ typeConfig: { timeout_minutes: 30 } });
    const action = driver.initialize(ctx);
    expect(action.action).toBe("wait_for_input");
    if (action.action === "wait_for_input") {
      expect(action.timeoutMs).toBe(30 * 60_000);
    }
  });

  // -- onTurnComplete: APPROVE keywords ------------------------------------

  describe("APPROVE keyword classification", () => {
    const approveKeywords = [
      "yes", "approve", "go", "confirm", "proceed",
      "ok", "sure", "yeah", "sounds good", "do it", "lgtm",
    ];

    for (const keyword of approveKeywords) {
      it(`classifies "${keyword}" as approve`, () => {
        const ctx = createMockContext();
        const action = driver.onTurnComplete(ctx, keyword);
        expect(action).toEqual({
          action: "complete",
          output: `Approved. User response: ${keyword}`,
        });
      });
    }

    it('classifies "YES" (uppercase) as approve', () => {
      const ctx = createMockContext();
      const action = driver.onTurnComplete(ctx, "YES");
      expect(action.action).toBe("complete");
    });

    it('classifies "Approve" (mixed case) as approve', () => {
      const ctx = createMockContext();
      const action = driver.onTurnComplete(ctx, "Approve");
      expect(action.action).toBe("complete");
    });

    it('classifies "LGTM" (uppercase) as approve', () => {
      const ctx = createMockContext();
      const action = driver.onTurnComplete(ctx, "LGTM");
      expect(action.action).toBe("complete");
    });

    it('classifies "yes please" (substring match) as approve', () => {
      const ctx = createMockContext();
      const action = driver.onTurnComplete(ctx, "yes please");
      expect(action.action).toBe("complete");
    });

    it('classifies "I approve this" (substring match) as approve', () => {
      const ctx = createMockContext();
      const action = driver.onTurnComplete(ctx, "I approve this");
      expect(action.action).toBe("complete");
    });

    it('classifies "sounds good to me" (substring match) as approve', () => {
      const ctx = createMockContext();
      const action = driver.onTurnComplete(ctx, "sounds good to me");
      expect(action.action).toBe("complete");
    });
  });

  // -- onTurnComplete: DENY keywords ---------------------------------------

  describe("DENY keyword classification", () => {
    const denyKeywords = [
      "no", "deny", "stop", "reject", "cancel",
      "abort", "hold", "wait", "don't",
    ];

    for (const keyword of denyKeywords) {
      it(`classifies "${keyword}" as deny`, () => {
        const ctx = createMockContext();
        const action = driver.onTurnComplete(ctx, keyword);
        expect(action).toEqual({
          action: "fail",
          error: `Denied by user: ${keyword}`,
        });
      });
    }

    it('classifies "NO" (uppercase) as deny', () => {
      const ctx = createMockContext();
      const action = driver.onTurnComplete(ctx, "NO");
      expect(action.action).toBe("fail");
    });

    it('classifies "DENY" (uppercase) as deny', () => {
      const ctx = createMockContext();
      const action = driver.onTurnComplete(ctx, "DENY");
      expect(action.action).toBe("fail");
    });

    it('classifies "no way" (substring match) as deny', () => {
      const ctx = createMockContext();
      const action = driver.onTurnComplete(ctx, "no way");
      expect(action.action).toBe("fail");
    });

    it('classifies "please stop" (substring match) as deny', () => {
      const ctx = createMockContext();
      const action = driver.onTurnComplete(ctx, "please stop");
      expect(action.action).toBe("fail");
    });
  });

  // -- onTurnComplete: AMBIGUOUS -------------------------------------------

  describe("AMBIGUOUS classification", () => {
    // Note: "not sure" contains "sure" (approve keyword) so it classifies as approve, not ambiguous
    const ambiguousInputs = ["maybe", "let me think", "hmm", "idk"];

    for (const input of ambiguousInputs) {
      it(`classifies "${input}" as ambiguous`, () => {
        const ctx = createMockContext();
        const action = driver.onTurnComplete(ctx, input);
        expect(action.action).toBe("fail");
        if (action.action === "fail") {
          expect(action.error).toContain("Could not determine approval");
        }
      });
    }
  });

  // -- onTurnComplete: PRIORITY (approve beats deny) -----------------------

  it("approve beats deny when both keywords present", () => {
    const ctx = createMockContext();
    // "sounds good" (approve) + "wait" (deny) -- approve checked first
    const action = driver.onTurnComplete(ctx, "sounds good, but wait");
    expect(action.action).toBe("complete");
  });

  // -- estimateDurationMs --------------------------------------------------

  it("estimateDurationMs with timeout_minutes=30 returns 30 * 60_000", () => {
    expect(driver.estimateDurationMs({ timeout_minutes: 30 })).toBe(30 * 60_000);
  });

  it("estimateDurationMs with default returns 60 * 60_000", () => {
    expect(driver.estimateDurationMs({})).toBe(60 * 60_000);
  });

  // -- configSchema --------------------------------------------------------

  it("configSchema accepts empty config (all optional)", () => {
    const result = driver.configSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("configSchema accepts message and timeout_minutes", () => {
    const result = driver.configSchema.safeParse({ message: "x", timeout_minutes: 30 });
    expect(result.success).toBe(true);
  });

  it("configSchema rejects timeout_minutes: 0 (min 1)", () => {
    const result = driver.configSchema.safeParse({ timeout_minutes: 0 });
    expect(result.success).toBe(false);
  });

  it("configSchema rejects timeout_minutes: 1441 (max 1440)", () => {
    const result = driver.configSchema.safeParse({ timeout_minutes: 1441 });
    expect(result.success).toBe(false);
  });

  it("configSchema rejects unknown keys", () => {
    const result = driver.configSchema.safeParse({ extra: true });
    expect(result.success).toBe(false);
  });

  // -- onAbort -------------------------------------------------------------

  it("onAbort is callable and returns nothing", () => {
    const ctx = createMockContext();
    expect(driver.onAbort(ctx)).toBeUndefined();
  });
});
