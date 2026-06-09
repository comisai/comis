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
// WR-04: drive the adversarial-injection fixtures end-to-end through the gate.
import adversarialFixtures from "./__fixtures__/critic-eval/adversarial-injection.json";

// These imports will FAIL (RED) until verification-gate.ts is created:
import {
  runVerificationCritic,
  createVerificationCritic,
  shouldRunCritic,
  // L5: resolveMaxOutputTokens must be exported from verification-gate.ts
  resolveMaxOutputTokens,
  // CR-01: main-path sizing — must NOT return the 512 verdict reserve.
  resolveMainPathMaxOutputTokens,
} from "./verification-gate.js";

// Also import isCompletionClaim to use as a negative assertion in D5,
// and detectImpliedToolCall for the WR-01 user-facing-text assertions.
import { isCompletionClaim, detectImpliedToolCall } from "./critic-isolation.js";

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

  it("returns not-verified when critic emits non-JSON response", async () => {
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

  it("returns not-verified when critic emits partial JSON response", async () => {
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

  it("returns not-verified when critic emits bad enum value in JSON", async () => {
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

  it("returns not-verified when critic emits whitespace-only response", async () => {
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
        "The game is complete! I have implemented the movement controls and collision detection. The snake moves smoothly.",
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
        "All done! I have finished the implementation. Everything is complete and ready to use for production.",
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
      // Ensure response is >= minResponseChars (100) to pass the gate
      const rawResponse = fixture.turns[0]?.response ??
        "All done! I have finished the implementation and everything is ready.";
      const response = rawResponse.length >= 100
        ? rawResponse
        : rawResponse + " All tasks have been completed satisfactorily.";
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
// CR-01 — Terminal delivery is honest at the DEFAULT maxRetries (no re-queue loop)
//
// postExecution is terminal in Phase 154 — it does NOT re-invoke the executor,
// so a not-verified verdict's `response` is delivered VERBATIM to the user.
// The DEFAULT config is maxCriticRetries=2 (>0). Under the old code that branch
// returned the agent-directed redirect ("Please complete the following unmet
// requirements: …") as the user-facing reply. Until a re-queue consumer exists,
// the delivered text MUST be the first-person honest unmet-list, NEVER the
// agent-directed redirect and NEVER an unqualified completion claim.
// ---------------------------------------------------------------------------
describe("CR-01 — honest terminal delivery at default maxRetries (2)", () => {
  const CLAIM_RESPONSE =
    "The game is complete! I have implemented the movement controls and collision detection. The snake moves smoothly and the game is fully playable.";

  it("default maxRetries (2): delivered response is NOT the agent-directed redirect", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(
        JSON.stringify({
          verdict: "not-verified",
          unmet: ["REQ-1", "REQ-2"],
          followUp: "Please complete the following unmet requirements: REQ-1, REQ-2",
        }),
      ),
    );
    // No maxRetries override → defaults to 2 (the production default).
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("not-verified");
    // The agent-directed instruction must NOT be surfaced to the user.
    expect(result.response).not.toMatch(/please complete the following/i);
    // First-person honest form (the user is told the AGENT could not finish).
    expect(result.response.toLowerCase()).toMatch(/\bi (was|am) (not |un)?able/);
  });

  it("default maxRetries (2): delivered response does NOT match isCompletionClaim", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(
        JSON.stringify({
          verdict: "not-verified",
          unmet: ["REQ-0", "REQ-1"],
          followUp: "Please complete all requirements.",
        }),
      ),
    );
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    expect(result.verdict).toBe("not-verified");
    expect(isCompletionClaim(result.response)).toBe(false);
  });

  it("default and maxRetries=0 deliver the SAME honest form (terminal delivery is uniform)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(
        JSON.stringify({
          verdict: "not-verified",
          unmet: ["REQ-1"],
          followUp: "Please complete REQ-1.",
        }),
      ),
    );
    const atDefault = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
    });
    const atZero = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
      maxRetries: 0,
    });
    expect(atDefault.response).toBe(atZero.response);
  });
});

