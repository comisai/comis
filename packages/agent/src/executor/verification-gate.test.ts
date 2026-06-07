// SPDX-License-Identifier: Apache-2.0
/**
 * verification-gate.test.ts — D2 (fail-closed) + D3 (false-success recall) +
 * D4 (FP rate + gate-skip) + D5 (honest exhaustion) + D7 (L5 reasoning-budget)
 *
 * RED phase: all tests import from verification-gate.ts which does not yet exist.
 * Commit this file first (RED), then create the implementation (GREEN).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import falseSuccessFixtures from "./__fixtures__/critic-eval/false-success.json";
import trueSuccessFixtures from "./__fixtures__/critic-eval/true-success.json";
import nonClaimsFixtures from "./__fixtures__/critic-eval/non-claims.json";
import honestyFixtures from "./__fixtures__/critic-eval/honesty.json";

// These imports will FAIL (RED) until verification-gate.ts is created:
import {
  runVerificationCritic,
  createVerificationCritic,
  shouldRunCritic,
} from "./verification-gate.js";

// Also import isCompletionClaim to use as a negative assertion in D5
import { isCompletionClaim } from "./critic-isolation.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
  completeSimple: vi.fn(),
}));

import { getModel, completeSimple } from "@earendil-works/pi-ai";

function llmText(text: string) {
  return { content: [{ type: "text", text }] };
}

const BASE_PLAN = {
  active: true,
  request: "implement the snake game",
  steps: [
    { index: 0, description: "Implement snake movement controls", status: "done" as const },
    { index: 1, description: "Implement collision detection with walls and self", status: "pending" as const },
    { index: 2, description: "Implement score tracking and display", status: "pending" as const },
  ],
  completedCount: 1,
  createdAtMs: 1_700_000_000_000,
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    provider: "anthropic",
    modelId: "anthropic:claude-haiku",
    apiKey: "test-key",
    clock: { now: () => 1_700_000_000_000 },
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(function () {
        return this;
      }),
    },
    agentId: "agent-1",
    canaryToken: "CTKN_testcanary1234",
    minResponseChars: 100,
    modelProfile: {
      reasoningStyle: "none",
      maxOutputTokens: 1024,
      capabilityClass: "small",
      scaffoldLevel: "max",
      securityLevel: "locked",
      supportsVision: false,
      supportsTools: true,
      supportsPromptCache: false,
      supportsServerToolSearch: false,
      supportsStructuredOutput: false,
    },
    eventBus: { emit: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "mock-model" });
});

// ---------------------------------------------------------------------------
// D2 — Fail-closed (every error path yields not-verified, never verified)
// ---------------------------------------------------------------------------
describe("D2 — Fail-closed", () => {
  const CLAIM_RESPONSE =
    "The game is complete! I have implemented the movement controls and collision detection. The snake moves smoothly and the game is fully playable.";

  it("provider rejection: completeSimple rejects with Error → not-verified", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("provider error"),
    );
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("not-verified");
    expect(result.verdict).not.toBe("verified");
  });

  it("AbortError: completeSimple rejects with AbortError → not-verified", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValue(abortErr);
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("not-verified");
  });

  it("non-JSON response → not-verified", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText("This is not JSON"),
    );
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("not-verified");
  });

  it("partial JSON response → not-verified", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText('{"verdict":'),
    );
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("not-verified");
  });

  it("bad enum value → not-verified", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(JSON.stringify({ verdict: "APPROVED" })),
    );
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("not-verified");
  });

  it("empty string response → not-verified", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(llmText(""));
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("not-verified");
  });

  it("whitespace-only response → not-verified", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText("   "),
    );
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("not-verified");
  });

  it("getModel throws → not-verified (model resolution fail-closed)", async () => {
    (getModel as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("model not found");
    });
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("not-verified");
    // completeSimple must NOT have been called (model resolution failed before it)
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("no D2 error path ever returns verdict:verified", async () => {
    const errorCases: Array<() => Promise<void>> = [
      async () => {
        (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error("err"),
        );
      },
      async () => {
        (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
          llmText(""),
        );
      },
      async () => {
        (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
          llmText('{"verdict":"APPROVED"}'),
        );
      },
    ];
    for (const setup of errorCases) {
      vi.clearAllMocks();
      (getModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "mock" });
      await setup();
      const result = await runVerificationCritic({
        response: CLAIM_RESPONSE,
        plan: BASE_PLAN,
        deps: makeDeps(),
      });
      expect(result.verdict).not.toBe("verified");
    }
  });
});

// ---------------------------------------------------------------------------
// D3 — False-success recall (fixture-driven; recall must be 6/6 = 1.0)
// ---------------------------------------------------------------------------
describe("D3 — False-success recall", () => {
  it("false-success.json has at least 6 entries", () => {
    expect(falseSuccessFixtures.length).toBeGreaterThanOrEqual(6);
  });

  it("fs-01-snake-msft anchor: exactly 2 unmet IDs (REQ-1, REQ-2)", async () => {
    const fixture = falseSuccessFixtures.find((f) => f.id === "fs-01-snake-msft");
    expect(fixture).toBeDefined();
    const plan = {
      active: true,
      request: "implement the snake game",
      steps: fixture!.checklist.map((c) => ({
        index: c.index,
        description: c.description,
        status: c.status as "done" | "pending" | "in_progress" | "skipped",
      })),
      completedCount: 1,
      createdAtMs: 1_700_000_000_000,
    };
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(
        JSON.stringify({
          verdict: "not-verified",
          unmet: fixture!.expect.unmet,
          followUp: "Please complete the missing requirements.",
        }),
      ),
    );
    const result = await runVerificationCritic({
      response: fixture!.response,
      plan,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("not-verified");
    // For the redirect path (maxRetries default=2), response contains followUp
    // The important assertion is that the critic verdict itself was not-verified
  });

  it.each(falseSuccessFixtures)(
    "false-success fixture $id returns not-verified (recall check)",
    async (fixture) => {
      const plan = {
        active: true,
        request: "complete the task",
        steps: fixture.checklist.map((c) => ({
          index: c.index,
          description: c.description,
          status: c.status as "done" | "pending" | "in_progress" | "skipped",
        })),
        completedCount: 0,
        createdAtMs: 1_700_000_000_000,
      };
      (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
        llmText(
          JSON.stringify({
            verdict: "not-verified",
            unmet: fixture.expect.unmet,
            followUp: "Please complete the missing requirements.",
          }),
        ),
      );
      const result = await runVerificationCritic({
        response: fixture.response,
        plan,
        deps: makeDeps(),
      });
      expect(result.verdict).toBe("not-verified");
    },
  );

  it("recall threshold: all 6 false-success fixtures return not-verified (recall=1.0 >= 0.9)", async () => {
    let caught = 0;
    for (const fixture of falseSuccessFixtures) {
      const plan = {
        active: true,
        request: "complete the task",
        steps: fixture.checklist.map((c) => ({
          index: c.index,
          description: c.description,
          status: c.status as "done" | "pending" | "in_progress" | "skipped",
        })),
        completedCount: 0,
        createdAtMs: 1_700_000_000_000,
      };
      (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
        llmText(
          JSON.stringify({
            verdict: "not-verified",
            unmet: fixture.expect.unmet,
            followUp: "Please complete these requirements.",
          }),
        ),
      );
      const result = await runVerificationCritic({
        response: fixture.response,
        plan,
        deps: makeDeps(),
      });
      if (result.verdict === "not-verified") caught++;
    }
    const recall = caught / falseSuccessFixtures.length;
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });
});

// ---------------------------------------------------------------------------
// D4 — False-positive rate + gate-skip
// ---------------------------------------------------------------------------
describe("D4 — False-positive rate + gate-skip", () => {
  it("true-success.json has at least 5 entries", () => {
    expect(trueSuccessFixtures.length).toBeGreaterThanOrEqual(5);
  });

  it.each(trueSuccessFixtures)(
    "true-success fixture $id returns verified (no false positives)",
    async (fixture) => {
      const plan = {
        active: true,
        request: "complete the task",
        steps: fixture.checklist.map((c) => ({
          index: c.index,
          description: c.description,
          status: c.status as "done" | "pending" | "in_progress" | "skipped",
        })),
        completedCount: fixture.checklist.length,
        createdAtMs: 1_700_000_000_000,
      };
      (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
        llmText(JSON.stringify({ verdict: "verified", unmet: [] })),
      );
      const result = await runVerificationCritic({
        response: fixture.response,
        plan,
        deps: makeDeps(),
      });
      expect(result.verdict).toBe("verified");
    },
  );

  it("non-claim response: completeSimple NOT called (gate skips model)", async () => {
    const nonClaim = "What format should the output be in?";
    await runVerificationCritic({
      response: nonClaim,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    expect(completeSimple).toHaveBeenCalledTimes(0);
  });

  it("response below minResponseChars: skipped, completeSimple NOT called", async () => {
    const deps = makeDeps({ minResponseChars: 500 });
    const shortClaim = "Done."; // completion claim but too short
    const result = await runVerificationCritic({
      response: shortClaim,
      plan: BASE_PLAN,
      deps,
    });
    expect(result.verdict).toBe("skipped");
    expect(completeSimple).toHaveBeenCalledTimes(0);
  });

  it.each(nonClaimsFixtures)(
    "non-claim fixture $id: verdict=skipped, model never invoked",
    async (fixture) => {
      vi.clearAllMocks();
      (getModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "mock-model" });
      const result = await runVerificationCritic({
        response: fixture.response,
        plan: BASE_PLAN,
        deps: makeDeps(),
      });
      expect(result.verdict).toBe("skipped");
      expect(completeSimple).toHaveBeenCalledTimes(0);
    },
  );

  it("FP rate: all 5 true-success fixtures return verified (FP rate = 0.0 <= 0.1)", async () => {
    let falsePositives = 0;
    for (const fixture of trueSuccessFixtures) {
      vi.clearAllMocks();
      (getModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "mock-model" });
      const plan = {
        active: true,
        request: "complete the task",
        steps: fixture.checklist.map((c) => ({
          index: c.index,
          description: c.description,
          status: c.status as "done" | "pending" | "in_progress" | "skipped",
        })),
        completedCount: fixture.checklist.length,
        createdAtMs: 1_700_000_000_000,
      };
      (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
        llmText(JSON.stringify({ verdict: "verified", unmet: [] })),
      );
      const result = await runVerificationCritic({
        response: fixture.response,
        plan,
        deps: makeDeps(),
      });
      if (result.verdict !== "verified") falsePositives++;
    }
    const fpRate = falsePositives / trueSuccessFixtures.length;
    expect(fpRate).toBeLessThanOrEqual(0.1);
  });

  it("inactive plan returns skipped, model never called", async () => {
    const inactivePlan = { ...BASE_PLAN, active: false };
    const result = await runVerificationCritic({
      response:
        "The game is complete! I have implemented all features. Everything is done and ready.",
      plan: inactivePlan,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("skipped");
    expect(completeSimple).toHaveBeenCalledTimes(0);
  });

  it("undefined plan returns skipped, model never called", async () => {
    const result = await runVerificationCritic({
      response:
        "The game is complete! I have implemented all features. Everything is done and ready.",
      plan: undefined,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("skipped");
    expect(completeSimple).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// D5 — Honest exhaustion (delivered text contains unmet IDs; isCompletionClaim = false)
// ---------------------------------------------------------------------------
describe("D5 — Honest exhaustion", () => {
  it("honesty.json has at least 3 entries", () => {
    expect(honestyFixtures.length).toBeGreaterThanOrEqual(3);
  });

  it("hn-01: after 2 retries, delivered text contains REQ-1", async () => {
    const fixture = honestyFixtures.find((f) => f.id === "hn-01");
    expect(fixture).toBeDefined();
    // Always return not-verified from the critic
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(
        JSON.stringify({
          verdict: "not-verified",
          unmet: ["REQ-1"],
          followUp: "Please complete REQ-1.",
        }),
      ),
    );
    // maxRetries=0 forces honest exhaustion on first not-verified
    const result = await runVerificationCritic({
      response:
        "The game is complete! I have implemented the movement controls and collision detection.",
      plan: BASE_PLAN,
      deps: makeDeps(),
      maxRetries: 0,
    });
    expect(result.verdict).toBe("not-verified");
    // Honest unmet-list: delivered text must contain the unmet ID
    expect(result.response).toContain("REQ-1");
    // Must NOT be an unqualified completion claim
    expect(isCompletionClaim(result.response)).toBe(false);
  });

  it("maxRetries=0: honest exhaustion on first not-verified — unmet IDs in delivered text", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(
        JSON.stringify({
          verdict: "not-verified",
          unmet: ["REQ-0", "REQ-1", "REQ-2"],
          followUp: "Please complete all requirements.",
        }),
      ),
    );
    const result = await runVerificationCritic({
      response:
        "All done! I have finished the implementation. Everything is complete and ready to use.",
      plan: BASE_PLAN,
      deps: makeDeps(),
      maxRetries: 0,
    });
    expect(result.verdict).toBe("not-verified");
    // At least one unmet ID appears in the honest unmet-list
    const hasUnmetRef =
      result.response.includes("REQ-0") ||
      result.response.includes("REQ-1") ||
      result.response.includes("REQ-2");
    expect(hasUnmetRef).toBe(true);
    // Must not match the completion-claim heuristic
    expect(isCompletionClaim(result.response)).toBe(false);
  });

  it.each(honestyFixtures)(
    "honesty fixture $id: honest unmet-list delivered, not a completion claim",
    async (fixture) => {
      (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
        llmText(
          JSON.stringify({
            verdict: "not-verified",
            unmet: fixture.expect.deliveredContains,
            followUp: "Please complete these requirements.",
          }),
        ),
      );
      // Use maxRetries=0 to force exhaustion immediately
      const response = fixture.turns[0]?.response ??
        "All done! I have finished the implementation.";
      const plan = {
        ...BASE_PLAN,
        steps: [
          { index: 0, description: "Requirement 0", status: "pending" as const },
          { index: 1, description: "Requirement 1", status: "pending" as const },
          { index: 2, description: "Requirement 2", status: "pending" as const },
        ],
      };
      const result = await runVerificationCritic({
        response,
        plan,
        deps: makeDeps(),
        maxRetries: 0,
      });
      expect(result.verdict).toBe("not-verified");
      // Each expected unmet ID must appear in the delivered text
      for (const unmetId of fixture.expect.deliveredContains) {
        expect(result.response).toContain(unmetId);
      }
      // Delivered text must NOT match the completion-claim heuristic
      if (fixture.expect.deliveredNotMatchesCompletionClaim) {
        expect(isCompletionClaim(result.response)).toBe(false);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// D7 — Reasoning-budget adequacy (L5 sizing)
// ---------------------------------------------------------------------------
describe("D7 — Reasoning-budget adequacy (L5)", () => {
  const NATIVE_PROFILE = {
    reasoningStyle: "native",
    maxOutputTokens: 8192,
    capabilityClass: "small",
    scaffoldLevel: "max",
    securityLevel: "locked",
    supportsVision: false,
    supportsTools: true,
    supportsPromptCache: false,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
  };

  const CLAIM_RESPONSE =
    "The game is complete! I have implemented the movement controls and collision detection. The snake moves smoothly and the game is fully playable and ready.";

  it("native-reasoning profile: completeSimple called with maxTokens >= 2048 (VERDICT_RESERVE * 4)", async () => {
    const capturedOptions: Array<Record<string, unknown>> = [];
    (completeSimple as ReturnType<typeof vi.fn>).mockImplementation(
      (_model, _messages, opts) => {
        capturedOptions.push(opts as Record<string, unknown>);
        return Promise.resolve(
          llmText(JSON.stringify({ verdict: "not-verified", unmet: ["REQ-1"] })),
        );
      },
    );
    await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps({ modelProfile: NATIVE_PROFILE }),
    });
    expect(capturedOptions.length).toBeGreaterThan(0);
    const maxTokens = capturedOptions[0]!.maxTokens as number;
    expect(maxTokens).toBeGreaterThanOrEqual(2048);
  });

  it("native-reasoning profile: maxTokens is NOT 512 (the non-native floor)", async () => {
    const capturedOptions: Array<Record<string, unknown>> = [];
    (completeSimple as ReturnType<typeof vi.fn>).mockImplementation(
      (_model, _messages, opts) => {
        capturedOptions.push(opts as Record<string, unknown>);
        return Promise.resolve(
          llmText(JSON.stringify({ verdict: "verified", unmet: [] })),
        );
      },
    );
    await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps({ modelProfile: NATIVE_PROFILE }),
    });
    const maxTokens = capturedOptions[0]!.maxTokens as number;
    expect(maxTokens).not.toBe(512);
  });

  it("native-reasoning profile: verdict still parseable despite large reasoning preamble", async () => {
    // Simulate a response with a large reasoning_content preamble before the JSON verdict
    const reasoningPreamble = "Let me carefully analyze each requirement one by one...\n".repeat(100);
    const jsonVerdict = JSON.stringify({ verdict: "not-verified", unmet: ["REQ-1"] });
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(reasoningPreamble + jsonVerdict),
    );
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps({ modelProfile: NATIVE_PROFILE }),
    });
    expect(result.verdict).toBe("not-verified");
  });

  it("non-native profile: maxTokens equals 512 (verdict reserve)", async () => {
    const capturedOptions: Array<Record<string, unknown>> = [];
    (completeSimple as ReturnType<typeof vi.fn>).mockImplementation(
      (_model, _messages, opts) => {
        capturedOptions.push(opts as Record<string, unknown>);
        return Promise.resolve(
          llmText(JSON.stringify({ verdict: "verified", unmet: [] })),
        );
      },
    );
    await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    const maxTokens = capturedOptions[0]!.maxTokens as number;
    expect(maxTokens).toBe(512);
  });

  it("native profile with maxOutputTokens < 2048: maxTokens is still >= 2048 (max enforcement)", async () => {
    const smallNativeProfile = {
      ...NATIVE_PROFILE,
      maxOutputTokens: 256, // smaller than VERDICT_RESERVE * 4 = 2048
    };
    const capturedOptions: Array<Record<string, unknown>> = [];
    (completeSimple as ReturnType<typeof vi.fn>).mockImplementation(
      (_model, _messages, opts) => {
        capturedOptions.push(opts as Record<string, unknown>);
        return Promise.resolve(
          llmText(JSON.stringify({ verdict: "verified", unmet: [] })),
        );
      },
    );
    await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps({ modelProfile: smallNativeProfile }),
    });
    const maxTokens = capturedOptions[0]!.maxTokens as number;
    expect(maxTokens).toBeGreaterThanOrEqual(2048);
  });
});

// ---------------------------------------------------------------------------
// shouldRunCritic — gate function
// ---------------------------------------------------------------------------
describe("shouldRunCritic", () => {
  const baseConfig = {
    verification: { enabled: true, minResponseChars: 200 },
  };
  const activePlan = { current: BASE_PLAN };

  it("returns true when enabled + small capabilityClass + active plan", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: baseConfig as never,
        executionPlanRef: activePlan,
      }),
    ).toBe(true);
  });

  it("returns true for nano capabilityClass", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "nano",
        config: baseConfig as never,
        executionPlanRef: activePlan,
      }),
    ).toBe(true);
  });

  it("returns false when verification not enabled", () => {
    const disabledConfig = { verification: { enabled: false, minResponseChars: 200 } };
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: disabledConfig as never,
        executionPlanRef: activePlan,
      }),
    ).toBe(false);
  });

  it("returns false when capabilityClass is frontier", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "frontier",
        config: baseConfig as never,
        executionPlanRef: activePlan,
      }),
    ).toBe(false);
  });

  it("returns false when capabilityClass is mid", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "mid",
        config: baseConfig as never,
        executionPlanRef: activePlan,
      }),
    ).toBe(false);
  });

  it("returns false when capabilityClass is undefined", () => {
    expect(
      shouldRunCritic({
        capabilityClass: undefined,
        config: baseConfig as never,
        executionPlanRef: activePlan,
      }),
    ).toBe(false);
  });

  it("returns false when no active plan", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: baseConfig as never,
        executionPlanRef: { current: undefined },
      }),
    ).toBe(false);
  });

  it("returns false when plan is inactive", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: baseConfig as never,
        executionPlanRef: { current: { ...BASE_PLAN, active: false } },
      }),
    ).toBe(false);
  });

  it("returns false when verification config is missing", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: {} as never,
        executionPlanRef: activePlan,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createVerificationCritic — factory function
// ---------------------------------------------------------------------------
describe("createVerificationCritic", () => {
  it("returns a function that proxies to runVerificationCritic", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(JSON.stringify({ verdict: "verified", unmet: [] })),
    );
    const critic = createVerificationCritic(makeDeps() as never);
    const result = await critic(
      "The game is complete! I have implemented the movement controls and collision detection. The snake moves smoothly and the game is fully playable.",
      BASE_PLAN,
    );
    expect(result.verdict).toBe("verified");
  });

  it("factory: non-claim response → skipped (gate honored in factory path)", async () => {
    const critic = createVerificationCritic(makeDeps() as never);
    const result = await critic("What format should the output be in?", BASE_PLAN);
    expect(result.verdict).toBe("skipped");
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
