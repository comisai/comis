// SPDX-License-Identifier: Apache-2.0
/**
 * Structural tests for the retry-loop module entry point.
 *
 * Behavioral coverage of the model retry pipeline lives in
 * model-retry.test.ts (the underlying retry-with-failover helper) and the
 * integration suite. This file pins the stuck-session early-return shape
 * + the silent-failure delegation to silent-failure-handlers.ts.
 *
 * Why source-grep here: invoking runRetryLoop requires a fully wired
 * AgentSession + ModelRegistry + the deps surface — same cost barrier as
 * the orchestrator test. The branch dispatch is pinned structurally.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runRetryLoop, stuckSessionResult } from "./retry-loop.js";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "retry-loop.ts");
const source = readFileSync(sourcePath, "utf-8");

describe("retry-loop.ts — module surface", () => {
  it("exports runRetryLoop (async) and stuckSessionResult", () => {
    expect(typeof runRetryLoop).toBe("function");
    expect(typeof stuckSessionResult).toBe("function");
  });

  it("stuckSessionResult returns the canonical stuck-session PromptRunResult", () => {
    expect(stuckSessionResult()).toEqual({
      promptSucceeded: false,
      promptError: undefined,
      escalationAttempted: false,
      stuckSessionDetected: true,
    });
  });
});

describe("retry-loop.ts — stuck-session guard", () => {
  it("zero LLM calls + zero steps triggers early return with stuckSessionDetected: true", () => {
    // Structural lock on the stuck-session predicate.
    expect(source).toMatch(
      /\(stuckCheck\.llmCalls \?\? 0\)\s*===\s*0\s*&&\s*\(stuckCheck\.stepsExecuted \?\? 0\)\s*===\s*0/,
    );
    // And on the early-return shape.
    expect(source).toMatch(/return \{[^}]*stuckSessionDetected:\s*true[^}]*\}/);
  });

  it("Zero-LLM-call WARN log uses the canonical hint + errorKind", () => {
    expect(source).toMatch(/"Zero-LLM-call execution detected"/);
    expect(source).toMatch(/Session stuck: prompt returned with zero LLM calls/);
    expect(source).toMatch(/errorKind: "internal" as ErrorKind/);
  });
});

describe("retry-loop.ts — silent-failure delegation (dependency-direction)", () => {
  it("delegates to silent-failure-handlers for each classified branch", () => {
    expect(source).toMatch(/from\s+"\.\/silent-failure-handlers\.js"/);
    expect(source).toMatch(/handleSignedReplay/);
    expect(source).toMatch(/handleRateLimited/);
    expect(source).toMatch(/handleClientRequest/);
    expect(source).toMatch(/handleSilentRetryDefault/);
    expect(source).toMatch(/declareSilentTerminalFailure/);
  });

  it("does NOT import from prompt-runner.ts (dependency-direction)", () => {
    expect(source).not.toMatch(/from\s+"\.\/prompt-runner\.js"/);
  });

  it("imports types only from prompt-runner-types.ts", () => {
    expect(source).toMatch(/from\s+"\.\/prompt-runner-types\.js"/);
  });
});