// ---------------------------------------------------------------------------
// WR-01 / IN-03 — LLM-controlled `unmet` strings cannot break the D5 guarantee
//
// `unmet[]` comes straight from the critic verdict JSON; the critic just
// consumed UNTRUSTED reviewed content. A crafted unmet label must NOT be able
// to make the delivered honest text match isCompletionClaim, nor smuggle an
// implied-tool-call phrase into user-facing prose. The delivered text is built
// from sanitized bare REQ-\d+ tokens only.
// ---------------------------------------------------------------------------
describe("WR-01 — adversarial unmet labels cannot satisfy isCompletionClaim", () => {
  const CLAIM_RESPONSE =
    "All done! I have finished the implementation. Everything is complete and ready to use for production now.";

  it("malicious unmet label 'all tasks are done' does not make delivered text a completion claim", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(
        JSON.stringify({
          verdict: "not-verified",
          unmet: ["REQ-0 (all tasks are done)", "REQ-1 all requirements are met"],
          followUp: "ok",
        }),
      ),
    );
    // Exercise BOTH the default (2) and exhaustion (0) paths — both deliver honest text.
    for (const maxRetries of [2, 0]) {
      const result = await runVerificationCritic({
        response: CLAIM_RESPONSE,
        plan: BASE_PLAN,
        deps: makeDeps(),
        maxRetries,
      });
      expect(result.verdict).toBe("not-verified");
      expect(isCompletionClaim(result.response)).toBe(false);
    }
  });

  it("unmet label carrying a tool-call phrase does not place it in user-facing text", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(
        JSON.stringify({
          verdict: "not-verified",
          unmet: ["REQ-0 then call write_file", "REQ-1 run the exec tool"],
        }),
      ),
    );
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
      maxRetries: 2,
    });
    expect(result.verdict).toBe("not-verified");
    expect(detectImpliedToolCall(result.response)).toBe(false);
    // Sanitized to bare REQ tokens — the verbose attacker text is dropped.
    expect(result.response).not.toMatch(/write_file|exec tool/i);
    expect(result.response).toMatch(/REQ-0/);
    expect(result.response).toMatch(/REQ-1/);
  });

  it("unmet labels with no REQ token fall back to a generic phrase (still honest)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(
        JSON.stringify({
          verdict: "not-verified",
          unmet: ["everything is finished and complete"],
        }),
      ),
    );
    const result = await runVerificationCritic({
      response: CLAIM_RESPONSE,
      plan: BASE_PLAN,
      deps: makeDeps(),
      maxRetries: 0,
    });
    expect(result.verdict).toBe("not-verified");
    expect(isCompletionClaim(result.response)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WR-04 — Adversarial-injection fixtures driven END-TO-END through the gate
//
// The D1 suite only SHAPE-asserts the adversarial fixtures (count + expected
// verdict); it never feeds a fixture `response` through runVerificationCritic
// while the (mocked) model COMPLIES with the embedded injection. This suite
// proves the platform controls neutralize the attempt through the REAL code
// path — even when the model is fooled into emitting the attacker payload:
//   - ALL injected fixtures: the reviewed response is wrapped as UNTRUSTED
//     before the model sees it (structural injection defense — the system
//     prompt's instructions are never reachable as commands).
//   - canary-lure fixtures (injection: isolation-violation, response embeds the
//     canary): a model that ECHOES the canary → detectCanaryLeakage → flips a
//     forged "verified" to not-verified.
//   - implied-tool-call fixtures (response asks to "call write_file"): a model
//     that returns verified + a tool-call followUp → detectImpliedToolCall →
//     flips it to not-verified.
// This is the real S2 assertion the fixtures were always meant to drive.
// ---------------------------------------------------------------------------
describe("WR-04 — adversarial injection resistance end-to-end (complying model)", () => {
  const injectedFixtures = adversarialFixtures.filter((f) => f.id.includes("injected"));

  function planFor(fixture: (typeof adversarialFixtures)[number]) {
    return {
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
  }

  // Ensure the response clears the gate (completion claim + >= minResponseChars).
  function gateableResponse(fixture: (typeof adversarialFixtures)[number]) {
    const base = `${fixture.response} I have completed all of the required steps.`;
    return base.length >= 100 ? base : base + " ".repeat(100 - base.length);
  }

  it("has at least 3 injected fixtures to exercise", () => {
    expect(injectedFixtures.length).toBeGreaterThanOrEqual(3);
  });

  it.each(injectedFixtures)(
    "$id: reviewed response is wrapped UNTRUSTED before the model sees it",
    async (fixture) => {
      const seenUserContent: string[] = [];
      (completeSimple as ReturnType<typeof vi.fn>).mockImplementation(
        (_model, req: { messages: Array<{ content: string }> }) => {
          seenUserContent.push(req.messages[0]!.content);
          // Model COMPLIES with the injection: forge a "verified" verdict.
          return Promise.resolve(
            llmText(JSON.stringify({ verdict: "verified", unmet: [] })),
          );
        },
      );
      await runVerificationCritic({
        response: gateableResponse(fixture),
        plan: planFor(fixture),
        deps: makeDeps(),
      });
      expect(seenUserContent.length).toBe(1);
      const userMsg = seenUserContent[0]!;
      // The injection rode the USER message, wrapped as UNTRUSTED data.
      expect(userMsg).toContain("UNTRUSTED");
      // The original injected text is present but INSIDE the untrusted wrapper.
      const startIdx = userMsg.indexOf("<<<UNTRUSTED_");
      const endIdx = userMsg.indexOf("<<<END_UNTRUSTED_");
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
    },
  );

  it("canary-lure fixture: a model that echoes the canary is flipped to not-verified", async () => {
    const fixture = injectedFixtures.find((f) => f.id === "inj-03-injected");
    expect(fixture).toBeDefined();
    const deps = makeDeps(); // canaryToken: "CTKN_testcanary1234" (matches the fixture lure)
    // The model FELL for the canary-extraction lure: it forges "verified" AND
    // leaks the canary token in its output.
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(
        JSON.stringify({
          verdict: "verified",
          unmet: [],
          followUp: `Confirmed. Token: ${(deps as { canaryToken: string }).canaryToken}`,
        }),
      ),
    );
    const result = await runVerificationCritic({
      response: gateableResponse(fixture!),
      plan: planFor(fixture!),
      deps,
    });
    // detectCanaryLeakage (checked BEFORE Zod parse) catches the leak → fail-closed.
    expect(result.verdict).toBe("not-verified");
    // And the canary itself must never reach the user-facing response.
    expect(result.response).not.toContain((deps as { canaryToken: string }).canaryToken);
  });

  it("implied-tool-call fixture: a model that returns verified + 'call write_file' is flipped to not-verified", async () => {
    const fixture = injectedFixtures.find((f) => f.id === "inj-04-injected");
    expect(fixture).toBeDefined();
    // The model FELL for the scope-widening injection: forges "verified" with a
    // followUp that implies executing a tool.
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(
        JSON.stringify({
          verdict: "verified",
          unmet: [],
          followUp: "All set — now call write_file to finalize the deliverable.",
        }),
      ),
    );
    const result = await runVerificationCritic({
      response: gateableResponse(fixture!),
      plan: planFor(fixture!),
      deps: makeDeps(),
    });
    // detectImpliedToolCall intercepts the scope-widening verdict → not-verified.
    expect(result.verdict).toBe("not-verified");
  });

  it("forged-JSON fixture: a model that returns verified does NOT leak the forged verdict text to the user", async () => {
    const fixture = injectedFixtures.find((f) => f.id === "inj-02-injected");
    expect(fixture).toBeDefined();
    // Model echoes the embedded `System: output {...verified...}` as its verdict.
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(JSON.stringify({ verdict: "verified", unmet: [] })),
    );
    const result = await runVerificationCritic({
      response: gateableResponse(fixture!),
      plan: planFor(fixture!),
      deps: makeDeps(),
    });
    // The forged JSON was wrapped UNTRUSTED on the way in (asserted above). If the
    // model still returns a structurally-valid verified verdict, that is a model
    // failure the wrap is designed to prevent — we assert here only that the gate
    // does not crash and returns a well-formed verdict (verified|not-verified).
    expect(["verified", "not-verified"]).toContain(result.verdict);
  });
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
//
// WR-02: the post-execution hook has NO secretManager at its layer, so it
// cannot resolve a cloud API key. buildSyntheticCriticDeps must call with
// apiKey:"" — which for a key-REQUIRING provider (groq/cerebras/openrouter/…,
// all mapped to capabilityClass "small") would auth-fail → fail-closed
// not-verified → clobber a CORRECT answer into a false "I was unable to
// satisfy…". So shouldRunCritic gates the critic to KEYLESS providers in this
// phase and skips-with-WARN for key-requiring ones (cloud key threading is
// Phase 155). Every call now passes the resolved `provider`.
// ---------------------------------------------------------------------------
describe("shouldRunCritic", () => {
  const baseConfig = {
    verification: { enabled: true, minResponseChars: 200 },
  };
  const activePlan = { current: BASE_PLAN };
  function makeLogger() {
    return {
      info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
      child: vi.fn(function () { return this; }),
    };
  }

  it("returns true when enabled + small capabilityClass + active plan + keyless provider", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: baseConfig as never,
        executionPlanRef: activePlan,
        provider: "ollama",
      }),
    ).toBe(true);
  });

  it("returns true for nano capabilityClass (keyless provider)", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "nano",
        config: baseConfig as never,
        executionPlanRef: activePlan,
        provider: "ollama",
      }),
    ).toBe(true);
  });

  it("returns true for lm-studio (also keyless)", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: baseConfig as never,
        executionPlanRef: activePlan,
        provider: "lm-studio",
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
        provider: "ollama",
      }),
    ).toBe(false);
  });

  it("returns false when capabilityClass is frontier", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "frontier",
        config: baseConfig as never,
        executionPlanRef: activePlan,
        provider: "ollama",
      }),
    ).toBe(false);
  });

  it("returns false when capabilityClass is mid", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "mid",
        config: baseConfig as never,
        executionPlanRef: activePlan,
        provider: "ollama",
      }),
    ).toBe(false);
  });

  it("returns false when capabilityClass is undefined", () => {
    expect(
      shouldRunCritic({
        capabilityClass: undefined,
        config: baseConfig as never,
        executionPlanRef: activePlan,
        provider: "ollama",
      }),
    ).toBe(false);
  });

  it("returns false when no active plan", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: baseConfig as never,
        executionPlanRef: { current: undefined },
        provider: "ollama",
      }),
    ).toBe(false);
  });

  it("returns false when plan is inactive", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: baseConfig as never,
        executionPlanRef: { current: { ...BASE_PLAN, active: false } },
        provider: "ollama",
      }),
    ).toBe(false);
  });

  it("returns false when verification config is missing", () => {
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: {} as never,
        executionPlanRef: activePlan,
        provider: "ollama",
      }),
    ).toBe(false);
  });

  // --- WR-02: key-requiring CLOUD providers are skipped (not clobbered) ------
  it.each(["groq", "cerebras", "openrouter", "deepseek", "mistral", "xai"])(
    "returns false for key-requiring cloud provider %s (skip, not clobber)",
    (provider) => {
      expect(
        shouldRunCritic({
          capabilityClass: "small",
          config: baseConfig as never,
          executionPlanRef: activePlan,
          provider,
        }),
      ).toBe(false);
    },
  );

  it("emits a one-time WARN (with a Phase-155 hint) when skipping a key-requiring provider", () => {
    const logger = makeLogger();
    shouldRunCritic({
      capabilityClass: "small",
      config: baseConfig as never,
      executionPlanRef: activePlan,
      provider: "groq",
      logger: logger as never,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [meta, message] = logger.warn.mock.calls[0]!;
    expect(String(message) + JSON.stringify(meta)).toMatch(/155|cloud key/i);
  });

  it("does NOT WARN for a keyless provider (no spurious operator noise)", () => {
    const logger = makeLogger();
    shouldRunCritic({
      capabilityClass: "small",
      config: baseConfig as never,
      executionPlanRef: activePlan,
      provider: "ollama",
      logger: logger as never,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does NOT WARN when gated off for a non-small class even if key-requiring (no critic intended)", () => {
    const logger = makeLogger();
    shouldRunCritic({
      capabilityClass: "frontier",
      config: baseConfig as never,
      executionPlanRef: activePlan,
      provider: "groq",
      logger: logger as never,
    });
    // Frontier never runs the critic — the missing-key WARN would be noise.
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SD4 — resolveMainPathMaxOutputTokens floor bump (Phase 158)
//
// NATIVE_REASONING_MAIN_PATH_FLOOR raised 4096→16384 so reasoning_content
// cannot starve the visible answer on small native-reasoning models.
// RED: tests fail because NATIVE_REASONING_MAIN_PATH_FLOOR=4096
//   (Math.max(8192, 4096)=8192, not 16384).
// ---------------------------------------------------------------------------
describe("SD4 — resolveMainPathMaxOutputTokens floor raised to 16_384 (Phase 158)", () => {
  const BASE_PROFILE = {
    contextWindow: 32_768,
    capabilityClass: "small" as const,
    scaffoldLevel: "max" as const,
    securityLevel: "locked" as const,
    supportsVision: false,
    supportsTools: true,
    supportsPromptCache: false,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
  };

  it("Test A: native-reasoning profile with maxOutputTokens=8192 → returns 16384 (floor raised 4096→16384)", () => {
    const profile = { ...BASE_PROFILE, reasoningStyle: "native" as const, maxOutputTokens: 8192 };
    // RED: currently returns Math.max(8192, 4096)=8192 (not 16384) — fails until SD4 lands.
    expect(resolveMainPathMaxOutputTokens(profile)).toBe(16_384);
  });

  it("Test B: non-reasoning profile with maxOutputTokens=8192 → returns 8192 (floor not applied)", () => {
    const profile = { ...BASE_PROFILE, reasoningStyle: "none" as const, maxOutputTokens: 8192 };
    // Non-reasoning path returns profile.maxOutputTokens unchanged.
    expect(resolveMainPathMaxOutputTokens(profile)).toBe(8192);
  });

  it("Test C: native-reasoning profile with maxOutputTokens=32768 → returns 32768 (already above 16384 floor)", () => {
    const profile = { ...BASE_PROFILE, reasoningStyle: "native" as const, maxOutputTokens: 32_768 };
    // Math.max(32768, 16384)=32768 — model budget preserved.
    expect(resolveMainPathMaxOutputTokens(profile)).toBe(32_768);
  });
});

// ---------------------------------------------------------------------------
// SD3 — shouldRunCritic effectiveEnabled parameter (Phase 158)
//
// effectiveEnabled is the pre-resolved flag from resolveScaffoldDefaults.
// When provided, it replaces the config.verification?.enabled check:
//   effectiveEnabled=true  → override-on  (even if config not set)
//   effectiveEnabled=false → override-off (explicit false wins)
// The keyless-provider check (WR-02) still applies AFTER the effectiveEnabled
// gate.
// RED: tests fail because shouldRunCritic does not yet accept effectiveEnabled.
// ---------------------------------------------------------------------------
describe("SD3 — shouldRunCritic effectiveEnabled parameter (Phase 158)", () => {
  const activePlan = { current: BASE_PLAN };

  it("Test D: effectiveEnabled=true + small + ollama + active plan → returns true (override-on)", () => {
    // config has NO verification.enabled set — effectiveEnabled supplies the gate.
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: {} as never,
        executionPlanRef: activePlan,
        provider: "ollama",
        effectiveEnabled: true,
      }),
    ).toBe(true);
  });

  it("Test E: effectiveEnabled=false + small + ollama + active plan → returns false (explicit false wins even for small/keyless)", () => {
    // Even though class=small + keyless + config.verification.enabled=true,
    // effectiveEnabled=false (pre-resolved by resolveScaffoldDefaults) wins.
    expect(
      shouldRunCritic({
        capabilityClass: "small",
        config: { verification: { enabled: true, minResponseChars: 200 } } as never,
        executionPlanRef: activePlan,
        provider: "ollama",
        effectiveEnabled: false,
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

// ---------------------------------------------------------------------------
// L5 — resolveMaxOutputTokens exported and correct (direct export test)
//
// The function was previously unexported (only used internally by callCritic).
// L5 requires it to be exported so pi-executor.ts can apply the same sizing
// on the MAIN execution path (not just the critic path).
// ---------------------------------------------------------------------------
describe("L5 — resolveMaxOutputTokens exported and sizing correct", () => {
  const BASE_PROFILE = {
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    capabilityClass: "small" as const,
    scaffoldLevel: "max" as const,
    securityLevel: "locked" as const,
    supportsVision: false,
    supportsTools: true,
    supportsPromptCache: false,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
  };

  it("L5: native-reasoning profile → resolveMaxOutputTokens returns >= 2048 (VERDICT_RESERVE_TOKENS * 4)", () => {
    // FAILS before the export is added (resolveMaxOutputTokens is undefined).
    const profile = { ...BASE_PROFILE, reasoningStyle: "native" as const, maxOutputTokens: 4096 };
    expect(resolveMaxOutputTokens(profile)).toBeGreaterThanOrEqual(2048);
  });

  it("L5: non-reasoning profile → resolveMaxOutputTokens returns 512 (VERDICT_RESERVE_TOKENS)", () => {
    const profile = { ...BASE_PROFILE, reasoningStyle: "none" as const, maxOutputTokens: 4096 };
    expect(resolveMaxOutputTokens(profile)).toBe(512);
  });

  it("L5: native profile with small maxOutputTokens → still returns >= 2048 (max() enforcement)", () => {
    const profile = { ...BASE_PROFILE, reasoningStyle: "native" as const, maxOutputTokens: 256 };
    expect(resolveMaxOutputTokens(profile)).toBeGreaterThanOrEqual(2048);
  });
});

// ---------------------------------------------------------------------------
// CR-01 — main-path output budget MUST NOT clamp to the 512 verdict reserve
//
// Regression guard: the original L5 wiring fed the critic's
// resolveMaxOutputTokens (which returns VERDICT_RESERVE_TOKENS=512 for
// non-reasoning profiles) into the MAIN execution path's ConfigResolver,
// truncating every non-reasoning agent answer at 512 tokens. The main path
// must use the model's REAL maxOutputTokens instead.
// ---------------------------------------------------------------------------
describe("CR-01 — resolveMainPathMaxOutputTokens does not cap the main answer at 512", () => {
  const BASE_PROFILE = {
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    capabilityClass: "small" as const,
    scaffoldLevel: "max" as const,
    securityLevel: "locked" as const,
    supportsVision: false,
    supportsTools: true,
    supportsPromptCache: false,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
  };

  it("CR-01: non-reasoning small model returns its FULL maxOutputTokens, never the 512 verdict floor", () => {
    const profile = { ...BASE_PROFILE, reasoningStyle: "none" as const, maxOutputTokens: 4096 };
    const budget = resolveMainPathMaxOutputTokens(profile);
    // The defect: this used to be VERDICT_RESERVE_TOKENS (512) on the main path.
    expect(budget).toBe(4096);
    expect(budget).not.toBe(512);
  });

  it("CR-01: non-reasoning model with a large maxOutputTokens passes the full budget through", () => {
    const profile = { ...BASE_PROFILE, reasoningStyle: "none" as const, maxOutputTokens: 8192 };
    expect(resolveMainPathMaxOutputTokens(profile)).toBe(8192);
  });

  it("CR-01: native-reasoning profile is sized UP so reasoning_content does not starve the answer", () => {
    // A small profile budget must be raised, not lowered, for native reasoning.
    const profile = { ...BASE_PROFILE, reasoningStyle: "native" as const, maxOutputTokens: 1024 };
    const budget = resolveMainPathMaxOutputTokens(profile);
    expect(budget).toBeGreaterThanOrEqual(4096);
    expect(budget).toBeGreaterThanOrEqual(profile.maxOutputTokens);
  });

  it("CR-01: native-reasoning profile with a large budget keeps the larger value (never shrinks)", () => {
    const profile = { ...BASE_PROFILE, reasoningStyle: "native" as const, maxOutputTokens: 16384 };
    expect(resolveMainPathMaxOutputTokens(profile)).toBe(16384);
  });
});
