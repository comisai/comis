// SPDX-License-Identifier: Apache-2.0
/**
 * Structural tests for the output-escalation module.
 *
 * Behavioral coverage of output escalation, success-path response
 * processing (empty-recovery, SEP extraction, post-batch continuation,
 * budget continuation), and failure-path overflow recovery lives in the
 * underlying module tests:
 *   - executor-response-filter.test.ts (recoverEmptyFinalResponse,
 *     extractExecutionPlan, scanWithOutputGuard)
 *   - post-batch-continuation.test.ts
 *   - overflow-recovery.test.ts
 *   - error-classifier.test.ts (classifyError, classifyPromptTimeout)
 *
 * This file pins the structural invariants of the output-escalation entry
 * point and the dependency direction (no import from prompt-runner.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { escalateOutput } from "./output-escalation.js";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "output-escalation.ts");
const source = readFileSync(sourcePath, "utf-8");
const interactiveRecoverySource = readFileSync(
  resolve(here, "interactive-silent-recovery.ts"),
  "utf-8",
);

describe("output-escalation.ts — module surface", () => {
  it("exports an async function `escalateOutput`", () => {
    expect(typeof escalateOutput).toBe("function");
  });
});

describe("output-escalation.ts — escalation gate (max_tokens truncation)", () => {
  it("only fires when bridge stopReason === 'maxTokens' AND escalation enabled AND config.maxTokens undefined", () => {
    // Structural lock on the three-condition gate.
    expect(source).toMatch(/bridgeStopReason !== "maxTokens"/);
    expect(source).toMatch(/!escalationEnabled/);
    expect(source).toMatch(/config\.maxTokens !== undefined/);
  });

  it("emits the execution:output_escalated event for observability", () => {
    expect(source).toMatch(/execution:output_escalated/);
    expect(source).toMatch(/originalMaxTokens/);
    expect(source).toMatch(/escalatedMaxTokens/);
  });

  it("restores session.agent.streamFn in a finally block (one-shot wrapper)", () => {
    expect(source).toMatch(/} finally \{[\s\S]+?session\.agent\.streamFn = originalStreamFn/);
  });
});

describe("output-escalation.ts — dependency direction", () => {
  it("does NOT import from prompt-runner.ts (dependency direction invariant)", () => {
    expect(source).not.toMatch(/from\s+"\.\/prompt-runner\.js"/);
  });

  it("imports types only from prompt-runner-types.ts", () => {
    expect(source).toMatch(/from\s+"\.\/prompt-runner-types\.js"/);
  });

  it("delegates failure-path processing to ./failure-path.js", () => {
    expect(source).toMatch(/from\s+"\.\/failure-path\.js"/);
    expect(source).toMatch(/processFailurePath/);
  });
});

describe("output-escalation.ts — failure log privacy", () => {
  it("converts retry and continuation failures to safe message strings", () => {
    expect(source).toMatch(/toSafeErrorLogString\(escalationError\)/);
    expect(source).toMatch(/toSafeErrorLogString\(continuationResult\.error\)/);
    expect(source).toMatch(/toSafeErrorLogString\(continuationResult\.error\.cause\)/);
    expect(source).not.toMatch(/err:\s*(?:escalationError|followUpResult\.error|continuationResult\.error\.cause)/);
  });
});

describe("output-escalation.ts — interactive silent-response boundary", () => {
  it("checks exact-route delivery evidence before accepting a silent response", () => {
    expect(source).toMatch(/applyInteractiveSilentRecovery/);
    expect(interactiveRecoverySource).toMatch(/recoverInteractiveSilentResponse/);
    expect(interactiveRecoverySource).toMatch(/bridge\.hasOutboundDelivery/);
    expect(interactiveRecoverySource).toMatch(/execution:recovery_attempted/);
    expect(interactiveRecoverySource).toMatch(/interactive_silent_sentinel/);
  });
});

describe("output-escalation.ts — response-language boundary", () => {
  it("applies bounded locale enforcement before the output guard", () => {
    const qualityIndex = source.indexOf("applyResponseLocaleEnforcement(");
    const guardIndex = source.indexOf("scanWithOutputGuard({", qualityIndex);

    expect(source).toMatch(/from\s+"\.\/response-locale-enforcement\.js"/);
    expect(qualityIndex).toBeGreaterThan(0);
    expect(guardIndex).toBeGreaterThan(qualityIndex);
  });
});
